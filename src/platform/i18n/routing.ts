import type { LocalePrefixStrategy } from "@/platform/config/types";

export type I18nRoutingConfig = {
  readonly defaultLocale: string;
  readonly supportedLocales: readonly string[];
  readonly localeLabels: Readonly<Record<string, string>>;
  readonly localePrefixStrategy: LocalePrefixStrategy;
};

function normalizeRoute(route: string): string {
  if (!route || route === "/") return "/";
  return `/${route.replace(/^\/+|\/+$/g, "")}`;
}

export function isSupportedLocale(config: I18nRoutingConfig, locale: string): boolean {
  return config.supportedLocales.some((supported) => supported === locale);
}

function assertLocale(config: I18nRoutingConfig, locale: string): void {
  if (!isSupportedLocale(config, locale)) throw new Error(`unsupported locale: ${locale}`);
}

export function localePath(config: I18nRoutingConfig, locale: string, route: string): string {
  assertLocale(config, locale);
  const normalized = normalizeRoute(route);
  if (locale === config.defaultLocale) return normalized;
  return normalized === "/" ? `/${locale}` : `/${locale}${normalized}`;
}

export function localeFromPath(config: I18nRoutingConfig, pathname: string): string {
  const firstSegment = normalizeRoute(pathname).split("/").filter(Boolean)[0];
  if (firstSegment && isSupportedLocale(config, firstSegment)) return firstSegment;
  return config.defaultLocale;
}

export function buildLanguageAlternates(
  config: I18nRoutingConfig,
  canonicalOrigin: string,
  route: string,
): Readonly<Record<string, string>> {
  const origin = canonicalOrigin.replace(/\/+$/, "");
  const entries = config.supportedLocales.map(
    (locale) => [locale, `${origin}${localePath(config, locale, route)}`] as const,
  );
  return Object.fromEntries([
    ...entries,
    ["x-default", `${origin}${localePath(config, config.defaultLocale, route)}`],
  ]);
}
