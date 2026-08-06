# creat-web v1 Corrected Master Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. No application task may begin until the review gate below is satisfied.

**Goal:** Execute the reviewed and corrected `creat-web v1` design without modifying Quick I Ching.

**Status:** blocked pending independent review of the corrected design/plan suite and owner approval.

## 1. Binding document order

Read and apply in this exact order:

1. Five original specifications under `docs/specs/`.
2. `docs/specs/creat-web-v1-gemini-review-resolution.md`.
3. `docs/superpowers/plans/2026-08-06-creat-web-master-execution-plan.md`.
4. `docs/superpowers/plans/2026-08-06-creat-web-execution-preflight.md`.
5. `docs/superpowers/plans/2026-08-06-creat-web-gemini-review-corrections.md`.
6. The current phase plan.

Precedence, highest first:

```text
Gemini review execution corrections
Gemini review design resolution
original execution preflight
phase plan
original master execution plan
original specifications
```

A phase-plan example must not be implemented when a higher-precedence document corrects it.

## 2. Phase order

1. Foundation
2. Authentication and retained account subject
3. SEO, homepage and legal foundation
4. Commerce and Waffo one-time payment
5. Credit ledger
6. Subscriptions and refunds
7. Security, operations and release

No later phase starts before the prior phase exit gate is reviewed.

## 3. Corrected mandatory cross-phase requirements

- Quick I Ching remains read-only.
- Better Auth `user` is the active canonical authentication identity.
- Retained financial/credit/subscription records reference non-authentication `account_subjects.id`.
- Magic Link email opens a non-consuming fragment-based confirmation page; only explicit POST consumes the token.
- Disabled integrations cannot require secrets or instantiate clients during import/build.
- Waffo display amounts are converted to internal `BIGINT` minor units using a reviewed currency exponent registry.
- Non-production deployments emit no canonical and no sitemap, and use layered noindex/access controls.
- Analytics emits zero third-party network requests before consent and on forced-disabled sensitive routes.
- `past_due` access uses a persisted grace deadline and never creates renewal credits without successful payment.
- Production has no successful no-op fulfillment.

## 4. Branch and Superpowers protocol

For every phase:

- create an isolated worktree using `superpowers:using-git-worktrees`;
- follow TDD using `superpowers:test-driven-development`;
- execute task-by-task with a focused commit after verified pass;
- use `superpowers:requesting-code-review` at phase completion;
- process feedback with `superpowers:receiving-code-review`;
- run `superpowers:verification-before-completion` before any completion or merge claim;
- open a draft PR and attach command evidence;
- merge only after designated approval.

## 5. General code-start gate

Application code remains prohibited until all are true:

- [ ] The five original specs and Gemini resolution have been independently reviewed.
- [ ] The old plan suite, old preflight, Gemini execution corrections and this v2 entrypoint have been independently reviewed.
- [ ] Every resulting `BLOCKING` and `IMPORTANT` finding has been resolved in documentation.
- [ ] The owner explicitly approves the corrected design and plan suite.
- [ ] The assistant states exactly: **“设计已经定稿，现在可以开始写代码。”**

## 6. Waffo-specific implementation gate

Before Waffo adapter code, additionally require:

- isolated Waffo test account/store/product/webhook resources;
- exact current event names;
- exact signature header, algorithm and encoding;
- exact environment/store/merchant identity fields;
- sanitized payload fixtures;
- exact amount representation and currency behavior;
- verified capability matrix.

This additional gate does not block unrelated Foundation, Auth or SEO phases after the general gate passes.

## 7. Repository-level verification target

After all phases merge, a clean environment must run:

```bash
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
bun run test:integration
bun run test:contract
bun run test:build-matrix
bun run build
bun run test:e2e
bun run verify:architecture
bun run verify:secrets
bun run verify:release
```

These commands are targets defined by the plans; they become evidence only after implementation creates them and fresh execution returns exit code `0`.
