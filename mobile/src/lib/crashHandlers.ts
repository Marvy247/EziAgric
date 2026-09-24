/**
 * Global crash handlers + ANR watchdog (issue #263).
 *
 * - `ErrorUtils.setGlobalHandler` catches uncaught JS exceptions.
 * - `ErrorUtils.getPromiseRejectionTracking().setHandler` catches
 *   unhandled promise rejections.
 * - ANR watchdog: a foreground interval checks that the main JS thread is
 *   still ticking; a stall beyond ANR_THRESHOLD_MS while the app is active
 *   records an `anr` report (best-effort — if the thread is fully wedged
 *   the report is delivered on the next successful tick).
 *
 * Detox/test safe: handlers are no-ops under NODE_ENV=test.
 */

import { reportCrash, type CrashKind } from './crashReporter';

const ANR_THRESHOLD_MS = 5000;
const ANR_POLL_MS = 1000;
const ANR_REPORT_COOLDOWN_MS = 60_000;

type ErrorUtilsStatic = {
  setGlobalHandler: (handler: (error: Error, isFatal?: boolean) => void) => void;
  getHandler: () => ((error: Error, isFatal?: boolean) => void) | undefined;
  getPromiseRejectionTracking?: () => {
    setHandler: (handler: (error: unknown) => void) => void;
  };
};

function getErrorUtils(): ErrorUtilsStatic | undefined {
  const globalAny = globalThis as {
    ErrorUtils?: ErrorUtilsStatic;
    errorUtils?: ErrorUtilsStatic;
  };
  return globalAny.ErrorUtils ?? globalAny.errorUtils;
}

function report(kind: CrashKind, error: Error, meta?: Record<string, unknown>): void {
  reportCrash({
    kind,
    message: error.message ?? String(error),
    stack: error.stack,
    fatal: kind !== 'handled',
    meta,
  });
}

let previousGlobalHandler: ((error: Error, isFatal?: boolean) => void) | undefined;
let anrTimer: ReturnType<typeof setInterval> | undefined;
let lastAnrReportAt = 0;

function installGlobalErrorHandler(): void {
  const errorUtils = getErrorUtils();
  if (!errorUtils?.setGlobalHandler) return;

  previousGlobalHandler = errorUtils.getHandler?.();
  errorUtils.setGlobalHandler((error: Error, isFatal?: boolean) => {
    report('crash', error, { isFatal: isFatal ?? true });
    if (previousGlobalHandler) {
      previousGlobalHandler(error, isFatal);
    }
  });
}

function installPromiseRejectionHandler(): void {
  const errorUtils = getErrorUtils();
  const tracking = errorUtils?.getPromiseRejectionTracking?.();
  tracking?.setHandler((error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    report('crash', err, { source: 'unhandledRejection' });
  });
}

export function startAnrWatchdog(): void {
  if (anrTimer) return;
  let lastTick = Date.now();

  anrTimer = setInterval(() => {
    const now = Date.now();
    const stall = now - lastTick;
    lastTick = now;
    if (stall >= ANR_THRESHOLD_MS && now - lastAnrReportAt >= ANR_REPORT_COOLDOWN_MS) {
      lastAnrReportAt = now;
      report(
        'anr',
        new Error(`Main thread stalled for ${stall}ms (ANR watchdog)`),
        { stallMs: stall, thresholdMs: ANR_THRESHOLD_MS },
      );
    }
  }, ANR_POLL_MS);
  if (typeof anrTimer === 'object' && anrTimer !== null && 'unref' in anrTimer) {
    (anrTimer as { unref: () => void }).unref();
  }
}

export function stopAnrWatchdog(): void {
  if (anrTimer) {
    clearInterval(anrTimer);
    anrTimer = undefined;
  }
}

/** Idempotent. No-op under NODE_ENV=test so Detox runs stay clean. */
export function installCrashHandlers(): void {
  if (process.env.NODE_ENV === 'test') return;
  installGlobalErrorHandler();
  installPromiseRejectionHandler();
  startAnrWatchdog();
}
