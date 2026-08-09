import { localeBundles } from "@/config/locales.config";
import { routeRegistry } from "@/config/routes.config";
import { siteConfig } from "@/config/site.config";
import { buildLanguageAlternates, localePath } from "@/platform/i18n/routing";

const PLACEHOLDER = /\b(todo|tbd|placeholder|replace[ -]?me|lorem ipsum)\b/i;
const indexable = routeRegistry.indexable();

for (const locale of siteConfig.supportedLocales) {
  const bundle = (localeBundles as Readonly<Record<string, (typeof localeBundles)["en"]>>)[locale];
  if (!bundle) throw new Error(`missing locale bundle: ${locale}`);

  for (const route of indexable) {
    const copy = bundle.seo[route.route];
    if (!copy) throw new Error(`missing localized SEO copy: ${locale}:${route.route}`);
    for (const [field, value] of Object.entries({
      searchIntent: copy.searchIntent,
      primaryKeyword: copy.primaryKeyword,
      title: copy.title,
      description: copy.description,
      h1: copy.h1,
    })) {
      if (!value.trim()) throw new Error(`empty localized ${field}: ${locale}:${route.route}`);
      if (PLACEHOLDER.test(value)) {
        throw new Error(`placeholder localized ${field}: ${locale}:${route.route}`);
      }
    }

    const isHome = route.route === "/";
    if (!isHome && !bundle.landingSections[route.route]) {
      throw new Error(`missing localized landing content: ${locale}:${route.route}`);
    }
    if (isHome && bundle.homeSections.length === 0) {
      throw new Error(`missing localized homepage content: ${locale}`);
    }

    const alternates = buildLanguageAlternates(siteConfig, siteConfig.canonicalOrigin, route.route);
    if (
      alternates["x-default"] !==
      `${siteConfig.canonicalOrigin}${localePath(siteConfig, siteConfig.defaultLocale, route.route)}`
    ) {
      throw new Error(`invalid x-default: ${route.route}`);
    }
    for (const supported of siteConfig.supportedLocales) {
      if (!alternates[supported]) throw new Error(`missing hreflang ${supported}: ${route.route}`);
    }
  }
}

if (siteConfig.localePrefixStrategy !== "as-needed") {
  throw new Error("only default-unprefixed locale routing is supported");
}

console.log(
  JSON.stringify({
    event: "i18n_verified",
    locales: siteConfig.supportedLocales,
    indexableRoutes: indexable.length,
  }),
);
