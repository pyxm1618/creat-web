# creat-web v1 Critical Authentication Clarifications

- Date: 2026-08-06
- Status: binding correction
- Applies after: `creat-web-v1-gemini-review-resolution.md`
- Implementation status: blocked pending corrected-plan review and owner approval

This document resolves authentication details discovered while verifying the Gemini corrections. It supersedes conflicting auth/deletion examples in all earlier specifications and plans.

## 1. Retained subject provisioning is idempotent, not falsely assumed atomic

Better Auth user creation and custom `account_subjects` creation may not share one database transaction through every supported hook/adapter path. The design must not claim cross-system atomicity unless implementation proves it.

Required strategy:

1. `account_subjects.auth_user_id` has a unique constraint.
2. A Better Auth user-create after hook calls idempotent `ensureAccountSubject(authUserId)`.
3. The first authenticated session/onboarding boundary also calls `ensureAccountSubject` as repair protection.
4. Every commerce, credit, subscription and product write resolves an active subject first and fails closed if provisioning cannot be completed.
5. Concurrent ensure calls use insert-on-conflict/select semantics and return the same subject.
6. A scheduled/operator integrity check detects active Better Auth users without subjects and detached subjects with inconsistent status.

No second login identity or credential data is introduced.

Required PostgreSQL tests:

- concurrent ensure calls produce exactly one subject;
- hook failure followed by first-session repair succeeds;
- subject provisioning failure prevents commerce/credit writes without corrupting the auth user;
- deleted/detached subjects are never silently reattached to a new user.

## 2. Magic Link POST must forward Better Auth session cookies

The public confirmation route is POST-only, but Better Auth's manual magic-link verification API currently accepts token input through its server API query object. The route must preserve Better Auth's response headers.

Preferred route pattern:

```ts
const response = await auth.api.magicLinkVerify({
  query: {
    token,
    callbackURL: returnTo,
  },
  headers: request.headers,
  asResponse: true,
});

return response;
```

If the implementation uses `returnHeaders: true` instead, every `Set-Cookie` header must be forwarded exactly to the Next.js response. Do not consume the token and then discard the session cookie.

Rules:

- use the Node.js runtime for this route;
- pass request headers required for Better Auth security/context;
- return/forward status, redirect location and all Set-Cookie values;
- do not manually construct a Better Auth session token;
- do not expose Better Auth's GET verify endpoint as the emailed/public link;
- do not retry verification automatically after an ambiguous response because the first attempt consumes the token.

Required tests:

- successful POST returns a valid Better Auth session cookie and the subsequent protected request is authenticated;
- simulated response-header loss causes the test to fail, proving cookie forwarding is part of the contract;
- consumed-token retry does not create a second session;
- redirect remains within the callback allowlist.

## 3. Account-deletion email links must not delete on GET

Better Auth's built-in delete-account verification URL may perform deletion when the URL is accessed. It must not be emailed directly because mail-security scanners can fetch GET links.

V1 default deletion policy:

- require an authenticated fresh session;
- display explicit consequences and require a deliberate confirmation action;
- submit account deletion through a same-origin POST operation;
- create the retryable local deletion workflow before Better Auth identity removal;
- do not enable or send Better Auth's direct auto-delete URL.

If a later project requires email re-verification for deletion, it must use a two-step neutral confirmation page analogous to Magic Link:

1. email GET opens a no-store/no-referrer/noindex page and performs no deletion;
2. explicit user POST verifies the deletion token and starts the workflow;
3. the direct destructive Better Auth URL is never placed in email.

Required tests:

- repeated scanner GET requests cannot delete or schedule deletion;
- explicit fresh-session POST schedules exactly one deletion workflow;
- CSRF/origin failures do not schedule deletion;
- failure in downstream cancellation/anonymization prevents Better Auth hard deletion and remains retryable;
- after completed deletion, sessions are invalid and retained financial subject records remain coherent.

## 4. References

- Better Auth server API response/headers: https://better-auth.com/docs/concepts/api
- Better Auth Next.js cookie integration: https://better-auth.com/docs/integrations/next
- Better Auth Magic Link manual verification: https://better-auth.com/docs/plugins/magic-link
- Better Auth account deletion: https://better-auth.com/docs/concepts/users-accounts
