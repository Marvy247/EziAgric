# Crash & ANR Reporting (Mobile)

Issue: #263 · Related: #57 (PII), #59 (incident process), #48 (readiness)

Field failures are visible within minutes, symbolicated, PII-free, and a
new-crash spike blocks rollout promotion.

## Pipeline

```
mobile crash/ANR
  → src/lib/crashReporter.ts   (scrub → serialize → fire-and-forget)
      ├─ POST {EXPO_PUBLIC_CRASH_INGEST_URL}   self-host intake
      └─ POST Sentry envelope (optional, EXPO_PUBLIC_SENTRY_DSN)
  → backend POST /crash-reports                (re-scrub → log → count)
      └─ spike threshold → alert `mobile_crash_spike` (routing: page)
  → symbolication via artifacts from .github/workflows/mobile-crash-symbols.yml
  → release gate scripts/check-crash-gate.mjs blocks promotion on spikes
```

| Layer | File |
| --- | --- |
| PII scrubbing | `src/lib/crashScrubbing.ts` |
| Reporter + transports | `src/lib/crashReporter.ts` |
| Global handlers + ANR watchdog | `src/lib/crashHandlers.ts` |
| Error boundary | `src/components/CrashErrorBoundary.tsx` |
| Intake endpoint | `backend/src/routes/crash.routes.ts` |
| Spike alert | `backend/src/config/alertRegistry.ts` → `mobile_crash_spike` |
| Release gate | `scripts/check-crash-gate.mjs` |

## Capture points

1. **Uncaught JS exceptions** — `ErrorUtils.setGlobalHandler` installed in
   `installCrashHandlers()` (`src/index.tsx`, before `registerRootComponent`).
2. **Unhandled promise rejections** — promise-rejection tracking handler.
3. **Render exceptions** — `CrashErrorBoundary` wraps the app tree in
   `App.tsx`, reports with the React component stack, and shows a
   controlled fallback with a retry.
4. **ANR** — a foreground watchdog flags main-thread stalls ≥ 5s as `anr`
   reports (60s cooldown between ANR reports).

Handlers are no-ops under `NODE_ENV=test` so Detox/unit runs stay clean.

## PII scrubbing

Payloads are scrubbed **twice**: once on device
(`crashScrubbing.ts` — same denylist/pattern semantics as
`backend/src/lib/logRedaction.ts`) and again server-side
(`redactPii` on intake). Field denylist + conservative email/phone/wallet/IP
pattern pass; stacks are scrubbed in full (their first line embeds the
message). Arbitrary digit runs are never redacted — trade/ledger ids must
survive.

Enforcement is by inspection tests against the **serialized** payload:

- `mobile/src/lib/__tests__/crashReporter.test.ts`
- `backend/src/__tests__/crash.routes.test.ts`

Retention: scrubbed reports exist only as log lines (30-day log retention,
same window as `MANIFEST_PII_RETENTION_DAYS`).

## Symbolication

Release builds ship minified/Hermes bundles. `.github/workflows/mobile-crash-symbols.yml`
runs on every published release / `v*.*.*` tag, exports JS bundles with
sourcemaps for ios + android, and attaches them to the GitHub Release
(400-day retention, same convention as SBOMs). Symbolicate with
`npx metro-symbolicate <map-file> <stack>`.

Set `EXPO_PUBLIC_CRASH_RELEASE` (CI injects the git tag) so reports and
symbol bundles share one release identifier.

## Crash spike runbook

The intake dispatches `mobile_crash_spike` (routing: **page**, 15-minute
dedupe) when a release crosses `CRASH_SPIKE_THRESHOLD` reports inside
`CRASH_SPIKE_WINDOW_MS` (defaults: 10 / 15 minutes).

1. Open the release's crash list in the intake logs / Sentry (symbolicated
   via the release artifacts).
2. Identify the top issue; if it is fund-affecting or login-blocking treat
   it as P1 per
   [incident-response.md](../../docs/runbooks/incident-response.md#severity-levels).
3. **Rollout is blocked** — `scripts/check-crash-gate.mjs` fails the
   release-gate workflow while a spike is open. Hotfix or roll back
   ([rollback runbook](../../docs/runbooks/rollback.md)), do not promote.
4. After the fix ships under a new release id, the gate re-evaluates
   against fresh metrics.

## Release gate

`scripts/check-crash-gate.mjs` compares a crash-metrics JSONL export
(`{ts, release, newCrashes, sessions}` records) against baseline thresholds
and exits non-zero on a spike or missing data — "no data" fails closed
unless `--allow-empty` is passed during bootstrap.

```bash
node scripts/check-crash-gate.mjs --input mobile/crash-snapshot.jsonl
```

It runs in `.github/workflows/crash-gate.yml` on every published release;
a red gate blocks rollout promotion exactly like a failed staging validate
(see [deployment.md](../../docs/runbooks/deployment.md#pre-deploy-checklist)).

## Configuration

| Var | Where | Purpose |
| --- | --- | --- |
| `EXPO_PUBLIC_CRASH_INGEST_URL` | mobile env | Self-host intake URL |
| `EXPO_PUBLIC_SENTRY_DSN` | mobile env | Optional Sentry transport |
| `EXPO_PUBLIC_CRASH_RELEASE` | mobile env (CI) | Release id on every report |
| `CRASH_SPIKE_THRESHOLD` | backend env | Reports before spike alert (default 10) |
| `CRASH_SPIKE_WINDOW_MS` | backend env | Spike sliding window (default 15m) |
| `CRASH_INTAKE_RATE_LIMIT_PER_MIN` | backend env | Per-IP intake limit (default 60) |
