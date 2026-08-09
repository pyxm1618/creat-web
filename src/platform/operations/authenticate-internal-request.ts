import { timingSafeEqual } from "node:crypto";

export function authenticateInternalRequest(
  request: Request,
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function unauthorizedInternalResponse(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "cache-control": "no-store" },
  });
}
