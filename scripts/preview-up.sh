#!/usr/bin/env bash
# preview-up.sh — Start an isolated per-PR preview stack (backend + postgres
# + redis) with the staging seed subset, per docs/preview-environments.md.
#
# Usage:
#   PREVIEW_PR_NUMBER=123 ./scripts/preview-up.sh [--reset] [--skip-seed]
#
# Required env:
#   PREVIEW_PR_NUMBER   — PR number; scopes COMPOSE_PROJECT_NAME so concurrent
#                         previews never share containers/volumes/ports.
#
# Optional env (defaults shown):
#   PREVIEW_PORT=4001  PREVIEW_POSTGRES_PORT=5435  PREVIEW_REDIS_PORT=6382
#
# Exit codes:
#   0 — stack healthy and seeded
#   1 — startup/seed failure
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$ROOT_DIR/backend"

RESET=false
SKIP_SEED=false
for arg in "$@"; do
  case "$arg" in
    --reset)     RESET=true ;;
    --skip-seed) SKIP_SEED=true ;;
  esac
done

: "${PREVIEW_PR_NUMBER:?PREVIEW_PR_NUMBER is required (scopes the compose project)}"

export COMPOSE_PROJECT_NAME="eziagric-pr-${PREVIEW_PR_NUMBER}"
export PREVIEW_PORT="${PREVIEW_PORT:-4001}"
export PREVIEW_POSTGRES_PORT="${PREVIEW_POSTGRES_PORT:-5435}"
export PREVIEW_REDIS_PORT="${PREVIEW_REDIS_PORT:-6382}"

PREVIEW_DB_URL="postgresql://postgres:preview-password@localhost:${PREVIEW_POSTGRES_PORT}/amana_preview"
export DATABASE_URL="$PREVIEW_DB_URL"

cd "$ROOT_DIR"

if [[ "$RESET" == "true" ]]; then
  echo "→ Resetting preview stack ${COMPOSE_PROJECT_NAME}..."
  docker compose --profile preview down -v --remove-orphans
fi

echo "→ Starting preview stack (${COMPOSE_PROJECT_NAME})..."
docker compose --profile preview build backend-preview
docker compose --profile preview up -d

echo "→ Waiting for postgres-preview..."
until docker compose exec -T postgres-preview pg_isready -U postgres -q; do
  sleep 1
done

echo "→ Waiting for backend-preview (/health/ready)..."
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:${PREVIEW_PORT}/health/ready" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
if ! curl -fsS "http://localhost:${PREVIEW_PORT}/health/ready" >/dev/null 2>&1; then
  echo "❌ backend-preview never became ready" >&2
  docker compose --profile preview logs backend-preview | tail -n 100 >&2 || true
  exit 1
fi

echo "→ Running migrations against preview DB..."
cd "$BACKEND_DIR"
npx prisma migrate deploy

if [[ "$SKIP_SEED" == "false" ]]; then
  echo "→ Seeding preview data subset (seed.staging.ts)..."
  npx tsx prisma/seed.staging.ts
fi

cd "$ROOT_DIR"
echo ""
echo "✓ Preview stack is up!"
echo "  Backend  : http://localhost:${PREVIEW_PORT}"
echo "  Postgres : localhost:${PREVIEW_POSTGRES_PORT}  (db: amana_preview)"
echo "  Redis    : localhost:${PREVIEW_REDIS_PORT}"
