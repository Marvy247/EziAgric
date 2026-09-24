#!/usr/bin/env bash
# preview-smoke.sh — E2E smoke against a per-PR preview environment
# (issue #264). Reuses the staging seed assertions + admin smoke journey so a
# preview is held to the same bar as staging.
#
# Usage:
#   PREVIEW_URL=http://localhost:4001 \
#   PREVIEW_DB_URL=postgresql://... \
#   ./scripts/preview-smoke.sh
#
# Exit codes:
#   0 — smoke passed
#   1 — smoke failed (blocks PR merge signal for the preview label)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PREVIEW_URL="${PREVIEW_URL:-http://localhost:4001}"
PREVIEW_DB_URL="${PREVIEW_DB_URL:-postgresql://postgres:preview-password@localhost:5435/amana_preview}"

echo "═══════════════════════════════════════════════════════════════"
echo "  Amana — Preview Environment Smoke"
echo "═══════════════════════════════════════════════════════════════"
echo "  URL : $PREVIEW_URL"
echo "  DB  : $PREVIEW_DB_URL"
echo ""

FAIL=0

echo "[1/3] Seed data assertions (staging-validate subset)..."
if STAGING_DATABASE_URL="$PREVIEW_DB_URL" \
   STAGING_URL="$PREVIEW_URL" \
   "$SCRIPT_DIR/staging-validate.sh"; then
  echo "  ✓ Seed/schema validation passed"
else
  echo "  ✗ Seed/schema validation failed"
  FAIL=1
fi

echo ""
echo "[2/3] Admin route smoke journey..."
if STAGING_URL="$PREVIEW_URL" "$SCRIPT_DIR/staging-admin-smoke-test.sh"; then
  echo "  ✓ Admin smoke journey passed"
else
  echo "  ✗ Admin smoke journey failed"
  FAIL=1
fi

echo ""
echo "[3/3] Readiness gate..."
READY_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$PREVIEW_URL/health/ready" || echo "000")
if [[ "$READY_CODE" == "200" ]]; then
  echo "  ✓ /health/ready returned 200"
else
  echo "  ✗ /health/ready returned $READY_CODE"
  FAIL=1
fi

echo ""
if [[ $FAIL -gt 0 ]]; then
  echo "❌ Preview smoke FAILED. Fix before relying on this preview."
  exit 1
fi
echo "✅ Preview smoke passed."
