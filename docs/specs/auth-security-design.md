# Authentication and account security design

- Status: proposed for independent review
- Scope: Better Auth, Google, magic link, sessions, account lifecycle
- Password authentication: intentionally disabled in v1

## 1. Decision

`creat-web v1` uses Better Auth as the only authentication implementation. It supports:

- Google OAuth sign-in;
- passwordless magic-link sign-in through email;
- persistent database sessions;
- session listing and revocation;
- secure account deletion;
- one canonical platform user identity.

The word “minimal” applies only to the number of enabled sign-in methods. It does **not** permit minimal security, incomplete account lifecycle handling, in-memory production state, or untested provider callbacks.

## 2. Explicitly excluded from v1

- email/password sign-up and sign-in;
- password reset and password change;
- passkeys;
- two-factor authentication;
- organizations, invitations, teams, and enterprise SSO;
- custom JWT-only authentication;
- a second authentication provider implementation;
- custom account-merging logic based solely on matching email strings.

Password authentication can be added later, but only together with email verification, reset flows, breach/abuse controls, session invalidation, and complete tests.

## 3. Canonical identity model

Better Auth’s user record is the canonical identity. Product data references the Better Auth user ID directly.

Required platform records:

- `user` — canonical account identity;
- `session` — active login sessions;
- `account` — Google/OAuth account links and provider credentials as required;
- `verification` — temporary verification and magic-link records;
- `rateLimit` — durable authentication abuse counters in production.

A separate generic application `users` table and synchronization bridge are forbidden in v1. Product-specific profile data belongs in a separate `user_profile` or product table keyed by the canonical user ID.

## 4. Google sign-in

### 4.1 Configuration

Each environment must define its own trusted application origin and authorized Google callback URI. Production callback construction must use an explicit `BETTER_AUTH_URL` or equivalent validated base URL.

Required checks:

- HTTPS in staging and production;
- exact authorized redirect URI;
- no wildcard trusted origins;
- provider client ID and secret present only when Google sign-in is enabled;
- production credentials must not be used in local or test environments;
- only required Google scopes are requested.

### 4.2 Account linking

The system must rely on Better Auth’s supported provider/account-linking behavior rather than inventing automatic database merges.

Rules:

1. A provider account must never be linked to two local users.
2. Email equality alone is not sufficient to perform a custom merge.
3. Only provider-verified email information may participate in supported linking behavior.
4. Ambiguous duplicate-account conditions fail closed and are logged without exposing private details to the user.
5. Tests must cover Google-first then magic-link, magic-link-first then Google, repeated sign-in, changed Google profile name, and attempted conflicting account links.

## 5. Magic-link sign-in

### 5.1 Required behavior

- cryptographically secure token generation;
- token stored hashed, never plaintext;
- default expiration: 10 minutes unless review establishes a stronger project-specific value;
- atomic single use;
- generic response regardless of whether the email already exists;
- only allow approved relative callback paths or trusted application origins;
- no token, full URL, or email contents in logs or analytics;
- email normalization before account lookup;
- resend and duplicate-click behavior must be deterministic and safe.

Better Auth currently documents atomic first-attempt token consumption. If verification is stored outside the primary database, the storage must support an atomic `getAndDelete` equivalent across instances. V1 therefore defaults to database-backed verification rather than an in-process lock.

### 5.2 Email transport

Resend is the initial email provider behind an internal `EmailSender` boundary.

Sending requirements:

- verified sender domain in production;
- environment-specific sender address;
- product name and support address supplied from configuration;
- no hard-coded Quick I Ching wording;
- timeout and provider errors surfaced to the auth flow without logging the token;
- delivery failure metrics contain message/provider identifiers but not the secret link;
- test transport available without external delivery.

### 5.3 Abuse protection

Magic-link send is a sensitive unauthenticated operation. Protection must include:

- database-backed Better Auth rate limiting in serverless deployments;
- stricter custom rule for magic-link send than the generic auth limit;
- trusted proxy/IP header configuration for Vercel/Cloudflare topology;
- email-address and IP-based abuse dimensions at the application boundary;
- optional or default production Turnstile challenge according to final threat model;
- cooldown messaging without account enumeration;
- bounded daily limits and operational alerting for abnormal send volume.

Server-side internal `auth.api` calls are not automatically covered by client-request rate limits and must not be used to bypass the public protection layer.

## 6. Session design

### 6.1 Storage and cookies

Sessions are database-backed. Authentication cookies must be:

- `HttpOnly`;
- `Secure` outside local development;
- appropriate `SameSite` policy;
- host/path scoped to the application’s real needs;
- given a product-specific prefix from configuration;
- omitted from analytics and logs.

CSRF and origin checks must remain enabled. Unsafe Better Auth options that disable CSRF/origin checks are prohibited.

### 6.2 Lifetime

Initial default:

- session lifetime: 7 days;
- rolling update age: 1 day;
- fresh-session age for sensitive operations: 15 minutes.

These are reviewable defaults, not permanent business policy. Sensitive operations include account deletion, changing account email/identity links, viewing security details, and high-risk billing/account actions.

### 6.3 User controls

The account UI must support:

- current session display;
- active session/device listing when available;
- revoke one session;
- revoke other sessions;
- revoke all sessions;
- normal sign-out;
- explicit feedback when a revoked/expired session is encountered.

Session identifiers must never be exposed in analytics events or copied into support logs.

## 7. Authorization boundary

Authentication proves identity; authorization decides access.

Rules:

- server components, route handlers, and server actions must perform server-side authorization;
- hiding a button is not authorization;
- product records must be queried by both record ID and authenticated owner/permission;
- public, authenticated, admin/operator, and webhook routes use explicit policies;
- middleware may provide routing convenience but is not the only authorization layer;
- all mutation inputs are schema validated;
- cross-user object access receives not-found/forbidden behavior that avoids unnecessary data disclosure.

V1 does not need a general RBAC system. An optional operator/admin role may be a small explicit field or allowlist with fresh-session requirements and audit logging.

## 8. Account lifecycle

### 8.1 Account creation

Creation may occur through Google or magic link. Product onboarding must be separate from identity creation so that incomplete onboarding cannot corrupt authentication state.

### 8.2 Email and provider changes

V1 should avoid implementing arbitrary primary-email changes unless Better Auth’s supported flow and verification behavior are fully integrated. Provider link/unlink operations must prevent removing the user’s last viable sign-in method.

### 8.3 Account deletion

Deletion requires:

1. authenticated user;
2. fresh session or re-verification link;
3. clear consequences for subscription, credits, retained transaction records, and product data;
4. transactionally recorded deletion request;
5. immediate session revocation;
6. cancellation/handling of active subscriptions according to product policy;
7. product-data deletion or pseudonymization workflow;
8. retention of only legally/operationally required commerce and security records;
9. idempotent retry if downstream deletion fails;
10. final user notification where delivery remains lawful and possible.

Account deletion must not directly cascade-delete financial records required for refunds, disputes, reconciliation, or accounting.

## 9. Logging and privacy

Allowed authentication log data:

- request/correlation ID;
- event type;
- provider name;
- success/failure category;
- internal user ID after authentication;
- coarse network/security signals where justified;
- provider message identifiers;
- timestamps.

Forbidden log/analytics data:

- magic-link token or URL;
- session token;
- OAuth authorization code;
- client secret;
- raw cookie header;
- full provider profile payload;
- unnecessary full IP retention;
- user password if password support is added later.

Logs require documented retention and access control.

## 10. Environment and secret requirements

Expected production secrets/configuration include:

- application/base URL;
- Better Auth secret;
- Google client ID and client secret;
- Resend API key and verified sender;
- database URL;
- Turnstile keys if enabled;
- trusted origin/proxy configuration;
- product support and security contact addresses.

Secret validation must reject placeholders, reused purpose-incompatible keys, insufficient entropy, HTTP production origins, and unknown deployment modes.

## 11. Error behavior

User-facing errors should be actionable but not reveal account existence or provider internals.

Examples:

- magic link request: always acknowledge the request generically;
- expired/used token: show a safe retry path;
- provider callback error: show a stable error code and sign-in retry;
- conflicting account: do not merge automatically; direct to support/operator process;
- email provider outage: report temporary inability without claiming an email was sent;
- database outage: fail closed and do not create a partial authenticated state.

## 12. Test matrix

### 12.1 Unit tests

- configuration invariants;
- callback URL allowlist;
- email normalization;
- log redaction;
- authorization helpers;
- account-deletion state transitions.

### 12.2 PostgreSQL integration tests

- Better Auth schema installs from an empty database;
- Google account record uniqueness;
- magic-link token hashed at rest;
- concurrent magic-link redemption succeeds exactly once;
- database rate-limit counters work across simulated instances;
- session creation, refresh, expiry, and revocation;
- deletion request idempotency;
- financial records survive account deletion while identity is pseudonymized/deleted according to policy.

### 12.3 E2E tests

- magic-link request and test-transport retrieval;
- valid link sign-in;
- expired and already-used link;
- sign-out and revoked-session handling;
- protected route redirect and server-side denial;
- account settings/session management;
- account deletion confirmation and post-deletion access denial;
- Google OAuth tested through provider-approved test strategy or contract-level callback fixtures, without pretending a mocked button is full OAuth verification.

### 12.4 Security tests

- untrusted callback URL rejected;
- CSRF/origin checks active;
- rate-limit bypass attempts;
- spoofed forwarded IP handling;
- account enumeration resistance;
- cross-user record access denial;
- secret/token redaction.

## 13. Acceptance criteria

Authentication is production-ready only when:

- Google and magic link both work in isolated staging;
- duplicate-account/linking scenarios are tested;
- magic-link redemption is atomic across instances;
- database-backed rate limiting is active in production mode;
- all authorization occurs server side at the resource boundary;
- account deletion and session revocation are complete and retryable;
- no auth secrets or private links appear in logs/analytics;
- an empty database can migrate and run the full auth test suite;
- production build fails for unsafe or incomplete auth configuration.

## 14. References

- https://better-auth.com/docs/authentication/google
- https://better-auth.com/docs/plugins/magic-link
- https://better-auth.com/docs/concepts/session-management
- https://better-auth.com/docs/concepts/rate-limit
- https://better-auth.com/docs/concepts/database
- https://better-auth.com/docs/reference/security
