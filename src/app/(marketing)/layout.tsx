import type { ReactNode } from "react";

import { SiteFooter } from "@/components/navigation/site-footer";
import { SiteHeader } from "@/components/navigation/site-header";

export default function MarketingLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="site-frame">
      <SiteHeader />
      {children}
      <SiteFooter />
    </div>
  );
}
