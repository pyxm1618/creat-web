import Link from "next/link";

import { featuresConfig } from "@/config/features.config";
import { siteConfig } from "@/config/site.config";
import { localePath } from "@/platform/i18n/routing";

export function SiteHeader({ locale = siteConfig.defaultLocale }: Readonly<{ locale?: string }>) {
  const homeHref = localePath(siteConfig, locale, "/");
  const pricingHref = localePath(siteConfig, locale, "/pricing");

  return (
    <header className="site-header">
      <div className="content-width site-header__inner">
        <Link className="brand-link" href={homeHref} aria-label={`${siteConfig.name} home`}>
          {siteConfig.name}
        </Link>
        <nav aria-label="Primary navigation" className="site-nav">
          <Link href={pricingHref}>Pricing</Link>
          {featuresConfig.auth.enabled ? <Link href="/sign-in">Sign in</Link> : null}
        </nav>
        {siteConfig.supportedLocales.length > 1 ? (
          <nav aria-label="Language" className="language-nav">
            {siteConfig.supportedLocales.map((targetLocale) => (
              <Link
                key={targetLocale}
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
