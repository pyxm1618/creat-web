import type { LandingSection } from "@/components/landing/landing-page";

import { localePath, type I18nRoutingConfig } from "./routing";

function localizedHref(
  href: string,
  config: I18nRoutingConfig,
  locale: string,
  localizedRoutes: ReadonlySet<string>,
): string {
  if (!href.startsWith("/") || href.startsWith("//")) return href;
  const [path, suffix = ""] = href.split(/(?=[?#])/u, 2);
  if (!path || !localizedRoutes.has(path)) return href;
  return `${localePath(config, locale, path)}${suffix}`;
}

export function localizeLandingSections(
  sections: readonly LandingSection[],
  config: I18nRoutingConfig,
  locale: string,
  localizedRoutes: ReadonlySet<string>,
): readonly LandingSection[] {
  return sections.map((section) => {
    switch (section.type) {
      case "hero":
        return {
          ...section,
          primaryCta: {
            ...section.primaryCta,
            href: localizedHref(section.primaryCta.href, config, locale, localizedRoutes),
          },
          ...(section.secondaryCta
            ? {
                secondaryCta: {
                  ...section.secondaryCta,
                  href: localizedHref(section.secondaryCta.href, config, locale, localizedRoutes),
                },
              }
            : {}),
        };
      case "use-cases":
        return {
          ...section,
          items: section.items.map((item) => ({
            ...item,
            ...(item.href
              ? { href: localizedHref(item.href, config, locale, localizedRoutes) }
              : {}),
          })),
        };
      case "related-resources":
        return {
          ...section,
          links: section.links.map((link) => ({
            ...link,
            href: localizedHref(link.href, config, locale, localizedRoutes),
          })),
        };
      case "final-cta":
        return {
          ...section,
          cta: {
            ...section.cta,
            href: localizedHref(section.cta.href, config, locale, localizedRoutes),
          },
        };
      default:
        return section;
    }
  });
}
