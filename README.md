# UMS — Phase 0 Kernel

Integrated University Management System. Phase 0 builds the kernel and platform
components every later module depends on: tenant isolation, transactions, audit,
messaging, and idempotency.

## Status

| Component | State |
|---|---|
| K-01 Repo & tooling (strict TS, vitest, ESLint money rule, dependency-cruiser) | done |
| K-02 DB roles, migrations, privilege model | done |
| K-03 Request context (ALS, correlation, context logger) | done |
| K-04 `withTenantTx` + P-05 transaction-boundary guard | done |
| K-05 Tenant isolation RLS (T01–T09, T12) | done |
| K-06 `shared` (uuidv7, public ids + HMAC, Money, UTC, i18n errors) | done |
| K-07 Audit (per-tenant SHA-256 hash chain, partitions, append-only guards) | done |
| K-08 Outbox + Relay (gap-free `log_seq`, fencing epoch, E-01/E-02) | done |
| K-09 → K-15, `apps/*`, `demo:phase0` | in progress |

Verification: `npx tsc --noEmit` clean; `npx vitest run` → **117 tests, 8 files, all passing**.

## Test suites

| File | Tests | Covers |
|---|---|---|
| `libs/shared/src/shared.spec.ts` | 21 | K-06 |
| `libs/kernel/src/context/context.spec.ts` | 18 | K-03 |
| `tests/integration/k02-database.int.spec.ts` | 10 | K-02 roles, privileges, migration idempotency |
| `tests/integration/k04-transactions.int.spec.ts` | 15 | K-04 LOCAL settings, timeouts, nesting, P-05 |
| `tests/integration/k05-rls.int.spec.ts` | 16 | K-05 FORCE RLS, cross-tenant denial |
| `tests/integration/k07-audit.int.spec.ts` | 17 | K-07 hash chain, tamper detection |
| `tests/integration/k08-relay.int.spec.ts` | 18 | K-08 crash windows, fencing, dedup, G1 |
| `tests/smoke.spec.ts` | 2 | toolchain |

Integration tests never mock the database: each file clones `ucs_template` and connects as
the real application role (`app_sample`, `app_relay`), so the guarantees under test are the
ones PostgreSQL actually enforces.

## What Phase 0 still needs

1. **K-09** — consumer integration tests (T01–T12: E-07/E-08/E-09/E-11, G4). `Consumer` is
   implemented in `libs/platform/messaging/src/consumer.ts` but has no suite yet.
2. **K-10** — `@Idempotent()` decorator + interceptor (the `idempotency_key` table exists).
3. **K-11** — contract JSON files in `db/schemas-contract/` + client generation.
4. **K-12** — kernel timers (`kernel.job_schedule`, `job_due` via the kernel outbox).
5. **K-14** — `tools/generators/module/generate.ts` (module + migration + manifest).
6. **K-15** — `check:grants`, `check:pools`, `check:traceability`, `check:dev-auth`,
   `check:contracts` are wired as scripts but still need their `docs/traceability.json`.
7. **AC-039** — `GET /api/v1/sample/items/:publicId` returning 403 +
   `SECURITY.CROSS_TENANT_ACCESS` (K-05-T10/T11), plus the all-routes sweep.
8. `apps/api`, `apps/worker`, `npm run demo:phase0`, `docs/kernel-guide.md`.

## Requirements

- Node >= 22
- PostgreSQL >= 16 (17 in this sandbox)

## Local setup

```bash
npm install
# cluster roles + database + migrations + test template
npm run db:migrate -- --template
npm test
```

Environment variables (all optional, defaults target a local trust-auth cluster):

| Variable | Default |
|---|---|
| `PGHOST` | `127.0.0.1` |
| `PGPORT` | `5432` |
| `PGDATABASE` | `ucs` |
| `DATABASE_URL` | `postgres://migrator@127.0.0.1:5432/ucs` |
| `ADMIN_DATABASE_URL` | `postgres://postgres@127.0.0.1:5432/postgres` |

## Architecture

`modules/*` may depend only on `kernel`, `platform`, and `shared`; `kernel` never
depends on a module; a module is consumable only through its `*.public.ts`
facade. These rules are enforced by `.dependency-cruiser.cjs`, not convention.

The database is the security boundary: row-level security with `FORCE` on every
tenant-scoped table, `set_config(..., true)` inside each transaction, and no
`BYPASSRLS` role anywhere.
