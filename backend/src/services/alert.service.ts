import crypto from "crypto";
import { env } from "../config/env";
import { appLogger } from "../middleware/logger";
import { ALERT_REGISTRY, type AlertRouting } from "../config/alertRegistry";

export type AlertType =
  | "db_connection_failure"
  | "redis_connection_failure"
  | "cache_unavailable"
  | "reconciliation_drift_warning"
  | "reconciliation_drift_critical"
  | "reconciliation_job_failure"
  | "stellar_fee_congestion"
  | "admin_soroban_tx_failure"
  | "job_missed_heartbeat"
  | "job_repeated_failures"
  | "job_failure_rate_high"
  | "outbox_critical_gaps"
  | "outbox_scan_failed"
  | "synthetic_probe_failure"
  | "pii_log_leak_detected"
  | "mobile_crash_spike"
  | "deploy_rollback_triggered"
  | "backup_stale";

export interface AlertPayload {
  type: AlertType;
  severity: "critical";
  /** Routing class and runbook link, looked up from ALERT_REGISTRY. */
  routing: AlertRouting;
  runbookUrl: string;
  timestamp: string;
  message: string;
  details?: Record<string, unknown>;
}

export class AlertService {
  private readonly alertWebhookUrl: string | undefined;
  private readonly alertWebhookSecret: string | undefined;
  private readonly cooldownMs: number;
  private readonly lastSentAt = new Map<AlertType, number>();

  constructor(
    alertWebhookUrl: string | undefined = env.ALERT_WEBHOOK_URL,
    alertWebhookSecret: string | undefined = env.ALERT_WEBHOOK_SECRET,
    cooldownMs: number = env.ALERT_COOLDOWN_MS,
  ) {
    this.alertWebhookUrl = alertWebhookUrl;
    this.alertWebhookSecret = alertWebhookSecret;
    this.cooldownMs = cooldownMs;
  }

  async dispatch(
    type: AlertType,
    message: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.alertWebhookUrl) {
      return;
    }

    const registryEntry = ALERT_REGISTRY[type];
    const dedupeWindowMs = registryEntry.dedupeWindowMs ?? this.cooldownMs;

    const now = Date.now();
    const lastSent = this.lastSentAt.get(type);
    if (lastSent !== undefined && now - lastSent < dedupeWindowMs) {
      appLogger.debug({ type }, "Alert suppressed by cooldown");
      return;
    }

    const payload: AlertPayload = {
      type,
      severity: "critical",
      routing: registryEntry.routing,
      runbookUrl: registryEntry.runbookUrl,
      timestamp: new Date().toISOString(),
      message,
      details,
    };

    const body = JSON.stringify(payload);
    const signature = this.alertWebhookSecret
      ? crypto.createHmac("sha256", this.alertWebhookSecret).update(body).digest("hex")
      : undefined;

    try {
      const response = await fetch(this.alertWebhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(signature ? { "X-Alert-Signature": signature } : {}),
        },
        body,
      });

      if (!response.ok) {
        appLogger.warn(
          { type, statusCode: response.status },
          "Alert dispatch returned non-OK status",
        );
        return;
      }

      this.lastSentAt.set(type, now);
      appLogger.info({ type }, "Alert dispatched successfully");
    } catch (error) {
      appLogger.error({ error, type }, "Failed to dispatch alert");
    }
  }

  isConfigured(): boolean {
    return !!this.alertWebhookUrl;
  }

  resetCooldown(type?: AlertType): void {
    if (type) {
      this.lastSentAt.delete(type);
      return;
    }
    this.lastSentAt.clear();
  }
}

export const alertService = new AlertService();
