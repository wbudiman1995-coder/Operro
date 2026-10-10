import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { CLEANUP_BATCH, runStorageCleanup } from "../src/lib/storage-cleanup";

const root = path.join(__dirname, "../../..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

interface World {
  objects: Set<string>;                       // "bucket/path" present in Storage
  denyRemove?: Set<string>;                   // removal silently does nothing (policy denial)
  listError?: Set<string>;                    // listing fails for these buckets
  removeError?: string;                       // remove() returns an error
  begin: { marked: number; skipped: number; pending: Array<{ item_id: string; bucket: string; path: string }> };
  recordError?: boolean;
}

function fake(world: World) {
  const log: string[] = [];
  const recorded: Array<{ item_id: string; result: string; error?: string }> = [];
  const client = {
    schema: () => ({
      rpc: async (name: string, args: Record<string, unknown>) => {
        log.push(`rpc:${name}`);
        if (name === "storage_cleanup_begin") return { data: { run_id: "run-1", ...world.begin }, error: null };
        if (name === "storage_cleanup_record") {
          if (world.recordError) return { data: null, error: { code: "55000", message: "run_not_running" } };
          recorded.push(...(args.p_results as typeof recorded));
          return { data: (args.p_results as unknown[]).length, error: null };
        }
        if (name === "storage_cleanup_finish") return { data: recorded.some((r) => r.result === "failed") || world.begin.pending.length > recorded.length ? "partial" : "completed", error: null };
        return { data: null, error: null };
      },
    }),
    storage: {
      from: (bucket: string) => ({
        list: async (folder: string, options: { search: string }) => {
          log.push(`list:${bucket}/${folder}`);
          if (world.listError?.has(bucket)) return { data: null, error: { message: "storage 503" } };
          return { data: [...world.objects].filter((key) => key.startsWith(`${bucket}/${folder}/`) && key.endsWith(options.search)).map((key) => ({ name: key.slice(key.lastIndexOf("/") + 1) })), error: null };
        },
        remove: async (paths: string[]) => {
          log.push(`remove:${bucket}`);
          if (world.removeError) return { data: null, error: { message: world.removeError } };
          const removed = paths.filter((p) => !world.denyRemove?.has(`${bucket}/${p}`));
          for (const p of removed) world.objects.delete(`${bucket}/${p}`);
          return { data: removed.map((name) => ({ name })), error: null };
        },
      }),
    },
  };
  return { client, log, recorded };
}

const item = (n: number, bucket = "styling-references") => ({ item_id: `item-${n}`, bucket, path: `org/ref/${n}.jpg` });

test("objects are removed only after begin has tombstoned metadata, and each outcome is recorded", async () => {
  const world: World = { objects: new Set(["styling-references/org/ref/1.jpg", "styling-references/org/ref/2.jpg"]), begin: { marked: 2, skipped: 0, pending: [item(1), item(2)] } };
  const { client, log, recorded } = fake(world);
  const summary = await runStorageCleanup(client as never, "preview-1");
  assert.equal(log[0], "rpc:storage_cleanup_begin");
  assert.ok(log.indexOf("remove:styling-references") > log.indexOf("rpc:storage_cleanup_begin"), "no object is touched before metadata is marked");
  assert.deepEqual(recorded.map((r) => r.result), ["deleted", "deleted"]);
  assert.equal(world.objects.size, 0);
  assert.equal(log[log.length - 1], "rpc:storage_cleanup_finish");
  assert.deepEqual([summary.deleted, summary.missing, summary.failed, summary.status], [2, 0, 0, "completed"]);
});

test("an object that is already absent is 'missing' - but only when listing actually succeeded", async () => {
  const world: World = { objects: new Set(), begin: { marked: 1, skipped: 0, pending: [item(1)] } };
  const { client, recorded, log } = fake(world);
  const summary = await runStorageCleanup(client as never, "p");
  assert.deepEqual(recorded, [{ item_id: "item-1", result: "missing" }]);
  assert.ok(!log.some((entry) => entry.startsWith("remove:")), "nothing to remove when the object is absent");
  assert.equal(summary.missing, 1);

  const broken: World = { objects: new Set(["styling-references/org/ref/1.jpg"]), listError: new Set(["styling-references"]), begin: { marked: 1, skipped: 0, pending: [item(1)] } };
  const b = fake(broken);
  const failed = await runStorageCleanup(b.client as never, "p");
  assert.equal(b.recorded[0].result, "failed", "a listing error must never be read as 'already gone'");
  assert.match(b.recorded[0].error ?? "", /list:/);
  assert.equal(failed.failed, 1);
  assert.equal(broken.objects.size, 1, "and the object is left in place for the retry");
});

test("a removal that did not really remove the object (policy denial) is a failure, not a success", async () => {
  const world: World = { objects: new Set(["styling-references/org/ref/1.jpg", "styling-references/org/ref/2.jpg"]), denyRemove: new Set(["styling-references/org/ref/2.jpg"]), begin: { marked: 2, skipped: 0, pending: [item(1), item(2)] } };
  const { client, recorded } = fake(world);
  const summary = await runStorageCleanup(client as never, "p");
  assert.deepEqual(recorded.map((r) => [r.item_id, r.result]), [["item-1", "deleted"], ["item-2", "failed"]]);
  assert.match(recorded[1].error ?? "", /still present/);
  assert.equal(summary.status, "partial");
  assert.deepEqual([summary.deleted, summary.failed], [1, 1]);
});

test("a Storage error is a partial failure that is recorded, never reported as success", async () => {
  const world: World = { objects: new Set(["styling-references/org/ref/1.jpg"]), removeError: "storage 500", begin: { marked: 1, skipped: 0, pending: [item(1)] } };
  const { client, recorded } = fake(world);
  const summary = await runStorageCleanup(client as never, "p");
  assert.equal(recorded[0].result, "failed");
  assert.match(recorded[0].error ?? "", /remove: storage 500/);
  assert.equal(summary.status, "partial");
});

test("work is processed in bounded batches and progress is recorded after each batch", async () => {
  const pending = Array.from({ length: CLEANUP_BATCH * 2 + 3 }, (_, i) => item(i + 1));
  const world: World = { objects: new Set(pending.map((p) => `${p.bucket}/${p.path}`)), begin: { marked: pending.length, skipped: 0, pending } };
  const { client, log } = fake(world);
  await runStorageCleanup(client as never, "p");
  assert.equal(log.filter((entry) => entry === "rpc:storage_cleanup_record").length, 3, "one record call per batch");
});

test("if recording fails mid-run the run is still finished (lease released) and the error is surfaced", async () => {
  const world: World = { objects: new Set(["styling-references/org/ref/1.jpg"]), recordError: true, begin: { marked: 1, skipped: 0, pending: [item(1)] } };
  const { client, log } = fake(world);
  const summary = await runStorageCleanup(client as never, "p");
  assert.match(summary.error ?? "", /storage_cleanup_record_failed/);
  assert.equal(log[log.length - 1], "rpc:storage_cleanup_finish");
});

test("a begin refusal (stale preview, other tenant, lease held, not owner) propagates and removes nothing", async () => {
  const client = { schema: () => ({ rpc: async () => ({ data: null, error: { code: "55P03", message: "cleanup_already_running" } }) }), storage: { from: () => { throw new Error("storage must not be touched"); } } };
  await assert.rejects(runStorageCleanup(client as never, "p"), /storage_cleanup_begin_failed:55P03/);
});

test("server actions re-check capability, require an explicit confirmation, and the UI never shows bytes or prices", () => {
  const actions = read("apps/web/src/app/settings/storage/cleanup-actions.ts");
  assert.match(actions, /capabilities\["settings\.manage"\]/);
  assert.match(actions, /formData\.get\("confirm"\) !== "yes"/);
  assert.doesNotMatch(actions, /organization_id|organizationId(?!\))/, "tenancy is never taken from the form");
  const panel = read("apps/web/src/components/storage-cleanup-panel.tsx");
  assert.match(panel, /pratinjau tidak menghapus apa pun/);
  assert.doesNotMatch(panel, /Rp\b|IDR|byte|\bMB\b|\bGB\b|harga|tagihan/i, "no cost or size estimates");
  const migration = read("supabase/migrations/20261029160000_storage_cleanup_foundation.sql");
  assert.doesNotMatch(migration, /pg_database_size|pg_total_relation_size|pg_relation_size/, "no database-byte estimates");
  assert.match(migration, /METADATA FIRST/);
  assert.doesNotMatch(migration, /delete from storage\.objects|storage\.delete/i, "the database never deletes objects itself");
});
