import type { Metadata } from "next";

import { LandingPage } from "@/components/landing/landing-page";
import { JsonLd } from "@/components/seo/json-ld";
import { homeConfig } from "@/config/home.config";
import { routeRegistry } from "@/config/routes.config";
import { currentSeoEnvironment } from "@/platform/seo/environment-policy";
import { metadataForRoute } from "@/platform/seo/metadata";
import { webApplicationJsonLd, websiteJsonLd } from "@/platform/seo/structured-data";

export const metadata: Metadata = metadataForRoute(routeRegistry, "/", currentSeoEnvironment());

export default function HomePage() {
  const home = routeRegistry.get("/");
  if (home.class !== "public_indexable") throw new Error("home route must be indexable");

  return (
    <main>
      <JsonLd
        value={websiteJsonLd({
          name: routeRegistry.site.siteName,
          url: routeRegistry.site.canonicalOrigin,
          description: routeRegistry.site.defaultDescription,
        })}
      />
      <JsonLd
        value={webApplicationJsonLd({
          name: home.title,
          url: routeRegistry.site.canonicalOrigin,
          description: home.description,
        })}
      />
      <LandingPage sections={homeConfig.sections} />
    </main>
  );
}
