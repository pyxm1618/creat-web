import "server-only";

import { getAccountContext } from "./account-context";
import { assertFreshSession } from "./session";

export type AccountContext = NonNullable<Awaited<ReturnType<typeof getAccountContext>>>;

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("authentication required");
    this.name = "AuthenticationRequiredError";
  }
}

export class FreshAuthenticationRequiredError extends Error {
  constructor() {
    super("fresh authentication required");
    this.name = "FreshAuthenticationRequiredError";
  }
}

export async function requireFreshAccountSession(
  headers: Headers,
  now?: Date,
): Promise<AccountContext> {
  const account = await getAccountContext(headers);
  if (!account) throw new AuthenticationRequiredError();
  try {
    assertFreshSession({ authenticatedAt: new Date(account.session.createdAt) }, now ?? new Date());
  } catch {
    throw new FreshAuthenticationRequiredError();
  }
  return account;
}
