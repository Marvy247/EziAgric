# Deployment Runbook

Step-by-step deploy process for the three deployable pieces of Amana:
backend, frontend, and the Soroban escrow contract. Companion docs:
[docker-profiles.md](../docker-profiles.md) (environment topology),
[migration-rollback-playbook.md](../migration-rollback-playbook.md)
(migrations in depth - see also [database-migration.md](./database-migration.md)),
and [contract-deployment-local-network.md](../contract-deployment-local-network.md).

## Environments

| Environment | Infra | How it's deployed |
|---|---|---|
| `dev` | Local Docker (`docker-compose.yml` `dev` profile) | `./scripts/dev-up.sh` |
| `staging` | Docker Compose `staging` profile, seeded synthetic data | `./scripts/staging-up.sh`, also runs automatically via `.github/workflows/staging.yml` on push to `develop` |
| `production` | Externally managed cloud infra (managed Postgres, managed Redis) - see [docker-profiles.md](../docker-profiles.md#production-notes) | Manual, following this runbook (no CD pipeline exists yet) |

There is currently no automated production deploy workflow - production
release is a manual, checklist-driven process. If you're setting one up,
this runbook is the source of truth for what it needs to do.

## Pre-deploy checklist

Before deploying to staging or production:

1. CI is green on the commit you're deploying (`.github/workflows/ci.yml`).
2. Risky changes are behind a feature flag defaulted to off (see
   [admin.md](../api/admin.md#feature-flags)) rather than deployed live.
3. Confirm whether this deploy includes a Prisma migration. If so, read
   [database-migration.md](./database-migration.md) fully before continuing
   - migrations are the highest-risk part of any deploy. Backward-incompatible
   migration SQL is also blocked at PR time by
   [migration-check.yml](../migration-rollback-playbook.md#7-ci-migration-check)
   unless the PR carries the `migration:destructive-approved` label.
4. Take a fresh backup if deploying to production (see
   [database-migration.md](./database-migration.md#backups)), and confirm the
   [backup freshness check](./backup-restore-drill.md) is green (a stale-backup
   alert means RPO claims are unfounded — fix that first).
5. The mobile **crash release gate** is green for the candidate release
   (`.github/workflows/crash-gate.yml`, `scripts/check-crash-gate.mjs`) —
   a new-crash spike blocks promotion exactly like a failed staging
   validate (see [crash-reporting.md](../../mobile/docs/crash-reporting.md)).
6. For backend changes: the [zero-downtime rolling sequence](#backend-zero-downtime-rolling-deploy)
   below is understood and the auto-rollback trigger is armed.

## Backend deployment

The backend is an Express app under `backend/`, backed by Postgres (via
Prisma) and Redis.

### Staging

```bash
cp .env.staging.example .env.staging   # first time only; fill in secrets
./scripts/staging-up.sh
```

`staging-up.sh` starts the `staging` Docker Compose profile, waits for
Postgres/Redis health checks, applies pending migrations via
`migrate-safe.sh --env=staging`, seeds synthetic data, and (unless
`--skip-validate` is passed) runs `staging-validate.sh` to smoke-test the
deployment. This is the same sequence `.github/workflows/staging.yml` runs
on every push to `develop`.

Tear down with:

```bash
docker compose --profile staging down -v --remove-orphans
```

### Production

1. Build the backend:
   ```bash
   cd backend
   npm ci
   npx prisma generate
   npm run build   # emits dist/
   ```
2. Apply migrations first, separately from the app deploy:
   ```bash
   ./scripts/migrate-safe.sh --env=production
   ```
   See [database-migration.md](./database-migration.md) - this step alone
   has its own pre-flight checks, backup, and confirmation gate for
   destructive DDL.
3. Roll out `dist/` to the production environment (behind whatever process
   manager/orchestrator the target infra uses) with the production `.env`
   populated per `backend/src/config/env.ts` (JWT secrets, `DATABASE_URL`,
   `REDIS_URL`, `ADMIN_STELLAR_PUBKEYS`, `STELLAR_NETWORK=mainnet`, etc.).
4. Confirm the new instance is healthy before routing traffic to it:
   ```bash
   curl https://<host>/health/ready
   curl https://<host>/health/startup
   ```
   Both should return `200`. `health.detail.routes.ts` also exposes deeper
   dependency checks (DB, Redis) under `/health` - see
   [trades.md](../api/trades.md) and [overview.md](../api/overview.md) for
   general API conventions if you're scripting this check.
5. Only after the new instance passes health checks, shift traffic to it
   and stop the old instance (keep it stoppable-but-not-deleted for a
   rollback window - see [rollback.md](./rollback.md)).

### Backend zero-downtime rolling deploy

The strategy that makes the production sequence above drop-free (issue
#265). Companions: [graceful-shutdown.md](../graceful-shutdown.md),
[health-probe-semantics.md](../../backend/docs/health-probe-semantics.md),
[migration-rollback-playbook.md](../migration-rollback-playbook.md).

**1. Rolling strategy with readiness gates (already encoded in infra).**
[`infra/k8s/backend-deployment.yaml`](../../infra/k8s/backend-deployment.yaml)
rolls with `maxSurge: 1, maxUnavailable: 0`: the replacement pod must pass
`startupProbe` (`/health/startup`) and `readinessProbe` (`/health/ready`)
before it receives traffic, and the old pod is de-listed by its own
readiness probe flipping to `503 shutdown_in_progress` (see
`ShutdownOrchestrator`) before SIGTERM. A `preStop` sleep of 10s plus
`terminationGracePeriodSeconds: 45` gives the load balancer time to stop
routing to the draining pod. Reproduce the same gates in any non-k8s
environment: never route to an instance until `GET /health/ready` and
`GET /health/startup` are both `200`.

**2. Expand → migrate → contract.**
Schema changes ship expand-first (additive DDL + dual-write/backfill),
contract last — full discipline in
[migration-rollback-playbook.md §2 Expand → Migrate → Contract](../migration-rollback-playbook.md#expand--migrate--contract-discipline).
PR-time enforcement: `migration-check.yml` fails backward-incompatible DDL
on PRs to `main` unless `migration:destructive-approved` is set, and the PR
template carries the migration checklist.

**3. Verify connection draining under load.**
While the rollout runs, drive read traffic through the load balancer with a
strict zero-failure threshold:

```bash
BASE_URL=https://<staging-or-prod-host> \
ROLLOUT_CMD="kubectl rollout restart deployment/backend" \
./scripts/verify-rolling-deploy.sh
```

The script starts `k6/rolling-deploy.js` (`http_req_failed: rate==0`),
triggers the rollout, waits for readiness to recover, and fails if a single
request errored — the DoD evidence for "load test during rolling deploy
shows zero failed requests." Unit-level drain ordering is covered by
`backend/src/__tests__/shutdown.graceful.test.ts`.

**4. Automated rollback on error-rate burn.**
During/after a rollout, arm the burn trigger:

```bash
PROMETHEUS_URL=http://<prometheus> ALERT_WEBHOOK_URL=... \
BASE_URL=https://<host> \
./scripts/rollback-on-burn.sh --rollback-cmd "kubectl rollout undo deployment/backend"
```

It fires when `SLOPE_BudgetBurn_Fast_S1` is active or the live 5xx ratio
over `--window` exceeds `--threshold` (default 5%/5m), executes the
rollback, verifies readiness recovery, and dispatches the
`deploy_rollback_triggered` alert (routing: page,
[rollback.md](./rollback.md)). `--dry-run` rehearses without executing;
`--simulate-burn` is the game-day path used to demonstrate automatic
rollback on an injected failure (DoD), e.g.:

```bash
./scripts/rollback-on-burn.sh --simulate-burn --rollback-cmd "echo '[drill] rollback would run here'"
```

**5. Consolidated sequence (runbook form).**

1. Preflight: CI green, crash gate green, fresh backup, migration gate green.
2. Apply migrations separately via `migrate-safe.sh --env=production`
   (expand phase only, per §2 discipline).
3. Start `verify-rolling-deploy.sh` (or kick the rollout and then start it —
   the script supports `MODE=manual` for rollouts you trigger yourself).
4. Roll out the new revision (`kubectl set image ...` / `rollout restart`);
   watch `kubectl rollout status deployment/backend`.
5. Confirm `/health/ready` + `/health/startup` are `200` from outside the
   cluster, then arm `rollback-on-burn.sh` for the observation window.
6. Spot-check one read + one write endpoint
   (§ [Post-deploy verification](#post-deploy-verification)).
7. If burn trips: rollback runs automatically; confirm the alert page,
   verify recovery, and open a postmortem per
   [incident-response.md](./incident-response.md).
8. Record the drain-verification k6 result with the release notes — it is
   the "zero failed requests" drill evidence.

Drill cadence: rehearse steps 3–5 on staging at every release train; the
`--simulate-burn` game-day runs quarterly alongside the backup drill
([backup-restore-drill.md](./backup-restore-drill.md)).

## Frontend deployment

The frontend is a Next.js app under `frontend/`.

```bash
cd frontend
npm ci
npm run build   # next build
npm run start   # next start, or hand dist output to your Next.js host
```

There's no Vercel/Netlify config checked into the repo today - deploy
`frontend/` to whatever Node host or static/edge platform your environment
uses, pointing its API base URL env var at the backend for that
environment (staging backend for a staging frontend deploy, etc.).

## Contract deployment

The Soroban escrow contract lives in `contracts/amana_escrow`.

- **Local network**: fully scripted and documented -
  `./scripts/deploy-contract-local.sh --network standalone --admin <pubkey> --token-contract <id> --treasury <pubkey>`.
  See [contract-deployment-local-network.md](../contract-deployment-local-network.md)
  for the full flow, including `--upgrade` for redeploying to an existing
  contract ID. `scripts/check-contract-deployment-safety.sh` runs as a
  separate CI check (`.github/workflows/ci.yml`) against the contract
  source, not from inside the deploy script itself - it's worth running
  manually before a deploy too, since a CI failure after you've already
  deployed is too late.
- **Testnet/mainnet**: not yet scripted. Use the same parameters and
  `soroban-cli`/`stellar-cli` flow as the local script, pointed at the
  target network's RPC and passphrase (`STELLAR_NETWORK_PASSPHRASE` in
  `backend/src/config/env.ts` shows the values the backend expects to
  match). Run `check-contract-deployment-safety.sh` against the contract
  source before deploying to a real network, the same check CI runs on
  every PR.
- After deploying/upgrading a contract, update the backend's contract ID
  configuration (`treasury.routes.ts` / `stellar.service.ts` consumers read
  it from environment) and verify with:
  ```bash
  curl "https://<backend-host>/contract/<contractId>/state?tradeId=<known-trade-id>"
  ```
  (see [stellar.md](../api/stellar.md#contract-state)).

## Post-deploy verification

1. `GET /health/ready` and `GET /health/startup` return `200`.
2. Run (or confirm CI already ran) `staging-validate.sh`-equivalent smoke
   checks for the environment you deployed to.
3. Spot-check one read endpoint (`GET /trades/stats` with a known test
   token) and, for a backend deploy, one write endpoint in a non-production
   environment before trusting the same code path in production.
4. Watch error rates/logs for the deployed service for at least one full
   request-rate cycle before declaring the deploy complete.

If any of the above fails, go to [rollback.md](./rollback.md) rather than
attempting a forward fix under pressure.
