import type { Metadata } from "next";

import { JsonLd } from "@/components/seo/json-ld";
import { LandingPage, type LandingSection } from "@/components/landing/landing-page";
import { routeRegistry } from "@/config/routes.config";
import { currentSeoEnvironment } from "@/platform/seo/environment-policy";
import { metadataForRoute } from "@/platform/seo/metadata";
import { webApplicationJsonLd, websiteJsonLd } from "@/platform/seo/structured-data";

export const metadata: Metadata = metadataForRoute(routeRegistry, "/", currentSeoEnvironment());

const sections: readonly LandingSection[] = [
  {
    type: "hero",
    eyebrow: "Neutral starter · draft content",
    h1: "Build a focused web product on a safer foundation",
    body: "This sample product purpose is intentionally neutral: demonstrate a reusable web foundation with authentication, technical SEO, configurable legal pages, commerce boundaries and release gates without inheriting another product’s identity.",
    primaryCta: { label: "Review pricing structure", href: "/pricing" },
    secondaryCta: { label: "Sign in", href: "/sign-in" },
  },
  {
    type: "tool-demo",
    title: "Separate product logic from platform infrastructure",
    body: "Keep authentication, SEO, legal, commerce and observability behind reusable interfaces while the actual product experience remains project-owned.",
    render: (
      <div>
        <p className="section-kicker">Example boundary</p>
        <strong>Product UI → application use case → platform adapter</strong>
        <p>Replace this demonstration panel with the real product surface.</p>
      </div>
    ),
  },
  {
    type: "use-cases",
    title: "Designed for small, focused web products",
    items: [
      {
        title: "SEO-first tools",
        body: "Render useful primary content on the server and make indexability explicit per route.",
        href: "/pricing",
      },
      {
        title: "Account-based products",
        body: "Use reusable authentication and deletion workflows without coupling business records to login identity.",
      },
      {
        title: "Paid utilities",
        body: "Add provider-isolated payments and durable fulfillment without trusting browser redirects.",
      },
    ],
  },
  {
    type: "how-it-works",
    title: "A repeatable delivery sequence",
    steps: [
      {
        title: "Configure",
        body: "Replace draft site, route, legal and product facts with reviewed project data.",
      },
      {
        title: "Build",
        body: "Implement the narrow product experience on top of stable platform boundaries.",
      },
      {
        title: "Verify",
        body: "Run architecture, security, SEO, data and release checks before production.",
      },
    ],
  },
  {
    type: "features",
    title: "Reusable foundations without premature framework lock-in",
    items: [
      {
        title: "Explicit route policy",
        body: "Each route is indexable, noindex, private or system—never implicitly public.",
      },
      {
        title: "Provider isolation",
        body: "External email, auth and payment services sit behind application boundaries.",
      },
      {
        title: "Fail-closed release checks",
        body: "Draft legal facts, placeholder domains and unsafe deployment modes block release.",
      },
    ],
  },
  { type: "pricing", title: "Keep price and entitlement authority on the server" },
  {
    type: "faq",
    title: "Starter questions",
    items: [
      {
        question: "Is this a finished product?",
        answer:
          "No. It is a reusable starter whose product copy, commercial facts and legal facts must be replaced and reviewed for each launch.",
      },
      {
        question: "Does the starter guarantee search rankings?",
        answer: "No. It provides technical SEO controls and validation, not a ranking guarantee.",
      },
      {
        question: "Can providers be disabled?",
        answer:
          "Yes. Optional integrations are composed behind feature flags and must not require secrets merely because their modules exist.",
      },
    ],
  },
  {
    type: "seo-content",
    heading: "What the starter standardizes",
    body: (
      <>
        <p>
          The starter standardizes technical concerns that are easy to get subtly wrong:
          authentication sessions, route indexability, canonical behavior, structured data, legal
          document versioning, payment state, idempotency, retries, retention and release
          verification.
        </p>
        <p>
          It deliberately leaves positioning, product mechanics, final legal language and production
          provider facts to the downstream project. That separation makes the shared foundation
          reusable without turning it into a product-specific monolith.
        </p>
      </>
    ),
  },
  {
    type: "final-cta",
    heading: "Replace draft facts before launch",
    body: "The neutral configuration is safe for development because production verification rejects its placeholders and draft legal status.",
    cta: { label: "Review the policy framework", href: "/privacy" },
  },
];

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
      <LandingPage sections={sections} />
    </main>
  );
}
