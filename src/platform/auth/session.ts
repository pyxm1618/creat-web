const DEFAULT_FRESH_SESSION_MS = 15 * 60 * 1000;

export function assertFreshSession(
  session: { readonly authenticatedAt: Date },
  now: Date,
  maxAgeMs = DEFAULT_FRESH_SESSION_MS,
): void {
  const age = now.getTime() - session.authenticatedAt.getTime();
  if (age < 0) throw new Error("invalid session timestamp");
  if (age > maxAgeMs) throw new Error("fresh authentication required");
}
