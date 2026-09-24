#!/usr/bin/env bash
# backup-restore-drill.sh — Automated backup restore drill (issue #266).
#
# Restores the LATEST backup into an ISOLATED environment (compose `test`
# profile — tmpfs postgres + redis, separate project name), asserts integrity
# (manifest sha256 + per-table row counts), boots the application against the
# restored copy and serves read traffic, measures RTO against target, and
# publishes a timing report (backup-drills/). This is the quarterly drill —
# an untested backup is not a backup.
#
# Usage:
#   S3_BUCKET=... GPG_RECIPIENT=... ./scripts/backup-restore-drill.sh
#   ./scripts/backup-restore-drill.sh --key backups/daily/amana-daily-....sql.gz.gpg
#   ./scripts/backup-restore-drill.sh --skip-app        # integrity+restore only
#   ./scripts/backup-restore-drill.sh --exercise-restore-script
#
# Required env (S3 access, same as db-backup.sh/db-restore.sh):
#   S3_BUCKET, GPG access to decrypt, AWS credentials
# Optional env:
#   BACKUP_TYPE=daily            which bucket prefix to drill (default daily)
#   RTO_TARGET_MINUTES=30        RTO target recorded in the report
#   DRILL_APP_PORT=4010          host port for the drill backend
#   REPORT_DIR=backup-drills     where reports/history are written
#
# Flags:
#   --key <s3-object-key>          drill a specific backup instead of latest
#   --skip-app                     skip the application boot smoke
#   --exercise-restore-script      restore via scripts/db-restore.sh
#                                  (rehearses the production restore path)
#                                  instead of the verified local dump
#
# Exit codes:
#   0 — restore + integrity + app smoke green, RTO recorded
#   1 — any drill step failed (findings must be filed)
#   2 — usage / preflight error
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BACKUP_TYPE="${BACKUP_TYPE:-daily}"
RTO_TARGET_MINUTES="${RTO_TARGET_MINUTES:-30}"
DRILL_APP_PORT="${DRILL_APP_PORT:-4010}"
REPORT_DIR_REL="${REPORT_DIR:-backup-drills}"
REPORT_DIR="$ROOT_DIR/$REPORT_DIR_REL"
SPECIFIC_KEY=""
SKIP_APP=false
EXERCISE_RESTORE_SCRIPT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --key) SPECIFIC_KEY="${2:?}"; shift 2 ;;
    --key=*) SPECIFIC_KEY="${1#*=}"; shift ;;
    --skip-app) SKIP_APP=true; shift ;;
    --exercise-restore-script) EXERCISE_RESTORE_SCRIPT=true; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-amana-drill}"

DRILL_DB_URL="postgresql://postgres:password@localhost:5433/amana_test"
DRILL_REDIS_URL="redis://localhost:6381"
STEPS_JSON=""
PASS=0
FAIL=0
DRILL_START_EPOCH=$(date -u +%s)
RTO_SECONDS=0
APP_READY=false

if [[ -f "$ROOT_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  set -o allexport; source "$ROOT_DIR/.env"; set +o allexport
fi

: "${S3_BUCKET:?S3_BUCKET is required}"
S3_PREFIX="${S3_PREFIX:-backups}"
AWS_ARGS=()
[[ -n "${S3_ENDPOINT:-}" ]] && AWS_ARGS+=(--endpoint-url "$S3_ENDPOINT")

step_ok()   { echo "  ✓ $1"; ((PASS++)) || true; }
step_fail() { echo "  ✗ $1"; ((FAIL++)) || true; }

record_step() {
  local name="$1" ms="$2" ok="$3"
  local entry
  entry=$(printf '{"step":"%s","ms":%s,"ok":%s}' "$name" "$ms" "$ok")
  if [[ -z "$STEPS_JSON" ]]; then
    STEPS_JSON="$entry"
  else
    STEPS_JSON+=",$entry"
  fi
}

cleanup() {
  echo ""
  echo "[cleanup] Tearing down drill stack (${COMPOSE_PROJECT_NAME})..."
  docker compose -f "$ROOT_DIR/docker-compose.yml" --profile test down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f amana-drill-backend >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Amana — Backup Restore Drill"
echo "═══════════════════════════════════════════════════════════════"
echo "  Type   : $BACKUP_TYPE"
echo "  RTO tgt: ${RTO_TARGET_MINUTES}m"
echo "  Project: $COMPOSE_PROJECT_NAME"
echo ""

# ── [1] Resolve latest backup + manifest ─────────────────────────────────────
echo "[1/7] Resolve latest backup + integrity manifest"
T_STEP=$(date -u +%s%3N 2>/dev/null || date -u +%s000)
if [[ -n "$SPECIFIC_KEY" ]]; then
  S3_KEY="$SPECIFIC_KEY"
else
  S3_KEY=$(aws "${AWS_ARGS[@]}" s3 ls "s3://$S3_BUCKET/$S3_PREFIX/$BACKUP_TYPE/" 2>/dev/null \
    | awk '{print $4}' | grep '^amana-' | sort | tail -n 1 || true)
  [[ -n "$S3_KEY" ]] || S3_KEY=""
  [[ -n "$S3_KEY" ]] && S3_KEY="$S3_PREFIX/$BACKUP_TYPE/$S3_KEY"
fi

if [[ -z "$S3_KEY" ]]; then
  step_fail "No backup found at s3://$S3_BUCKET/$S3_PREFIX/$BACKUP_TYPE/"
  echo "❌ Drill FAILED at resolve — no backups exist to drill. See docs/runbooks/backup-restore-drill.md."
  exit 1
fi
step_ok "Latest backup: s3://$S3_BUCKET/$S3_KEY"
record_step "resolve-backup" "$(( $(date -u +%s%3N 2>/dev/null || date -u +%s000) - T_STEP ))" true

TMPDIR_DRILL="$(mktemp -d)"
MANIFEST="$TMPDIR_DRILL/manifest.json"
HAVE_MANIFEST=false
if aws "${AWS_ARGS[@]}" s3 cp "s3://$S3_BUCKET/$S3_KEY.manifest.json" "$MANIFEST" >/dev/null 2>&1; then
  HAVE_MANIFEST=true
  step_ok "Manifest downloaded"
else
  step_ok "No manifest alongside backup (legacy) — integrity falls back to schema/count sanity"
fi

# ── [2] Isolated restore target ──────────────────────────────────────────────
echo ""
echo "[2/7] Start isolated drill stack (compose test profile, tmpfs)"
T_STEP=$(date -u +%s%3N 2>/dev/null || date -u +%s000)
cd "$ROOT_DIR"
if docker compose --profile test up -d; then
  until docker compose exec -T postgres-test pg_isready -U postgres -q; do sleep 1; done
  step_ok "postgres-test + redis-test ready (isolated, tmpfs)"
else
  step_fail "Could not start drill stack"
  record_step "start-stack" 0 false
  echo "❌ Drill FAILED — cannot start the isolated environment."
  exit 1
fi
record_step "start-stack" "$(( $(date -u +%s%3N 2>/dev/null || date -u +%s000) - T_STEP ))" true

# ── [3] Download + decrypt + checksum ────────────────────────────────────────
echo ""
echo "[3/7] Download + decrypt + integrity checks"
T_STEP=$(date -u +%s%3N 2>/dev/null || date -u +%s000)
ENCRYPTED="$TMPDIR_DRILL/backup.sql.gz.gpg"
PLAIN="$TMPDIR_DRILL/backup.sql.gz"
aws "${AWS_ARGS[@]}" s3 cp "s3://$S3_BUCKET/$S3_KEY" "$ENCRYPTED" >/dev/null
gpg --batch --yes --output "$PLAIN" --decrypt "$ENCRYPTED" >/dev/null 2>&1
step_ok "Backup downloaded and decrypted"

CHECKSUM_OK=true
if [[ "$HAVE_MANIFEST" == "true" ]] && command -v jq &>/dev/null; then
  EXPECTED_SHA=$(jq -r '.sha256 // empty' "$MANIFEST")
  ACTUAL_SHA=$(sha256sum "$PLAIN" | awk '{print $1}')
  if [[ -n "$EXPECTED_SHA" && "$EXPECTED_SHA" == "$ACTUAL_SHA" ]]; then
    step_ok "sha256 matches manifest"
  else
    step_fail "sha256 MISMATCH (expected ${EXPECTED_SHA:-none}, got $ACTUAL_SHA)"
    CHECKSUM_OK=false
  fi
fi
record_step "download-decrypt-checksum" "$(( $(date -u +%s%3N 2>/dev/null || date -u +%s000) - T_STEP ))" "$CHECKSUM_OK"

# ── [4] Restore ──────────────────────────────────────────────────────────────
echo ""
echo "[4/7] Restore into isolated drill DB"
T_STEP=$(date -u +%s%3N 2>/dev/null || date -u +%s000)
RESTORE_OK=true
if [[ "$EXERCISE_RESTORE_SCRIPT" == "true" ]]; then
  if DATABASE_URL="$DRILL_DB_URL" "$ROOT_DIR/scripts/db-restore.sh" --key "$S3_KEY"; then
    step_ok "Restored via scripts/db-restore.sh (production restore path rehearsed)"
  else
    step_fail "db-restore.sh failed"
    RESTORE_OK=false
  fi
else
  if gunzip -c "$PLAIN" | psql "$DRILL_DB_URL" >/dev/null 2>&1; then
    step_ok "Restored from verified local dump"
  else
    step_fail "psql restore failed"
    RESTORE_OK=false
  fi
fi
record_step "restore" "$(( $(date -u +%s%3N 2>/dev/null || date -u +%s000) - T_STEP ))" "$RESTORE_OK"
if [[ "$RESTORE_OK" != "true" ]]; then
  echo "❌ Drill FAILED at restore. File findings per docs/runbooks/backup-restore-drill.md."
  exit 1
fi

# ── [5] Integrity assertions ─────────────────────────────────────────────────
echo ""
echo "[5/7] Integrity assertions (row counts + schema)"
T_STEP=$(date -u +%s%3N 2>/dev/null || date -u +%s000)
INTEGRITY_OK=true
MISMATCHES=0
TABLES_CHECKED=0

for core in User Trade Dispute; do
  EXIST=$(psql "$DRILL_DB_URL" -At -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_name='$core'")
  if [[ "$EXIST" == "1" ]]; then
    step_ok "Table $core exists in restored copy"
  else
    step_fail "Table $core missing in restored copy"
    INTEGRITY_OK=false
  fi
done

if [[ "$HAVE_MANIFEST" == "true" ]] && command -v jq &>/dev/null; then
  while IFS=$'\t' read -r TBL EXPECTED; do
    [[ -z "$TBL" ]] && continue
    [[ "$EXPECTED" == "-1" ]] && continue
    TABLES_CHECKED=$((TABLES_CHECKED + 1))
    ACTUAL=$(psql "$DRILL_DB_URL" -At -c "SELECT COUNT(*) FROM \"$TBL\"" 2>/dev/null || echo "-1")
    if [[ "$ACTUAL" == "$EXPECTED" ]]; then
      :
    else
      MISMATCHES=$((MISMATCHES + 1))
      step_fail "Row count mismatch on $TBL (manifest=$EXPECTED restored=$ACTUAL)"
      INTEGRITY_OK=false
    fi
  done < <(jq -r '.rowCounts | to_entries[] | [.key, (.value|tostring)] | @tsv' "$MANIFEST")
  if [[ $MISMATCHES -eq 0 ]]; then
    step_ok "All $TABLES_CHECKED manifest row counts match the restored copy"
  fi
else
  # Legacy backup: basic non-empty sanity on core tables.
  for core in "User" "Trade"; do
    C=$(psql "$DRILL_DB_URL" -At -c "SELECT COUNT(*) FROM \"$core\"" 2>/dev/null || echo "-1")
    if [[ "$C" =~ ^[0-9]+$ ]] && [[ "$C" -ge 1 ]]; then
      step_ok "$core has $C rows (sanity)"
    else
      step_fail "$core unreadable or empty in restored copy"
      INTEGRITY_OK=false
    fi
  done
fi
record_step "integrity" "$(( $(date -u +%s%3N 2>/dev/null || date -u +%s000) - T_STEP ))" "$INTEGRITY_OK"

# ── [6] Application smoke against restored copy ──────────────────────────────
echo ""
echo "[6/7] Boot application against restored copy + serve read traffic"
T_STEP=$(date -u +%s%3N 2>/dev/null || date -u +%s000)
if [[ "$SKIP_APP" == "true" ]]; then
  step_ok "Skipped (--skip-app) — RTO will reflect restore-only"
else
  docker build -t amana-drill-backend:latest "$ROOT_DIR/backend" >/dev/null
  docker run -d --name amana-drill-backend \
    --network "${COMPOSE_PROJECT_NAME}_default" \
    -p "${DRILL_APP_PORT}:4000" \
    -e NODE_ENV=staging \
    -e PORT=4000 \
    -e DATABASE_URL="postgresql://postgres:password@postgres-test:5432/amana_test" \
    -e REDIS_URL="redis://redis-test:6379" \
    -e JWT_SECRET="drill-jwt-secret-minimum-32-characters-xxx" \
    -e AMANA_ESCROW_CONTRACT_ID="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC" \
    -e USDC_CONTRACT_ID="CBIELTK6YBZJU5UP2WWQEUCY7PUJE7R6OB3NIUJKL5UH4WJQJ6HVHKX" \
    -e ADMIN_ROUTES_ENABLED=true \
    amana-drill-backend:latest >/dev/null

  for _ in $(seq 1 60); do
    if curl -fsS "http://localhost:${DRILL_APP_PORT}/health/ready" >/dev/null 2>&1; then
      APP_READY=true
      break
    fi
    sleep 2
  done

  if [[ "$APP_READY" == "true" ]]; then
    step_ok "Application booted; /health/ready (DB=restored copy) is green"
    RTO_SECONDS=$(( $(date -u +%s) - DRILL_START_EPOCH ))
    # Read traffic served from the restored copy (DoD).
    READ_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${DRILL_APP_PORT}/health/detail" || echo "000")
    if [[ "$READ_CODE" == "200" ]]; then
      step_ok "Read traffic served from restored copy (GET /health/detail → 200 in ${RTO_SECONDS}s)"
    else
      step_fail "Read traffic failed (GET /health/detail → $READ_CODE)"
    fi
    if STAGING_URL="http://localhost:${DRILL_APP_PORT}" "$ROOT_DIR/scripts/staging-admin-smoke-test.sh"; then
      step_ok "Admin smoke journey passed against restored copy"
    else
      step_fail "Admin smoke journey failed against restored copy"
    fi
  else
    step_fail "Application never became ready against the restored copy"
    docker logs amana-drill-backend --tail 50 || true
  fi
fi
record_step "app-smoke" "$(( $(date -u +%s%3N 2>/dev/null || date -u +%s000) - T_STEP ))" "$APP_READY"
if [[ "$SKIP_APP" == "true" ]]; then
  RTO_SECONDS=$(( $(date -u +%s) - DRILL_START_EPOCH ))
fi

# ── [7] RTO report ───────────────────────────────────────────────────────────
echo ""
echo "[7/7] Publish timing report"
TARGET_SECONDS=$((RTO_TARGET_MINUTES * 60))
WITHIN_TARGET=false
if (( RTO_SECONDS <= TARGET_SECONDS )); then WITHIN_TARGET=true; fi

mkdir -p "$REPORT_DIR"
TS_UTC=$(date -u +%Y%m%dT%H%M%SZ)
REPORT_FILE="$REPORT_DIR/drill-report-$TS_UTC.json"
HISTORY_FILE="$REPORT_DIR/rto-history.jsonl"
DRILL_OK=false
[[ $FAIL -eq 0 && "$APP_READY" == "true" ]] && DRILL_OK=true
[[ $FAIL -eq 0 && "$SKIP_APP" == "true" ]] && DRILL_OK=true

cat > "$REPORT_FILE" <<EOF
{
  "ts": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "backupKey": "$S3_KEY",
  "backupType": "$BACKUP_TYPE",
  "rtoSeconds": $RTO_SECONDS,
  "rtoTargetSeconds": $TARGET_SECONDS,
  "withinTarget": $WITHIN_TARGET,
  "drillOk": $DRILL_OK,
  "integrity": { "manifest": $HAVE_MANIFEST, "tablesChecked": $TABLES_CHECKED, "mismatches": $MISMATCHES },
  "appServedReadTraffic": $APP_READY,
  "passed": $PASS,
  "failed": $FAIL,
  "steps": [${STEPS_JSON}]
}
EOF

printf '{"ts":"%s","rtoSeconds":%s,"targetSeconds":%s,"withinTarget":%s,"drillOk":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RTO_SECONDS" "$TARGET_SECONDS" \
  "$WITHIN_TARGET" "$DRILL_OK" >> "$HISTORY_FILE"

echo "  Report : $REPORT_FILE"
echo "  History: $HISTORY_FILE"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "## Backup Restore Drill — $TS_UTC"
    echo "| Metric | Value |"
    echo "| --- | --- |"
    echo "| Backup | \`$S3_KEY\` |"
    echo "| RTO | **${RTO_SECONDS}s** (target ${TARGET_SECONDS}s) |"
    echo "| Within target | $([[ "$WITHIN_TARGET" == "true" ]] && echo '✅ yes' || echo '❌ no') |"
    echo "| Integrity | $([[ "$MISMATCHES" -eq 0 ]] && echo '✅' || echo '❌') ($TABLES_CHECKED tables vs manifest) |"
    echo "| App served reads | $([[ "$APP_READY" == "true" ]] && echo '✅' || echo '⏭️ skipped') |"
    echo "| Checks | $PASS passed / $FAIL failed |"
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed | RTO ${RTO_SECONDS}s / target ${TARGET_SECONDS}s"
echo "═══════════════════════════════════════════════════════════════"

if [[ $FAIL -gt 0 ]]; then
  echo "❌ Drill FAILED — file findings per docs/runbooks/backup-restore-drill.md (critical ones fixed before sign-off)."
  exit 1
fi
if [[ "$WITHIN_TARGET" != "true" ]]; then
  echo "⚠️  Drill green but RTO ${RTO_SECONDS}s exceeded target ${TARGET_SECONDS}s — track in $HISTORY_FILE."
fi
echo "✅ Backup restore drill passed."
exit 0
