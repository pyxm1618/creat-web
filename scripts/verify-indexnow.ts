import assert from "node:assert/strict";

import {
  INDEXNOW_ENDPOINT,
  INDEXNOW_KEY_LOCATION_PATH,
  buildIndexNowPayload,
} from "@/platform/seo/indexnow";

const canonicalOrigin = "https://example.com";
const key = "IndexNow-Verify-12345";

assert.equal(INDEXNOW_ENDPOINT, "https://api.indexnow.org/indexnow");
assert.equal(INDEXNOW_KEY_LOCATION_PATH, "/indexnow-key.txt");

const payload = buildIndexNowPayload({
  canonicalOrigin,
  key,
  urls: ["/changed", "https://example.com/changed#fragment", "/deleted?gone=1"],
});

assert.deepEqual(payload, {
  host: "example.com",
  key,
  keyLocation: "https://example.com/indexnow-key.txt",
  urlList: ["https://example.com/changed", "https://example.com/deleted?gone=1"],
});

assert.throws(
  () =>
    buildIndexNowPayload({
      canonicalOrigin,
      key,
      urls: ["https://other.example/changed"],
    }),
  /canonical origin/i,
);

console.log(
  JSON.stringify({
    ok: true,
    endpoint: INDEXNOW_ENDPOINT,
    keyLocationPath: INDEXNOW_KEY_LOCATION_PATH,
    maxBatch: 10_000,
  }),
);
