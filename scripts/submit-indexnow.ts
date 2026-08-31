import { routeRegistry } from "@/config/routes.config";
import { env } from "@/platform/config/env";
import { submitIndexNowUrls } from "@/platform/seo/indexnow";

const urls = process.argv
  .slice(2)
  .map((value) => value.trim())
  .filter(Boolean);

if (!env.indexNowKey) {
  throw new Error("INDEXNOW_KEY is required before submitting URL changes");
}
if (urls.length === 0) {
  throw new Error("usage: bun run seo:indexnow -- <changed-url> [changed-url...]");
}

const result = await submitIndexNowUrls({
  canonicalOrigin: routeRegistry.site.canonicalOrigin,
  key: env.indexNowKey,
  urls,
});

console.log(
  JSON.stringify({
    accepted: true,
    providerStatus: result.statusCode,
    submitted: result.submitted,
  }),
);
