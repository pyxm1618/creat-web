export type LinkEdge = {
  readonly from: string;
  readonly to: string;
};

export type LinkGraphReport = {
  readonly broken: readonly string[];
  readonly orphans: readonly string[];
};

function normalizeRoute(route: string): string {
  if (route === "/") return "/";
  return route.replace(/\/+$/, "") || "/";
}

export function validateLinkGraph(
  indexableRoutes: readonly string[],
  links: readonly LinkEdge[],
): LinkGraphReport {
  const routes = new Set(indexableRoutes.map(normalizeRoute));
  const knownSources = new Set(links.map((link) => normalizeRoute(link.from)));
  const incoming = new Set<string>();
  const broken = new Set<string>();

  for (const link of links) {
    const target = normalizeRoute(link.to);
    if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("mailto:")) {
      continue;
    }
    if (!routes.has(target) && target !== "/privacy" && target !== "/terms" && target !== "/contact" && target !== "/refund-policy" && target !== "/acceptable-use" && target !== "/account-deletion" && target !== "/sign-in") {
      broken.add(target);
      continue;
    }
    incoming.add(target);
  }

  const orphans = [...routes].filter((route) => route !== "/" && !incoming.has(route));

  for (const source of knownSources) {
    if (!routes.has(source) && source !== "/") {
      // Source pages may be non-indexable legal/private pages; only targets affect broken-link reporting.
    }
  }

  return {
    broken: [...broken].sort(),
    orphans: orphans.sort(),
  };
}
