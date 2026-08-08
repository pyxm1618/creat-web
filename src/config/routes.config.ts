import { createRouteRegistry } from "@/platform/seo/route-registry";
import type { RouteDefinition } from "@/platform/seo/types";

import { seoConfig } from "./seo.config";

export const routeDefinitions = [
  {
    route: "/",
    class: "public_indexable",
    searchIntent: "evaluate a reusable web product starter",
    primaryKeyword: "web product starter",
    secondaryKeywords: ["next.js starter", "saas starter architecture"],
    title: "Reusable Web Product Starter",
    description:
      "Explore a neutral starter architecture for secure, SEO-aware web products with reusable authentication, commerce and operations foundations.",
    h1: "Build a focused web product on a safer foundation",
    pageType: "WebApplication",
    relatedRoutes: ["/pricing", "/privacy", "/terms"],
    lastModified: "2026-08-08",
  },
  {
    route: "/pricing",
    class: "public_indexable",
    searchIntent: "understand starter product pricing structure",
    primaryKeyword: "web product pricing template",
    secondaryKeywords: ["pricing page starter"],
    title: "Pricing Structure",
    description:
      "Review the starter pricing-page structure and the server-owned product configuration used by reusable web products.",
    h1: "Pricing structure",
    pageType: "Pricing",
    relatedRoutes: ["/", "/refund-policy", "/terms"],
    lastModified: "2026-08-08",
  },
  {
    route: "/privacy",
    class: "public_noindex",
    pageType: "Legal",
    title: "Privacy Notice",
    description: "Project-configured privacy notice.",
  },
  {
    route: "/terms",
    class: "public_noindex",
    pageType: "Legal",
    title: "Terms of Service",
    description: "Project-configured terms of service.",
  },
  {
    route: "/acceptable-use",
    class: "public_noindex",
    pageType: "Legal",
    title: "Acceptable Use Policy",
    description: "Project-configured acceptable use policy.",
  },
  {
    route: "/refund-policy",
    class: "public_noindex",
    pageType: "Legal",
    title: "Refund and Cancellation Policy",
    description: "Project-configured refund and cancellation policy.",
  },
  {
    route: "/contact",
    class: "public_noindex",
    pageType: "Legal",
    title: "Contact",
    description: "Project contact information.",
  },
  {
    route: "/account-deletion",
    class: "public_noindex",
    pageType: "Legal",
    title: "Account Deletion",
    description: "Account deletion instructions and lifecycle summary.",
  },
  { route: "/sign-in", class: "public_noindex" },
  { route: "/auth/magic-link/confirm", class: "public_noindex" },
  { route: "/account", class: "private" },
  { route: "/account/security", class: "private" },
  { route: "/account/deleted", class: "private" },
  { route: "/checkout/return", class: "private" },
  { route: "/robots.txt", class: "system" },
  { route: "/sitemap.xml", class: "system" },
  { route: "/api/auth", class: "system" },
  { route: "/api/auth/magic-link/request", class: "system" },
  { route: "/api/auth/magic-link/confirm", class: "system" },
  { route: "/api/account/delete", class: "system" },
  { route: "/api/cron/account-deletions", class: "system" },
  { route: "/api/test/emails/latest", class: "system" },
] as const satisfies readonly RouteDefinition[];

export const routeRegistry = createRouteRegistry(seoConfig, routeDefinitions);
