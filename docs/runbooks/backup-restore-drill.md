# Runbook — Backup Freshness & Restore Drills

> Goal: keep database backups **provably** restorable. A backup that has never
> been restored is a hope, not a backup (issue #266).
>
> Related: [`database-migration.md`](database-migration.md) (backup before every
> migration), [`migration-rollback-playbook.md`](../migration-rollback-playbook.md)
> §6, [`deployment.md`](deployment.md) (pre-deploy backup freshness check).

## Preconditions

| Item | Where |
| --- | --- |
| Daily encrypted backups | `scripts/db-backup.sh` → `s3://$S3_BUCKET/$S3_PREFIX/daily/` |
| Integrity manifest | uploaded as `<backup-key>.manifest.json` (sha256 + per-table row counts) |
| GPG private key | CI secret `BACKUP_GPG_PRIVATE_KEY`, recipient `BACKUP_GPG_RECIPIENT` |
| AWS credentials | CI secrets `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` |
| Freshness SLA | `BACKUP_SLA_HOURS` (default **26h** — daily job + slack) |
| RTO target | `RTO_TARGET_MINUTES` (default **30**) |

## Procedure

### 1. Freshness gate (weekly, automated)

Workflow: `.github/workflows/backup-drill.yml` → job `freshness`
(cron `0 4 * * 1`, and before every deploy via `docs/runbooks/deployment.md`).

```bash
# local / manual
./scripts/check-backup-freshness.sh                 # S3 mode
./scripts/check-backup-freshness.sh --status-file f.json   # offline mode
./scripts/check-backup-freshness.sh --simulate-gap  # prove the alert fires
```

* Exit `0` → a daily backup exists within the SLA.
* Exit `1` → **missing or stale** → `backup_stale` alert (severity: page,
  webhook `ALERT_WEBHOOK_URL`), message says which timestamp was found.
* The `simulate-gap` mode is the controlled-gap validation (same pattern as
  `scripts/slo-fault-test.sh`): it must exit `1`. If it does not, the alert
  wiring is broken — fix it before relying on the gate.

### 2. Restore drill (quarterly, automated)

Workflow: `.github/workflows/backup-drill.yml` → job `drill`
(cron `0 5 1 1,4,7,10 *`, or `workflow_dispatch` with `mode: drill`).

```bash
S3_BUCKET=... ./scripts/backup-restore-drill.sh                        # default path
S3_BUCKET=... ./scripts/backup-restore-drill.sh --exercise-restore-script
S3_BUCKET=... ./scripts/backup-restore-drill.sh --key backups/daily/amana-daily-...gpg
S3_BUCKET=... ./scripts/backup-restore-drill.sh --skip-app             # restore-only
```

What the drill asserts, in order:

1. **Resolve** — newest `daily/` object exists; manifest fetched when present.
2. **Isolated target** — compose `test` profile (`COMPOSE_PROJECT_NAME=amana-drill`,
   tmpfs postgres on 5433, redis on 6381). Never touches dev/staging/prod data.
3. **Integrity** — decrypt, sha256 vs manifest (legacy backups: schema sanity).
4. **Restore** — default from the verified local dump;
   `--exercise-restore-script` runs `scripts/db-restore.sh` itself
   (the production restore path).
5. **Row counts** — every `rowCounts` entry in the manifest vs the restored copy;
   `User`/`Trade`/`Dispute` must exist.
6. **App smoke** — boots `backend/Dockerfile` against the restored DB, waits for
   `/health/ready`, then serves read traffic (`GET /health/detail` → 200 plus
   `scripts/staging-admin-smoke-test.sh`).
7. **RTO report** — wall-clock start → app serving reads, compared to
   `RTO_TARGET_MINUTES`; written to `backup-drills/drill-report-<ts>.json` and
   appended to `backup-drills/rto-history.jsonl` (committed by the workflow,
   artifact uploaded for 400 days).

Exit `0` only when every step passes; exit `1` → findings must be filed.

### 3. Manual emergency restore (prod-adjacent rehearsal)

```bash
DATABASE_URL="$TARGET_URL" ./scripts/db-restore.sh --type daily   # latest
DATABASE_URL="$TARGET_URL" ./scripts/db-restore.sh --key backups/daily/amana-daily-<ts>.sql.gz.gpg
```

Run against a **new, empty** database first. Promote to production only via the
incident commander per `migration-rollback-playbook.md` §6.

## Failure modes

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `freshness` fails, drill succeeds | daily job not running / S3 perms | Check `backup-db` workflow + IAM; backfill a manual `db-backup.sh` |
| `freshness` fails with `--simulate-gap` returning 0 | alert wiring broken | Fix `check-backup-freshness.sh`/webhook before trusting the gate |
| sha256 mismatch | truncated upload or corrupt object | Fail drill; restore from previous backup; investigate uploader |
| Row count mismatch | restore raced with a live writer, or dump missing data | Re-run drill; if reproducible → restore path bug (critical finding) |
| App never ready on restored copy | schema/migration drift in the dump | Compare `prisma migrate diff` between dump and `main`; file finding |
| RTO > target (but green) | dump size growing / restore path slow | Track in `rto-history.jsonl`; consider incremental dump or larger drill runner |
| GPG import fails in CI | rotated key secret | Update `BACKUP_GPG_PRIVATE_KEY`; re-encrypt test object; re-run drill |

## Sign-off checklist (per quarter)

- [ ] `freshness` job green for the quarter (no open `backup_stale` pages).
- [ ] `drill` job green; `drillOk: true` in the committed report.
- [ ] RTO within target (or variance explained in the report commit).
- [ ] Integrity: 0 manifest mismatches (or legacy schema sanity noted).
- [ ] App served read traffic from the restored copy.
- [ ] Findings filed for every warning; critical ones fixed before sign-off.

## Links

- Alert type: `backup_stale` → `backend/src/config/alertRegistry.ts` (routing: page)
- Schedules: `.github/workflows/backup-drill.yml`
- Scripts: `scripts/db-backup.sh`, `scripts/db-restore.sh`,
  `scripts/check-backup-freshness.sh`, `scripts/backup-restore-drill.sh`
- Pre-deploy gate: `docs/runbooks/deployment.md`
