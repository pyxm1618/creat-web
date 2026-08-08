import type { ReactNode } from "react";

export function ToolDemoSection({
  title,
  body,
  render,
}: Readonly<{ title: string; body: string; render: ReactNode }>) {
  return (
    <section className="section" aria-labelledby="demo-heading">
      <div className="content-width two-column">
        <div>
          <p className="section-kicker">Product surface</p>
          <h2 id="demo-heading">{title}</h2>
          <p>{body}</p>
        </div>
        <div className="demo-panel">{render}</div>
      </div>
    </section>
  );
}
