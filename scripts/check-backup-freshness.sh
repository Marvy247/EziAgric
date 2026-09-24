#!/usr/bin/env bash
# check-backup-freshness.sh — Alert if the latest database backup is missing
# or stale beyond the SLA (issue #266). Modeled on verify-secrets-rotation.sh
# (age-vs-SLA gate) and validated the way slo-fault-test.sh validates alerts:
# a controlled gap must make the check fail.
#
# Modes:
#   1) S3 (default): lists s3://$S3_BUCKET/$S3_PREFIX/daily/ and computes the
#      age of the newest backup from its amana-daily-<UTCts> key.
#   2) --status-file <json>: offline/CI mode. JSON shape:
#        { "latestDailyTs": "2026-09-23T02:00:00Z" }   (null/missing = gap)
#   3) --simulate-gap: behave as if zero backups exist — used to validate
#      that the missing-backup alert actually fires (DoD "simulated gap").
#
# Usage:
#   ./scripts/check-backup-freshness.sh
#   ./scripts/check-backup-freshness.sh --simulate-gap
#   ./scripts/check-backup-freshness.sh --status-file fixture.json
#
# Env:
#   BACKUP_SLA_HOURS        freshness SLA (default 26 — daily job + slack)
#   ALERT_WEBHOOK_URL       optional; dispatches `backup_stale` (page)
#   ALERT_WEBHOOK_SECRET    optional HMAC key for X-Alert-Signature
#   S3_BUCKET / S3_PREFIX / S3_ENDPOINT   (S3 mode; same as db-backup.sh)
#
# Exit codes:
#   0 — a fresh backup exists within the SLA
#   1 — backup missing or stale beyond the SLA (alert)
#   2 — usage error
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

SLA_HOURS="${BACKUP_SLA_HOURS:-26}"
MODE="s3"
STATUS_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --simulate-gap) MODE="gap"; shift ;;
    --status-file) MODE="status"; STATUS_FILE="${2:?}"; shift 2 ;;
    --status-file=*) MODE="status"; STATUS_FILE="${1#*=}"; shift ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -f "$ROOT_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  set -o allexport; source "$ROOT_DIR/.env"; set +o allexport
fi

echo "==============================================================="
echo "  EziAgric — Backup Freshness Check"
echo "==============================================================="
echo "  SLA : ${SLA_HOURS}h"
echo "  Mode: $MODE"
echo ""

LATEST_TS=""
NOW_EPOCH=$(date -u +%s)

case "$MODE" in
  gap)
    LATEST_TS=""
    ;;
  status)
    if [[ ! -f "$STATUS_FILE" ]]; then
      echo "❌ status file not found: $STATUS_FILE"
      exit 2
    fi
    if ! command -v jq &>/dev/null; then
      echo "❌ jq is required for --status-file mode"
      exit 2
    fi
    LATEST_TS=$(jq -r '.latestDailyTs // empty' "$STATUS_FILE")
    ;;
  s3)
    : "${S3_BUCKET:?S3_BUCKET is required for S3 mode}"
    S3_PREFIX="${S3_PREFIX:-backups}"
    AWS_ARGS=()
    [[ -n "${S3_ENDPOINT:-}" ]] && AWS_ARGS+=(--endpoint-url "$S3_ENDPOINT")
    NEWEST_KEY=$(aws "${AWS_ARGS[@]}" s3 ls "s3://$S3_BUCKET/$S3_PREFIX/daily/" 2>/dev/null \
      | awk '{print $4}' | grep '^amana-daily-' | sort | tail -n 1 || true)
    if [[ -n "$NEWEST_KEY" ]]; then
      # amana-daily-YYYYmmddTHHMMSSZ.sql.gz.gpg
      TS_RAW=$(echo "$NEWEST_KEY" | sed -n 's/^amana-daily-\([0-9]\{8\}T[0-9]\{6\}Z\).*/\1/p')
      if [[ -n "$TS_RAW" ]]; then
        LATEST_TS="$(date -u -d "${TS_RAW:0:8} ${TS_RAW:9:2}:${TS_RAW:11:2}:${TS_RAW:13:2} UTC" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
          || true)"
      fi
    fi
    ;;
esac

dispatch_alert() {
  [[ -n "${ALERT_WEBHOOK_URL:-}" ]] || return 0
  local payload
  payload=$(printf '{"type":"backup_stale","severity":"critical","routing":"page","runbookUrl":"docs/runbooks/backup-restore-drill.md","timestamp":"%s","message":"Database backup missing or stale beyond %sh SLA (latest: %s)","details":{"slaHours":%s,"latest":"%s"}}' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SLA_HOURS" "${LATEST_TS:-none}" "$SLA_HOURS" "${LATEST_TS:-none}")
  if [[ -n "${ALERT_WEBHOOK_SECRET:-}" ]]; then
    local sig
    sig=$(printf '%s' "$payload" | openssl dgst -sha256 -hmac "$ALERT_WEBHOOK_SECRET" -hex | awk '{print $2}')
    curl -fsS -X POST "$ALERT_WEBHOOK_URL" -H 'Content-Type: application/json' \
      -H "X-Alert-Signature: $sig" -d "$payload" >/dev/null || true
  else
    curl -fsS -X POST "$ALERT_WEBHOOK_URL" -H 'Content-Type: application/json' \
      -d "$payload" >/dev/null || true
  fi
  echo "  ✓ backup_stale alert dispatched (routing: page)"
}

alert_and_fail() {
  local reason="$1"
  echo ""
  echo "🚨 [BACKUP STALE ALERT] $reason"
  echo "   SLA: ${SLA_HOURS}h | runbook: docs/runbooks/backup-restore-drill.md"
  echo "   Untested/stale backups mean RPO claims are unfounded — see the runbook."
  dispatch_alert
  echo ""
  echo "❌ Backup freshness check FAILED."
  exit 1
}

if [[ -z "$LATEST_TS" ]]; then
  alert_and_fail "No daily backup found (missing entirely, or status file reports none)."
fi

LAST_EPOCH=$(date -u -d "$LATEST_TS" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$LATEST_TS" +%s 2>/dev/null || echo 0)
if [[ "$LAST_EPOCH" == "0" ]]; then
  alert_and_fail "Could not parse latest backup timestamp: $LATEST_TS"
fi

AGE_HOURS=$(( (NOW_EPOCH - LAST_EPOCH) / 3600 ))

if (( AGE_HOURS > SLA_HOURS )); then
  alert_and_fail "Latest backup is ${AGE_HOURS}h old (last: $LATEST_TS, SLA: ${SLA_HOURS}h)."
fi

echo "  ✓ Latest backup: $LATEST_TS (${AGE_HOURS}h old, SLA ${SLA_HOURS}h)"
echo ""
echo "✅ Backup freshness check passed."
exit 0
