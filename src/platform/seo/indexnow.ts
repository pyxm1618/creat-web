export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
export const INDEXNOW_KEY_LOCATION_PATH = "/indexnow-key.txt";
export const INDEXNOW_MAX_URLS = 10_000;

const INDEXNOW_KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;
const INDEXNOW_TIMEOUT_MS = 8_000;

export type IndexNowPayload = Readonly<{
  host: string;
  key: string;
  keyLocation: string;
  urlList: readonly string[];
}>;

export type IndexNowSubmissionResult = Readonly<{
  statusCode: 200 | 202;
  submitted: number;
}>;

export class IndexNowSubmissionError extends Error {
  readonly statusCode: number | undefined;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "IndexNowSubmissionError";
    this.statusCode = statusCode;
  }
}

function validateKey(key: string): string {
  const value = key.trim();
  if (!INDEXNOW_KEY_PATTERN.test(value)) {
    throw new Error("IndexNow key must contain 8-128 ASCII letters, digits, or dashes");
  }
  return value;
}

function canonicalBase(canonicalOrigin: string): URL {
  const base = new URL(canonicalOrigin);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("IndexNow canonical origin must use HTTP or HTTPS");
  }
  if (base.username || base.password) {
    throw new Error("IndexNow canonical origin must not contain credentials");
  }
  return new URL(base.origin);
}

function normalizeUrl(base: URL, input: string): string {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    throw new Error("IndexNow URL is invalid");
  }
  if (url.username || url.password) {
    throw new Error("IndexNow URLs must not contain credentials");
  }
  if (url.origin !== base.origin) {
    throw new Error("IndexNow URLs must belong to the canonical origin");
  }
  url.hash = "";
  return url.toString();
}

export function buildIndexNowPayload(
  input: Readonly<{
    canonicalOrigin: string;
    key: string;
    urls: readonly string[];
  }>,
): IndexNowPayload {
  if (input.urls.length === 0) throw new Error("IndexNow requires at least one URL");
  if (input.urls.length > INDEXNOW_MAX_URLS) {
    throw new Error("IndexNow accepts at most 10,000 URLs per request");
  }

  const base = canonicalBase(input.canonicalOrigin);
  const key = validateKey(input.key);
  const urlList = [...new Set(input.urls.map((url) => normalizeUrl(base, url)))];

  return {
    host: base.host,
    key,
    keyLocation: `${base.origin}${INDEXNOW_KEY_LOCATION_PATH}`,
    urlList,
  };
}

export async function submitIndexNowUrls(
  input: Readonly<{
    canonicalOrigin: string;
    key: string;
    urls: readonly string[];
    fetchImpl?: typeof fetch;
  }>,
): Promise<IndexNowSubmissionResult> {
  const payload = buildIndexNowPayload(input);
  const fetchImpl = input.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(INDEXNOW_TIMEOUT_MS),
    });
  } catch {
    throw new IndexNowSubmissionError("IndexNow provider is unavailable");
  }

  if (response.status !== 200 && response.status !== 202) {
    throw new IndexNowSubmissionError(
      "IndexNow provider rejected the submission",
      response.status,
    );
  }

  return {
    statusCode: response.status,
    submitted: payload.urlList.length,
  };
}
