import type { MetadataRoute } from "next";

import { routeRegistry } from "@/config/routes.config";
import { currentSeoEnvironment, seoEnvironmentPolicy } from "@/platform/seo/environment-policy";

export default function robots(): MetadataRoute.Robots {
  const policy = seoEnvironmentPolicy(currentSeoEnvironment());

  if (!policy.index) {
    return {
      rules: [{ userAgent: "*", disallow: "/" }],
    };
  }

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/account", "/auth", "/api", "/checkout"],
      },
    ],
    sitemap: new URL("/sitemap.xml", routeRegistry.site.canonicalOrigin).toString(),
  };
}
