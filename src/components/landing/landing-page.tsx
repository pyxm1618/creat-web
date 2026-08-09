import Link from "next/link";
import type { ReactNode } from "react";

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

function HeroSection(props: Extract<LandingSection, { type: "hero" }>) {
  return (
    <section className="hero" aria-labelledby="page-title">
      {props.eyebrow ? <p className="eyebrow">{props.eyebrow}</p> : null}
      <h1 id="page-title">{props.h1}</h1>
      <p className="hero-copy">{props.lead}</p>
      <div className="hero-actions">
        <Link className="button primary" href={props.primaryCta.href}>
          {props.primaryCta.label}
        </Link>
        {props.secondaryCta ? (
          <Link className="button secondary" href={props.secondaryCta.href}>
            {props.secondaryCta.label}
          </Link>
        ) : null}
      </div>
    </section>
  );
}

function ToolDemoSection(props: Extract<LandingSection, { type: "tool-demo" }>) {
  return (
    <section className="section" aria-labelledby="tool-demo-title">
      <h2 id="tool-demo-title">{props.heading}</h2>
      <p>{props.body}</p>
      {props.surface}
    </section>
  );
}

function UseCasesSection(props: Extract<LandingSection, { type: "use-cases" }>) {
  return (
    <section className="section" aria-labelledby="use-cases-title">
      <h2 id="use-cases-title">{props.heading}</h2>
      {props.intro ? <p>{props.intro}</p> : null}
      <div className="grid three">
        {props.items.map((item) => (
          <article className="card" key={item.title}>
            <h3>{item.title}</h3>
            <p>{item.body}</p>
            {item.href ? <Link href={item.href}>Explore {item.title}</Link> : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function HowItWorksSection(props: Extract<LandingSection, { type: "how-it-works" }>) {
  return (
    <section className="section" aria-labelledby="how-title">
      <h2 id="how-title">{props.heading}</h2>
      <ol className="steps">
        {props.steps.map((step) => (
          <li key={step.title}>
            <strong>{step.title}</strong>
            <p>{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function FeaturesSection(props: Extract<LandingSection, { type: "features" }>) {
  return (
    <section className="section" aria-labelledby="features-title">
      <h2 id="features-title">{props.heading}</h2>
      <div className="grid three">
        {props.items.map((item) => (
          <article className="card" key={item.title}>
            <h3>{item.title}</h3>
            <p>{item.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function ComparisonSection(props: Extract<LandingSection, { type: "comparison" }>) {
  return (
    <section className="section" aria-labelledby="comparison-title">
      <h2 id="comparison-title">{props.heading}</h2>
      {props.body ? <p>{props.body}</p> : null}
      <div className="grid three">
        {props.items.map((item) => (
          <article className="card" key={item.title}>
            <h3>{item.title}</h3>
            <p>{item.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function PricingSection(props: Extract<LandingSection, { type: "pricing" }>) {
  return (
    <section className="section" aria-labelledby="pricing-title">
      <h2 id="pricing-title">{props.heading}</h2>
      <p>{props.body}</p>
      <div className="grid three">{props.cards}</div>
    </section>
  );
}

function FaqSection(props: Extract<LandingSection, { type: "faq" }>) {
  return (
    <section className="section" aria-labelledby="faq-title">
      <h2 id="faq-title">{props.heading}</h2>
      <div className="faq-list">
        {props.items.map((item) => (
          <details key={item.question}>
            <summary>{item.question}</summary>
            <p>{item.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function SeoContentSection(props: Extract<LandingSection, { type: "seo-content" }>) {
  return (
    <section className="section prose" aria-labelledby="seo-content-title">
      <h2 id="seo-content-title">{props.heading}</h2>
      {props.paragraphs.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </section>
  );
}

function RelatedResourcesSection(props: Extract<LandingSection, { type: "related-resources" }>) {
  return (
    <nav className="section" aria-labelledby="related-title">
      <h2 id="related-title">{props.heading}</h2>
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

function FinalCtaSection(props: Extract<LandingSection, { type: "final-cta" }>) {
  return (
    <section className="section final-cta" aria-labelledby="final-cta-title">
      <h2 id="final-cta-title">{props.heading}</h2>
      <p>{props.body}</p>
      <Link className="button primary" href={props.cta.href}>
        {props.cta.label}
      </Link>
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
