import type { LandingSection } from "@/components/landing/landing-page";

import { routeRegistry } from "./routes.config";

export type SeoLandingConfig = {
  readonly route: string;
  readonly sections: readonly LandingSection[];
};

function indexableRoute(route: string) {
  const definition = routeRegistry.get(route);
  if (definition.class !== "public_indexable") {
    throw new Error(`${route} must be indexable`);
  }
  return definition;
}

const checklistRoute = indexableRoute("/seo-starter-checklist");
const pricingRoute = indexableRoute("/pricing");

export const seoLandingPages = [
  {
    route: "/seo-starter-checklist",
    sections: [
      {
        type: "hero",
        enabled: true,
        order: 10,
        eyebrow: "Reusable SEO landing template",
        h1: checklistRoute.h1,
        body: "Use this page as both a launch checklist and a reference implementation for adding a genuinely distinct search-intent landing page without recreating metadata, structured data, internal-link or performance plumbing.",
        primaryCta: { label: "Start from the homepage", href: "/" },
      },
      {
        type: "use-cases",
        enabled: true,
        order: 20,
        title: "Before creating a new SEO landing page",
        items: [
          {
            title: "Confirm independent intent",
            body: "The page should answer a materially different search need, not just a synonym of an existing route.",
          },
          {
            title: "Provide a useful surface",
            body: "Prefer the real tool, workflow, calculator, demo, or decision support near the top when that is what the query expects.",
          },
          {
            title: "Write standalone supporting content",
            body: "Add the explanation, examples, limits and internal links required for the page to be useful without keyword padding.",
          },
        ],
      },
      {
        type: "how-it-works",
        enabled: true,
        order: 30,
        title: "SEO launch checklist",
        steps: [
          {
            title: "Model intent and TDH",
            body: "Define one search intent, primary keyword, supporting terms, a descriptive title, a useful meta description, and one clear visible H1.",
          },
          {
            title: "Verify crawl and canonical behavior",
            body: "Confirm status 200, crawlable anchors, production canonical, sitemap inclusion, robots policy, and no staging or private-route leakage.",
          },
          {
            title: "Check real-page performance",
            body: "Measure the rendered mobile and desktop page, keep unnecessary client JavaScript out, size images explicitly, and avoid blocking third-party scripts.",
          },
          {
            title: "Review visible structured data",
            body: "Emit only schema that matches what users can actually see; never manufacture ratings, reviews, offers or FAQ content for markup.",
          },
        ],
      },
      {
        type: "features",
        enabled: true,
        order: 40,
        title: "What the starter validates automatically",
        items: [
          {
            title: "Metadata and intent",
            body: "Required intent fields, TDH length heuristics, uniqueness, placeholder detection, canonical consistency and review state.",
          },
          {
            title: "Internal links",
            body: "Known targets, indexable-page reachability and related-route relationships so new pages do not become orphaned.",
          },
          {
            title: "Release safety",
            body: "Production release checks block example domains, draft legal facts, missing provider facts and unsafe optional-module configuration.",
          },
        ],
      },
      {
        type: "faq",
        enabled: true,
        order: 50,
        title: "Landing-page questions",
        items: [
          {
            question: "How many SEO pages should a new site create?",
            answer:
              "As few as the product can justify. Add a page when it serves a distinct intent with useful standalone content; do not create a fixed quota of keyword pages.",
          },
          {
            question: "Does the primary keyword need an exact-match title and H1?",
            answer:
              "No. The title and H1 should clearly describe the same topic and intent without mechanical exact-match repetition or keyword stuffing.",
          },
        ],
      },
      {
        type: "seo-content",
        enabled: true,
        order: 60,
        heading: "Why the template separates intent from implementation",
        body: (
          <>
            <p>
              Route intent belongs in the SEO registry, while the actual tool and supporting content
              live in landing-page configuration. This keeps canonical, metadata, sitemap and
              internal-link rules consistent even when different products use very different page
              structures.
            </p>
            <p>
              A downstream project can add a route and content configuration, then reuse the same
              server renderer and validation gates. That is deliberately different from generating
              hundreds of near-duplicate pages from a keyword list.
            </p>
          </>
        ),
      },
      {
        type: "related-resources",
        enabled: true,
        order: 70,
        title: "Continue the launch flow",
        links: [
          {
            label: "SEO-first starter homepage",
            href: "/",
            description: "Return to the product-first launch structure and optional module model.",
          },
          {
            label: "Web product pricing template",
            href: "/pricing",
            description: "Review the monetization surface before enabling commerce.",
          },
          {
            label: "Privacy notice template",
            href: "/privacy",
            description: "Replace draft operator and provider disclosures before production.",
          },
        ],
      },
      {
        type: "final-cta",
        enabled: true,
        order: 80,
        heading: "Add pages only when the intent deserves one",
        body: "For the next landing page, add its intent model and content configuration, link it from a relevant page, and let the shared SEO gates catch mechanical mistakes.",
        cta: { label: "Return to the starter", href: "/" },
      },
    ],
  },
  {
    route: "/pricing",
    sections: [
      {
        type: "hero",
        enabled: true,
        order: 10,
        eyebrow: "Optional monetization surface",
        h1: pricingRoute.h1,
        body: "Keep commercial facts and price authority on the server. A new SEO-only site can leave commerce disabled; once value is validated, configure real products and enable the payment module without rebuilding the public shell.",
        primaryCta: { label: "Return to the SEO-first starter", href: "/" },
      },
      {
        type: "features",
        enabled: true,
        order: 20,
        title: "Server-owned pricing contract",
        items: [
          {
            title: "Immutable product version",
            body: "A local product key and version bind the expected currency, amount, provider product ID, fulfillment and refund policy.",
          },
          {
            title: "Provider isolation",
            body: "The browser never becomes price or entitlement authority, and Waffo-specific details stay behind the payment-provider adapter.",
          },
          {
            title: "Commerce can remain off",
            body: "When the feature flag is disabled, the public marketing site does not require payment secrets, SDK initialization or payment database workflows.",
          },
        ],
      },
      {
        type: "related-resources",
        enabled: true,
        order: 30,
        title: "Related commercial policies",
        links: [
          { label: "Refund and cancellation policy", href: "/refund-policy" },
          { label: "Terms of service", href: "/terms" },
          { label: "SEO starter launch checklist", href: "/seo-starter-checklist" },
        ],
      },
    ],
  },
] as const satisfies readonly SeoLandingConfig[];

export function seoLandingForRoute(route: string): SeoLandingConfig | undefined {
  return seoLandingPages.find((page) => page.route === route);
}
