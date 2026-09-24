## Description
<!-- Provide a clear, detailed description of your changes -->

## Related Issues
<!-- List related issues below using 'Closes #issue-number' -->
- Closes #

## Type of Change
- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New feature (non-breaking change adding functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Infrastructure / CI / Policy / Documentation update

## PR Checklist
- [ ] Code builds and passes all unit & integration tests locally (`pnpm test` / `cargo test`)
- [ ] Documentation has been updated to reflect code changes
- [ ] **Admin Regression Tests**: If this PR modifies admin routes, controllers, middleware, or services, corresponding regression tests under `backend/src/__tests__/` have been added or updated (enforced by CI policy).
- [ ] **Secret Management**: No secrets, private keys, or credentials are hardcoded.
- [ ] **Network Isolation & Security**: Infrastructure changes preserve network isolation for admin endpoints.

## Contract Changes (complete if this PR modifies `contracts/`)
- [ ] **Security Review Checklist**: If this PR adds or modifies a contract admin function (e.g. `admin_clawback`), the [Contract E2E Security Review Checklist](../contracts/amana_escrow/docs/security-review-checklist.md) has been completed and attached or linked above.
- [ ] **Safe Upgrade Guide**: If this PR changes the contract ABI, storage layout, or introduces new events, the [Safe Upgrade Guide](../contracts/amana_escrow/docs/safe-upgrade-guide.md) release notes section has been updated.
- [ ] **Upgrade Simulation**: `./scripts/simulate-contract-upgrade.sh` has been run and exits 0.
- [ ] **Event Symbol Registry**: Any new contract event symbols are registered in [`upgrade-considerations.md`](../contracts/amana_escrow/docs/upgrade-considerations.md).

## Migration Changes (complete if this PR modifies `backend/prisma/migrations/`)
- [ ] **Expand → Migrate → Contract**: This PR is a single phase — additive DDL (expand), backfill/dual-write (migrate), or old-shape removal (contract). See [migration-rollback-playbook.md §2](../docs/migration-rollback-playbook.md#expand--migrate--contract-discipline).
- [ ] **Rollback SQL**: A companion `rollback.sql` exists for any non-trivially reversible migration and has been tested on staging.
- [ ] **Backward compatible**: No `DROP` / `RENAME` / `SET NOT NULL` / column type change, or the PR carries the reviewed `migration:destructive-approved` label ([migration-check.yml](../.github/workflows/migration-check.yml) enforces this on `main`).
- [ ] **Local scan run**: `./scripts/check-migration-compat.sh --dir backend/prisma/migrations` exits 0.
