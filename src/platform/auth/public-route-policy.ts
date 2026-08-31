const blockedPostPaths = new Set(["/api/auth/delete-user", "/api/auth/sign-in/magic-link"]);

export function isBlockedPublicAuthRequest(request: Request): boolean {
  return request.method === "POST" && blockedPostPaths.has(new URL(request.url).pathname);
}
