# Legal launch checklist

The legal framework in this starter is deliberately draft-only. Before production:

- Replace operator legal name, jurisdiction, support contact and any required postal address.
- Set the real minimum age and eligibility rules.
- List only data categories actually processed by the product.
- List every enabled processor and its actual purpose, including authentication, email, hosting, database, analytics, payment, storage, anti-abuse and AI services.
- Document the real payment model: merchant of record, payment service provider, or no payment.
- Review one-time purchase, subscription, credit, refund and cancellation terms against the actual product configuration.
- Define retention periods and their operational/legal basis; do not inherit starter placeholders as legal conclusions.
- Document account deletion effects and any retained records that remain detached from the authentication identity.
- Document international transfer facts where applicable.
- Give each legal document a reviewed version and effective date.
- Set `releaseStatus` and each document `reviewStatus` to `reviewed` only after appropriate human/legal review.
- Run `bun run verify:release`; production must remain blocked while facts are draft or inconsistent.

The starter validates configuration consistency. It does not provide jurisdiction-specific legal advice or guarantee compliance.
