#!/usr/bin/env bash
# preview-down.sh — Teardown for a per-PR preview stack (issue #264).
# Always safe to run; verifies no orphaned containers remain for the project.
#
# Usage:
#   PREVIEW_PR_NUMBER=123 ./scripts/preview-down.sh
#
# Exit codes:
#   0 — torn down, no orphans
#   1 — orphaned resources remain (teardown verification failed)
set -euo pipefail

: "${PREVIEW_PR_NUMBER:?PREVIEW_PR_NUMBER is required}"
export COMPOSE_PROJECT_NAME="eziagric-pr-${PREVIEW_PR_NUMBER}"

cd "$(dirname "$0")/.."

echo "→ Tearing down preview stack ${COMPOSE_PROJECT_NAME}..."
docker compose --profile preview down -v --remove-orphans

ORPHANS=$(docker ps -aq --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" 2>/dev/null || true)
VOLUMES=$(docker volume ls -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" 2>/dev/null || true)

if [[ -n "$ORPHANS" || -n "$VOLUMES" ]]; then
  echo "❌ Teardown verification failed — orphaned resources remain:" >&2
  [[ -n "$ORPHANS" ]] && echo "  containers: $ORPHANS" >&2
  [[ -n "$VOLUMES" ]] && echo "  volumes: $VOLUMES" >&2
  exit 1
fi

echo "✓ Preview stack torn down; no orphaned containers or volumes."
