#!/usr/bin/env node
/**
 * check-crash-gate.mjs — release gate: block rollout promotion when the
 * candidate release shows a new-crash spike (issue #263).
 *
 * Reads a JSONL crash-metrics export where each line is one of:
 *   {"type":"baseline","maxNewCrashRate":0.02,"maxCrashes":25}
 *   {"ts":"ISO","release":"0.1.0 (42)","newCrashes":3,"sessions":1500}
 *
 * Gate rules (evaluated for the candidate release, --release):
 *   1. newCrashRate = newCrashes / sessions must be <= maxNewCrashRate
 *   2. absolute newCrashes must be <= maxCrashes
 *   3. missing metrics file / no records for the release fails CLOSED
 *      (bootstrap escape: --allow-empty)
 *
 * Usage:
 *   node scripts/check-crash-gate.mjs --release "0.1.0 (42)" [--input file]
 *
 * Exit codes:
 *   0 — gate passed (safe to promote)
 *   1 — spike detected, or metrics unavailable (do not promote)
 *   2 — usage error
 */

import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const DEFAULT_BASELINE = {
  maxNewCrashRate: 0.02,
  maxCrashes: 25,
};

export function parseCrashMetrics(lines) {
  const records = [];
  let baseline = { ...DEFAULT_BASELINE };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "baseline") {
      baseline = {
        maxNewCrashRate:
          typeof obj.maxNewCrashRate === "number" ? obj.maxNewCrashRate : baseline.maxNewCrashRate,
        maxCrashes: typeof obj.maxCrashes === "number" ? obj.maxCrashes : baseline.maxCrashes,
      };
      continue;
    }
    if (typeof obj.release === "string" && typeof obj.sessions === "number") {
      records.push(obj);
    }
  }
  return { baseline, records };
}

export function evaluateCrashGate({ records, baseline, release }) {
  const failures = [];
  const relevant = records.filter((r) => r.release === release);

  if (relevant.length === 0) {
    failures.push(
      `No crash metrics found for release "${release}" — crash intake not reporting. Gate fails closed.`,
    );
    return { passed: false, failures, stats: null };
  }

  const newCrashes = relevant.reduce((sum, r) => sum + (r.newCrashes || 0), 0);
  const sessions = relevant.reduce((sum, r) => sum + (r.sessions || 0), 0);
  const rate = sessions > 0 ? newCrashes / sessions : newCrashes > 0 ? Infinity : 0;

  if (rate > baseline.maxNewCrashRate) {
    failures.push(
      `New-crash rate ${(rate * 100).toFixed(2)}% exceeds baseline ${(baseline.maxNewCrashRate * 100).toFixed(2)}% ` +
        `(${newCrashes} crashes / ${sessions} sessions).`,
    );
  }
  if (newCrashes > baseline.maxCrashes) {
    failures.push(
      `New-crash count ${newCrashes} exceeds absolute cap ${baseline.maxCrashes}.`,
    );
  }

  return {
    passed: failures.length === 0,
    failures,
    stats: { newCrashes, sessions, rate, records: relevant.length },
  };
}

function parseArgs(argv) {
  const args = { input: "mobile/crash-snapshot.jsonl", release: null, allowEmpty: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") args.input = argv[++i];
    else if (arg.startsWith("--input=")) args.input = arg.slice(8);
    else if (arg === "--release") args.release = argv[++i];
    else if (arg.startsWith("--release=")) args.release = arg.slice(10);
    else if (arg === "--allow-empty") args.allowEmpty = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node scripts/check-crash-gate.mjs --release <id> [--input <file>] [--allow-empty]",
    );
    process.exit(0);
  }
  if (!args.release) {
    console.error("❌ --release is required.");
    process.exit(2);
  }

  const inputPath = resolve(process.cwd(), args.input);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Amana — Mobile Crash Release Gate");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Release : ${args.release}`);
  console.log(`  Metrics : ${inputPath}`);
  console.log("");

  if (!existsSync(inputPath)) {
    if (args.allowEmpty) {
      console.log("⚠️  Metrics file missing — allowed by --allow-empty (bootstrap).");
      console.log("✅ Crash gate passed (bootstrap).");
      process.exit(0);
    }
    console.log(`❌ Metrics file not found: ${inputPath}`);
    console.log("❌ Crash gate FAILED. Do not promote to production.");
    process.exit(1);
  }

  const { baseline, records } = parseCrashMetrics(
    readFileSync(inputPath, "utf8").split("\n"),
  );
  const result = evaluateCrashGate({
    records,
    baseline,
    release: args.release,
  });

  if (!result.passed && args.allowEmpty && result.stats === null) {
    console.log("⚠️  No records for release — allowed by --allow-empty (bootstrap).");
    console.log("✅ Crash gate passed (bootstrap).");
    process.exit(0);
  }

  if (result.stats) {
    console.log(`  Sessions : ${result.stats.sessions}`);
    console.log(`  Crashes  : ${result.stats.newCrashes}`);
    console.log(
      `  Rate     : ${(result.stats.rate * 100).toFixed(2)}% (max ${(baseline.maxNewCrashRate * 100).toFixed(2)}%)`,
    );
    console.log(`  Samples  : ${result.stats.records}`);
  }
  console.log("");

  if (!result.passed) {
    for (const failure of result.failures) {
      console.log(`  ✗ ${failure}`);
    }
    console.log("");
    console.log("❌ Crash gate FAILED. Do not promote to production.");
    console.log("   See mobile/docs/crash-reporting.md#crash-spike-runbook");
    process.exit(1);
  }

  console.log("✅ Crash gate passed. Safe to promote.");
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
