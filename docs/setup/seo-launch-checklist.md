# SEO launch checklist

Use this checklist for each downstream product before `APP_ENV=production`.

- Replace the draft site name, canonical origin, locale, default metadata and OG asset.
- Replace every draft search intent, primary keyword, title, description, H1 and last-modified date with reviewed project facts.
- Classify every public/private/system route exactly once in `routes.config.ts`.
- Confirm only intentionally indexable routes appear in the production sitemap.
- Confirm preview/staging return `X-Robots-Tag: noindex, nofollow`, omit canonical tags and return 404 for `/sitemap.xml`.
- Confirm production canonical URLs use the production origin only.
- Review internal links so every indexable page has a meaningful inbound link and no broken targets.
- Confirm visible page facts and JSON-LD match; do not add ratings, reviews, FAQ or prices that are not visible and true.
- Confirm primary content is present in the initial server-rendered HTML.
- Run mobile, keyboard and automated accessibility checks.
- Run `bun run verify:seo`, `bun run build`, and browser E2E before release.

The starter provides technical SEO controls. It does not guarantee rankings.
