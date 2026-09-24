#!/usr/bin/env bash
# test-compose-profiles.sh — Validates docker-compose.yml structure for every
# profile without starting containers (docs/docker-profiles.md § Validating
# Profile Config). Asserts each expected service is attached to its profile
# and that host ports don't collide across profiles.
#
# Usage:
#   ./scripts/test-compose-profiles.sh
#
# Exit codes:
#   0 — all profile assertions passed
#   1 — one or more assertions failed
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"

PASS=0
FAIL=0

check() {
  local label="$1"
  local condition="$2"
  if eval "$condition"; then
    echo "  ✓ $label"
    ((PASS++)) || true
  else
    echo "  ✗ $label"
    ((FAIL++)) || true
  fi
}

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker is required to validate compose profiles."
  exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Amana — Docker Compose Profile Validation"
echo "═══════════════════════════════════════════════════════════════"

for profile in dev staging test preview; do
  echo ""
  echo "[$profile] docker compose --profile $profile config"
  if docker compose -f "$COMPOSE_FILE" --profile "$profile" config >/dev/null 2>&1; then
    echo "  ✓ config is valid"
    ((PASS++)) || true
  else
    echo "  ✗ config failed to render"
    ((FAIL++)) || true
    continue
  fi
done

echo ""
echo "[service ↔ profile mapping]"
has_service() {
  local profile="$1" service="$2"
  docker compose -f "$COMPOSE_FILE" --profile "$profile" config --services 2>/dev/null \
    | grep -qx "$service"
}
check "dev has postgres"        "has_service dev postgres"
check "dev has redis"           "has_service dev redis"
check "staging has postgres-staging" "has_service staging postgres-staging"
check "staging has redis-staging"    "has_service staging redis-staging"
check "test has postgres-test"  "has_service test postgres-test"
check "test has redis-test"     "has_service test redis-test"
check "preview has backend-preview"  "has_service preview backend-preview"
check "preview has postgres-preview" "has_service preview postgres-preview"
check "preview has redis-preview"    "has_service preview redis-preview"

echo ""
echo "[host port uniqueness]"
rendered=$(docker compose -f "$COMPOSE_FILE" --profile dev --profile staging --profile test --profile preview config 2>/dev/null || true)
port_count=$(echo "$rendered" | grep -E 'published:' | awk '{print $2}' | sort | uniq -d | wc -l | tr -d ' ')
check "no duplicated published ports across profiles" "[[ \"$port_count\" == \"0\" ]]"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════════════════════════"
if [[ $FAIL -gt 0 ]]; then
  echo "❌ Compose profile validation FAILED."
  exit 1
fi
echo "✅ All compose profile checks passed."
