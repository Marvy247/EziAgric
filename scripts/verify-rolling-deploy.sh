#!/usr/bin/env bash
# verify-rolling-deploy.sh — Connection-draining verification under load
# during a rolling deploy (issue #265). Runs k6/rolling-deploy.js (strict
# http_req_failed rate==0) across a live rollout and fails if ANY request
# errors.
#
# Usage:
#   BASE_URL=https://staging.example.com \
#   ./scripts/verify-rolling-deploy.sh
#
#   ROLLOUT_CMD="kubectl rollout restart deployment/backend" \
#   BASE_URL=https://api.example.com \
#   ./scripts/verify-rolling-deploy.sh
#
# Env:
#   BASE_URL       — target behind the load balancer (required)
#   ROLLOUT_CMD    — command that starts the rollout. Default:
#                    kubectl rollout restart deployment/backend
#                    (set MODE=manual to skip triggering and use an already
#                    running rollout, e.g. a compose recreate you started)
#   MODE           — kubectl | manual (default kubectl when kubectl exists)
#   READINESS_URL  — defaults to $BASE_URL/health/ready
#   READY_CONSECUTIVE — consecutive 200s required (default 3)
#   ROLLOUT_TIMEOUT_S — max seconds to wait for readiness (default 180)
#   K6_BIN         — k6 binary (default: k6)
#
# Exit codes:
#   0 — rollout completed with zero failed requests
#   1 — failed requests observed, readiness never recovered, or preflight failed
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${BASE_URL:?BASE_URL is required (behind the load balancer)}"
READINESS_URL="${READINESS_URL:-$BASE_URL/health/ready}"
READY_CONSECUTIVE="${READY_CONSECUTIVE:-3}"
ROLLOUT_TIMEOUT_S="${ROLLOUT_TIMEOUT_S:-180}"
K6_BIN="${K6_BIN:-k6}"
MODE="${MODE:-}"
K6_RESULT_DIR="${K6_RESULT_DIR:-$(mktemp -d)}"

if [[ -z "$MODE" ]]; then
  if command -v kubectl >/dev/null 2>&1; then MODE=kubectl; else MODE=manual; fi
fi
if [[ "$MODE" == "kubectl" ]]; then
  ROLLOUT_CMD="${ROLLOUT_CMD:-kubectl rollout restart deployment/backend}"
fi

PASS=0
FAIL=0
step_ok()   { echo "  ✓ $1"; ((PASS++)) || true; }
step_fail() { echo "  ✗ $1"; ((FAIL++)) || true; }

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Amana — Rolling Deploy Drain Verification"
echo "═══════════════════════════════════════════════════════════════"
echo "  Target : $BASE_URL"
echo "  Mode   : $MODE"
echo ""

echo "[1/5] Preflight"
if ! command -v "$K6_BIN" >/dev/null 2>&1; then
  step_fail "k6 not found (install k6 or set K6_BIN)"
  echo "❌ Preflight failed — cannot verify drain under load."
  exit 1
fi
step_ok "k6 available ($K6_BIN)"

READY_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$READINESS_URL" || echo "000")
if [[ "$READY_CODE" == "200" ]]; then
  step_ok "readiness is 200 before rollout"
else
  step_fail "readiness returned $READY_CODE before rollout"
  echo "❌ Preflight failed — target not ready to start."
  exit 1
fi

echo ""
echo "[2/5] Start load (k6/rolling-deploy.js, http_req_failed rate==0)"
K6_LOG="$K6_RESULT_DIR/k6.log"
BASE_URL="$BASE_URL" "$K6_BIN" run "$ROOT_DIR/k6/rolling-deploy.js" \
  >"$K6_LOG" 2>&1 &
K6_PID=$!
trap 'kill "$K6_PID" 2>/dev/null || true' EXIT
step_ok "load generator running (pid $K6_PID)"
sleep 5

echo ""
echo "[3/5] Trigger rollout: $ROLLOUT_CMD"
if [[ "$MODE" == "manual" ]]; then
  echo "  (MODE=manual — assuming the rollout is already in progress)"
else
  if eval "$ROLLOUT_CMD"; then
    step_ok "rollout triggered"
  else
    step_fail "rollout command failed"
  fi
fi

echo ""
echo "[4/5] Wait for readiness recovery ($READY_CONSECUTIVE consecutive 200s, ≤${ROLLOUT_TIMEOUT_S}s)"
CONSECUTIVE=0
ELAPSED=0
while (( ELAPSED < ROLLOUT_TIMEOUT_S )); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$READINESS_URL" || echo "000")
  if [[ "$CODE" == "200" ]]; then
    CONSECUTIVE=$((CONSECUTIVE + 1))
  else
    CONSECUTIVE=0
  fi
  if (( CONSECUTIVE >= READY_CONSECUTIVE )); then
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done
if (( CONSECUTIVE >= READY_CONSECUTIVE )); then
  step_ok "readiness recovered after ${ELAPSED}s"
else
  step_fail "readiness did not recover within ${ROLLOUT_TIMEOUT_S}s"
fi

echo ""
echo "[5/5] Wait for load test to finish"
K6_EXIT=0
wait "$K6_PID" || K6_EXIT=$?
trap - EXIT
if [[ $K6_EXIT -eq 0 ]]; then
  step_ok "zero failed requests during rollout (k6 threshold http_req_failed rate==0 passed)"
else
  step_fail "k6 reported failed requests or an error during the rollout (exit $K6_EXIT)"
fi

echo ""
echo "───────── k6 tail ─────────"
tail -n 40 "$K6_LOG" || true
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════════════════════════"
if [[ $FAIL -gt 0 ]]; then
  echo "❌ Rolling deploy drain verification FAILED — requests were dropped."
  echo "   Follow docs/runbooks/rollback.md before continuing the rollout."
  exit 1
fi
echo "✅ Rolling deploy verified: zero failed requests while pods drained."
