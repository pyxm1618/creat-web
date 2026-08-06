import { assertAllowedRelativeCallback } from "./callback-url";

export function buildMagicLinkConfirmationUrl(input: {
  readonly appOrigin: string;
  readonly token: string;
  readonly returnTo: string;
}): string {
  const returnTo = assertAllowedRelativeCallback(input.returnTo);
  const url = new URL("/auth/magic-link/confirm", input.appOrigin);
  url.hash = new URLSearchParams({ token: input.token, returnTo }).toString();
  return url.toString();
}
