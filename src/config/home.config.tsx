import type { LandingSection } from "@/components/landing/landing-page";
import { SubscriptionOffer } from "@/components/commerce/subscription-offer";

import { featuresConfig } from "./features.config";
import { routeRegistry } from "./routes.config";

const homeRoute = routeRegistry.get("/");
if (homeRoute.class !== "public_indexable") throw new Error("home route must be indexable");

export const homeConfig = {
  sections: [
    {
      type: "hero",
      enabled: true,
      order: 10,
      eyebrow: "SEO-first neutral starter",
      h1: homeRoute.h1,
      lead: "Launch a useful public web product before committing to authentication, email or payments. The starter keeps SEO-critical copy server-rendered and lets product modules stay completely off until validation justifies them.",
      primaryCta: { label: "Explore the launch checklist", href: "/seo-starter-checklist" },
      secondaryCta: { label: "Review pricing structure", href: "/pricing" },
    },
    {
      type: "tool-demo",
      enabled: true,
      order: 20,
      heading: "Put the product surface before supporting copy",
      body: "For tools, calculators and generators, replace this neutral surface with the real server-rendered or progressively enhanced product experience. Authentication and commerce are not prerequisites for the first launch.",
      surface: (
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">
            Product-first boundary
          </p>
          <strong className="mt-3 block text-base font-semibold text-foreground">
            Useful surface → supporting explanation → optional platform modules
          </strong>
          <p className="mt-2 text-[0.9375rem] leading-relaxed text-muted">
            Swap this panel for the product itself without rebuilding the SEO shell.
          </p>
        </div>
      ),
    },
    {
      type: "use-cases",
      enabled: true,
      order: 30,
      heading: "Start with one clear search intent",
      items: [
        {
          title: "SEO-first tools",
          body: "Ship one useful tool and the content required to satisfy its search intent before expanding into adjacent topics.",
          href: "/seo-starter-checklist",
        },
        {
          title: "Focused product landing pages",
          body: "Add a page only when it serves a genuinely distinct intent rather than splitting synonyms into thin doorway pages.",
        },
        {
          title: "Validated paid utilities",
          body: "Enable auth, payment, credits and subscriptions after the public product proves that users value the workflow.",
        },
      ],
    },
    {
      type: "how-it-works",
      enabled: true,
      order: 40,
      heading: "A repeatable SEO launch sequence",
      steps: [
        {
          title: "Configure",
          body: "Replace site identity, canonical origin, TDH, primary intent, logo and legal operator facts in the small config surface.",
        },
        {
          title: "Publish useful HTML",
          body: "Keep the product surface and supporting content server-rendered, crawlable and linked through normal anchors.",
        },
        {
          title: "Validate before expanding",
          body: "Submit the sitemap, observe indexing and demand, then add only the product modules and landing pages that earn their complexity.",
        },
      ],
    },
    {
      type: "features",
      enabled: true,
      order: 50,
      heading: "Platform features stay optional",
      items: [
        {
          title: "Intent-aware SEO registry",
          body: "Indexable routes declare search intent, keyword focus, TDH, canonical, related routes and review state in one place.",
        },
        {
          title: "Server-first marketing",
          body: "The default homepage does not need authentication, commerce or analytics JavaScript to render its core content.",
        },
        {
          title: "Fail-closed release gates",
          body: "Placeholder domains, draft legal facts, broken internal links and unsafe deployment modes block production verification.",
        },
      ],
    },
    {
      type: "comparison",
      enabled: false,
      order: 60,
      heading: "Evidence or comparison",
      body: "Enable this section only when the downstream product has truthful, visible evidence worth comparing.",
      items: [
        {
          title: "No fabricated proof",
          body: "Do not add ratings, reviews or claims merely to populate a schema or landing-page pattern.",
        },
      ],
    },
    {
      type: "pricing",
      enabled: featuresConfig.commerce.subscriptions,
      order: 60,
      heading: "Test Mode subscription",
      body: "Subscribe in Waffo Test Mode to receive 100 usage credits for each successful monthly payment.",
      cards: [
        <SubscriptionOffer
          key="test2-subscription"
          productKey="test2"
          headline="test2 monthly"
          body="A Test Mode subscription for the current end-to-end acceptance run."
          priceLabel="$1.88 / month"
        />,
      ],
    },
    {
      type: "faq",
      enabled: true,
      order: 70,
      heading: "SEO-first starter questions",
      items: [
        {
          question: "Do I need authentication for the first launch?",
          answer:
            "No. The neutral starter keeps authentication, email, commerce, credits, subscriptions and analytics disabled by default.",
        },
        {
          question: "Should every related keyword become a separate page?",
          answer:
            "No. Create a separate landing page only when it serves a distinct search intent and can provide genuinely useful standalone content.",
        },
        {
          question: "Does the starter guarantee rankings?",
          answer:
            "No. It enforces technical and on-page hygiene, but rankings still depend on usefulness, competition, authority and search demand.",
        },
      ],
    },
    {
      type: "seo-content",
      enabled: true,
      order: 80,
      heading: "What the SEO-first starter standardizes",
      paragraphs: [
        "The starter centralizes route intent, canonical policy, title and description generation, one primary H1, structured data, internal-link relationships, locale alternates and production review gates. Those controls make obvious launch mistakes mechanically detectable instead of relying on a final manual sweep.",
        "Product positioning and copy remain downstream responsibilities. The starter provides a reliable delivery surface without creating doorway pages, hidden keyword blocks, fake review markup or client-only content that crawlers and users cannot depend on.",
      ],
    },
    {
      type: "related-resources",
      enabled: true,
      order: 90,
      heading: "Related launch resources",
      links: [
        {
          label: "SEO starter launch checklist",
          href: "/seo-starter-checklist",
          description: "Use the reusable landing-page pattern and pre-launch validation checklist.",
        },
        {
          label: "Web product pricing template",
          href: "/pricing",
          description: "See how monetization can remain separate from the SEO launch surface.",
        },
        {
          label: "Privacy notice template",
          href: "/privacy",
          description: "Replace draft operator and provider facts before production release.",
        },
      ],
    },
    {
      type: "final-cta",
      enabled: true,
      order: 100,
      heading: "Launch the useful public surface first",
      body: "Replace the neutral brand, intent, TDH, logo, body copy and legal facts; keep optional product modules off until the site earns the next phase.",
      cta: { label: "Open the SEO launch checklist", href: "/seo-starter-checklist" },
    },
  ] satisfies readonly LandingSection[],
} as const;
