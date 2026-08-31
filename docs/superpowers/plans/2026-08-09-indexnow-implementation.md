# IndexNow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional, authenticated IndexNow URL-change notifications to the SEO-first starter and make the capability part of authoritative CI verification.

**Architecture:** A shared server-only IndexNow module validates the public key and canonical-origin URLs, builds the official batch payload, and submits to the global IndexNow endpoint. A fixed root key-verification route exposes the configured key, while an authenticated internal route and CLI invoke the shared module. Runtime configuration keeps the feature disabled when `INDEXNOW_KEY` is absent.

**Tech Stack:** Next.js 16 App Router, TypeScript, Bun, Zod, Vitest, existing GitHub Actions quality gates.

## Global Constraints

- Do not submit the entire sitemap on every deployment.
- Submit only recently added, updated, deleted, moved, or redirected URLs.
- Use `https://api.indexnow.org/indexnow`.
- Maximum 10,000 URLs per POST.
- Provider HTTP 200 and 202 are accepted.
- Only canonical-origin URLs may be submitted.
- `INDEXNOW_KEY` is public ownership verification, not internal API authentication.
- Reuse `CRON_SECRET` for internal submission authorization.
- IndexNow remains disabled when `INDEXNOW_KEY` is absent.
- Do not weaken any existing SEO, security, E2E, performance, or clean-setup gate.

---

### Task 1: Runtime configuration and failing tests

**Files:**
- Modify: `src/platform/config/load-runtime-config.ts`
- Modify: `.env.example`
- Modify: `tests/unit/config/runtime-env.test.ts`

**Interfaces:**
- Produces: `RuntimeEnv.indexNowKey: string | undefined`.
- Produces: deployed `CRON_SECRET` requirement when IndexNow is enabled.

- [ ] Add tests proving disabled configuration leaves `indexNowKey` undefined.
- [ ] Add tests proving invalid keys are rejected.
- [ ] Add tests proving a valid production key requires `CRON_SECRET` and loads when the secret is present.
- [ ] Run the unit suite and confirm the new tests fail before implementation.
- [ ] Implement `INDEXNOW_KEY` parsing and validation using `/^[A-Za-z0-9-]{8,128}$/` and existing placeholder rejection.
- [ ] Extend cron-secret activation to `features.auth.enabled || features.commerce.enabled || Boolean(parsed.INDEXNOW_KEY)`.
- [ ] Re-run the focused unit suite and confirm it passes.

### Task 2: Shared IndexNow submission module with TDD

**Files:**
- Create: `src/platform/seo/indexnow.ts`
- Create: `tests/unit/seo/indexnow.test.ts`

**Interfaces:**
- Produces: `INDEXNOW_ENDPOINT`, `INDEXNOW_KEY_LOCATION_PATH`, `buildIndexNowPayload()`, `submitIndexNowUrls()`, and `IndexNowSubmissionError`.

- [ ] Add failing tests for relative/absolute canonical URLs, fragment stripping, deduplication, cross-origin rejection, credential rejection, and the 10,000 URL cap.
- [ ] Add failing tests proving POST uses the global endpoint with `host`, `key`, `keyLocation`, and `urlList`.
- [ ] Add failing tests proving 200/202 are accepted and non-success/network failures reject.
- [ ] Implement the smallest shared module satisfying those tests with an 8-second timeout and no secret logging.
- [ ] Re-run the focused tests and confirm all pass.

### Task 3: Public verification route and authenticated submission route

**Files:**
- Create: `src/app/indexnow-key.txt/route.ts`
- Create: `src/app/api/internal/seo/indexnow/route.ts`

**Interfaces:**
- Public: `GET /indexnow-key.txt` -> configured key or 404.
- Internal: `POST /api/internal/seo/indexnow` with `{ urls: string[] }` and Bearer `CRON_SECRET`.

- [ ] Implement the key route with `text/plain`, `no-store`, and 404/noindex behavior when disabled.
- [ ] Implement request schema `urls: z.array(z.string().min(1)).min(1).max(10000)`.
- [ ] Authenticate before revealing IndexNow configuration state.
- [ ] Map invalid JSON/schema to 400, disabled to 404, upstream rate limiting to 503, other upstream failures to 502, and accepted submissions to 200/202.
- [ ] Keep key and secrets out of all response errors.

### Task 4: CLI, offline verification gate, and CI wiring

**Files:**
- Create: `scripts/submit-indexnow.ts`
- Create: `scripts/verify-indexnow.ts`
- Modify: `package.json`

**Interfaces:**
- CLI: `bun run seo:indexnow -- <url...>`.
- Gate: `bun run verify:indexnow`.

- [ ] Implement CLI using the shared module and configured canonical origin/key.
- [ ] Implement offline verifier that checks official endpoint, key location, dedupe/canonical behavior, and cross-origin rejection without network access.
- [ ] Add scripts `seo:indexnow` and `verify:indexnow`.
- [ ] Chain `verify:indexnow` into `verify:seo` so existing CI automatically enforces the feature.

### Task 5: Documentation and release activation checklist

**Files:**
- Modify: `README.md`
- Modify: `docs/setup/new-product.md`
- Modify: `docs/releases/v0.1.0-staging-verification.md`

- [ ] Document that sitemap remains the complete inventory and IndexNow is for recent URL changes.
- [ ] Document key generation constraints, `INDEXNOW_KEY`, `CRON_SECRET`, `/indexnow-key.txt`, internal endpoint, and CLI.
- [ ] Add production verification steps: fetch key file, submit one recently changed canonical URL, record accepted 200/202, and never fabricate provider evidence.

### Task 6: Final verification and PR update

**Files:**
- Modify: PR #7 description after verification.

- [ ] Run focused unit/config verification.
- [ ] Run authoritative repository verification including Quality, E2E, Performance, and Clean Setup on one final SHA.
- [ ] Confirm the IndexNow gate actually executed rather than being skipped.
- [ ] Update PR #7 body with final SHA, CI run, IndexNow implementation summary, and external activation distinction.
- [ ] Mark PR #7 Ready for Review only after all required gates are green.
- [ ] Do not merge.
