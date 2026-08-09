import { randomUUID } from "node:crypto";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_LENGTH = 2048;

export type TurnstileVerificationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "invalid" | "duplicate" | "unavailable" };

type SiteverifyResponse = {
  readonly success?: boolean;
  readonly hostname?: string;
  readonly action?: string;
  readonly [key: string]: unknown;
};

function errorCodes(result: SiteverifyResponse): readonly string[] {
  const value = result["error-codes"];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export async function verifyTurnstileToken({
  token,
  secretKey,
  remoteIp,
  expectedAction,
  expectedHostname,
  fetchImpl = fetch,
}: Readonly<{
  token: string;
  secretKey: string;
  remoteIp?: string;
  expectedAction?: string;
  expectedHostname?: string;
  fetchImpl?: typeof fetch;
}>): Promise<TurnstileVerificationResult> {
  const normalizedToken = token.trim();
  if (!normalizedToken || normalizedToken.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "invalid" };
  }

  const body = new URLSearchParams({
    secret: secretKey,
    response: normalizedToken,
    idempotency_key: randomUUID(),
  });
  if (remoteIp) body.set("remoteip", remoteIp);

  let response: Response;
  let result: SiteverifyResponse;
  try {
    response = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return { ok: false, reason: "unavailable" };
    result = (await response.json()) as SiteverifyResponse;
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  if (!result.success) {
    return {
      ok: false,
      reason: errorCodes(result).includes("timeout-or-duplicate") ? "duplicate" : "invalid",
    };
  }
  if (expectedAction && result.action !== expectedAction) return { ok: false, reason: "invalid" };
  if (expectedHostname && result.hostname !== expectedHostname) return { ok: false, reason: "invalid" };
  return { ok: true };
}
