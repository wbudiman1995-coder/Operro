/**
 * Guarded restore-script generator for a DISPOSABLE target (parity #38). It reads a downloaded organization-export archive and a schema
 * probe of the disposable target, refuses anything unsafe, and writes ONE SQL file plus a report. It opens no network or database
 * connection and never executes the SQL: the operator reads it and runs it with psql against the database they named.
 *
 *   npx tsx apps/web/scripts/restore-org-export.ts sql <archive-dir> <probe.json> --target-database <name> --out <restore.sql>
 *
 * Exit codes: 0 generated, 1 refused (each reason is printed), 2 bad usage. It will not overwrite an existing output file.
 * The SQL aborts unless the target is marked disposable (public.operro_restore_target), is empty for the organization, is at the schema
 * version the probe reported and is the database named here. See docs/runbooks/DISPOSABLE_RESTORE_DRILL.md. A generated script is not a
 * restore, and a restore into a disposable database is not a recovery claim; only a recorded drill is.
 */
import fs from "node:fs";
import path from "node:path";

import { generateRestoreSql } from "../src/lib/org-export-restore-sql";
import { findManifest, readArchiveFile } from "./verify-org-export";

const USAGE = "usage: restore-org-export sql <archive-dir> <probe.json> --target-database <name> --out <restore.sql>";

export function runRestoreCli(argv: string[]): { code: number; output: string } {
  const [command, ...rest] = argv;
  if (command !== "sql") return { code: 2, output: USAGE };
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--target-database" || arg === "--out") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--") || options.has(arg)) return { code: 2, output: USAGE };
      options.set(arg, value);
      index += 1;
    } else if (arg.startsWith("--")) return { code: 2, output: USAGE };
    else positional.push(arg);
  }
  const targetDatabase = options.get("--target-database");
  const out = options.get("--out");
  if (positional.length !== 2 || !targetDatabase || !out) return { code: 2, output: USAGE };

  const root = path.resolve(positional[0]);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { code: 2, output: `archive directory not found: ${positional[0]}` };
  const manifestPath = findManifest(root);
  if (!manifestPath) return { code: 2, output: "expected exactly one manifest.json under the archive directory" };
  let manifest: unknown;
  let probe: unknown;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { return { code: 2, output: "manifest.json is not valid JSON" }; }
  try { probe = JSON.parse(fs.readFileSync(path.resolve(positional[1]), "utf8")); } catch { return { code: 2, output: "probe file is missing or not valid JSON" }; }
  const outPath = path.resolve(out);
  const reportPath = `${outPath}.report.json`;
  if (fs.existsSync(outPath) || fs.existsSync(reportPath)) return { code: 2, output: `refusing to overwrite an existing file: ${out}` };

  const jobFolder = path.dirname(manifestPath);
  const result = generateRestoreSql({ manifest, probe, targetDatabase, read: (relative) => readArchiveFile(root, jobFolder, relative) });
  if (!result.ok) {
    return { code: 1, output: ["RESTORE SCRIPT REFUSED (nothing was written)", ...result.failures.map((failure) => `  FAIL ${failure}`)].join("\n") };
  }
  fs.writeFileSync(outPath, result.sql, { encoding: "utf8", flag: "wx" });
  fs.writeFileSync(reportPath, `${JSON.stringify(result.report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const lines = [
    "RESTORE SCRIPT GENERATED (not executed; this is not a restore and not a recovery claim)",
    `  sql:    ${out}  sha256 ${result.report.sqlSha256}`,
    `  report: ${out}.report.json  sha256 ${result.report.reportSha256}`,
    `  organization ${result.report.organizationId}, manifest ${result.report.manifestSha256}`,
    `  tables ${result.report.tables.length}, rows ${result.report.totalRows}, target database ${result.report.targetDatabase}`,
    ...result.report.warnings.map((warning) => `  note ${warning}`),
    "Run it only after creating the disposable marker (docs/runbooks/restore-target-marker.sql) in the database named above:",
    `  psql "$DISPOSABLE_DATABASE_URL" -v ON_ERROR_STOP=1 -f ${out} | tee restore-output.txt`,
  ];
  return { code: 0, output: lines.join("\n") };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const result = runRestoreCli(process.argv.slice(2));
  console.log(result.output);
  process.exit(result.code);
}
