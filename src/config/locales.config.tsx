import type { LandingSection } from "@/components/landing/landing-page";
import { homeConfig } from "@/config/home.config";
import { routeRegistry } from "@/config/routes.config";
import { seoLandingPages } from "@/config/seo-landings.config";
import { siteConfig } from "@/config/site.config";
import type { LocalizedSeoCopy } from "@/platform/seo/metadata";

export type LocaleBundle = {
  readonly seo: Readonly<Record<string, LocalizedSeoCopy>>;
  readonly homeSections: readonly LandingSection[];
  readonly landingSections: Readonly<Record<string, readonly LandingSection[]>>;
};

type SupportedLocale = (typeof siteConfig.supportedLocales)[number];

const defaultSeo = Object.fromEntries(
  routeRegistry.indexable().map((route) => [
    route.route,
    {
      searchIntent: route.searchIntent,
      primaryKeyword: route.primaryKeyword,
      secondaryKeywords: route.secondaryKeywords ?? [],
      title: route.title,
      description: route.description,
      h1: route.h1,
    } satisfies LocalizedSeoCopy,
  ]),
) as Readonly<Record<string, LocalizedSeoCopy>>;

const defaultLandingSections = Object.fromEntries(
  seoLandingPages.map((page) => [page.route, page.sections]),
) as Readonly<Record<string, readonly LandingSection[]>>;

/**
 * Add every enabled locale here. TypeScript forces a top-level bundle when
 * `siteConfig.supportedLocales` grows; `verify:i18n` additionally checks that
 * each bundle contains translated SEO copy and visible content for every
 * indexable route.
 */
export const localeBundles = {
  en: {
    seo: defaultSeo,
    homeSections: homeConfig.sections,
    landingSections: defaultLandingSections,
  },
} as const satisfies Record<SupportedLocale, LocaleBundle>;

export function localeBundle(locale: string): LocaleBundle | undefined {
  return (localeBundles as Readonly<Record<string, LocaleBundle>>)[locale];
}
