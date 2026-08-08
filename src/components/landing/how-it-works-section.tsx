export type ProcessStep = {
  readonly title: string;
  readonly body: string;
};

export function HowItWorksSection({
  title,
  steps,
}: Readonly<{ title: string; steps: readonly ProcessStep[] }>) {
  return (
    <section className="section section--muted" aria-labelledby="how-heading">
      <div className="content-width">
        <h2 id="how-heading">{title}</h2>
        <ol className="steps-grid">
          {steps.map((step, index) => (
            <li key={step.title}>
              <span className="step-number" aria-hidden="true">
                {index + 1}
              </span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
