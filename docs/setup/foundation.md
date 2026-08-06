# Foundation setup

## Requirements

- Bun 1.3.14
- PostgreSQL 16
- Node-compatible environment for Next.js tooling

## Local environment

Copy `.env.example` to `.env.local` and set:

```text
APP_ENV=local
APP_ORIGIN=http://localhost:3000
DATABASE_URL=postgres://postgres:postgres@localhost:5432/creat_web
```

All optional external providers are disabled by default. Google, Resend, Waffo and analytics credentials are not required for the foundation build.

## Install and verify

```bash
bun install --frozen-lockfile
bun run db:migrate
bun run verify
```

The verification suite checks formatting, TypeScript, unit tests, real PostgreSQL migrations, architecture boundaries, an optional-provider build matrix and release configuration.

## Architecture boundary

Platform code under `src/platform/**` must never import product code under `src/modules/**`. Provider-specific environment variables are validated only when their feature is enabled.

## Migration policy

Schema changes are defined in Drizzle schema files, generated into versioned migrations, committed with SQL and metadata, and applied with `bun run db:migrate`. Production deployments must not use schema push.
