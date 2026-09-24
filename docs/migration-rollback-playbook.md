# Database Migration Safety & Rollback Playbook

This document covers how to safely apply Prisma migrations, detect destructive changes, and roll back when something goes wrong.

---

## 1. Everyday Migration Workflow

Always use `scripts/migrate-safe.sh` instead of running `prisma migrate deploy` directly. It adds pre-flight checks, a backward-compatibility scan, and an optional backup step.

```bash
# Staging
./scripts/migrate-safe.sh --env=staging

# Production (with backup + interactive confirm for destructive DDL)
./scripts/migrate-safe.sh --env=production

# Dry run — report what would happen without making changes
./scripts/migrate-safe.sh --env=staging --dry-run
```

### What the script checks

| Step | Check |
|------|-------|
| 1 | Database connectivity |
| 2 | List pending migrations (dry status) |
| 3 | Scan pending SQL for destructive DDL (`DROP`, `TRUNCATE`, `NOT NULL` without `DEFAULT`) |
| 4 | Create a `pg_dump` backup (production) or warn (non-production) |
| 5 | `prisma migrate deploy` |
| 6 | Post-migration status verification |

---

## 2. Backward-Compatibility Rules

### Safe operations (no rollout risk)
- Adding a nullable column
- Adding a new table
- Adding an index (`CREATE INDEX CONCURRENTLY` preferred in prod)
- Widening a `VARCHAR` limit

### Requires care
| Operation | Risk | Mitigation |
|-----------|------|-----------|
| `NOT NULL` column without default | Fails for existing rows | Add a `DEFAULT` or backfill first |
| Renaming a column | Breaks code that references old name | Use a two-phase deploy: add new column, migrate data, remove old column |
| Changing a column type | Data loss / cast errors | Use `USING` expression; test with production data volume |
| Adding a `UNIQUE` constraint | Fails if duplicates exist | Deduplicate data first in a separate migration |

### Destructive (requires maintenance window + rollback plan)
| Operation | Mitigation |
|-----------|-----------|
| `DROP COLUMN` | Ensure no code references column; deploy code first |
| `DROP TABLE` | Ensure no foreign key references; archive data if needed |
| `TRUNCATE` | Only in emergency data cleanup; always backup first |

### Expand → Migrate → Contract discipline

Every schema change ships in **three separately deployable phases** so that
at every commit both the previous and the next release of the application
run correctly against the same database — the property that makes rolling
deploys ([deployment.md](runbooks/deployment.md#backend-zero-downtime-rolling-deploy))
and instant rollback safe:

| Phase | What ships | Rollback story |
|---|---|---|
| **1. Expand** | Additive DDL only: new table, new nullable column, new index (`CONCURRENTLY` in prod). No existing shape changes. Old code ignores the new objects. | Redeploy previous code; DDL can stay (harmless) or be dropped later in a contract phase. |
| **2. Migrate** | Dual-write / backfill: application writes both old+new (feature-flagged), backfill historical rows, verify counts/checksums. Schema still readable by old code. | Turn the flag off; old path is intact. |
| **3. Contract** | Remove the old column/table/unique constraint **only after** no release in the rollback window still references it. | Previous release is no longer supported — this is the point of no return; schedule it for the end of the rollout window, never bundled with phase 1. |

Rules of thumb:

- **One phase per PR.** `migration-check.yml` blocks phase-3 DDL
  (`DROP`/`RENAME`/`SET NOT NULL`/type changes) on PRs to `main` unless the
  PR carries `migration:destructive-approved` — so a rename smuggled into an
  "add a column" PR fails CI, not staging.
- Phase 3 PRs must state which releases still reference the old shape
  (usually: "everything older than the previous production release").
- Feature flags are the application half of expand/migrate: flip
  `rolloutPercentage` only while both paths are still written.

---

## 3. Writing a Rollback SQL File

Prisma does not support automatic down-migrations. For each migration that is not trivially reversible, create a companion `rollback.sql` in the same migration directory:

```
backend/prisma/migrations/
  20260424000001_add_foo_column/
    migration.sql      ← prisma-generated, applies the change
    rollback.sql       ← hand-written, undoes the change
```

**Example:**

`migration.sql` (generated):
```sql
ALTER TABLE "Trade" ADD COLUMN "fooBar" TEXT;
```

`rollback.sql` (hand-written):
```sql
ALTER TABLE "Trade" DROP COLUMN IF EXISTS "fooBar";
```

Keep rollback SQL minimal and tested. Run it against a staging clone before recording the playbook.

---

## 4. Rollback Procedures

### Scenario A — Migration failed mid-run

Prisma wraps each migration in a transaction. If the migration fails, the transaction is rolled back automatically. The migration is left in a "failed" state in `_prisma_migrations`.

```bash
# Inspect state
DATABASE_URL=<url> npx prisma migrate status

# If safe to retry after fixing the SQL:
./scripts/migrate-safe.sh --env=staging

# If you need to mark it as rolled back without reapplying:
./scripts/migrate-rollback.sh --env=staging --mark-rolled-back=<migration_name>
```

### Scenario B — Migration succeeded but broke the application

Use the companion `rollback.sql` if one exists:

```bash
./scripts/migrate-rollback.sh --env=staging \
  --from-sql=backend/prisma/migrations/<name>/rollback.sql
```

For production, coordinate with on-call before running. This modifies the live schema.

### Scenario C — Catastrophic failure (restore from backup)

```bash
./scripts/migrate-rollback.sh --env=production \
  --from-backup=backups/pre-migration-20260424-120000.sql.gz
```

> **Warning:** This drops and recreates the database. All rows inserted after the backup point will be lost. Only use this as a last resort.

After restoring:
1. Confirm application is healthy.
2. Mark the failed migration as rolled back: `./scripts/migrate-rollback.sh --mark-rolled-back=<name>`.
3. File a post-mortem.

---

## 5. Pre-production Checklist

Before applying any migration to production:

- [ ] Migration applied and validated on staging (`./scripts/migrate-safe.sh --env=staging`)
- [ ] Staging validation passes (`./scripts/staging-validate.sh`)
- [ ] Rollback SQL written and tested on staging
- [ ] Pre-migration backup taken (`backups/` directory)
- [ ] No destructive DDL without maintenance window scheduled
- [ ] Application code deployed / feature-flagged to tolerate both old and new schema (if blue-green)
- [ ] On-call engineer notified
- [ ] Post-migration smoke test plan ready

---

## 6. Backup Strategy

| Environment | When | Tool | Retention |
|-------------|------|------|-----------|
| Staging | Before every migration | `pg_dump` via `migrate-safe.sh` | 7 days |
| Production | Before every migration + daily | Managed cloud backup + `pg_dump` (`scripts/db-backup.sh`) | 30 days |

Backups are stored in `backups/` locally (staging) and in encrypted cloud
storage (production). The `backups/` directory is in `.gitignore`.

Production backups uploaded by `scripts/db-backup.sh` carry an integrity
manifest (`<backup-key>.manifest.json`: sha256 of the dump + per-table row
counts) used by restore drills.

**Backups are only trusted once restored.** Issue #266 automates both halves:

- **Freshness gate** (weekly + pre-deploy): `scripts/check-backup-freshness.sh`
  fails (and pages `backup_stale`) when the latest daily backup is missing or
  older than `BACKUP_SLA_HOURS` (default 26h). `--simulate-gap` is the
  controlled-gap validation of that alert.
- **Restore drill** (quarterly): `scripts/backup-restore-drill.sh` restores the
  latest backup into an isolated compose `test` stack, asserts manifest
  integrity, boots the application against the restored copy, serves read
  traffic, and records RTO vs `RTO_TARGET_MINUTES` under `backup-drills/`.

Full procedure, failure modes, and the quarterly sign-off checklist:
[runbooks/backup-restore-drill.md](runbooks/backup-restore-drill.md).

---

## 7. CI Migration Check

The CI workflow [`.github/workflows/migration-check.yml`](../.github/workflows/migration-check.yml)
runs on every PR that touches `backend/prisma/`:

- Lists the migration diff versus the PR base branch
- Scans new migration SQL for backward-incompatible DDL via
  [`scripts/check-migration-compat.sh`](../scripts/check-migration-compat.sh)
  (BLOCK tier: `DROP`, `TRUNCATE`, renames, `SET NOT NULL`, column type
  changes; WARN tier: unique constraints/indexes) and emits PR annotations
- Verifies `migration_lock.toml` is present and still declares the
  `postgresql` provider

Failures block merge for production branches (`main`) unless the approval
label applies (§8).

---

## 8. Contacts and Escalation

| Situation | Action |
|-----------|--------|
| Failed migration on staging | Fix SQL, re-run `migrate-safe.sh`, or rollback |
| Failed migration on production | Page on-call immediately; execute Scenario B or C above |
| Data loss suspected | Stop writes; page on-call; do NOT run any more migrations |

### CI approval policy for risky DDL

- PRs with risky DDL always receive a CI warning comment with remediation steps.
- For PRs targeting `main`, risky DDL fails the migration safety workflow unless the PR has the `migration:destructive-approved` label.
- Apply the label only after explicit DBA/on-call review, a tested `rollback.sql`, and a planned maintenance window.
