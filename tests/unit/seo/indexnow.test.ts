import { describe, expect, it } from "vitest";

import {
  INDEXNOW_ENDPOINT,
  INDEXNOW_KEY_LOCATION_PATH,
  IndexNowSubmissionError,
  buildIndexNowPayload,
  submitIndexNowUrls,
} from "@/platform/seo/indexnow";

const KEY = "IndexNow-Key-12345";
const CANONICAL_ORIGIN = "https://example.com";

describe("IndexNow payload", () => {
  it("normalizes canonical URLs, strips fragments, and deduplicates", () => {
    const payload = buildIndexNowPayload({
      canonicalOrigin: CANONICAL_ORIGIN,
      key: KEY,
      urls: [
        "/new-page",
        "https://example.com/new-page#section",
        "https://example.com/updated?version=2#details",
      ],
    });

    expect(payload).toEqual({
      host: "example.com",
      key: KEY,
      keyLocation: `https://example.com${INDEXNOW_KEY_LOCATION_PATH}`,
      urlList: ["https://example.com/new-page", "https://example.com/updated?version=2"],
    });
  });

  it("rejects cross-origin and credential-bearing URLs", () => {
    expect(() =>
      buildIndexNowPayload({
        canonicalOrigin: CANONICAL_ORIGIN,
        key: KEY,
        urls: ["https://other.example/page"],
      }),
    ).toThrow(/canonical origin/i);

    expect(() =>
      buildIndexNowPayload({
        canonicalOrigin: CANONICAL_ORIGIN,
        key: KEY,
        urls: ["https://user:password@example.com/private"],
      }),
    ).toThrow(/credentials/i);
  });

  it("enforces the official non-empty 10,000 URL batch limit", () => {
    expect(() =>
      buildIndexNowPayload({ canonicalOrigin: CANONICAL_ORIGIN, key: KEY, urls: [] }),
    ).toThrow(/at least one/i);

    expect(() =>
      buildIndexNowPayload({
        canonicalOrigin: CANONICAL_ORIGIN,
        key: KEY,
        urls: Array.from({ length: 10_001 }, (_, index) => `/page-${index}`),
      }),
    ).toThrow(/10,000/i);
  });
});

describe("IndexNow submission", () => {
  it.each([200, 202])("accepts provider HTTP %s", async (statusCode) => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(null, { status: statusCode });
    };

    const result = await submitIndexNowUrls({
      canonicalOrigin: CANONICAL_ORIGIN,
      key: KEY,
      urls: ["/changed"],
      fetchImpl,
    });

    expect(requestedUrl).toBe(INDEXNOW_ENDPOINT);
    expect(requestedInit?.method).toBe("POST");
    expect(requestedInit?.headers).toEqual({ "content-type": "application/json; charset=utf-8" });
    expect(JSON.parse(String(requestedInit?.body))).toEqual({
      host: "example.com",
      key: KEY,
      keyLocation: "https://example.com/indexnow-key.txt",
      urlList: ["https://example.com/changed"],
    });
    expect(result).toEqual({ statusCode, submitted: 1 });
  });

  it("raises a typed error for provider rejection", async () => {
    const fetchImpl: typeof fetch = async () => new Response("rate limited", { status: 429 });

    const submission = submitIndexNowUrls({
      canonicalOrigin: CANONICAL_ORIGIN,
      key: KEY,
      urls: ["/changed"],
      fetchImpl,
    });

    await expect(submission).rejects.toBeInstanceOf(IndexNowSubmissionError);
    await expect(submission).rejects.toMatchObject({ statusCode: 429 });
  });

  it("fails closed when the provider is unavailable", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("network unavailable");
    };

    await expect(
      submitIndexNowUrls({
        canonicalOrigin: CANONICAL_ORIGIN,
        key: KEY,
        urls: ["/changed"],
        fetchImpl,
      }),
    ).rejects.toThrow(/unavailable/i);
  });
});
