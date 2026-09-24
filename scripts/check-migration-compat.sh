#!/usr/bin/env bash
# check-migration-compat.sh — PR-time backward-incompatible migration scanner
# (migration-rollback-playbook.md §2/§7, issue #265).
#
# Two tiers, mirroring the playbook's tables:
#   BLOCK  — destructive / backward-incompatible DDL (fails the check unless
#            the PR carries `migration:destructive-approved`)
#   WARN   — requires-care DDL (annotation only; needs a plan, not a block)
#
# Usage:
#   ./scripts/check-migration-compat.sh backend/prisma/migrations/**/migration.sql
#   ./scripts/check-migration-compat.sh --dir backend/prisma/migrations
#   ./scripts/check-migration-compat.sh --github-annotations <files...>
#
# Flags:
#   --dir <path>           scan every migration.sql under <path>
#   --github-annotations   emit ::error/::warning lines for PR annotations
#   --lock-file <path>     verify migration_lock.toml (default: backend/prisma/migration_lock.toml)
#
# Exit codes:
#   0 — no BLOCK-tier findings (warnings allowed)
#   1 — at least one BLOCK-tier finding
#   2 — usage error (no files to scan / lock file invalid)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

GITHUB_ANNOTATIONS=false
SCAN_DIR=""
LOCK_FILE="$ROOT_DIR/backend/prisma/migration_lock.toml"
FILES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) SCAN_DIR="${2:?--dir needs a path}"; shift 2 ;;
    --dir=*) SCAN_DIR="${1#*=}"; shift ;;
    --github-annotations) GITHUB_ANNOTATIONS=true; shift ;;
    --lock-file) LOCK_FILE="${2:?--lock-file needs a path}"; shift 2 ;;
    --lock-file=*) LOCK_FILE="${1#*=}"; shift ;;
    -h|--help)
      sed -n '2,22p' "$0"
      exit 0
      ;;
    -*) echo "Unknown flag: $1" >&2; exit 2 ;;
    *) FILES+=("$1"); shift ;;
  esac
done

if [[ -n "$SCAN_DIR" ]]; then
  while IFS= read -r f; do
    FILES+=("$f")
  done < <(find "$SCAN_DIR" -name 'migration.sql' -type f | sort)
fi

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "No migration.sql files to scan."
  exit 0
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Amana — Migration Backward-Compatibility Check"
echo "═══════════════════════════════════════════════════════════════"
echo "  Files: ${#FILES[@]}"

BLOCK_COUNT=0
WARN_COUNT=0

annotate() {
  local level="$1" title="$2" message="$3"
  if [[ "$GITHUB_ANNOTATIONS" == "true" ]]; then
    echo "::$level title=$title::$message"
  fi
}

scan_block() {
  local file="$1" pattern="$2" why="$3"
  if grep -Ein -m1 "$pattern" "$file" >/dev/null 2>&1; then
    local line
    line=$(grep -Ein -m1 "$pattern" "$file" | cut -c1-160)
    echo "  ✗ BLOCK: $file — $why"
    echo "      $line"
    annotate "error" "Backward-incompatible migration" "$file: $why ($line)"
    ((BLOCK_COUNT++)) || true
  fi
}

scan_warn() {
  local file="$1" pattern="$2" why="$3"
  if grep -Ein -m1 "$pattern" "$file" >/dev/null 2>&1; then
    local line
    line=$(grep -Ein -m1 "$pattern" "$file" | cut -c1-160)
    echo "  ⚠ WARN : $file — $why"
    echo "      $line"
    annotate "warning" "Migration needs care" "$file: $why ($line)"
    ((WARN_COUNT++)) || true
  fi
}

for file in "${FILES[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "  ✗ File not found: $file" >&2
    exit 2
  fi
  echo ""
  echo "Scanning $file"

  # ── BLOCK tier: playbook §2 "Destructive" + "Requires care" ops that break
  # running code the moment the migration commits (issue #265 DoD:
  # backward-incompatible attempt caught by review checklist tooling).
  scan_block "$file" 'DROP[[:space:]]+TABLE' \
    'DROP TABLE breaks running code — archive first, deploy code removal first'
  scan_block "$file" 'DROP[[:space:]]+(COLUMN|CONSTRAINT)' \
    'DROP COLUMN/CONSTRAINT breaks running code — expand/migrate/contract phase 3 only'
  scan_block "$file" 'TRUNCATE([[:space:]]|$)' \
    'TRUNCATE is destructive — emergency-only, backup first'
  scan_block "$file" 'ALTER[[:space:]]+TABLE[^;]*RENAME[[:space:]]+(TO|COLUMN)' \
    'Rename breaks code referencing the old name — two-phase expand/migrate/contract'
  scan_block "$file" 'ALTER[[:space:]]+(TABLE|COLUMN)[^;]*SET[[:space:]]+NOT[[:space:]]+NULL' \
    'NOT NULL without a backfill/default fails for existing rows — add DEFAULT, backfill, then tighten'
  scan_block "$file" 'ALTER[[:space:]]+COLUMN[^;]*TYPE' \
    'Column type change risks cast errors/data loss — use USING and expand/migrate/contract'

  # ── WARN tier: playbook §2 "Requires care"
  scan_warn "$file" 'ADD[[:space:]]+CONSTRAINT[^;]*UNIQUE' \
    'UNIQUE constraint fails if duplicates exist — dedupe in a prior migration'
  scan_warn "$file" 'CREATE[[:space:]]+UNIQUE[[:space:]]+INDEX' \
    'UNIQUE index fails if duplicates exist — dedupe first; prefer CONCURRENTLY in prod'
  scan_warn "$file" 'DROP[[:space:]]+INDEX' \
    'Dropping an index can regress query latency — verify with query-performance-review'
done

echo ""
echo "[lock file]"
if [[ -f "$LOCK_FILE" ]]; then
  if grep -Eq 'provider\s*=\s*"postgresql"' "$LOCK_FILE"; then
    echo "  ✓ migration_lock.toml declares provider = \"postgresql\""
  else
    echo "  ✗ migration_lock.toml does not declare provider = \"postgresql\""
    annotate "error" "migration_lock.toml" "provider must remain \"postgresql\""
    ((BLOCK_COUNT++)) || true
  fi
else
  echo "  ✗ migration_lock.toml not found at $LOCK_FILE"
  annotate "error" "migration_lock.toml" "missing at $LOCK_FILE"
  ((BLOCK_COUNT++)) || true
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Results: $BLOCK_COUNT block-tier, $WARN_COUNT warn-tier findings"
echo "═══════════════════════════════════════════════════════════════"

if [[ $BLOCK_COUNT -gt 0 ]]; then
  echo "❌ Backward-incompatible migration detected."
  echo "   Refactor to expand → migrate → contract (migration-rollback-playbook.md §2),"
  echo "   or get explicit approval via the migration:destructive-approved label."
  exit 1
fi

echo "✅ No backward-incompatible migration patterns found."
exit 0
