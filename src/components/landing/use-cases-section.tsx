import Link from "next/link";

export type UseCaseItem = {
  readonly title: string;
  readonly body: string;
  readonly href?: string;
};

export function UseCasesSection({
  title,
  items,
}: Readonly<{ title: string; items: readonly UseCaseItem[] }>) {
  return (
    <section className="section" aria-labelledby="use-cases-heading">
      <div className="content-width">
        <h2 id="use-cases-heading">{title}</h2>
        <div className="card-grid">
          {items.map((item) => (
            <article className="feature-card" key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
              {item.href ? <Link href={item.href}>Learn more</Link> : null}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
