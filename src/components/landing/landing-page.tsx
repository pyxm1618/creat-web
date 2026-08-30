import Link from "next/link";
import type { ReactNode } from "react";

import {
  bodyText,
  buttonOnInverse,
  buttonPrimaryLarge,
  buttonSecondaryLarge,
  card,
  cardTitle,
  container,
  eyebrow,
  inlineLink,
  leadText,
  sectionSpacing,
  sectionTitle,
} from "@/components/ui/styles";

export type LandingSection =
  | {
      readonly type: "hero";
      readonly enabled?: boolean;
      readonly order?: number;
      readonly eyebrow?: string;
      readonly h1: string;
      readonly lead: string;
      readonly primaryCta: { readonly label: string; readonly href: string };
      readonly secondaryCta?: { readonly label: string; readonly href: string };
    }
  | {
      readonly type: "tool-demo";
      readonly enabled?: boolean;
      readonly order?: number;
      readonly heading: string;
      readonly body: string;
      readonly surface: ReactNode;
    }
  | {
      readonly type: "use-cases";
      readonly enabled?: boolean;
      readonly order?: number;
      readonly heading: string;
      readonly intro?: string;
      readonly items: readonly {
        readonly title: string;
        readonly body: string;
        readonly href?: string;
      }[];
    }
  | {
      readonly type: "how-it-works";
      readonly enabled?: boolean;
      readonly order?: number;
      readonly heading: string;
      readonly steps: readonly { readonly title: string; readonly body: string }[];
    }
  | {
      readonly type: "features";
      readonly enabled?: boolean;
      readonly order?: number;
      readonly heading: string;
      readonly items: readonly { readonly title: string; readonly body: string }[];
    }
  | {
      readonly type: "comparison";
      readonly enabled?: boolean;
      readonly order?: number;
      readonly heading: string;
      readonly body?: string;
      readonly items: readonly { readonly title: string; readonly body: string }[];
    }
  | {
      readonly type: "pricing";
      readonly enabled?: boolean;
      readonly order?: number;
      readonly heading: string;
      readonly body: string;
      readonly cards: readonly ReactNode[];
    }
  | {
      readonly type: "faq";
      readonly enabled?: boolean;
      readonly order?: number;
      readonly heading: string;
      readonly items: readonly { readonly question: string; readonly answer: string }[];
    }
  | {
      readonly type: "seo-content";
      readonly enabled?: boolean;
      readonly order?: number;
      readonly heading: string;
      readonly paragraphs: readonly string[];
    }
  | {
      readonly type: "related-resources";
      readonly enabled?: boolean;
      readonly order?: number;
      readonly heading: string;
      readonly links: readonly {
        readonly label: string;
        readonly href: string;
        readonly description?: string;
      }[];
    }
  | {
      readonly type: "final-cta";
      readonly enabled?: boolean;
      readonly order?: number;
      readonly heading: string;
      readonly body: string;
      readonly cta: { readonly label: string; readonly href: string };
    };

const grid = "mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3";

function HeroSection(props: Extract<LandingSection, { type: "hero" }>) {
  return (
    <section className="border-b border-border bg-surface-muted" aria-labelledby="page-title">
      <div className={`${container} py-20 sm:py-28`}>
        {props.eyebrow ? <p className={eyebrow}>{props.eyebrow}</p> : null}
        <h1
          id="page-title"
          className="mt-5 max-w-3xl text-4xl font-semibold tracking-tight text-balance text-foreground sm:text-5xl lg:text-[3.25rem] lg:leading-[1.08]"
        >
          {props.h1}
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">{props.lead}</p>
        <div className="mt-9 flex flex-wrap gap-3">
          <Link className={buttonPrimaryLarge} href={props.primaryCta.href}>
            {props.primaryCta.label}
          </Link>
          {props.secondaryCta ? (
            <Link className={buttonSecondaryLarge} href={props.secondaryCta.href}>
              {props.secondaryCta.label}
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ToolDemoSection(props: Extract<LandingSection, { type: "tool-demo" }>) {
  return (
    <section className={sectionSpacing} aria-labelledby="tool-demo-title">
      <div className={container}>
        <h2 id="tool-demo-title" className={sectionTitle}>
          {props.heading}
        </h2>
        <p className={leadText}>{props.body}</p>
        <div className="mt-8 rounded-xl border border-border bg-surface p-6 shadow-sm sm:p-8">
          {props.surface}
        </div>
      </div>
    </section>
  );
}

function UseCasesSection(props: Extract<LandingSection, { type: "use-cases" }>) {
  return (
    <section className={sectionSpacing} aria-labelledby="use-cases-title">
      <div className={container}>
        <h2 id="use-cases-title" className={sectionTitle}>
          {props.heading}
        </h2>
        {props.intro ? <p className={leadText}>{props.intro}</p> : null}
        <div className={grid}>
          {props.items.map((item) => (
            <article className={`${card} flex flex-col`} key={item.title}>
              <h3 className={cardTitle}>{item.title}</h3>
              <p className={`mt-3 flex-1 ${bodyText}`}>{item.body}</p>
              {item.href ? (
                <Link href={item.href} className={`mt-4 ${inlineLink}`}>
                  Explore {item.title}
                </Link>
              ) : null}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorksSection(props: Extract<LandingSection, { type: "how-it-works" }>) {
  return (
    <section
      className={`${sectionSpacing} border-y border-border bg-surface-muted`}
      aria-labelledby="how-title"
    >
      <div className={container}>
        <h2 id="how-title" className={sectionTitle}>
          {props.heading}
        </h2>
        <ol className="mt-10 grid gap-8 sm:grid-cols-3">
          {props.steps.map((step, index) => (
            <li key={step.title}>
              <span className="flex size-8 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-foreground">
                {index + 1}
              </span>
              <strong className={`mt-4 block ${cardTitle}`}>{step.title}</strong>
              <p className={`mt-2 ${bodyText}`}>{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function FeaturesSection(props: Extract<LandingSection, { type: "features" }>) {
  return (
    <section className={sectionSpacing} aria-labelledby="features-title">
      <div className={container}>
        <h2 id="features-title" className={sectionTitle}>
          {props.heading}
        </h2>
        <div className={grid}>
          {props.items.map((item) => (
            <article className={card} key={item.title}>
              <h3 className={cardTitle}>{item.title}</h3>
              <p className={`mt-3 ${bodyText}`}>{item.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function ComparisonSection(props: Extract<LandingSection, { type: "comparison" }>) {
  return (
    <section className={sectionSpacing} aria-labelledby="comparison-title">
      <div className={container}>
        <h2 id="comparison-title" className={sectionTitle}>
          {props.heading}
        </h2>
        {props.body ? <p className={leadText}>{props.body}</p> : null}
        <div className={grid}>
          {props.items.map((item) => (
            <article className={card} key={item.title}>
              <h3 className={cardTitle}>{item.title}</h3>
              <p className={`mt-3 ${bodyText}`}>{item.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function PricingSection(props: Extract<LandingSection, { type: "pricing" }>) {
  return (
    <section
      className={`${sectionSpacing} border-y border-border bg-surface-muted`}
      aria-labelledby="pricing-title"
    >
      <div className={container}>
        <h2 id="pricing-title" className={sectionTitle}>
          {props.heading}
        </h2>
        <p className={leadText}>{props.body}</p>
        <div className={grid}>{props.cards}</div>
      </div>
    </section>
  );
}

function FaqSection(props: Extract<LandingSection, { type: "faq" }>) {
  return (
    <section className={sectionSpacing} aria-labelledby="faq-title">
      <div className={container}>
        <h2 id="faq-title" className={sectionTitle}>
          {props.heading}
        </h2>
        <div className="mt-8 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
          {props.items.map((item) => (
            <details key={item.question} className="group">
              <summary className="flex cursor-pointer items-center justify-between gap-4 p-5 text-[0.9375rem] font-medium text-foreground marker:content-none hover:bg-surface-muted">
                {item.question}
                <span
                  aria-hidden="true"
                  className="shrink-0 text-muted transition-transform group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className={`px-5 pb-5 ${bodyText}`}>{item.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function SeoContentSection(props: Extract<LandingSection, { type: "seo-content" }>) {
  return (
    <section className={sectionSpacing} aria-labelledby="seo-content-title">
      <div className={container}>
        <h2 id="seo-content-title" className={sectionTitle}>
          {props.heading}
        </h2>
        <div className="mt-6 max-w-2xl space-y-4">
          {props.paragraphs.map((paragraph) => (
            <p key={paragraph} className={bodyText}>
              {paragraph}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}

function RelatedResourcesSection(props: Extract<LandingSection, { type: "related-resources" }>) {
  return (
    <nav className={`${sectionSpacing} border-t border-border`} aria-labelledby="related-title">
      <div className={container}>
        <h2 id="related-title" className={sectionTitle}>
          {props.heading}
        </h2>
        <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {props.links.map((link) => (
            <li key={link.href} className={card}>
              <Link href={link.href} className={`${cardTitle} hover:text-accent`}>
                {link.label}
              </Link>
              {link.description ? <p className={`mt-2 ${bodyText}`}>{link.description}</p> : null}
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

function FinalCtaSection(props: Extract<LandingSection, { type: "final-cta" }>) {
  return (
    <section className="bg-inverse" aria-labelledby="final-cta-title">
      <div className={`${container} py-16 sm:py-20`}>
        <h2
          id="final-cta-title"
          className="max-w-2xl text-2xl font-semibold tracking-tight text-inverse-foreground sm:text-3xl"
        >
          {props.heading}
        </h2>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-inverse-foreground/70">
          {props.body}
        </p>
        <Link className={`${buttonOnInverse} mt-8`} href={props.cta.href}>
          {props.cta.label}
        </Link>
      </div>
    </section>
  );
}

export function LandingPage({ sections }: Readonly<{ sections: readonly LandingSection[] }>) {
  const visibleSections: LandingSection[] = sections.filter((section) => section.enabled !== false);
  visibleSections.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

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
          case "comparison":
            return <ComparisonSection key={key} {...section} />;
          case "pricing":
            return <PricingSection key={key} {...section} />;
          case "faq":
            return <FaqSection key={key} {...section} />;
          case "seo-content":
            return <SeoContentSection key={key} {...section} />;
          case "related-resources":
            return <RelatedResourcesSection key={key} {...section} />;
          case "final-cta":
            return <FinalCtaSection key={key} {...section} />;
        }
      })}
    </>
  );
}
