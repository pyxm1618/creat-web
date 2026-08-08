import Link from "next/link";

export function FinalCtaSection({
  heading,
  body,
  cta,
}: Readonly<{
  heading: string;
  body: string;
  cta: { readonly label: string; readonly href: string };
}>) {
  return (
    <section className="final-cta" aria-labelledby="final-cta-heading">
      <div className="content-width content-width--narrow">
        <h2 id="final-cta-heading">{heading}</h2>
        <p>{body}</p>
        <Link className="button button--primary" href={cta.href}>
          {cta.label}
        </Link>
      </div>
    </section>
  );
}
