/**
 * Tests for scripts/check-crash-gate.mjs — the release gate that blocks
 * rollout promotion on a new-crash spike (issue #263).
 */

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseCrashMetrics,
  evaluateCrashGate,
  DEFAULT_BASELINE,
} from "../check-crash-gate.mjs";

const SCRIPT = fileURLToPath(new URL("../check-crash-gate.mjs", import.meta.url));

const RELEASE = "0.1.0 (42)";

function metrics(lines) {
  return parseCrashMetrics(lines);
}

describe("parseCrashMetrics", () => {
  it("extracts baseline overrides and session records, skips junk", () => {
    const { baseline, records } = metrics([
      '{"type":"baseline","maxNewCrashRate":0.01,"maxCrashes":10}',
      '{"ts":"2026-09-01T00:00:00Z","release":"0.1.0 (42)","newCrashes":1,"sessions":100}',
      "not-json",
      "# comment",
      '{"release":123}',
    ]);
    expect(baseline).toEqual({ maxNewCrashRate: 0.01, maxCrashes: 10 });
    expect(records).toHaveLength(1);
    expect(records[0].sessions).toBe(100);
  });

  it("falls back to defaults when no baseline record exists", () => {
    const { baseline } = metrics([]);
    expect(baseline).toEqual(DEFAULT_BASELINE);
  });
});

describe("evaluateCrashGate", () => {
  it("passes when the new-crash rate is within baseline", () => {
    const { baseline, records } = metrics([
      '{"type":"baseline","maxNewCrashRate":0.02,"maxCrashes":25}',
      `{"ts":"t","release":"${RELEASE}","newCrashes":5,"sessions":1000}`,
    ]);
    const result = evaluateCrashGate({ records, baseline, release: RELEASE });
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
    expect(result.stats.rate).toBeCloseTo(0.005);
  });

  it("fails when the new-crash rate exceeds the baseline", () => {
    const { baseline, records } = metrics([
      '{"type":"baseline","maxNewCrashRate":0.02,"maxCrashes":25}',
      `{"ts":"t","release":"${RELEASE}","newCrashes":50,"sessions":1000}`,
    ]);
    const result = evaluateCrashGate({ records, baseline, release: RELEASE });
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("exceeds baseline");
  });

  it("fails on absolute crash-count cap even when sessions are large", () => {
    const { baseline, records } = metrics([
      '{"type":"baseline","maxNewCrashRate":0.5,"maxCrashes":10}',
      `{"ts":"t","release":"${RELEASE}","newCrashes":11,"sessions":100000}`,
    ]);
    const result = evaluateCrashGate({ records, baseline, release: RELEASE });
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("absolute cap");
  });

  it("fails closed when the release has no metrics at all", () => {
    const { baseline, records } = metrics([
      `{"ts":"t","release":"other","newCrashes":0,"sessions":100}`,
    ]);
    const result = evaluateCrashGate({ records, baseline, release: RELEASE });
    expect(result.passed).toBe(false);
    expect(result.stats).toBeNull();
    expect(result.failures.join(" ")).toContain("fails closed");
  });
});

describe("check-crash-gate.mjs — script syntax", () => {
  it("is valid ESM", () => {
    expect(() => {
      execSync(`node --check ${SCRIPT}`, { stdio: "pipe" });
    }).not.toThrow();
  });
});
