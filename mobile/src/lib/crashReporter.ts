/**
 * Crash / ANR reporting pipeline for the mobile client (issue #263).
 *
 * Two transports, both best-effort — the reporter must NEVER throw or cause
 * a secondary crash:
 *
 *  1. Self-host intake — POST of a scrubbed JSON payload to
 *     `EXPO_PUBLIC_CRASH_INGEST_URL` (backend `POST /crash-reports`).
 *  2. Sentry (optional) — when `EXPO_PUBLIC_SENTRY_DSN` is set, a minimal
 *     Sentry envelope is POSTed to the DSN's envelope endpoint. No SDK
 *     dependency required; symbolication uses the artifacts uploaded by
 *     .github/workflows/mobile-crash-symbols.yml.
 *
 * Every payload is scrubbed by crashScrubbing.ts *before* it is serialized,
 * so PII can never leave the device (verified by crashReporter.test.ts
 * against the serialized body).
 *
 * Development/test: console only, no network. Production: both transports.
 */

import { scrubCrashValue } from './crashScrubbing';

export type CrashKind = 'crash' | 'anr' | 'handled';

export interface CrashReportInput {
  kind: CrashKind;
  message: string;
  stack?: string;
  componentStack?: string | null;
  route?: string;
  fatal?: boolean;
  meta?: Record<string, unknown>;
}

export interface CrashReportPayload extends Record<string, unknown> {
  kind: CrashKind;
  release: string;
  platform: string;
  appVersion: string;
  message: string;
  stack?: string;
  componentStack?: string | null;
  route?: string;
  fatal: boolean;
  timestamp: string;
  device?: { osVersion?: string; model?: string; isDevice?: boolean };
}

const INGEST_TIMEOUT_MS = 5000;

function ingestUrl(): string | undefined {
  return process.env.EXPO_PUBLIC_CRASH_INGEST_URL;
}

function sentryDsn(): string | undefined {
  return process.env.EXPO_PUBLIC_SENTRY_DSN;
}

export function currentRelease(): string {
  return (
    process.env.EXPO_PUBLIC_CRASH_RELEASE ||
    process.env.EXPO_PUBLIC_APP_VERSION ||
    'dev'
  );
}

function buildPayload(input: CrashReportInput): CrashReportPayload {
  const raw: CrashReportPayload = {
    kind: input.kind,
    release: currentRelease(),
    platform: 'ios/android',
    appVersion: process.env.EXPO_PUBLIC_APP_VERSION || '0.0.0',
    message: input.message,
    stack: input.stack,
    componentStack: input.componentStack ?? null,
    route: input.route,
    fatal: input.fatal ?? input.kind !== 'handled',
    timestamp: new Date().toISOString(),
    meta: input.meta,
  };
  return scrubCrashValue(raw);
}

/** Serialize the payload — exported so tests can inspect the exact bytes sent. */
export function serializeCrashPayload(input: CrashReportInput): string {
  return JSON.stringify(buildPayload(input));
}

async function postJson(url: string, body: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Minimal Sentry envelope transport (https://develop.sentry.dev/sdk/overview/#envelopes).
 * Header line + event header line + JSON event, newline separated.
 */
function buildSentryEnvelope(payload: CrashReportPayload, dsn: string): { url: string; body: string } {
  const [protocol, rest] = dsn.split('//');
  const isHttps = protocol === 'https:';
  const [keysAndHost, path] = (rest || '').split(/\/(\d+\/?$)/);
  // DSN shape: https://<publicKey>@<host>/<projectId>
  const atIdx = keysAndHost.lastIndexOf('@');
  const publicKey = atIdx > 0 ? keysAndHost.slice(0, atIdx) : keysAndHost;
  const host = atIdx > 0 ? keysAndHost.slice(atIdx + 1) : keysAndHost;
  const projectId = (path || '').replace(/\/$/, '').replace(/^\d+\//, '') || path?.replace('/', '');
  const hostOnly = host.split('/')[0];
  const url = `${isHttps ? 'https' : 'http'}://${hostOnly}/api/${projectId}/envelope/`;

  const eventId = `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  const sentryHeader = { event_id: eventId, sent_at: new Date().toISOString() };
  const eventType = {
    event_id: eventId,
    timestamp: payload.timestamp,
    platform: 'other',
    level: payload.kind === 'anr' ? 'error' : 'fatal',
    logger: 'mobile.crash',
    release: payload.release,
    exception: {
      values: [
        {
          type: payload.kind,
          value: payload.message,
          stacktrace: payload.stack
            ? { frames: [{ function: payload.stack.split('\n')[0] || 'unknown' }] }
            : undefined,
        },
      ],
    },
    tags: {
      route: payload.route ?? 'unknown',
      platform_kind: 'mobile',
    },
  };

  const body = [
    JSON.stringify(sentryHeader),
    JSON.stringify({ type: 'event' }),
    JSON.stringify(eventType),
  ].join('\n');
  return { url: `${url}?sentry_key=${publicKey}&sentry_version=7`, body };
}

async function sendToSentry(payload: CrashReportPayload): Promise<void> {
  const dsn = sentryDsn();
  if (!dsn) return;
  try {
    const { url, body } = buildSentryEnvelope(payload, dsn);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS);
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-sentry-envelope' },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Never let the Sentry transport throw.
  }
}

/**
 * Report a crash/ANR/handled error. Fire-and-forget; never throws.
 * In dev/test only logs to console (matches frontend errorReporter.ts).
 */
export function reportCrash(input: CrashReportInput): void {
  try {
    const payload = buildPayload(input);
    const body = JSON.stringify(payload);
    const isProd = process.env.NODE_ENV === 'production';

    if (!isProd) {
      console.error(`[crashReporter] ${payload.kind} @ ${payload.route ?? 'unknown'}:`, payload.message);
      return;
    }

    const url = ingestUrl();
    if (url) {
      void postJson(url, body).catch(() => undefined);
    }
    void sendToSentry(payload).catch(() => undefined);
  } catch {
    // The reporter must never cause a secondary crash.
  }
}
