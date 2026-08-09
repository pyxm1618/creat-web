# Purpose-specific key rotation

Never reuse one secret for another purpose. Every rotation record includes environment, secret purpose, old/new key identifiers where available, operator, start/end time, verification evidence, rollback decision and old-key revocation.

General sequence: create new credential → configure overlap/dual validation if the provider supports it → deploy → verify the exact dependent journey → revoke old credential → verify again. If dual validation is unavailable, prepare a rollback deploy before switching.

## Better Auth secret

1. Create a new high-entropy `BETTER_AUTH_SECRET`.
2. Treat rotation as session-affecting unless the deployed Better Auth version explicitly supports multi-secret validation.
3. Deploy during an approved window; verify new sign-in/session creation, sign-out and protected routes.
4. Confirm expected session invalidation behavior and support impact.
5. Roll back the deploy/secret only if doing so does not re-enable a compromised credential; for compromise, contain and force re-authentication instead.

## Google OAuth client secret

1. Create a replacement secret for the existing staging/production OAuth client without changing authorized origins/redirect URIs unexpectedly.
2. Configure the new `GOOGLE_CLIENT_SECRET`, deploy and verify sign-in/callback/state handling.
3. Revoke the old secret in Google only after the new path succeeds.
4. Roll back to the old secret only when it is known uncompromised and still active.

## Resend API key

1. Create a scoped replacement key and preserve the verified sender/domain.
2. Set `RESEND_API_KEY`, deploy and send a staging Magic Link/test transactional message.
3. Verify delivery and that logs contain no message/private payload.
4. Revoke the old key. If verification fails, restore the old uncompromised key and investigate before revocation.

## Waffo private/API credential

1. Create/obtain a replacement provider credential for the same environment/merchant/store.
2. Set `WAFFO_PRIVATE_KEY`, deploy with commerce workers controlled, and verify product sync/test checkout/refund read path.
3. Re-enable normal workers only after provider authentication succeeds.
4. Revoke the old credential; reconcile any requests attempted during the transition.

## Waffo webhook verification key

1. Configure the provider's replacement webhook signing/verification material.
2. Where Waffo supports overlap, deploy validation for old+new during the transition. If overlap is not supported, coordinate the provider switch and application deploy as one change window.
3. Send a signed test event and verify valid acceptance, invalid-signature rejection, deduplication and no raw retention for invalid signatures.
4. Remove the old key after the provider confirms new signing is active.

## Turnstile secret

1. Rotate/create a new Turnstile secret for the same widget/site key as supported by Cloudflare.
2. Set `TURNSTILE_SECRET_KEY`, deploy and verify Magic Link with expected action/hostname plus forged/replayed-token rejection.
3. Revoke/reset old validation material only after the new secret succeeds.
4. Never expose the secret in browser config; only `TURNSTILE_SITE_KEY` is public.

## Cron/internal-job secret

1. Generate a new independent high-entropy `CRON_SECRET`.
2. Update the Vercel/project secret used to authorize scheduled internal routes and deploy.
3. Invoke an internal job with the new bearer credential and verify the old credential is rejected after cutover.
4. If the scheduler injects the credential automatically, verify at least one scheduled run and the unauthenticated 401 path before closing the rotation.

## Database credentials

1. Create a new database role/password or rotated credential with only required privileges.
2. Test connection/migrations/read-write behavior in isolated staging.
3. Update `DATABASE_URL`, deploy, verify readiness and a representative transaction.
4. Revoke the old credential after all application/worker connections have moved. For compromise, revoke as soon as containment permits and terminate old sessions.

## Analytics IDs/configuration

GA4 measurement IDs and Clarity project IDs are identifiers rather than bearer secrets, but changing them changes the data destination. Update `GA4_MEASUREMENT_ID`/`CLARITY_PROJECT_ID`, verify consent gating and the allowlisted payload contract, then disable the old destination if it is no longer authorized. Do not migrate private application data into analytics.

## Drill requirement

Staging activation must include at least one disposable credential rotation with rollback/recovery evidence and a review of every procedure above. The repository CI validates configuration rejection and secret-purpose separation; it cannot create or revoke real provider credentials on the owner's behalf.
