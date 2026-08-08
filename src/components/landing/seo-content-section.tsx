import type { ReactNode } from "react";

export function SeoContentSection({
  heading,
  body,
}: Readonly<{ heading: string; body: ReactNode }>) {
  return (
    <section className="section section--muted" aria-labelledby="seo-content-heading">
      <div className="content-width content-width--narrow prose">
        <h2 id="seo-content-heading">{heading}</h2>
        {body}
      </div>
    </section>
  );
}
