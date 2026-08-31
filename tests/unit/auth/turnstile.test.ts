import { describe, expect, it, vi } from "vitest";

import { verifyTurnstileToken } from "@/platform/auth/turnstile";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("verifyTurnstileToken", () => {
  it("accepts a valid single-use token with the expected action and hostname", async () => {
    let requestBody: BodyInit | null | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = init?.body;
      return jsonResponse({
        success: true,
        hostname: "example.com",
        action: "magic-link",
        "error-codes": [],
      });
    });

    await expect(
      verifyTurnstileToken({
        token: "valid-token",
        secretKey: "secret",
        remoteIp: "203.0.113.10",
        expectedAction: "magic-link",
        expectedHostname: "example.com",
        fetchImpl,
      }),
    ).resolves.toEqual({ ok: true });

    const body = requestBody as URLSearchParams;
    expect(body.get("response")).toBe("valid-token");
    expect(body.get("remoteip")).toBe("203.0.113.10");
    expect(body.get("idempotency_key")).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("rejects missing, malformed, or oversized tokens without calling Siteverify", async () => {
    const fetchImpl = vi.fn();
    for (const token of ["", " ", "x".repeat(2049)]) {
      await expect(
        verifyTurnstileToken({ token, secretKey: "secret", fetchImpl }),
      ).resolves.toEqual({ ok: false, reason: "invalid" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps forged tokens to invalid", async () => {
    await expect(
      verifyTurnstileToken({
        token: "forged",
        secretKey: "secret",
        fetchImpl: async () =>
          jsonResponse({ success: false, "error-codes": ["invalid-input-response"] }),
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("maps replayed tokens to duplicate", async () => {
    await expect(
      verifyTurnstileToken({
        token: "already-used",
        secretKey: "secret",
        fetchImpl: async () =>
          jsonResponse({ success: false, "error-codes": ["timeout-or-duplicate"] }),
      }),
    ).resolves.toEqual({ ok: false, reason: "duplicate" });
  });

  it("rejects action and hostname mismatches", async () => {
    for (const response of [
      { success: true, action: "other", hostname: "example.com" },
      { success: true, action: "magic-link", hostname: "evil.example" },
    ]) {
      await expect(
        verifyTurnstileToken({
          token: "valid",
          secretKey: "secret",
          expectedAction: "magic-link",
          expectedHostname: "example.com",
          fetchImpl: async () => jsonResponse(response),
        }),
      ).resolves.toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("fails closed when Siteverify is unavailable or malformed", async () => {
    await expect(
      verifyTurnstileToken({
        token: "valid",
        secretKey: "secret",
        fetchImpl: async () => {
          throw new Error("network down");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });

    await expect(
      verifyTurnstileToken({
        token: "valid",
        secretKey: "secret",
        fetchImpl: async () => new Response("not json", { status: 502 }),
      }),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});
