# creat-web Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement production-grade Better Auth authentication with Google OAuth, hashed single-use magic links, durable rate limiting, database sessions, server-side authorization, and retryable account deletion.

**Architecture:** Better Auth owns the canonical `user`, `session`, `account`, `verification`, and database rate-limit records. Product tables reference the Better Auth user ID directly. Provider/UI code consumes a narrow platform session and authorization API; no second synchronized user table or custom email-equality merge is created.

**Tech Stack:** Better Auth stable release, Better Auth Drizzle adapter and CLI, PostgreSQL/Drizzle, Resend, Next.js route handlers/server actions, Zod, Vitest, Playwright.

## Global Constraints

- Execute only after the foundation plan exit gate passes.
- Password sign-in, password reset, passkeys, 2FA, organizations, and custom JWT auth are excluded.
- Google and magic link are the only v1 sign-in methods.
- Better Auth-generated schema is committed and migrated through Drizzle; do not use schema push in production.
- Magic-link tokens, OAuth codes, cookies, session tokens, and full URLs never enter logs or analytics.
- Production rate limits use database storage; in-memory-only counters are forbidden.
- Email equality alone never triggers a custom account merge.
- Middleware is not the authorization boundary; every protected read/mutation checks identity and resource ownership server-side.
- Account deletion immediately revokes sessions and uses a retryable workflow; financial records are not cascade-deleted.

---

## File Map

- `src/platform/auth/auth.ts` — Better Auth composition root.
- `src/platform/auth/auth-client.ts` — browser client, isolated from product modules.
- `src/platform/auth/session.ts` — server session retrieval and fresh-session assertion.
- `src/platform/auth/authorization.ts` — owner/operator policies.
- `src/platform/auth/callback-url.ts` — callback allowlist.
- `src/platform/auth/email-normalization.ts` — deterministic normalization.
- `src/platform/email/email-sender.ts` — provider-neutral transport contract.
- `src/platform/email/resend-email-sender.ts` — production transport.
- `src/platform/email/test-email-sender.ts` — database-backed test transport.
- `src/platform/database/auth-schema.ts` — generated Better Auth Drizzle schema.
- `src/platform/database/account-lifecycle-schema.ts` — deletion/test-mail records.
- `src/app/api/auth/[...all]/route.ts` — Better Auth handler.
- `src/app/(account)/sign-in/page.tsx` — Google/magic-link UI.
- `src/app/(account)/account/security/page.tsx` — sessions and deletion UI.
- `src/app/(account)/account/security/actions.ts` — protected mutations.
- `src/platform/auth/account-deletion.ts` — deletion request state machine.
- `tests/unit/auth/*`, `tests/integration/auth/*`, `tests/e2e/auth.spec.ts` — test suites.

### Task 1: Install Better Auth and define the email transport boundary

**Files:**
- Modify: `package.json`
- Create: `src/platform/email/email-sender.ts`
- Create: `src/platform/email/resend-email-sender.ts`
- Create: `src/platform/email/test-email-sender.ts`
- Create: `tests/unit/email/email-sender.test.ts`

**Interfaces:**
- Produces: `EmailSender.send(message: TransactionalEmail): Promise<{ providerMessageId: string }>`.
- Produces: `createEmailSender(runtime): EmailSender`.

- [ ] **Step 1: Install pinned packages**

Run:

```bash
bun add --exact better-auth@latest @better-auth/drizzle-adapter@latest resend@latest
```

Expected: exact versions are written and `bun.lock` changes.

- [ ] **Step 2: Write the failing transport contract test**

```ts
import { expect, it } from "vitest";
import { createTestEmailSender } from "@/platform/email/test-email-sender";

it("stores only the destination, template and opaque provider id", async () => {
  const sender = createTestEmailSender();
  const result = await sender.send({
    to: "user@example.com",
    template: "magic-link",
    subject: "Sign in",
    html: "<a href=\"https://example.com/api/auth/magic-link/verify?token=secret\">Sign in</a>",
  });
  expect(result.providerMessageId).toMatch(/^test_/);
  expect(sender.messages[0]?.to).toBe("user@example.com");
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun run test:unit -- tests/unit/email/email-sender.test.ts`

Expected: FAIL because the transport does not exist.

- [ ] **Step 4: Implement the transport contract and in-process unit-test sender**

```ts
// src/platform/email/email-sender.ts
export type TransactionalEmail = {
  to: string;
  template: "magic-link" | "account-deletion" | "security-notice";
  subject: string;
  html: string;
};

export interface EmailSender {
  send(message: TransactionalEmail): Promise<{ providerMessageId: string }>;
}
```

```ts
// src/platform/email/test-email-sender.ts
import type { EmailSender, TransactionalEmail } from "./email-sender";

export function createTestEmailSender() {
  const messages: TransactionalEmail[] = [];
  const sender: EmailSender & { messages: TransactionalEmail[] } = {
    messages,
    async send(message) {
      messages.push(message);
      return { providerMessageId: `test_${messages.length}` };
    },
  };
  return sender;
}
```

Production `resend-email-sender.ts` must call `resend.emails.send`, use configured sender/support values, return the Resend message ID, and log only a redacted error category and provider ID.

- [ ] **Step 5: Run tests and commit**

Run: `bun run test:unit -- tests/unit/email/email-sender.test.ts`

Expected: PASS.

```bash
git add package.json bun.lock src/platform/email tests/unit/email
git commit -m "feat: add transactional email transport boundary"
```

### Task 2: Compose Better Auth and generate the authoritative Drizzle schema

**Files:**
- Create: `src/platform/auth/auth.ts`
- Create: `src/platform/database/auth-schema.ts` via CLI
- Modify: `src/platform/database/schema.ts`
- Create: `tests/integration/auth/schema.test.ts`
- Create: new generated Drizzle migration under `drizzle/`

**Interfaces:**
- Produces: `auth` Better Auth instance.
- Produces schema exports `user`, `session`, `account`, `verification`, and `rateLimit` generated from the current stable Better Auth configuration.

- [ ] **Step 1: Write the schema integration test first**

```ts
import { describe, expect, it } from "vitest";
import postgres from "postgres";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const sql = postgres(url, { max: 1 });

describe("Better Auth schema", () => {
  it("contains all canonical auth and durable rate-limit tables", async () => {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public'
    `;
    const names = rows.map((row) => row.table_name);
    expect(names).toEqual(expect.arrayContaining(["user", "session", "account", "verification", "rateLimit"]));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run db:migrate
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/auth/schema.test.ts
```

Expected: FAIL because auth tables do not exist.

- [ ] **Step 3: Create Better Auth configuration before generation**

```ts
// src/platform/auth/auth.ts
import "server-only";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { db } from "@/platform/database/client";
import * as schema from "@/platform/database/auth-schema";
import { env } from "@/platform/config/env";
import { siteConfig } from "@/config/site.config";
import { sendMagicLinkEmail } from "./magic-link-email";

export const auth = betterAuth({
  appName: siteConfig.name,
  baseURL: env.appOrigin,
  secret: env.betterAuthSecret,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  trustedOrigins: env.appOrigin ? [env.appOrigin] : [],
  emailAndPassword: { enabled: false },
  socialProviders: env.googleClientId && env.googleClientSecret
    ? { google: { clientId: env.googleClientId, clientSecret: env.googleClientSecret } }
    : {},
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, freshAge: 60 * 15 },
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 100,
    customRules: { "/sign-in/magic-link": { window: 60, max: 5 } },
  },
  advanced: { cookiePrefix: siteConfig.slug },
  plugins: [
    magicLink({
      expiresIn: 60 * 10,
      sendMagicLink: async ({ email, url }) => sendMagicLinkEmail({ email, url }),
    }),
  ],
});
```

Keep environment parsing compatible with schema generation by supplying explicit test values to the CLI command; never weaken production validation.

- [ ] **Step 4: Generate the schema with the official CLI**

Run:

```bash
DATABASE_URL="$TEST_DATABASE_URL" \
APP_ORIGIN="http://localhost:3000" \
BETTER_AUTH_SECRET="schema-generation-secret-with-at-least-32-characters" \
bunx auth@latest generate \
  --config src/platform/auth/auth.ts \
  --output src/platform/database/auth-schema.ts \
  --yes
```

Expected: the CLI creates a Drizzle schema containing the configured core/plugin tables. Review the generated diff; do not rename model property keys expected by Better Auth.

- [ ] **Step 5: Generate and apply the Drizzle migration**

Run:

```bash
bun run db:generate
DATABASE_URL="$TEST_DATABASE_URL" bun run db:migrate
```

Expected: a versioned SQL migration is added and applied.

- [ ] **Step 6: Run schema and empty-database tests**

Run:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/auth/schema.test.ts tests/integration/database/migrations.test.ts
```

Expected: PASS.

- [ ] **Step 7: Verify generation is stable**

Run the same `bunx auth@latest generate ...` command again.

Expected: `git diff -- src/platform/database/auth-schema.ts` is empty.

- [ ] **Step 8: Commit**

```bash
git add src/platform/auth/auth.ts src/platform/database/auth-schema.ts src/platform/database/schema.ts drizzle tests/integration/auth/schema.test.ts
git commit -m "feat: add canonical Better Auth database schema"
```

### Task 3: Implement safe callback paths, email normalization, and magic-link delivery

**Files:**
- Create: `src/platform/auth/callback-url.ts`
- Create: `src/platform/auth/email-normalization.ts`
- Create: `src/platform/auth/magic-link-email.ts`
- Create: `tests/unit/auth/callback-url.test.ts`
- Create: `tests/unit/auth/email-normalization.test.ts`
- Create: `tests/unit/auth/magic-link-email.test.ts`

**Interfaces:**
- Produces: `normalizeEmail(input: string): string`.
- Produces: `assertAllowedCallbackPath(input: string): string`.
- Produces: `sendMagicLinkEmail({ email, url }): Promise<void>`.

- [ ] **Step 1: Write failing callback and normalization tests**

```ts
import { expect, it } from "vitest";
import { assertAllowedCallbackPath } from "@/platform/auth/callback-url";
import { normalizeEmail } from "@/platform/auth/email-normalization";

it("allows only approved relative callback paths", () => {
  expect(assertAllowedCallbackPath("/account")).toBe("/account");
  expect(() => assertAllowedCallbackPath("https://evil.example/steal")).toThrow("untrusted callback");
  expect(() => assertAllowedCallbackPath("//evil.example/steal")).toThrow("untrusted callback");
});

it("normalizes surrounding whitespace and ASCII email case", () => {
  expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:unit -- tests/unit/auth`

Expected: FAIL.

- [ ] **Step 3: Implement the pure guards**

```ts
export function assertAllowedCallbackPath(input: string): string {
  if (!input.startsWith("/") || input.startsWith("//") || input.includes("\\")) {
    throw new Error("untrusted callback");
  }
  const pathname = new URL(input, "https://internal.invalid").pathname;
  const allowed = ["/", "/account", "/account/security", "/pricing"];
  if (!allowed.includes(pathname)) throw new Error("untrusted callback");
  return pathname;
}
```

```ts
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}
```

`sendMagicLinkEmail` must validate that the generated URL uses the configured application origin, create branded HTML without logging the URL, and use the configured `EmailSender`.

- [ ] **Step 4: Run tests and commit**

Run: `bun run test:unit -- tests/unit/auth`

Expected: PASS.

```bash
git add src/platform/auth/callback-url.ts src/platform/auth/email-normalization.ts src/platform/auth/magic-link-email.ts tests/unit/auth
git commit -m "feat: secure magic-link callbacks and delivery"
```

### Task 4: Add Next.js auth handlers, client, and sign-in page

**Files:**
- Create: `src/app/api/auth/[...all]/route.ts`
- Create: `src/platform/auth/auth-client.ts`
- Create: `src/app/(account)/sign-in/page.tsx`
- Create: `src/app/(account)/sign-in/sign-in-form.tsx`
- Create: `tests/e2e/auth.spec.ts`
- Create: `playwright.config.ts`

**Interfaces:**
- Produces: `/api/auth/*` Better Auth routes.
- Produces: Google and magic-link sign-in UI; no password controls.

- [ ] **Step 1: Write the failing browser test**

```ts
import { expect, test } from "@playwright/test";

test("sign-in page exposes Google and magic link but no password", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
  await expect(page.getByLabel(/email/i)).toBeVisible();
  await expect(page.getByLabel(/password/i)).toHaveCount(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:e2e -- tests/e2e/auth.spec.ts`

Expected: FAIL because `/sign-in` is missing.

- [ ] **Step 3: Implement the route handler**

```ts
// src/app/api/auth/[...all]/route.ts
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/platform/auth/auth";

export const { GET, POST } = toNextJsHandler(auth);
```

- [ ] **Step 4: Implement the isolated client and form**

```ts
// src/platform/auth/auth-client.ts
"use client";
import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({ plugins: [magicLinkClient()] });
```

The form calls `authClient.signIn.social({ provider: "google", callbackURL: "/account" })` and `authClient.signIn.magicLink({ email, callbackURL: "/account" })`. It always displays a generic magic-link acknowledgement and never reveals whether the account exists.

- [ ] **Step 5: Run browser and build tests**

Run:

```bash
bun run test:e2e -- tests/e2e/auth.spec.ts
bun run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/auth src/app/'(account)'/sign-in src/platform/auth/auth-client.ts tests/e2e/auth.spec.ts playwright.config.ts
git commit -m "feat: add Google and magic-link sign-in surface"
```

### Task 5: Prove hashed storage, atomic single use, and durable rate limits

**Files:**
- Create: `tests/integration/auth/magic-link-concurrency.test.ts`
- Create: `tests/integration/auth/rate-limit.test.ts`
- Create: `src/platform/email/database-test-email-sender.ts`
- Create: `src/platform/database/test-email-schema.ts`
- Create: migration under `drizzle/`

**Interfaces:**
- Produces database-backed test email retrieval for Playwright only in `NODE_ENV=test`.

- [ ] **Step 1: Write the concurrent redemption test**

Create a magic link through the real auth endpoint/test sender, then submit the same verification URL in two concurrent requests:

```ts
const [first, second] = await Promise.all([
  fetch(url, { redirect: "manual" }),
  fetch(url, { redirect: "manual" }),
]);
expect([first.status, second.status].sort()).toEqual([302, 400]);
```

Also query the `verification` table before redemption and assert the plaintext token from the URL does not occur in the stored value.

- [ ] **Step 2: Write the cross-instance rate-limit test**

Create two independently composed Better Auth instances pointing at the same PostgreSQL database. Alternate magic-link send requests between them and assert the sixth request inside the window is rate-limited.

- [ ] **Step 3: Run to verify failures**

Run:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/auth/magic-link-concurrency.test.ts tests/integration/auth/rate-limit.test.ts
```

Expected: FAIL until the test transport and database-backed configuration are complete.

- [ ] **Step 4: Implement test-mail persistence and complete configuration**

The test-only mail table stores `id`, normalized destination, template, HTML, created time, and consumed time. The retrieval helper must require `NODE_ENV=test`, return the latest unconsumed message, and mark it consumed transactionally. Production code must never expose a route that returns message HTML.

- [ ] **Step 5: Run the integration tests repeatedly**

Run the two tests five times:

```bash
for i in 1 2 3 4 5; do TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/auth/magic-link-concurrency.test.ts tests/integration/auth/rate-limit.test.ts || exit 1; done
```

Expected: all five iterations PASS; exactly one redemption succeeds each time.

- [ ] **Step 6: Commit**

```bash
git add src/platform/email/database-test-email-sender.ts src/platform/database/test-email-schema.ts drizzle tests/integration/auth
git commit -m "test: prove atomic magic links and durable auth limits"
```

### Task 6: Add server session and resource authorization APIs

**Files:**
- Create: `src/platform/auth/session.ts`
- Create: `src/platform/auth/authorization.ts`
- Create: `tests/unit/auth/authorization.test.ts`
- Create: `tests/integration/auth/session.test.ts`

**Interfaces:**
- Produces: `getCurrentSession(headers): Promise<PlatformSession | null>`.
- Produces: `requireUser(headers): Promise<PlatformUser>`.
- Produces: `requireFreshUser(headers): Promise<PlatformUser>`.
- Produces: `assertOwner({ actorUserId, resourceUserId }): void`.

- [ ] **Step 1: Write failing owner and freshness tests**

```ts
import { expect, it } from "vitest";
import { assertOwner } from "@/platform/auth/authorization";

it("denies cross-user resource access", () => {
  expect(() => assertOwner({ actorUserId: "user_a", resourceUserId: "user_b" })).toThrow("not authorized");
});
```

Integration tests must create a session, verify retrieval, revoke it, and assert subsequent retrieval returns null. A session older than 15 minutes must fail `requireFreshUser`.

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:unit -- tests/unit/auth/authorization.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement normalized platform types and server helpers**

```ts
export type PlatformUser = { id: string; email: string; name: string | null };
export type PlatformSession = { user: PlatformUser; sessionId: string; createdAt: Date; expiresAt: Date };

export function assertOwner(input: { actorUserId: string; resourceUserId: string }): void {
  if (input.actorUserId !== input.resourceUserId) throw new Error("not authorized");
}
```

`session.ts` calls `auth.api.getSession({ headers })`, maps Better Auth output to platform types, and performs freshness checks server-side.

- [ ] **Step 4: Run unit/integration tests and commit**

Run:

```bash
bun run test:unit -- tests/unit/auth/authorization.test.ts
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/auth/session.test.ts
```

Expected: PASS.

```bash
git add src/platform/auth/session.ts src/platform/auth/authorization.ts tests/unit/auth/authorization.test.ts tests/integration/auth/session.test.ts
git commit -m "feat: add server session and ownership authorization"
```

### Task 7: Add session-management and account-security UI

**Files:**
- Create: `src/app/(account)/account/layout.tsx`
- Create: `src/app/(account)/account/security/page.tsx`
- Create: `src/app/(account)/account/security/actions.ts`
- Modify: `tests/e2e/auth.spec.ts`

**Interfaces:**
- Produces protected account pages, list/revoke session actions, sign-out, and fresh-session feedback.

- [ ] **Step 1: Extend E2E with protected route and revocation behavior**

Add tests asserting anonymous access redirects to `/sign-in`, an authenticated test session sees active sessions, revoking another session removes it, and revoking all sessions denies subsequent account access.

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:e2e -- tests/e2e/auth.spec.ts`

Expected: FAIL.

- [ ] **Step 3: Implement protected server layout and actions**

Every action calls `requireUser` or `requireFreshUser` and invokes Better Auth server APIs. Do not pass session tokens to the browser; expose only masked device/session metadata and whether a row is current.

- [ ] **Step 4: Run E2E and commit**

Run: `bun run test:e2e -- tests/e2e/auth.spec.ts`

Expected: PASS.

```bash
git add src/app/'(account)'/account tests/e2e/auth.spec.ts
git commit -m "feat: add account session security controls"
```

### Task 8: Implement retryable account deletion state

**Files:**
- Create: `src/platform/database/account-lifecycle-schema.ts`
- Create: `src/platform/auth/account-deletion.ts`
- Create: `src/app/(account)/account/delete/page.tsx`
- Create: `src/app/(account)/account/delete/actions.ts`
- Create: `tests/unit/auth/account-deletion.test.ts`
- Create: `tests/integration/auth/account-deletion.test.ts`
- Modify: Drizzle schema/migrations

**Interfaces:**
- Produces: `requestAccountDeletion(userId, reason): Promise<DeletionRequest>`.
- Produces: `processAccountDeletion(requestId): Promise<void>`.
- Produces states `requested | sessions_revoked | processing | completed | retry | blocked`.

- [ ] **Step 1: Write failing state-machine and integration tests**

Tests must assert:

- duplicate requests return the same active request;
- a fresh session is required;
- all sessions are revoked immediately after the request is accepted;
- retrying after a simulated downstream failure does not create a second request;
- an identity is pseudonymized/deleted according to Better Auth support while a synthetic financial record remains.

- [ ] **Step 2: Run to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/auth/account-deletion.test.ts
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/auth/account-deletion.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement transactionally recorded deletion request and worker**

The request transaction inserts the unique active request and revokes sessions. Processing records each completed phase and catches retryable failures without restoring sessions. Until commerce deletion participation is implemented, production release validation must mark commerce-enabled deletion as incomplete rather than silently deleting around subscriptions.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
bun run test:unit -- tests/unit/auth/account-deletion.test.ts
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/auth/account-deletion.test.ts
bun run test:e2e -- tests/e2e/auth.spec.ts
```

Expected: PASS.

```bash
git add src/platform/database/account-lifecycle-schema.ts src/platform/auth/account-deletion.ts src/app/'(account)'/account/delete tests/unit/auth/account-deletion.test.ts tests/integration/auth/account-deletion.test.ts drizzle
git commit -m "feat: add retryable secure account deletion workflow"
```

### Task 9: Complete authentication staging verification

**Files:**
- Create: `docs/setup/google-oauth.md`
- Create: `docs/setup/resend-magic-link.md`
- Create: `docs/runbooks/auth-incidents.md`
- Modify: `.env.example`
- Modify: `scripts/verify-release.ts`

**Interfaces:**
- Produces reproducible operator setup and production-release checks.

- [ ] **Step 1: Add production config checks**

`verify-release.ts` must reject auth enabled with missing HTTPS origin, Better Auth secret, Google credentials, Resend key/sender, trusted origin, support email, or database-backed rate-limit mode.

- [ ] **Step 2: Document exact Google/Resend setup and rotation steps**

Include local, staging, and production callback URLs; separate credentials; verified sender domain; key rotation; failure rollback; and the rule that no wildcard redirect origin is accepted.

- [ ] **Step 3: Run the full authentication gate**

Run:

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration
bun run build
bun run test:e2e -- tests/e2e/auth.spec.ts
bun run verify:release
```

Expected: every command exits `0`.

- [ ] **Step 4: Perform isolated staging smoke tests**

Verify with real staging credentials:

- Google sign-in completes and reuses the same user on repeat sign-in;
- magic link arrives from the verified domain and expires after 10 minutes;
- a link succeeds only once;
- Google-first then magic-link and magic-link-first then Google follow the reviewed linking policy;
- revoke-all denies all prior sessions;
- no token/link appears in Vercel logs or analytics;
- account deletion revokes access immediately.

Record evidence in the PR without copying secrets or private links.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/setup docs/runbooks/auth-incidents.md .env.example scripts/verify-release.ts
git commit -m "docs: add authentication setup and incident runbook"
```

## Authentication Exit Gate

Before requesting review, prove:

- Better Auth schema regenerates without diff and installs from an empty PostgreSQL database;
- Google and magic-link sign-in work in isolated staging;
- no password route or UI exists;
- magic-link token is hashed at rest and concurrent redemption succeeds exactly once;
- rate limiting is database-backed and works across two auth instances;
- callback allowlist rejects absolute/protocol-relative attacker URLs;
- server-side resource ownership tests deny cross-user access;
- session revoke-one/revoke-all and fresh-session checks pass;
- account deletion is idempotent, revokes sessions immediately, and preserves synthetic financial records;
- logs and analytics contain no auth secrets, tokens, links, or raw cookies;
- full CI/build/E2E gates pass.
