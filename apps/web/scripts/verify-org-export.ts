/**
 * Offline restore-readiness check of a downloaded organization-export archive. DRY RUN ONLY: it reads local files and one
 * JSON probe, prints a report and exits 0 (ready) or 1 (not ready). It opens no network or database connection and writes
 * nothing, so it cannot point at production.
 *
 *   npx tsx apps/web/scripts/verify-org-export.ts <archive-dir> <probe.json> [--json]
 *
 * <archive-dir> holds the downloaded files laid out as in the bucket (<org>/exports/<job>/manifest.json, tables/...), or the
 * job folder itself. <probe.json> is the output of docs/runbooks/restore-schema-probe.sql run against the DISPOSABLE target.
 * A pass is NOT a restore and NOT a recovery claim; see docs/runbooks/DISPOSABLE_RESTORE_DRILL.md.
 */
import fs from "node:fs";
import path from "node:path";

import { planRestoreReadiness, type RestorePlan } from "../src/lib/org-export-restore-plan";

export function findManifest(root: string): string | null {
  const stack = [root];
  const found: string[] = [];
  while (stack.length > 0 && found.length < 2) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === "manifest.json") found.push(full);
    }
  }
  return found.length === 1 ? found[0] : null;
}

export function readArchiveFile(root: string, jobFolder: string, relative: string): string | null {
  if (relative.includes("\0") || relative.startsWith("/") || /(^|[\/])\.\.([\/]|$)/.test(relative)) return null;
  const candidates = [path.resolve(root, relative), path.resolve(jobFolder, relative.split("/").slice(3).join("/"))];
  for (const candidate of candidates) {
    const inside = [root, jobFolder].some((base) => candidate === base || candidate.startsWith(base + path.sep));
    if (inside && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return fs.readFileSync(candidate, "utf8");
  }
  return null;
}

export function runCli(argv: string[]): { code: number; output: string; plan: RestorePlan | null } {
  const args = argv.filter((arg) => !arg.startsWith("--"));
  const asJson = argv.includes("--json");
  if (args.length !== 2) return { code: 2, output: "usage: verify-org-export <archive-dir> <probe.json> [--json]", plan: null };
  const root = path.resolve(args[0]);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { code: 2, output: `archive directory not found: ${args[0]}`, plan: null };
  const manifestPath = findManifest(root);
  if (!manifestPath) return { code: 2, output: "expected exactly one manifest.json under the archive directory", plan: null };
  let manifest: unknown;
  let probe: unknown;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { return { code: 2, output: "manifest.json is not valid JSON", plan: null }; }
  try { probe = JSON.parse(fs.readFileSync(path.resolve(args[1]), "utf8")); } catch { return { code: 2, output: "probe file is missing or not valid JSON", plan: null }; }
  const jobFolder = path.dirname(manifestPath);
  const plan = planRestoreReadiness(manifest, (relative) => readArchiveFile(root, jobFolder, relative), probe);
  if (asJson) return { code: plan.ok ? 0 : 1, output: JSON.stringify(plan, null, 2), plan };
  const lines = [
    plan.ok ? "RESTORE-READINESS DRY RUN: PASS (this is not a restore and not a recovery claim)" : "RESTORE-READINESS DRY RUN: FAIL",
    `tables ${plan.summary.tables}, rows ${plan.summary.rows}, append-only tables ${plan.summary.insertOnlyTables}`,
    ...plan.failures.map((failure) => `  FAIL ${failure}`),
    ...plan.warnings.map((warning) => `  note ${warning}`),
    ...(plan.order.length ? ["load order (INSERT only, empty target):", ...plan.order.map((step, index) => `  ${String(index + 1).padStart(2)}. ${step.table} (${step.rows} rows${step.mode === "insert_only" ? ", append-only" : ""}${step.cyclic ? ", FK cycle" : ""})`)] : []),
  ];
  return { code: plan.ok ? 0 : 1, output: lines.join("\n"), plan };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const result = runCli(process.argv.slice(2));
  console.log(result.output);
  process.exit(result.code);
}
