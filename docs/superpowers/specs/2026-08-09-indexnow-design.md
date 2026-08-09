# IndexNow Design

## Goal

Add IndexNow as an optional, production-safe SEO capability for `creat-web` without changing the neutral starter's default behavior.

## Protocol baseline

- Notify IndexNow only for recently added, updated, deleted, moved, or redirected URLs.
- Keep XML sitemap as the long-term full URL inventory; do not submit the whole sitemap on every deployment.
- Use the global endpoint `https://api.indexnow.org/indexnow`.
- Use POST JSON for batching, with at most 10,000 URLs per request.
- Treat provider HTTP 200 and 202 as accepted.
- Use a root-level key verification resource and send its URL as `keyLocation`.

## Architecture

1. `INDEXNOW_KEY` is optional. If absent, IndexNow is disabled and the neutral starter remains unchanged.
2. The key is validated as 8-128 characters using only ASCII letters, digits, and `-`.
3. When IndexNow is enabled, deployed environments also require `CRON_SECRET`; the public IndexNow key is never used to authenticate internal submission requests.
4. `GET /indexnow-key.txt` returns the configured key as `text/plain`; when disabled it returns 404.
5. `src/platform/seo/indexnow.ts` owns URL normalization, canonical-origin enforcement, deduplication, the 10,000 URL limit, payload construction, timeout handling, and provider response handling.
6. Only URLs on the configured canonical origin are accepted. Fragments are stripped. Relative URLs are resolved against the canonical origin.
7. `POST /api/internal/seo/indexnow` accepts `{ "urls": string[] }`, requires `Authorization: Bearer <CRON_SECRET>`, and calls the shared submission module.
8. `bun run seo:indexnow -- <url...>` provides a deployment/publishing CLI using the same shared module.
9. A dedicated `verify:indexnow` gate performs offline contract checks and is included in `verify:seo`, so CI validates the feature without calling the real IndexNow service.

## Error handling

- Invalid key, empty URL list, more than 10,000 URLs, malformed URLs, cross-origin URLs, or credential-bearing URLs fail before network I/O.
- Provider 200/202 are accepted; other status codes raise a typed submission error.
- Network/timeout failures fail closed.
- The internal route returns 401 for invalid internal auth, 404 when IndexNow is disabled, 400 for invalid request data, and 502/503 for upstream failures.
- Key and internal secrets are never logged or returned in error bodies.

## Testing

- Unit tests cover payload construction, deduplication, same-origin enforcement, fragment removal, URL-count limit, 200/202 acceptance, and provider failure.
- Runtime configuration tests cover optional disablement, key validation, and deployed `CRON_SECRET` requirement when IndexNow is enabled.
- The offline `verify:indexnow` script is wired into the authoritative SEO CI gate.
- Existing full Quality, E2E, Performance, and Clean Setup gates must pass on the final head before PR #7 is marked ready again.
