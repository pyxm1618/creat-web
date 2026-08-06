# creat-web Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the documentation-only repository into a minimal, production-buildable Next.js foundation with validated configuration, PostgreSQL migrations, architectural boundaries, CI, and safe logging.

**Architecture:** One Bun-managed Next.js App Router application. Configuration is split into committed feature/site config and server-only environment parsing. PostgreSQL is accessed through one platform database module; platform-to-product dependency direction is machine-enforced before feature modules are added.

**Tech Stack:** Bun, Next.js App Router, React, TypeScript strict mode, Tailwind CSS, Zod, PostgreSQL, Drizzle ORM/Kit, postgres.js, Vitest, Playwright, ESLint flat config, Prettier, GitHub Actions.

## Global Constraints

- Do not read from or write to Quick I Ching during implementation; this plan is self-contained.
- Do not create empty provider/plugin abstractions.
- Use exact dependency versions resolved by `bun add --exact`; commit `bun.lock`.
- Local/test builds must work without Google, Resend, Waffo, or analytics credentials.
- Production configuration must fail closed on placeholders, HTTP origins, or missing enabled-module secrets.
- `src/platform/**` may never import `src/modules/**`.
- Server-only configuration/database modules may never be imported by client components.
- Each task ends with a focused commit and all prior tests still passing.

---

## File Map

- `package.json` — scripts and pinned dependencies.
- `tsconfig.json` — strict TypeScript and `@/*` alias.
- `next.config.ts` — Next.js configuration and production-safe headers hook.
- `eslint.config.mjs` — lint and import-boundary rules.
- `.prettierrc.json`, `.prettierignore` — deterministic formatting.
- `vitest.config.ts`, `vitest.integration.config.ts` — unit and PostgreSQL integration suites.
- `playwright.config.ts` — browser tests added by later plans.
- `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css` — neutral starter shell.
- `src/config/features.config.ts`, `src/config/site.config.ts` — committed configuration.
- `src/platform/config/env.ts`, `src/platform/config/validate-config.ts` — server environment and cross-config invariants.
- `src/platform/database/client.ts`, `src/platform/database/schema.ts` — database entry points.
- `drizzle.config.ts`, `drizzle/0000_foundation.sql` — migration tooling and initial migration.
- `scripts/db-migrate.ts`, `scripts/verify-migrations.ts`, `scripts/verify-release.ts` — deterministic operational checks.
- `src/platform/observability/logger.ts`, `src/platform/observability/redact.ts` — structured redacted logging.
- `tests/unit/config/*.test.ts`, `tests/unit/observability/*.test.ts` — pure tests.
- `tests/integration/database/*.test.ts` — real PostgreSQL tests.
- `.github/workflows/ci.yml` — frozen install and quality gates.

### Task 1: Bootstrap the minimal Next.js application

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `next-env.d.ts`
- Create: `next.config.ts`
- Create: `postcss.config.mjs`
- Create: `src/app/layout.tsx`
- Create: `src/app/page.tsx`
- Create: `src/app/globals.css`
- Create: `.gitignore`
- Create: `.prettierrc.json`
- Create: `.prettierignore`

**Interfaces:**
- Produces: a buildable App Router project with `@/*` mapped to `src/*`.
- Produces scripts consumed by every later task: `dev`, `build`, `start`, `format`, `format:check`, `lint`, `typecheck`, `test:unit`, `test:integration`, `test:contract`, `test:e2e`, `verify`.

- [ ] **Step 1: Create the package manifest**

```json
{
  "name": "creat-web",
  "version": "0.1.0",
  "private": true,
  "packageManager": "bun@1.3.14",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test:unit": "vitest run",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "test:contract": "vitest run --config vitest.contract.config.ts --passWithNoTests",
    "test:e2e": "playwright test",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "bun scripts/db-migrate.ts",
    "db:verify": "bun scripts/verify-migrations.ts",
    "verify:architecture": "eslint src tests scripts",
    "verify:secrets": "bunx secretlint '**/*' --secretlintrc .secretlintrc.json",
    "verify:release": "bun scripts/verify-release.ts",
    "verify": "bun run format:check && bun run lint && bun run typecheck && bun run test:unit && bun run test:integration && bun run build && bun run verify:architecture && bun run verify:secrets && bun run verify:release"
  }
}
```

- [ ] **Step 2: Install pinned runtime dependencies**

Run:

```bash
bun add --exact next@latest react@latest react-dom@latest zod@latest server-only@latest drizzle-orm@latest postgres@latest
```

Expected: `package.json` receives exact versions and `bun.lock` is created.

- [ ] **Step 3: Install pinned development dependencies**

Run:

```bash
bun add --dev --exact typescript@latest @types/node@latest @types/react@latest @types/react-dom@latest eslint@latest eslint-config-next@latest prettier@latest tailwindcss@latest @tailwindcss/postcss@latest drizzle-kit@latest vitest@latest @playwright/test@latest secretlint@latest @secretlint/secretlint-rule-preset-recommend@latest
```

Expected: all dependencies are exact versions in `package.json`.

- [ ] **Step 4: Create strict TypeScript configuration**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "es2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 5: Create the neutral server-rendered shell**

```tsx
// src/app/layout.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "creat-web",
  description: "Internal starter validation page",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

```tsx
// src/app/page.tsx
export default function HomePage() {
  return (
    <main>
      <h1>creat-web foundation</h1>
      <p>This neutral page is replaced by project configuration in the SEO plan.</p>
    </main>
  );
}
```

- [ ] **Step 6: Run the initial quality commands**

Run:

```bash
bun run format
bun run typecheck
bun run build
```

Expected: all commands exit `0` and Next.js emits a production build.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock tsconfig.json next-env.d.ts next.config.ts postcss.config.mjs src/app .gitignore .prettierrc.json .prettierignore
git commit -m "chore: bootstrap creat-web Next.js foundation"
```

### Task 2: Add committed feature and site configuration with invariant tests

**Files:**
- Create: `src/config/features.config.ts`
- Create: `src/config/site.config.ts`
- Create: `src/platform/config/types.ts`
- Create: `src/platform/config/validate-config.ts`
- Create: `tests/unit/config/validate-config.test.ts`
- Create: `vitest.config.ts`

**Interfaces:**
- Produces: `validateProductConfig(input: ProductConfig): ProductConfig`.
- Produces: `featuresConfig` and `siteConfig` used by all later plans.

- [ ] **Step 1: Write failing invariant tests**

```ts
import { describe, expect, it } from "vitest";
import { validateProductConfig } from "@/platform/config/validate-config";

const valid = {
  site: {
    slug: "sample-product",
    name: "Sample Product",
    canonicalOrigin: "https://example.com",
    defaultLocale: "en",
  },
  features: {
    auth: { enabled: true, google: true, magicLink: true, password: false },
    email: { enabled: true },
    commerce: { enabled: false, oneTime: false, subscriptions: false, credits: false },
    analytics: { ga4: false, clarity: false, consentRequired: true },
  },
} as const;

describe("validateProductConfig", () => {
  it("accepts a coherent configuration", () => {
    expect(validateProductConfig(valid).site.slug).toBe("sample-product");
  });

  it("rejects magic link without email", () => {
    expect(() =>
      validateProductConfig({
        ...valid,
        features: { ...valid.features, email: { enabled: false } },
      }),
    ).toThrow("magic link requires email transport");
  });

  it("rejects subscriptions when commerce is disabled", () => {
    expect(() =>
      validateProductConfig({
        ...valid,
        features: {
          ...valid.features,
          commerce: { enabled: false, oneTime: false, subscriptions: true, credits: false },
        },
      }),
    ).toThrow("subscriptions require commerce");
  });

  it("rejects localhost production origins", () => {
    expect(() =>
      validateProductConfig({ ...valid, site: { ...valid.site, canonicalOrigin: "http://localhost:3000" } }),
    ).toThrow("canonical origin must use production HTTPS");
  });
});
```

- [ ] **Step 2: Run the tests to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/config/validate-config.test.ts
```

Expected: FAIL because `validateProductConfig` does not exist.

- [ ] **Step 3: Implement exact configuration schemas**

```ts
// src/platform/config/types.ts
export type ProductConfig = {
  site: {
    slug: string;
    name: string;
    canonicalOrigin: string;
    defaultLocale: string;
  };
  features: {
    auth: { enabled: boolean; google: boolean; magicLink: boolean; password: false };
    email: { enabled: boolean };
    commerce: { enabled: boolean; oneTime: boolean; subscriptions: boolean; credits: boolean };
    analytics: { ga4: boolean; clarity: boolean; consentRequired: boolean };
  };
};
```

```ts
// src/platform/config/validate-config.ts
import { z } from "zod";
import type { ProductConfig } from "./types";

const schema = z.object({
  site: z.object({
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(2),
    canonicalOrigin: z.string().url(),
    defaultLocale: z.string().min(2),
  }),
  features: z.object({
    auth: z.object({ enabled: z.boolean(), google: z.boolean(), magicLink: z.boolean(), password: z.literal(false) }),
    email: z.object({ enabled: z.boolean() }),
    commerce: z.object({ enabled: z.boolean(), oneTime: z.boolean(), subscriptions: z.boolean(), credits: z.boolean() }),
    analytics: z.object({ ga4: z.boolean(), clarity: z.boolean(), consentRequired: z.boolean() }),
  }),
});

export function validateProductConfig(input: ProductConfig): ProductConfig {
  const parsed = schema.parse(input);
  if (parsed.features.auth.magicLink && !parsed.features.email.enabled) {
    throw new Error("magic link requires email transport");
  }
  if (parsed.features.commerce.subscriptions && !parsed.features.commerce.enabled) {
    throw new Error("subscriptions require commerce");
  }
  if (parsed.features.commerce.credits && !parsed.features.commerce.enabled) {
    throw new Error("credits require commerce");
  }
  const origin = new URL(parsed.site.canonicalOrigin);
  if (origin.protocol !== "https:" || origin.hostname === "localhost") {
    throw new Error("canonical origin must use production HTTPS");
  }
  return parsed;
}
```

- [ ] **Step 4: Add real committed configuration**

```ts
// src/config/features.config.ts
export const featuresConfig = {
  auth: { enabled: true, google: true, magicLink: true, password: false },
  email: { enabled: true },
  commerce: { enabled: true, oneTime: true, subscriptions: true, credits: true },
  analytics: { ga4: true, clarity: false, consentRequired: true },
} as const;
```

```ts
// src/config/site.config.ts
export const siteConfig = {
  slug: "creat-web-sample",
  name: "Creat Web Sample",
  canonicalOrigin: "https://example.com",
  defaultLocale: "en",
} as const;
```

- [ ] **Step 5: Run unit tests**

Run:

```bash
bun run test:unit -- tests/unit/config/validate-config.test.ts
```

Expected: PASS with four tests.

- [ ] **Step 6: Commit**

```bash
git add src/config src/platform/config tests/unit/config vitest.config.ts
git commit -m "feat: add validated product configuration"
```

### Task 3: Add server-only environment validation

**Files:**
- Create: `src/platform/config/env.ts`
- Create: `src/platform/config/load-runtime-config.ts`
- Create: `tests/unit/config/env.test.ts`
- Create: `.env.example`

**Interfaces:**
- Produces: `loadRuntimeEnv(source: NodeJS.ProcessEnv, features: ProductConfig["features"]): RuntimeEnv`.
- Consumes: feature configuration from Task 2.

- [ ] **Step 1: Write failing tests for optional and production-only secrets**

```ts
import { describe, expect, it } from "vitest";
import { loadRuntimeEnv } from "@/platform/config/load-runtime-config";

const disabled = {
  auth: { enabled: false, google: false, magicLink: false, password: false as const },
  email: { enabled: false },
  commerce: { enabled: false, oneTime: false, subscriptions: false, credits: false },
  analytics: { ga4: false, clarity: false, consentRequired: true },
};

describe("loadRuntimeEnv", () => {
  it("starts test mode without provider secrets when modules are disabled", () => {
    expect(loadRuntimeEnv({ NODE_ENV: "test", DATABASE_URL: "postgres://test:test@localhost:5432/test" }, disabled).mode).toBe("test");
  });

  it("rejects production HTTP origins", () => {
    expect(() =>
      loadRuntimeEnv(
        { NODE_ENV: "production", APP_ORIGIN: "http://example.com", DATABASE_URL: "postgres://x" },
        disabled,
      ),
    ).toThrow("APP_ORIGIN must be HTTPS in production");
  });

  it("requires Google credentials when enabled", () => {
    expect(() =>
      loadRuntimeEnv(
        { NODE_ENV: "production", APP_ORIGIN: "https://example.com", DATABASE_URL: "postgres://x", BETTER_AUTH_SECRET: "a".repeat(48) },
        { ...disabled, auth: { ...disabled.auth, enabled: true, google: true } },
      ),
    ).toThrow("GOOGLE_CLIENT_ID");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:unit -- tests/unit/config/env.test.ts`

Expected: FAIL because the loader is missing.

- [ ] **Step 3: Implement environment parsing and conditional requirements**

```ts
// src/platform/config/load-runtime-config.ts
import { z } from "zod";
import type { ProductConfig } from "./types";

export type RuntimeEnv = {
  mode: "development" | "test" | "production";
  appOrigin?: string;
  databaseUrl: string;
  betterAuthSecret?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  resendApiKey?: string;
  waffoPrivateKey?: string;
  waffoWebhookSecret?: string;
};

export function loadRuntimeEnv(source: NodeJS.ProcessEnv, features: ProductConfig["features"]): RuntimeEnv {
  const base = z
    .object({
      NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
      APP_ORIGIN: z.string().url().optional(),
      DATABASE_URL: z.string().min(1),
      BETTER_AUTH_SECRET: z.string().min(32).optional(),
      GOOGLE_CLIENT_ID: z.string().min(1).optional(),
      GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
      RESEND_API_KEY: z.string().min(1).optional(),
      WAFFO_PRIVATE_KEY: z.string().min(1).optional(),
      WAFFO_WEBHOOK_SECRET: z.string().min(1).optional(),
    })
    .parse(source);

  if (base.NODE_ENV === "production") {
    if (!base.APP_ORIGIN || new URL(base.APP_ORIGIN).protocol !== "https:") {
      throw new Error("APP_ORIGIN must be HTTPS in production");
    }
    if (features.auth.enabled && !base.BETTER_AUTH_SECRET) throw new Error("BETTER_AUTH_SECRET is required");
    if (features.auth.google && !base.GOOGLE_CLIENT_ID) throw new Error("GOOGLE_CLIENT_ID is required");
    if (features.auth.google && !base.GOOGLE_CLIENT_SECRET) throw new Error("GOOGLE_CLIENT_SECRET is required");
    if (features.email.enabled && !base.RESEND_API_KEY) throw new Error("RESEND_API_KEY is required");
    if (features.commerce.enabled && !base.WAFFO_PRIVATE_KEY) throw new Error("WAFFO_PRIVATE_KEY is required");
    if (features.commerce.enabled && !base.WAFFO_WEBHOOK_SECRET) throw new Error("WAFFO_WEBHOOK_SECRET is required");
  }

  return {
    mode: base.NODE_ENV,
    appOrigin: base.APP_ORIGIN,
    databaseUrl: base.DATABASE_URL,
    betterAuthSecret: base.BETTER_AUTH_SECRET,
    googleClientId: base.GOOGLE_CLIENT_ID,
    googleClientSecret: base.GOOGLE_CLIENT_SECRET,
    resendApiKey: base.RESEND_API_KEY,
    waffoPrivateKey: base.WAFFO_PRIVATE_KEY,
    waffoWebhookSecret: base.WAFFO_WEBHOOK_SECRET,
  };
}
```

- [ ] **Step 4: Add the server-only singleton and documented environment file**

```ts
// src/platform/config/env.ts
import "server-only";
import { featuresConfig } from "@/config/features.config";
import { loadRuntimeEnv } from "./load-runtime-config";

export const env = loadRuntimeEnv(process.env, featuresConfig);
```

`.env.example` must list every variable with safe dummy descriptions, not usable credentials.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
bun run test:unit -- tests/unit/config/env.test.ts
bun run typecheck
```

Expected: PASS and exit `0`.

- [ ] **Step 6: Commit**

```bash
git add src/platform/config tests/unit/config .env.example
git commit -m "feat: add conditional runtime environment validation"
```

### Task 4: Add PostgreSQL/Drizzle foundation and migration verification

**Files:**
- Create: `src/platform/database/schema.ts`
- Create: `src/platform/database/client.ts`
- Create: `drizzle.config.ts`
- Create: `drizzle/0000_foundation.sql`
- Create: `scripts/db-migrate.ts`
- Create: `scripts/verify-migrations.ts`
- Create: `vitest.integration.config.ts`
- Create: `tests/integration/database/migrations.test.ts`

**Interfaces:**
- Produces: `db` and `createDatabaseClient(url)`.
- Produces deterministic migration commands used by every later schema task.

- [ ] **Step 1: Write the empty-database migration test**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runMigrations } from "../../../scripts/db-migrate";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const sql = postgres(url, { max: 1 });

describe("foundation migrations", () => {
  beforeAll(async () => {
    await sql`drop schema if exists public cascade`;
    await sql`create schema public`;
  });

  afterAll(async () => sql.end());

  it("installs sequentially from an empty database", async () => {
    await runMigrations(url);
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name = '__drizzle_migrations'
    `;
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/creat_web_test bun run test:integration`

Expected: FAIL because migration code does not exist.

- [ ] **Step 3: Implement database client and migration runner**

```ts
// src/platform/database/client.ts
import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export function createDatabaseClient(url: string) {
  const queryClient = postgres(url, { prepare: false });
  return { db: drizzle(queryClient), close: () => queryClient.end() };
}
```

```ts
// scripts/db-migrate.ts
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export async function runMigrations(url: string): Promise<void> {
  const client = postgres(url, { max: 1, prepare: false });
  try {
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  await runMigrations(url);
}
```

- [ ] **Step 4: Add the initial SQL migration**

```sql
CREATE TABLE IF NOT EXISTS platform_healthcheck (
  id integer PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_healthcheck_singleton CHECK (id = 1)
);
```

The table is intentionally minimal and is removed or retained only through a later reviewed migration; it proves migration installation without pre-creating auth/commerce abstractions.

- [ ] **Step 5: Run migration tests twice for idempotent history application**

Run:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/creat_web_test bun run test:integration
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/creat_web_test bun run test:integration
```

Expected: both runs PASS.

- [ ] **Step 6: Commit**

```bash
git add src/platform/database drizzle drizzle.config.ts scripts/db-migrate.ts scripts/verify-migrations.ts vitest.integration.config.ts tests/integration/database
git commit -m "feat: add deterministic PostgreSQL migration foundation"
```

### Task 5: Add structured logging and mandatory redaction

**Files:**
- Create: `src/platform/observability/redact.ts`
- Create: `src/platform/observability/logger.ts`
- Create: `tests/unit/observability/redact.test.ts`

**Interfaces:**
- Produces: `redactRecord(input: unknown): unknown`.
- Produces: `logger.info(event, data)`, `logger.warn(event, data)`, `logger.error(event, data)`.

- [ ] **Step 1: Write failing redaction tests**

```ts
import { expect, it } from "vitest";
import { redactRecord } from "@/platform/observability/redact";

it("redacts tokens, cookies, secrets, authorization and magic links recursively", () => {
  expect(
    redactRecord({
      token: "secret-token",
      nested: { authorization: "Bearer abc", cookie: "session=abc" },
      url: "https://example.com/auth/magic?token=abc",
      safe: "payment.succeeded",
    }),
  ).toEqual({
    token: "[REDACTED]",
    nested: { authorization: "[REDACTED]", cookie: "[REDACTED]" },
    url: "[REDACTED_URL]",
    safe: "payment.succeeded",
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:unit -- tests/unit/observability/redact.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement recursive redaction and JSON logger**

```ts
// src/platform/observability/redact.ts
const SECRET_KEY = /(token|secret|authorization|cookie|password|private.?key|signature)/i;

export function redactRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactRecord);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : redactRecord(child)]),
    );
  }
  if (typeof value === "string" && /\/auth\/magic\?.*token=/i.test(value)) return "[REDACTED_URL]";
  return value;
}
```

```ts
// src/platform/observability/logger.ts
import { redactRecord } from "./redact";

function write(level: "info" | "warn" | "error", event: string, data: Record<string, unknown> = {}) {
  const record = { level, event, at: new Date().toISOString(), ...redactRecord(data) as Record<string, unknown> };
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export const logger = {
  info: (event: string, data?: Record<string, unknown>) => write("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) => write("warn", event, data),
  error: (event: string, data?: Record<string, unknown>) => write("error", event, data),
};
```

- [ ] **Step 4: Run tests**

Run: `bun run test:unit -- tests/unit/observability/redact.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/observability tests/unit/observability
git commit -m "feat: add structured logging with recursive redaction"
```

### Task 6: Enforce architectural and server-only import boundaries

**Files:**
- Create: `eslint.config.mjs`
- Create: `tests/unit/architecture/import-boundaries.test.ts`
- Create: `src/modules/product/README.md`

**Interfaces:**
- Produces lint rules preventing platform-to-product imports and provider SDK leakage.

- [ ] **Step 1: Add an intentionally failing architecture fixture inside the test**

The test reads `eslint.config.mjs` and asserts the forbidden patterns exist:

```ts
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("forbids platform imports from product modules and raw provider SDK leakage", async () => {
  const config = await readFile("eslint.config.mjs", "utf8");
  expect(config).toContain("@/modules/*");
  expect(config).toContain("@waffo/pancake-ts");
  expect(config).toContain("better-auth");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:unit -- tests/unit/architecture/import-boundaries.test.ts`

Expected: FAIL because the lint config does not exist.

- [ ] **Step 3: Implement file-scoped import restrictions**

```js
// eslint.config.mjs
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "coverage/**", "playwright-report/**"]),
  {
    files: ["src/platform/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["@/modules/*", "@/modules/**"] }],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/platform/commerce/providers/waffo/**"],
    rules: {
      "no-restricted-imports": ["error", { paths: ["@waffo/pancake-ts"] }],
    },
  },
  {
    files: ["src/modules/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { paths: ["better-auth"] }],
    },
  },
]);
```

- [ ] **Step 4: Run architecture test and lint**

Run:

```bash
bun run test:unit -- tests/unit/architecture/import-boundaries.test.ts
bun run lint
```

Expected: PASS and exit `0`.

- [ ] **Step 5: Commit**

```bash
git add eslint.config.mjs tests/unit/architecture src/modules/product/README.md
git commit -m "chore: enforce module and provider import boundaries"
```

### Task 7: Add GitHub Actions CI with real PostgreSQL

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.secretlintrc.json`
- Create: `scripts/verify-release.ts`

**Interfaces:**
- Produces required PR checks for later plans.

- [ ] **Step 1: Create release verification script**

```ts
// scripts/verify-release.ts
import { featuresConfig } from "@/config/features.config";
import { siteConfig } from "@/config/site.config";
import { validateProductConfig } from "@/platform/config/validate-config";

validateProductConfig({ site: siteConfig, features: featuresConfig });

const serialized = JSON.stringify({ siteConfig, featuresConfig });
for (const forbidden of ["quickiching", "ichingcoin", "localhost:3000", "CHANGE_ME", "TODO"]) {
  if (serialized.toLowerCase().includes(forbidden.toLowerCase())) {
    throw new Error(`release configuration contains forbidden placeholder: ${forbidden}`);
  }
}

console.info("release configuration verified");
```

- [ ] **Step 2: Create CI workflow**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  quality:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: creat_web_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    env:
      NODE_ENV: test
      DATABASE_URL: postgres://postgres:postgres@localhost:5432/creat_web_test
      TEST_DATABASE_URL: postgres://postgres:postgres@localhost:5432/creat_web_test
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14
      - run: bun install --frozen-lockfile
      - run: bun run format:check
      - run: bun run lint
      - run: bun run typecheck
      - run: bun run test:unit
      - run: bun run test:integration
      - run: bun run build
      - run: bun run verify:architecture
      - run: bun run verify:secrets
      - run: bun run verify:release
```

- [ ] **Step 3: Run the exact CI command sequence locally**

Run:

```bash
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration
bun run build
bun run verify:architecture
bun run verify:secrets
bun run verify:release
```

Expected: every command exits `0`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml .secretlintrc.json scripts/verify-release.ts
git commit -m "ci: enforce foundation quality gates"
```

### Task 8: Complete foundation verification and PR evidence

**Files:**
- Create: `docs/decisions/0001-toolchain.md`
- Create: `docs/setup/local-development.md`
- Modify: `README.md`

**Interfaces:**
- Produces exact resolved tool versions and reproducible local setup for later agents.

- [ ] **Step 1: Record resolved versions**

Run:

```bash
bun --version
bun pm ls --all
```

Copy the exact Bun, Next.js, React, TypeScript, Drizzle, Vitest, and Playwright versions into `docs/decisions/0001-toolchain.md`, together with the reason for Bun and the rule that upgrades require a passing full gate.

- [ ] **Step 2: Write clean setup instructions**

`docs/setup/local-development.md` must contain the exact commands:

```bash
cp .env.example .env.local
bun install --frozen-lockfile
createdb creat_web_test
DATABASE_URL=postgres://localhost/creat_web_test bun run db:migrate
TEST_DATABASE_URL=postgres://localhost/creat_web_test bun run test:integration
bun run dev
```

- [ ] **Step 3: Run full foundation verification**

Run:

```bash
bun run verify
```

Expected: exit `0` with no skipped required foundation checks.

- [ ] **Step 4: Commit**

```bash
git add docs/decisions/0001-toolchain.md docs/setup/local-development.md README.md
git commit -m "docs: document foundation toolchain and setup"
```

## Foundation Exit Gate

Before requesting review, attach evidence that:

- `bun install --frozen-lockfile` succeeds;
- empty PostgreSQL migration installation passes twice;
- configuration contradictions are rejected by tests;
- production env validation fails closed;
- architecture lint rules are active;
- tokens/secrets are redacted;
- production `next build` succeeds without external provider credentials in test-disabled mode;
- CI passes on the branch;
- no Quick I Ching names, IDs, copy, or domain concepts occur outside the historical design documents.
