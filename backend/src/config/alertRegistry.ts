import type { AlertType } from "../services/alert.service";

/**
 * Routing class for an alert:
 *  - "page"   — wakes on-call immediately (production impact or fund risk).
 *  - "ticket" — filed for same/next-business-day triage, no page.
 *
 * See docs/alert-routing-policy.md for the full severity rubric.
 */
export type AlertRouting = "page" | "ticket";

export interface AlertRegistryEntry {
  routing: AlertRouting;
  /** Runbook every recipient of this alert can open immediately. */
  runbookUrl: string;
  description: string;
  /**
   * Per-alert-type dedupe/grouping window, in ms. Falls back to the
   * service-wide `ALERT_COOLDOWN_MS` when omitted — most alert classes don't
   * need a bespoke window, only the noisy or slow-moving ones do.
   */
  dedupeWindowMs?: number;
}

/**
 * `Record<AlertType, ...>` makes this exhaustive at compile time: adding a
 * new AlertType without a registry entry fails the backend build. A runtime
 * test (`alertRegistry.test.ts`) checks the *content* of every entry
 * (non-empty runbook link, valid routing) so the "no alert ships without a
 * runbook" rule from docs/alert-routing-policy.md holds in CI too.
 */
export const ALERT_REGISTRY: Record<AlertType, AlertRegistryEntry> = {
  db_connection_failure: {
    routing: "page",
    runbookUrl: "docs/runbooks/incident-response.md#severity-levels",
    description: "Primary database is unreachable or the connection pool is exhausted.",
  },
  redis_connection_failure: {
    routing: "page",
    runbookUrl: "docs/runbooks/incident-response.md#severity-levels",
    description: "Redis is unreachable, degrading caching, sessions, and rate limiting.",
  },
  cache_unavailable: {
    routing: "ticket",
    runbookUrl: "docs/runbooks/incident-response.md#severity-levels",
    description: "Cache layer is degraded but the app is serving requests via fallback paths.",
  },
  reconciliation_drift_warning: {
    routing: "ticket",
    runbookUrl: "docs/runbooks/incident-response.md#severity-levels",
    description: "On-chain vs. off-chain balance reconciliation drifted past the warning threshold.",
  },
  reconciliation_drift_critical: {
    routing: "page",
    runbookUrl: "docs/runbooks/incident-response.md#severity-levels",
    description: "Reconciliation drift crossed the critical threshold — possible fund-accounting bug.",
  },
  reconciliation_job_failure: {
    routing: "page",
    runbookUrl: "docs/runbooks/incident-response.md#severity-levels",
    description: "The scheduled reconciliation job itself failed to run or complete.",
  },
  admin_soroban_tx_failure: {
    routing: "page",
    runbookUrl: "docs/admin-tx-failure-alerting.md",
    description: "Admin Soroban submissions are failing repeatedly (bad key, RPC outage, invalid XDR).",
  },
  stellar_fee_congestion: {
    routing: "ticket",
    runbookUrl: "docs/runbooks/incident-response.md#severity-levels",
    description: "Stellar network fee estimation detected sustained ledger congestion.",
    // Congestion tends to persist for a while once detected; avoid re-ticketing
    // on every request during the same episode.
    dedupeWindowMs: 15 * 60_000,
  },
  job_missed_heartbeat: {
    routing: "ticket",
    runbookUrl: "docs/runbooks/incident-response.md#severity-levels",
    description: "A monitored background job has not reported a heartbeat within its expected interval.",
  },
  job_repeated_failures: {
    routing: "page",
    runbookUrl: "docs/runbooks/incident-response.md#severity-levels",
    description: "A background job has failed repeatedly across consecutive runs.",
  },
  job_failure_rate_high: {
    routing: "page",
    runbookUrl: "docs/runbooks/incident-response.md#severity-levels",
    description: "A background job's failure rate crossed the alerting threshold.",
  },
  outbox_critical_gaps: {
    routing: "page",
    runbookUrl: "docs/runbooks/incident-response.md#severity-levels",
    description: "The outbox scanner found unpublished events past the critical-gap threshold — possible missed settlement actions.",
  },
  outbox_scan_failed: {
    routing: "ticket",
    runbookUrl: "docs/runbooks/incident-response.md#severity-levels",
    description: "The outbox completeness scan itself failed to run or complete.",
  },
  synthetic_probe_failure: {
    routing: "page",
    runbookUrl: "docs/synthetic-probes-policy.md#failure-triage",
    description: "A scheduled staging synthetic probe (auth -> create -> deposit -> release) failed.",
    // Probes run hourly; a 15-minute dedupe window avoids re-paging on
    // every subsequent run while the same underlying break is being fixed.
    dedupeWindowMs: 15 * 60_000,
  },
  pii_log_leak_detected: {
    routing: "ticket",
    runbookUrl: "docs/pii-log-scanning.md#responding-to-a-scanner-alert",
    description: "The PII log scanner found emails/phone numbers/secrets that survived log redaction.",
    // The scanner runs weekly; suppress repeat pages for the same
    // underlying gap until someone's had a chance to patch the denylist.
    dedupeWindowMs: 24 * 60 * 60_000,
  },
  mobile_crash_spike: {
    routing: "page",
    runbookUrl:
      "https://github.com/EziAgric/EziAgric/blob/main/mobile/docs/crash-reporting.md#crash-spike-runbook",
    description:
      "A release crossed the crash/ANR spike threshold — blocks rollout promotion until triaged.",
    // Spikes persist while the offending build is out; 15 minutes matches
    // the intake's own alert cooldown so pages aren't repeated per report.
    dedupeWindowMs: 15 * 60_000,
  },
  backup_stale: {
    routing: "page",
    runbookUrl: "docs/runbooks/backup-restore-drill.md",
    description:
      "No fresh database backup within the SLA — restores are unverifiable and RPO claims are unfounded.",
    // Backup cadence is daily; a 6-hour window avoids re-paging every
    // check while the backup job is being fixed.
    dedupeWindowMs: 6 * 60 * 60_000,
  },
  deploy_rollback_triggered: {
    routing: "page",
    runbookUrl: "docs/runbooks/rollback.md",
    description:
      "Error-rate burn during a deploy automatically triggered a rollback — confirm recovery and open a postmortem.",
    // One deploy episode = one page; repeats while the burn persists would
    // drown the on-call during an already-active incident.
    dedupeWindowMs: 30 * 60_000,
  },
};

export function getAlertRegistryEntry(type: AlertType): AlertRegistryEntry {
  return ALERT_REGISTRY[type];
}
