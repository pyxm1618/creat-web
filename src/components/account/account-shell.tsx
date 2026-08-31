import type { ReactNode } from "react";

import { bodyText, containerNarrow, eyebrow, pageTitle } from "@/components/ui/styles";

export function AccountShell({
  eyebrow: eyebrowText,
  title,
  titleId,
  intro,
  children,
}: Readonly<{
  eyebrow: string;
  title: string;
  titleId: string;
  intro?: ReactNode;
  children: ReactNode;
}>) {
  return (
    <main className={`${containerNarrow} py-14 sm:py-20`}>
      <section aria-labelledby={titleId}>
        <p className={eyebrow}>{eyebrowText}</p>
        <h1 id={titleId} className={`mt-3 ${pageTitle}`}>
          {title}
        </h1>
        {intro ? <div className={`mt-4 ${bodyText}`}>{intro}</div> : null}
        <div className="mt-8">{children}</div>
      </section>
    </main>
  );
}
