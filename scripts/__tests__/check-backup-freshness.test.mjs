/**
 * Tests for scripts/check-backup-freshness.sh — the gate that pages
 * `backup_stale` when the latest database backup is missing or beyond the
 * SLA (issue #266 DoD: missing-backup alert validated by simulated gap).
 *
 * Runs the real script against temp fixtures and asserts exit codes.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../check-backup-freshness.sh", import.meta.url));

function run(args, env = {}) {
  try {
    const stdout = execFileSync("bash", [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, output: stdout };
  } catch (err) {
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function statusFile(payload) {
  const dir = mkdtempSync(join(tmpdir(), "backup-freshness-"));
  const file = join(dir, "status.json");
  writeFileSync(file, JSON.stringify(payload), "utf8");
  return file;
}

describe("check-backup-freshness.sh", () => {
  it("passes when the latest backup is within the SLA", () => {
    const fresh = new Date(Date.now() - 5 * 3600_000).toISOString();
    const { code, output } = run(["--status-file", statusFile({ latestDailyTs: fresh })]);
    expect(code).toBe(0);
    expect(output).toContain("passed");
  });

  it("fails when the latest backup is stale beyond the SLA", () => {
    const stale = new Date(Date.now() - 48 * 3600_000).toISOString();
    const { code, output } = run(["--status-file", statusFile({ latestDailyTs: stale })]);
    expect(code).toBe(1);
    expect(output).toContain("BACKUP STALE ALERT");
  });

  it("fails when the status file reports no backup at all", () => {
    const { code, output } = run(["--status-file", statusFile({ latestDailyTs: null })]);
    expect(code).toBe(1);
    expect(output).toContain("No daily backup found");
  });

  it("fails on a simulated gap (validated missing-backup alert)", () => {
    const { code, output } = run(["--simulate-gap"]);
    expect(code).toBe(1);
    expect(output).toContain("BACKUP STALE ALERT");
  });

  it("respects a custom SLA boundary", () => {
    const edge = new Date(Date.now() - 2 * 3600_000).toISOString();
    const within = run(["--status-file", statusFile({ latestDailyTs: edge })], {
      BACKUP_SLA_HOURS: "3",
    });
    expect(within.code).toBe(0);
    const beyond = run(["--status-file", statusFile({ latestDailyTs: edge })], {
      BACKUP_SLA_HOURS: "1",
    });
    expect(beyond.code).toBe(1);
  });

  it("exits 2 on unknown arguments", () => {
    expect(run(["--bogus"]).code).toBe(2);
  });
});
