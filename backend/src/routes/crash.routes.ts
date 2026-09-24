import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { appLogger } from "../middleware/logger";
import { redactPii } from "../lib/logRedaction";
import { alertService } from "../services/alert.service";
import { env } from "../config/env";

/**
 * Self-host crash / ANR intake for the mobile client (issue #263).
 *
 * POST /crash-reports accepts the payload produced by
 * mobile/src/lib/crashReporter.ts. The payload is validated, scrubbed a
 * second time server-side (defence in depth — the client scrubber is not
 * trusted), logged, and counted. When a release's crash count crosses
 * CRASH_SPIKE_THRESHOLD inside CRASH_SPIKE_WINDOW_MS a `mobile_crash_spike`
 * alert is dispatched through the shared alert webhook (page routing,
 * see docs/alert-routing-policy.md).
 *
 * Scrubbed reports are retained only as log lines — no PII-bearing column
 * is written; retention follows the log pipeline (30 days, same as
 * MANIFEST_PII_RETENTION_DAYS).
 */

const crashReportSchema = z.object({
  kind: z.enum(["crash", "anr", "handled"]),
  release: z.string().min(1).max(120),
  platform: z.string().max(60).optional(),
  appVersion: z.string().max(60).optional(),
  message: z.string().max(4000),
  stack: z.string().max(30000).optional(),
  componentStack: z.string().max(30000).nullable().optional(),
  route: z.string().max(300).optional(),
  fatal: z.boolean().optional(),
  timestamp: z.string().max(40).optional(),
  device: z
    .object({
      osVersion: z.string().max(60).optional(),
      model: z.string().max(120).optional(),
      isDevice: z.boolean().optional(),
    })
    .optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type CrashReport = z.infer<typeof crashReportSchema>;

/** Sliding-window crash counter used for spike detection. */
const recentCrashes = new Map<string, number[]>();
let lastSpikeAlertAt = 0;
const SPIKE_ALERT_COOLDOWN_MS = 15 * 60_000;

/** Simple per-IP fixed-window rate limiter (in-memory, per instance). */
const rateWindows = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string, limitPerMin: number): boolean {
  const now = Date.now();
  const window = rateWindows.get(key);
  if (!window || now >= window.resetAt) {
    rateWindows.set(key, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  window.count += 1;
  if (rateWindows.size > 10_000) {
    for (const [k, v] of rateWindows) {
      if (now >= v.resetAt) rateWindows.delete(k);
    }
  }
  return window.count > limitPerMin;
}

export function recordCrashForSpikeDetection(
  release: string,
  now: number = Date.now(),
  windowMs: number = env.CRASH_SPIKE_WINDOW_MS,
  threshold: number = env.CRASH_SPIKE_THRESHOLD,
): boolean {
  const stamps = (recentCrashes.get(release) ?? []).filter((t) => now - t < windowMs);
  stamps.push(now);
  recentCrashes.set(release, stamps);
  return stamps.length >= threshold;
}

export function resetCrashSpikeStateForTests(): void {
  recentCrashes.clear();
  lastSpikeAlertAt = 0;
}

export function createCrashRouter(): Router {
  const router = Router();

  router.post("/", (req: Request, res: Response) => {
    if (rateLimited(req.ip ?? "unknown", env.CRASH_INTAKE_RATE_LIMIT_PER_MIN)) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }

    const parsed = crashReportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_crash_report", details: parsed.error.flatten().fieldErrors });
      return;
    }

    const scrubbed = redactPii(parsed.data);

    appLogger.warn(
      { crashReport: scrubbed },
      "Mobile crash report received",
    );

    if (scrubbed.kind === "crash" || scrubbed.kind === "anr") {
      const spiked = recordCrashForSpikeDetection(scrubbed.release);
      const now = Date.now();
      if (spiked && now - lastSpikeAlertAt >= SPIKE_ALERT_COOLDOWN_MS) {
        lastSpikeAlertAt = now;
        void alertService.dispatch(
          "mobile_crash_spike",
          `Mobile crash spike: ${env.CRASH_SPIKE_THRESHOLD}+ crash/ANR reports for release ${scrubbed.release} within ${Math.round(env.CRASH_SPIKE_WINDOW_MS / 60000)}m`,
          {
            release: scrubbed.release,
            kind: scrubbed.kind,
            threshold: env.CRASH_SPIKE_THRESHOLD,
            windowMs: env.CRASH_SPIKE_WINDOW_MS,
          },
        );
      }
    }

    res.status(202).json({ accepted: true });
  });

  return router;
}
