function normalizePath(pathname: string): string {
  if (pathname === "/") return "/";
  const stripped = pathname.replace(/\/+$/, "");
  return stripped || "/";
}

export function canonicalUrl(
  originInput: string,
  routeInput: string,
  query?: URLSearchParams,
): string {
  void query;
  const origin = new URL(originInput);
  const candidate = new URL(routeInput, origin);

  if (candidate.origin !== origin.origin) {
    throw new Error("canonical origin mismatch");
  }

  candidate.search = "";
  candidate.hash = "";
  candidate.pathname = normalizePath(candidate.pathname);

  return candidate.toString().replace(/\/$/, candidate.pathname === "/" ? "/" : "");
}
