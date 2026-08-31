import Link from "next/link";

import { featuresConfig } from "@/config/features.config";
import { siteConfig } from "@/config/site.config";
import { localePath } from "@/platform/i18n/routing";

const navLink =
  "text-sm font-medium text-muted transition-colors hover:text-foreground aria-[current=page]:text-foreground";

export function SiteHeader({ locale = siteConfig.defaultLocale }: Readonly<{ locale?: string }>) {
  const homeHref = localePath(siteConfig, locale, "/");
  const pricingHref = localePath(siteConfig, locale, "/pricing");

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-5xl items-center gap-6 px-6 sm:px-8">
        <Link
          className="text-[0.9375rem] font-semibold tracking-tight text-foreground"
          href={homeHref}
          aria-label={`${siteConfig.name} home`}
        >
          {siteConfig.name}
        </Link>
        <nav aria-label="Primary navigation" className="ml-auto flex items-center gap-6">
          <Link className={navLink} href={pricingHref}>
            Pricing
          </Link>
          {featuresConfig.auth.enabled ? (
            <Link className={navLink} href="/sign-in">
              Sign in
            </Link>
          ) : null}
        </nav>
        {siteConfig.supportedLocales.length > 1 ? (
          <nav
            aria-label="Language"
            className="flex items-center gap-3 border-l border-border pl-6"
          >
            {siteConfig.supportedLocales.map((targetLocale) => (
              <Link
                key={targetLocale}
                className={navLink}
                href={localePath(siteConfig, targetLocale, "/")}
                hrefLang={targetLocale}
                lang={targetLocale}
                aria-current={targetLocale === locale ? "page" : undefined}
              >
                {siteConfig.localeLabels[targetLocale]}
              </Link>
            ))}
          </nav>
        ) : null}
      </div>
    </header>
  );
}
