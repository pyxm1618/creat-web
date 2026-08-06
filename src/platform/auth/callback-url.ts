const ALLOWED_CALLBACK_PATHS = new Set([
  "/",
  "/account",
  "/account/security",
  "/pricing",
]);

export function assertAllowedRelativeCallback(input: string): string {
  if (!input.startsWith("/") || input.startsWith("//") || input.includes("\\")) {
    throw new Error("untrusted callback");
  }

  const parsed = new URL(input, "https://internal.invalid");
  if (parsed.origin !== "https://internal.invalid" || !ALLOWED_CALLBACK_PATHS.has(parsed.pathname)) {
    throw new Error("untrusted callback");
  }

  return `${parsed.pathname}${parsed.search}`;
}
