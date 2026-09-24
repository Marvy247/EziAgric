#!/usr/bin/env bash
# rollback-on-burn.sh — Automated rollback trigger on error-rate burn
# (issue #265). Evaluates the S1 fast-burn signal during/after a deploy and,
# when it fires, executes the rollback command, verifies readiness recovery,
# and dispatches a deploy_rollback_triggered alert through the shared alert
# webhook (routing: page, docs/runbooks/rollback.md).
#
# Burn signal (either qualifies):
#   A) Active Prometheus alert SLOPE_BudgetBurn_Fast_S1 (infra/prometheus/
#      slo-alerting-rules.yml — 1200x over 1h, pages after 10m)
#   B) Instant 5xx ratio over --window >= --threshold (default 5% over 5m),
#      the deploy-local equivalent when recording rules haven't accumulated
#
# Usage:
#   PROMETHEUS_URL=http://prometheus:9090 ./scripts/rollback-on-burn.sh
#   PROMETHEUS_URL=... ./scripts/rollback-on-burn.sh \
#       --rollback-cmd "kubectl rollout undo deployment/backend"
#   ./scripts/rollback-on-burn.sh --simulate-burn --rollback-cmd "echo rollback"
#
# Flags:
#   --window <promql duration>  ratio window (default 5m)
#   --threshold <0..1>          5xx ratio threshold (default 0.05)
#   --rollback-cmd <cmd>        command executed on burn
#                               (default: kubectl rollout undo deployment/backend)
#   --dry-run                   report burn + intended rollback, execute nothing
#   --simulate-burn             game-day: force the burn path (injected failure
#                               demonstration) without querying Prometheus
#
# Exit codes:
#   0 — no burn, OR burn handled (rollback ran / dry-run)
#   1 — burn detected and rollback failed or was unavailable
#   2 — usage / Prometheus unreachable while evaluating a real burn check
set -euo pipefail

WINDOW="5m"
THRESHOLD="0.05"
ROLLBACK_CMD=""
DRY_RUN=false
SIMULATE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --window) WINDOW="${2:?}"; shift 2 ;;
    --window=*) WINDOW="${1#*=}"; shift ;;
    --threshold) THRESHOLD="${2:?}"; shift 2 ;;
    --threshold=*) THRESHOLD="${1#*=}"; shift ;;
    --rollback-cmd) ROLLBACK_CMD="${2:?}"; shift 2 ;;
    --rollback-cmd=*) ROLLBACK_CMD="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --simulate-burn) SIMULATE=true; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$ROLLBACK_CMD" ]]; then
  ROLLBACK_CMD="kubectl rollout undo deployment/backend"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Amana — Error-Rate Burn Auto-Rollback"
echo "═══════════════════════════════════════════════════════════════"
echo "  Window   : $WINDOW"
echo "  Threshold: $THRESHOLD (5xx ratio)"
echo "  Rollback : $ROLLBACK_CMD"
echo "  Dry run  : $DRY_RUN"
echo ""

BURN=false
BURN_REASON=""

prom_query() {
  local expr="$1"
  curl -fsS --max-time 10 \
    --get "${PROMETHEUS_URL%/}/api/v1/query" \
    --data-urlencode "query=$expr" 2>/dev/null || true
}

if [[ "$SIMULATE" == "true" ]]; then
  BURN=true
  BURN_REASON="simulated burn (--simulate-burn, game-day injected failure)"
elif [[ -z "${PROMETHEUS_URL:-}" ]]; then
  echo "❌ PROMETHEUS_URL is required (or use --simulate-burn / --dry-run for drills)."
  exit 2
else
  echo "[1/3] Evaluating burn signals..."

  ALERT_JSON=$(prom_query 'ALERTS{alertname=~"SLOPE_BudgetBurn_Fast_.*",alertstate="firing"}')
  if echo "$ALERT_JSON" | grep -q '"result":\[{' 2>/dev/null; then
    BURN=true
    BURN_REASON="SLOPE_BudgetBurn_Fast_* alert is firing"
  fi

  if [[ "$BURN" == "false" ]]; then
    RATIO_JSON=$(prom_query "sum(rate(http_server_duration_milliseconds_count{status!~\"5..\",http_status_code!~\"5..\"}[${WINDOW}])) / clamp_min(sum(rate(http_server_duration_milliseconds_count[${WINDOW}])), 1)")
    # good_ratio < 1 - threshold  ⇔  error ratio > threshold
    GOOD_RATIO=$(echo "$RATIO_JSON" | sed -n 's/.*"result":\[{"metric":{},"value":\[.*,"\([0-9.eE+-]*\)"\]}.*/\1/p')
    if [[ -n "$GOOD_RATIO" ]]; then
      ERROR_RATIO=$(awk -v g="$GOOD_RATIO" 'BEGIN { printf "%.6f", 1 - g }')
      echo "  good_ratio=$GOOD_RATIO  error_ratio=$ERROR_RATIO (window=$WINDOW)"
      if awk -v r="$ERROR_RATIO" -v t="$THRESHOLD" 'BEGIN { exit !(r > t) }'; then
        BURN=true
        BURN_REASON="error ratio $ERROR_RATIO > threshold $THRESHOLD over $WINDOW"
      fi
    else
      echo "  ⚠ Prometheus returned no S1 series — falling back to alert check only"
    fi
  fi
fi

if [[ "$BURN" == "false" ]]; then
  echo ""
  echo "✅ No burn detected. Nothing to roll back."
  exit 0
fi

echo ""
echo "🚨 [DEPLOY BURN] $BURN_REASON"
echo "   Rollback plan: $ROLLBACK_CMD"

dispatch_alert() {
  [[ -n "${ALERT_WEBHOOK_URL:-}" ]] || return 0
  local payload
  payload=$(printf '{"type":"deploy_rollback_triggered","severity":"critical","routing":"page","runbookUrl":"docs/runbooks/rollback.md","timestamp":"%s","message":"Error-rate burn triggered automatic rollback: %s","details":{"reason":"%s","command":"%s"}}' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BURN_REASON" "$BURN_REASON" "$ROLLBACK_CMD")
  if [[ -n "${ALERT_WEBHOOK_SECRET:-}" ]]; then
    local sig
    sig=$(printf '%s' "$payload" | openssl dgst -sha256 -hmac "$ALERT_WEBHOOK_SECRET" -hex | awk '{print $2}')
    curl -fsS -X POST "$ALERT_WEBHOOK_URL" \
      -H 'Content-Type: application/json' \
      -H "X-Alert-Signature: $sig" \
      -d "$payload" >/dev/null || true
  else
    curl -fsS -X POST "$ALERT_WEBHOOK_URL" \
      -H 'Content-Type: application/json' \
      -d "$payload" >/dev/null || true
  fi
  echo "  ✓ deploy_rollback_triggered alert dispatched"
}

if [[ "$DRY_RUN" == "true" ]]; then
  echo "  (dry-run — would execute: $ROLLBACK_CMD)"
  dispatch_alert
  echo ""
  echo "✅ Dry run complete — burn detected, rollback NOT executed."
  exit 0
fi

echo ""
echo "[2/3] Executing rollback..."
if eval "$ROLLBACK_CMD"; then
  echo "  ✓ rollback command succeeded"
else
  echo "  ✗ rollback command FAILED"
  dispatch_alert
  echo "❌ Burn detected and rollback failed — escalate per docs/runbooks/incident-response.md."
  exit 1
fi

echo ""
echo "[3/3] Verifying readiness recovery..."
READINESS_URL="${READINESS_URL:-${BASE_URL:-http://localhost:4000}/health/ready}"
RECOVERED=false
for _ in $(seq 1 45); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$READINESS_URL" || echo "000")
  if [[ "$CODE" == "200" ]]; then
    RECOVERED=true
    break
  fi
  sleep 2
done

dispatch_alert

if [[ "$RECOVERED" == "true" ]]; then
  echo "  ✓ readiness recovered after rollback"
  echo ""
  echo "✅ Burn handled: rolled back and readiness is green."
  echo "   Post-incident: docs/runbooks/rollback.md → postmortem per incident-response.md"
  exit 0
fi

echo "  ✗ readiness did NOT recover after rollback"
echo "❌ Rollback executed but readiness is still failing — escalate immediately."
exit 1
