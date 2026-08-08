import Link from "next/link";

import { siteConfig } from "@/config/site.config";

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="content-width site-header__inner">
        <Link className="brand-link" href="/" aria-label={`${siteConfig.name} home`}>
          {siteConfig.name}
        </Link>
        <nav aria-label="Primary navigation" className="site-nav">
          <Link href="/pricing">Pricing</Link>
          <Link href="/sign-in">Sign in</Link>
        </nav>
      </div>
    </header>
  );
}
