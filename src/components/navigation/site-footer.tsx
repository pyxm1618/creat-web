import Link from "next/link";

import { siteConfig } from "@/config/site.config";

const legalLinks = [
  ["Privacy", "/privacy"],
  ["Terms", "/terms"],
  ["Acceptable use", "/acceptable-use"],
  ["Refunds", "/refund-policy"],
  ["Account deletion", "/account-deletion"],
  ["Contact", "/contact"],
] as const;

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="content-width site-footer__inner">
        <p>© {new Date().getUTCFullYear()} {siteConfig.name}. Starter content remains project-owned.</p>
        <nav aria-label="Legal navigation" className="footer-nav">
          {legalLinks.map(([label, href]) => (
            <Link href={href} key={href}>
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
