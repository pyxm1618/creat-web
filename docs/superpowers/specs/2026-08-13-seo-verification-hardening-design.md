# SEO Verification Hardening Design

## Goal

Strengthen Creat Web's existing SEO-first platform by adding deterministic evidence that the rendered production surface still matches the declared SEO registry, without replacing or restructuring the current SEO architecture.

## Base and scope

This work is intentionally stacked on `feat/seo-performance-i18n-platform-completion` at `2ed87103c439dc414af1730f95e371c3bf6455ae` because the SEO route registry, structured-data platform, production SEO harness, and performance harness live on that branch and are not yet on `main`.

The change is limited to SEO verification, reviewed-copy integrity, and production-like performance evidence. It does not change authentication, commerce, credits, payment, account deletion, provider contracts, database migrations, or product feature semantics.

## Design

### 1. Reviewed SEO snapshot integrity

A route marked `reviewStatus: "reviewed"` must also carry a deterministic review fingerprint derived from the SEO facts that actually require human review: search intent, primary/secondary keywords, title, description, H1, canonical override, page type, related routes, and last-modified date.

The route registry recomputes this fingerprint at startup and rejects stale fingerprints. Changing reviewed SEO copy therefore forces an explicit re-review instead of silently inheriting the old reviewed state.

### 2. Rendered production SEO audit

Production Playwright verification becomes registry-driven. For every `public_indexable` route it verifies:

- HTTP 200;
- canonical equals the registry-derived canonical;
- no `noindex` directive;
- exact title, description, and one H1 matching the registry;
- primary-keyword topical presence in rendered visible text, measured diagnostically rather than against a magic density percentage;
- all declared indexable `relatedRoutes` appear as real rendered anchors;
- structured data is parseable.

It also verifies that the production sitemap contains exactly the registered indexable canonicals and that public-noindex routes remain noindex and out of the sitemap.

### 3. Semantic DOM guardrails

The rendered audit treats heading semantics as document structure rather than visual styling: exactly one non-empty H1 is required on each indexable route, and empty headings are rejected. This catches UI/status components leaking into the heading tree without imposing project-specific decorative rules.

### 4. Topical relevance is a diagnostic, not a target density

The audit records visible word count, exact primary-keyword occurrences, and primary-keyword token coverage. It requires meaningful topical presence but does not enforce an arbitrary keyword-density percentage. This follows the QuickIChing lesson that density is useful for diagnosis while search-intent satisfaction and semantic relevance are the actual goal.

### 5. Production-like analytics-on performance scenario

The performance harness gains an analytics-enabled profile using test-only IDs and pre-granted consent. Third-party loader URLs are deterministically stubbed so CI measures Creat Web's own analytics integration overhead without depending on external network reliability. The existing Core Web Vitals and script budgets still apply.

This does not claim to replace an external real-provider Lighthouse check; it prevents the platform from regressing merely because analytics code becomes enabled.

## Testing strategy

- Unit tests cover fingerprint determinism and stale-review rejection.
- Static `verify:seo` continues to validate registry/config invariants.
- Production Playwright covers rendered TDH/canonical/indexability/topic graph/sitemap semantics.
- Performance Playwright covers both neutral and analytics-enabled product profiles.
- Full CI remains the merge gate.

## Non-goals

- No new landing pages or keywords.
- No change to sitemap/indexability policy.
- No automatic SEO copy generation.
- No hard keyword-density target.
- No port of QuickIChing-specific routes, content, I Ching terminology, or algorithms.
