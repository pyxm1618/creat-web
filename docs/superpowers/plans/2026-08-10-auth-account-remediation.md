# Authentication and Account Deletion Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Better Auth public bypasses, remove raw session-token exposure, enforce fresh authentication for billing mutations, and make commerce-enabled account deletion durable.

**Architecture:** The public Better Auth catch-all becomes an allowlisted security boundary while internal Better Auth API calls remain available to trusted server code. Account deletion continues through the existing leased state machine; a Commerce coordinator contributes deterministic cancellation commands and refuses identity deletion until those commands complete.

**Tech Stack:** Next.js 16 App Router, Better Auth 1.6.25, TypeScript 5.9, Drizzle ORM 0.45, PostgreSQL, Vitest, Playwright.

## Global Constraints

- Keep PR #7 open, Draft, and unmerged.
- Do not replace Better Auth or add a second authentication framework.
- Do not bypass Turnstile, platform rate limits, origin validation, or fresh-session validation.
- Keep financial and entitlement audit rows attached to the pseudonymous account subject after identity deletion.
- Follow red-green-refactor for every behavior change.

---

### Task 1: Public Better Auth Route Boundary

**Files:**
- Create: `src/platform/auth/public-route-policy.ts`
- Modify: `src/app/api/auth/[...all]/route.ts`
- Modify: `src/platform/auth/create-auth.ts`
- Modify: `tests/e2e/auth.spec.ts`
- Test: `tests/unit/auth/public-route-policy.test.ts`

**Interfaces:**
- Produces: `isBlockedPublicAuthRequest(request: Request): boolean`
- Blocks: `POST /api/auth/delete-user` and `POST /api/auth/sign-in/magic-link`
- Preserves: internal `auth.api.deleteUser(...)` and `auth.api.signInMagicLink(...)`

- [ ] **Step 1: Write the failing policy and browser tests**

```ts
expect(
  isBlockedPublicAuthRequest(
    new Request("https://app.example/api/auth/delete-user", { method: "POST" }),
  ),
).toBe(true);
expect(
  isBlockedPublicAuthRequest(
    new Request("https://app.example/api/auth/sign-in/magic-link", { method: "POST" }),
  ),
).toBe(true);
expect(
  isBlockedPublicAuthRequest(
    new Request("https://app.example/api/auth/callback/google", { method: "GET" }),
  ),
).toBe(false);
```

Add Playwright requests for both blocked POST paths and assert `404`; retain the existing custom Magic Link test as proof that `/api/auth/magic-link/request` still works.

- [ ] **Step 2: Run the tests and verify the expected failure**

```bash
bunx vitest run --config vitest.config.ts tests/unit/auth/public-route-policy.test.ts
bunx playwright test tests/e2e/auth.spec.ts
```

Expected: the unit test cannot import the policy and the public native endpoints do not return `404`.

- [ ] **Step 3: Implement the minimal route policy and remove Bearer auth**

```ts
const blockedPostPaths = new Set(["/api/auth/delete-user", "/api/auth/sign-in/magic-link"]);

export function isBlockedPublicAuthRequest(request: Request): boolean {
  return request.method === "POST" && blockedPostPaths.has(new URL(request.url).pathname);
}
```

Call the policy before `toNextJsHandler(auth)` and return `new Response("Not Found", { status: 404 })` when blocked. Remove `bearer` from the Better Auth plugin import and plugin array; keep the Magic Link plugin because the trusted custom route invokes it internally.

- [ ] **Step 4: Run focused tests and the auth build path**

```bash
bunx vitest run --config vitest.config.ts tests/unit/auth/public-route-policy.test.ts
bunx playwright test tests/e2e/auth.spec.ts
bun run typecheck
```

Expected: all commands exit `0`.

- [ ] **Step 5: Commit the boundary**

```bash
git add src/platform/auth/public-route-policy.ts 'src/app/api/auth/[...all]/route.ts' src/platform/auth/create-auth.ts tests/unit/auth/public-route-policy.test.ts tests/e2e/auth.spec.ts
git commit -m "fix(auth): close native endpoint bypasses"
```

### Task 2: Session Revocation Without Browser-visible Tokens

**Files:**
- Modify: `src/app/(account)/account/security/page.tsx`
- Modify: `src/app/(account)/account/security/actions.ts`
- Test: `tests/e2e/auth.spec.ts`

**Interfaces:**
- Browser input: `sessionId: string`
- Server resolution: reload the authenticated user's sessions and select exactly one matching `session.id`
- Better Auth call: `revokeSession({ body: { token: matched.token }, headers })`

- [ ] **Step 1: Add a failing security-page test**

```ts
const html = await (await request.get("/account/security")).text();
expect(html).not.toContain(contextSessionToken);
expect(html).toContain('name="sessionId"');
```

Use an authenticated browser context created through the existing scanner-safe Magic Link flow. Revoke another seeded session by id and assert that the target session disappears while the current session remains valid.

- [ ] **Step 2: Run the browser test and verify token leakage is observed**

```bash
bunx playwright test tests/e2e/auth.spec.ts --grep "session revocation"
```

Expected: the rendered HTML contains the raw token or lacks a `sessionId` field.

- [ ] **Step 3: Replace the form contract and resolve ownership server-side**

```ts
const sessionId = formData.get("sessionId");
if (typeof sessionId !== "string" || sessionId.length < 1) throw new Error("invalid session id");
const requestHeaders = await authenticatedHeaders();
const auth = requireAuth();
const sessions = await auth.api.listSessions({ headers: requestHeaders });
const matched = sessions.filter((session) => session.id === sessionId);
if (matched.length !== 1 || !matched[0]) throw new Error("session not found");
await auth.api.revokeSession({ body: { token: matched[0].token }, headers: requestHeaders });
```

Render only `session.id` in the hidden form field. Continue comparing tokens only inside the server component to label the current session.

- [ ] **Step 4: Run auth tests and typecheck**

```bash
bunx playwright test tests/e2e/auth.spec.ts --grep "session revocation"
bun run typecheck
```

Expected: both commands exit `0`, and the HTML assertion proves no raw session token is serialized.

- [ ] **Step 5: Commit the session fix**

```bash
git add 'src/app/(account)/account/security/page.tsx' 'src/app/(account)/account/security/actions.ts' tests/e2e/auth.spec.ts
git commit -m "fix(auth): keep session tokens server side"
```

### Task 3: Fresh-session Enforcement for Billing Mutations

**Files:**
- Create: `src/platform/auth/fresh-account-session.ts`
- Modify: `src/app/api/commerce/refunds/route.ts`
- Modify: `src/app/api/commerce/subscription/cancel/route.ts`
- Modify: `src/app/api/commerce/subscription/resume/route.ts`
- Test: `tests/e2e/auth.spec.ts`

**Interfaces:**
- Produces: `requireFreshAccountSession(headers: Headers, now?: Date): Promise<AccountContext>`
- Returns `401` for no account and `403` with `{ error: "fresh_authentication_required" }` for a stale/invalid session at each route boundary.

- [ ] **Step 1: Add failing stale-session route tests**

```ts
for (const path of [
  "/api/commerce/refunds",
  "/api/commerce/subscription/cancel",
  "/api/commerce/subscription/resume",
]) {
  const response = await staleSessionRequest.post(path, {
    headers: { origin: APP_ORIGIN, "content-type": "application/json", "idempotency-key": key },
    data: validBodies[path],
  });
  expect(response.status()).toBe(403);
  expect(await response.json()).toEqual({ error: "fresh_authentication_required" });
}
```

- [ ] **Step 2: Run the focused Playwright test and observe that stale sessions pass the freshness boundary**

```bash
bunx playwright test tests/e2e/auth.spec.ts --grep "billing mutations require a fresh session"
```

Expected: one or more routes return a status other than `403`.

- [ ] **Step 3: Implement one shared boundary and map errors explicitly**

```ts
export async function requireFreshAccountSession(
  headers: Headers,
  now = new Date(),
): Promise<AccountContext> {
  const account = await getAccountContext(headers);
  if (!account) throw new AuthenticationRequiredError();
  assertFreshSession({ authenticatedAt: new Date(account.session.createdAt) }, now);
  return account;
}
```

Each route catches only the typed authentication and freshness errors before parsing or enqueuing a command; all other errors retain their current route-specific mapping.

- [ ] **Step 4: Run browser, unit, and type checks**

```bash
bunx playwright test tests/e2e/auth.spec.ts --grep "billing mutations require a fresh session"
bunx vitest run --config vitest.config.ts tests/unit/auth/authorization.test.ts
bun run typecheck
```

Expected: all commands exit `0`.

- [ ] **Step 5: Commit fresh-session enforcement**

```bash
git add src/platform/auth/fresh-account-session.ts src/app/api/commerce/refunds/route.ts src/app/api/commerce/subscription/cancel/route.ts src/app/api/commerce/subscription/resume/route.ts tests/e2e/auth.spec.ts
git commit -m "fix(auth): require fresh billing sessions"
```

### Task 4: Durable Commerce Account-deletion Preparation

**Files:**
- Modify: `src/platform/accounts/platform-account-deletion-coordinator.ts`
- Modify: `src/platform/accounts/account-deletion-runtime.ts`
- Modify: `scripts/verify-release.ts`
- Test: `tests/integration/accounts/account-deletion-worker.test.ts`
- Test: `tests/integration/accounts/account-deletion.test.ts`
- Test: `tests/unit/config/validate-config.test.ts`

**Interfaces:**
- `createPlatformAccountDeletionCoordinator(input: { database: DatabaseClient; getCommerce: typeof getCommerceRuntime }): AccountDeletionCoordinator`
- Deterministic command key: `account-delete:${operationKey}:${subscriptionId}`
- Prepared states: subscription `canceling | canceled | expired | closed` and matching command `completed`

- [ ] **Step 1: Add failing coordinator integration tests**

```ts
await coordinator.prepare({ subjectId: subject.id, operationKey: deletionRequest.id });
const commands = await database.db
  .select()
  .from(commerceCommandJobs)
  .where(eq(commerceCommandJobs.idempotencyKey, `account-delete:${deletionRequest.id}:${subscription.id}`));
expect(commands).toHaveLength(1);
await expect(
  coordinator.prepare({ subjectId: subject.id, operationKey: deletionRequest.id }),
).rejects.toThrow("commerce account deletion preparation pending");
```

Then mark the command completed and subscription canceling, call `prepare` twice, and assert both calls succeed without inserting another command. Add a deletion-service test proving that the auth identity remains present while preparation is pending.

- [ ] **Step 2: Run the integration tests and verify the feature-flag stub fails**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/accounts/account-deletion-worker.test.ts tests/integration/accounts/account-deletion.test.ts
```

Expected: the commerce coordinator throws `commerce deletion coordinator is not configured` and no deterministic command exists.

- [ ] **Step 3: Implement deterministic preparation through the existing command queue**

```ts
for (const subscription of nonTerminalSubscriptions) {
  const idempotencyKey = `account-delete:${operationKey}:${subscription.id}`;
  await enqueueSubscriptionCommand(database, {
    subjectId,
    subscriptionId: subscription.id,
    command: "subscription_cancel",
    idempotencyKey,
  });
  const command = await loadCommandByIdempotencyKey(database, idempotencyKey);
  if (command.state === "dead_letter") throw new Error("commerce account deletion requires operator review");
  if (command.state !== "completed" || !terminalOrCanceling.has(subscription.status)) {
    throw new Error("commerce account deletion preparation pending");
  }
}
```

The coordinator returns immediately when Commerce is disabled. Wire `db` and `getCommerceRuntime` in the existing account deletion runtime. Extend release verification with a commerce-enabled configuration case that must construct the coordinator instead of accepting the old stub.

- [ ] **Step 4: Run account, Commerce, release, and type checks**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/accounts/account-deletion-worker.test.ts tests/integration/accounts/account-deletion.test.ts
bun run verify:commerce
bun run verify:release
bun run typecheck
```

Expected: all commands exit `0`; tests show the identity is not detached until cancellation preparation completes.

- [ ] **Step 5: Commit the deletion coordinator**

```bash
git add src/platform/accounts/platform-account-deletion-coordinator.ts src/platform/accounts/account-deletion-runtime.ts scripts/verify-release.ts tests/integration/accounts/account-deletion-worker.test.ts tests/integration/accounts/account-deletion.test.ts tests/unit/config/validate-config.test.ts
git commit -m "fix(accounts): coordinate commerce deletion"
```
