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

export type LandingSection =
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
      readonly type: "final-cta";
      readonly heading: string;
      readonly body: string;
      readonly cta: { readonly label: string; readonly href: string };
    };

export function LandingPage({ sections }: Readonly<{ sections: readonly LandingSection[] }>) {
  return (
    <>
      {sections.map((section, index) => {
        const key = `${section.type}-${index}`;
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
          case "final-cta":
            return <FinalCtaSection key={key} {...section} />;
        }
      })}
    </>
  );
}
