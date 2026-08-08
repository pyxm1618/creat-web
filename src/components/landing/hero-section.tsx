import Link from "next/link";

type Cta = { readonly label: string; readonly href: string };

export function HeroSection({
  eyebrow,
  h1,
  body,
  primaryCta,
  secondaryCta,
}: Readonly<{
  eyebrow?: string;
  h1: string;
  body: string;
  primaryCta: Cta;
  secondaryCta?: Cta;
}>) {
  return (
    <section className="hero-section" aria-labelledby="home-heading">
      <div className="content-width hero-section__inner">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1 id="home-heading">{h1}</h1>
        <p className="hero-copy">{body}</p>
        <div className="cta-row">
          <Link className="button button--primary" href={primaryCta.href}>
            {primaryCta.label}
          </Link>
          {secondaryCta ? (
            <Link className="button button--secondary" href={secondaryCta.href}>
              {secondaryCta.label}
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}
