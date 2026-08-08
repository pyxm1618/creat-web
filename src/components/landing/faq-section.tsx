export type FaqItem = {
  readonly question: string;
  readonly answer: string;
};

export function FaqSection({
  title,
  items,
}: Readonly<{ title: string; items: readonly FaqItem[] }>) {
  return (
    <section className="section" aria-labelledby="faq-heading">
      <div className="content-width content-width--narrow">
        <h2 id="faq-heading">{title}</h2>
        <div className="faq-list">
          {items.map((item) => (
            <details key={item.question}>
              <summary>{item.question}</summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
