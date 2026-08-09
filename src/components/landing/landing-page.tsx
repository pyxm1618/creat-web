import Link from "next/link";
import type { ReactNode } from "react";

import { FaqSection, type FaqItem } from "./faq-section";
import { FeaturesSection, type FeatureItem } from "./features-section";
import { FinalCtaSection } from "./final-cta-section";
import { HeroSection } from "./hero-section";
import { HowItWorksSection, type ProcessStep } from "./how-it-works-section";
import { PricingSection } from "./pricing-section";
import { SeoContentSection } from "./seo-content-section";
import { ToolDemoSection } from "./tool-demo-section";
import { UseCasesSection, type UseCaseItem } from "./use-cases-section";

type SectionControls = {
  readonly enabled?: boolean;
  readonly order?: number;
};

export type LandingSection = SectionControls &
  (
    | {
        readonly type: "hero";
        readonly eyebrow?: string;
        readonly h1: string;
        readonly body: string;
        readonly primaryCta: { readonly label: string; readonly href: string };
        readonly secondaryCta?: { readonly label: string; readonly href: string };
      }
    | {
        readonly type: "tool-demo";
        readonly title: string;
        readonly body: string;
        readonly render: ReactNode;
      }
    | { readonly type: "use-cases"; readonly title: string; readonly items: readonly UseCaseItem[] }
    | {
        readonly type: "how-it-works";
        readonly title: string;
        readonly steps: readonly ProcessStep[];
      }
    | { readonly type: "features"; readonly title: string; readonly items: readonly FeatureItem[] }
    | { readonly type: "pricing"; readonly title: string }
    | { readonly type: "faq"; readonly title: string; readonly items: readonly FaqItem[] }
    | { readonly type: "seo-content"; readonly heading: string; readonly body: ReactNode }
    | {
        readonly type: "comparison";
        readonly title: string;
        readonly body?: string;
        readonly items: readonly { readonly title: string; readonly body: string }[];
      }
    | {
        readonly type: "related-resources";
        readonly title: string;
        readonly links: readonly {
          readonly label: string;
          readonly href: string;
          readonly description?: string;
        }[];
      }
    | {
        readonly type: "final-cta";
        readonly heading: string;
        readonly body: string;
        readonly cta: { readonly label: string; readonly href: string };
      }
  );

function ComparisonSection(props: Readonly<Extract<LandingSection, { type: "comparison" }>>) {
  return (
    <section className="landing-section" aria-labelledby="comparison-heading">
      <div className="section-heading">
        <h2 id="comparison-heading">{props.title}</h2>
        {props.body ? <p>{props.body}</p> : null}
      </div>
      <div className="feature-grid">
        {props.items.map((item) => (
          <article key={item.title} className="feature-card">
            <h3>{item.title}</h3>
            <p>{item.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function RelatedResourcesSection(
  props: Readonly<Extract<LandingSection, { type: "related-resources" }>>,
) {
  return (
    <nav className="landing-section" aria-labelledby="related-resources-heading">
      <div className="section-heading">
        <h2 id="related-resources-heading">{props.title}</h2>
      </div>
      <ul className="related-links">
        {props.links.map((link) => (
          <li key={link.href}>
            <Link href={link.href}>{link.label}</Link>
            {link.description ? <p>{link.description}</p> : null}
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function LandingPage({ sections }: Readonly<{ sections: readonly LandingSection[] }>) {
  const visibleSections = sections
    .filter((section) => section.enabled !== false)
    .toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0));

  return (
    <>
      {visibleSections.map((section, index) => {
        const key = `${section.type}-${section.order ?? index}`;
        switch (section.type) {
          case "hero":
            return <HeroSection key={key} {...section} />;
          case "tool-demo":
            return <ToolDemoSection key={key} {...section} />;
          case "use-cases":
            return <UseCasesSection key={key} {...section} />;
          case "how-it-works":
            return <HowItWorksSection key={key} {...section} />;
          case "features":
            return <FeaturesSection key={key} {...section} />;
          case "pricing":
            return <PricingSection key={key} {...section} />;
          case "faq":
            return <FaqSection key={key} {...section} />;
          case "seo-content":
            return <SeoContentSection key={key} {...section} />;
          case "comparison":
            return <ComparisonSection key={key} {...section} />;
          case "related-resources":
            return <RelatedResourcesSection key={key} {...section} />;
          case "final-cta":
            return <FinalCtaSection key={key} {...section} />;
        }
      })}
    </>
  );
}
