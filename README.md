# UMS — Phase 0 Kernel

Integrated University Management System. Phase 0 builds the kernel and platform
components every later module depends on: tenant isolation, transactions, audit,
messaging, and idempotency.

## Status

| Component | State |
|---|---|
| K-01 Repo & tooling (strict TS, vitest, ESLint money rule, dependency-cruiser) | done |
| K-02 DB roles, migrations, privilege model | done |
| K-03 → K-15 | in progress |

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
