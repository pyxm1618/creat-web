export type FeatureItem = {
  readonly title: string;
  readonly body: string;
};

export function FeaturesSection({
  title,
  items,
}: Readonly<{ title: string; items: readonly FeatureItem[] }>) {
  return (
    <section className="section" aria-labelledby="features-heading">
      <div className="content-width">
        <h2 id="features-heading">{title}</h2>
        <div className="card-grid">
          {items.map((item) => (
            <article className="feature-card" key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
