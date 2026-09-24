# Ephemeral Preview Environments

Issue: #264 · Related: #58 (smoke probes), #51 (stack topology)

A `preview` label on a PR spins up a full **backend + postgres + redis**
stack from the `preview` Docker Compose profile, posts a public URL on the
PR, runs the E2E smoke journey automatically, and tears everything down on
merge/close or when the budget cap is reached.

## Lifecycle

```
label PR `preview`
  → ceiling check (MAX_CONCURRENT_PREVIEWS, graceful skip above it)
  → scripts/preview-up.sh
      COMPOSE_PROJECT_NAME=eziagric-pr-<n>
      build backend/Dockerfile → postgres-preview + redis-preview (tmpfs)
      wait /health/ready → prisma migrate deploy → seed.staging.ts subset
  → cloudflared quick tunnel → URL posted as a PR comment
  → scripts/preview-smoke.sh   (seed assertions + admin journey + readiness)
  → optional contract deploy to testnet (isolated account)
  → hold for PREVIEW_TTL_SECONDS (URL stays reachable)
  → always(): scripts/preview-down.sh  (teardown + orphan verification)
merge/close
  → teardown-on-close job re-runs preview-down.sh and rewrites the comment
```

| Piece | File |
| --- | --- |
| Compose profile | `docker-compose.yml` → `preview` (ports 4001/5435/6382) |
| Backend image | `backend/Dockerfile` |
| Bring-up | `scripts/preview-up.sh` |
| Smoke | `scripts/preview-smoke.sh` (reuses `staging-validate.sh` + admin smoke) |
| Teardown | `scripts/preview-down.sh` (fails on orphans) |
| Testnet deploys | `scripts/deploy-contract-testnet.sh` |
| Workflow | `.github/workflows/preview.yml` |

## What "full stack" means

- **Backend** — built from `backend/Dockerfile` (multi-stage, `NODE_ENV=staging`),
  waits on `/health/ready` before seeding.
- **DB** — `postgres-preview` on host port 5435, **tmpfs** (data never
  survives teardown).
- **Redis** — `redis-preview` on host port 6382.
- **Seeded data subset** — `backend/prisma/seed.staging.ts` (the same rich,
  idempotent fixture staging uses: 5 users, 8 trades covering all 7 statuses,
  4 disputes, manifests, events, vaults, goals) so smoke journeys have real
  rows. Assertions come from `staging-validate.sh` against the preview DB.
- **E2E smoke** — `scripts/preview-smoke.sh` = seed assertions + the admin
  route journey (`staging-admin-smoke-test.sh`, which the [synthetic probe
  policy](synthetic-probes-policy.md) treats as the canonical smoke) +
  `/health/ready`, run automatically on every deploy, plus a check that the
  public tunnel actually serves `/health/ready`.

Each preview is isolated by `COMPOSE_PROJECT_NAME=eziagric-pr-<n>` —
separate containers, networks, and (tmpfs) volumes, so concurrent PRs never
collide even sharing host port defaults (offset per profile: dev 5432,
test 5433, staging 5434, preview 5435).

## Contract deploys (isolated testnet accounts)

`scripts/deploy-contract-testnet.sh` deploys/upgrades the escrow contract
against Stellar testnet **using a dedicated, low-value preview account**
(`PREVIEW_TESTNET_ADMIN_SECRET` repo secret), never a production key:

1. Runs `check-contract-deployment-safety.sh` first (same gate CI runs).
2. Builds the wasm if missing, deploys (or `--upgrade`s) via the
   `stellar`/`soroban` CLI.
3. Prints the contract id to set as `PREVIEW_CONTRACT_ID`.

Key policy follows [secrets-policy.md](secrets-policy.md) (quarterly
rotation) and [synthetic-probes-policy.md §4](synthetic-probes-policy.md#4-accounts)
— the preview account is isolated from anything that touches real value.
The workflow step is a no-op until `PREVIEW_TESTNET_ADMIN_SECRET` is set.

## Budget & cost guardrails

| Guardrail | Value | Enforced by |
| --- | --- | --- |
| Max lifetime (hard) | **40 minutes** | `timeout-minutes` on the deploy job — job is killed and `always()` teardown still runs |
| URL TTL (soft) | **10 minutes** (`PREVIEW_TTL_SECONDS=600`) | `sleep` step; the tunnel dies with the job anyway |
| Concurrency ceiling | **3** previews (`MAX_CONCURRENT_PREVIEWS`) | Ceiling job — above it the deploy **skips gracefully** (notice + summary, not a red X) |
| Storage | tmpfs only for the preview DB | No volume cost; `preview-down.sh` verifies zero volumes remain |
| Compute | GitHub-hosted runner, one job per PR | Ceiling + TTL + hard timeout bound total runner-minutes |

Tune the three values at the top of `.github/workflows/preview.yml` (`env:`).
One preview ≈ one `ubuntu-latest` job for ≤40 minutes — the dominant cost —
so the ceiling is the primary spend control.

## Teardown verification

`preview-down.sh` runs `docker compose --profile preview down -v
--remove-orphans`, then **fails if any container or volume carrying the
project label still exists**. The workflow runs it:

- at the end of every deploy job (`if: always()` — survives smoke failures
  and TTL expiry), and
- again in the `teardown-on-close` job on merge/PR close (defensive; also
  covers self-hosted runners where state outlives a job).

The PR comment is rewritten to "torn down" in both paths, so a dead URL is
never mistaken for a live preview. Orphan checks over a test week are the
DoD evidence: any non-zero orphan fails the close job visibly.

## Operating it

```bash
# Add the label on the PR (or locally):
PREVIEW_PR_NUMBER=123 ./scripts/preview-up.sh
PREVIEW_URL=http://localhost:4001 PREVIEW_DB_URL=postgresql://... ./scripts/preview-smoke.sh
PREVIEW_PR_NUMBER=123 ./scripts/preview-down.sh
```

Triage a red deploy the same way as staging: read the workflow log tail
printed by `preview-up.sh` on `/health/ready` failure, then
[incident-response.md](runbooks/incident-response.md) only if the same
break also affects staging/production.

## DoD mapping

| DoD | Where |
| --- | --- |
| `preview` label spins full stack with URL posted on PR | `.github/workflows/preview.yml` (label trigger + comment upsert) |
| E2E smoke passes against preview automatically | `scripts/preview-smoke.sh` + tunnel exposure check |
| Teardown verified (no orphaned resources) | `scripts/preview-down.sh` orphan assertions, `always()` + close job |
| Concurrent preview ceiling enforced gracefully | Ceiling job — notice + summary skip, never a failed check |
| Budget caps / cost guardrails documented | § Budget & cost guardrails above |
