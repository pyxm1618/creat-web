/**
 * Shared Tailwind class strings for the whole site.
 *
 * These are plain constants rather than components so the marketing, legal and
 * account surfaces stay visually identical without shipping any runtime JS
 * against the script budget in tests/performance/marketing-performance.spec.ts.
 *
 * Always compose from the semantic color tokens defined in src/app/globals.css
 * (surface / foreground / muted / accent / border / inverse) so both the light
 * and dark themes stay correct.
 */

export const container = "mx-auto w-full max-w-5xl px-6 sm:px-8";
export const containerNarrow = "mx-auto w-full max-w-3xl px-6 sm:px-8";
export const sectionSpacing = "py-14 sm:py-20";

export const eyebrow = "text-xs font-semibold uppercase tracking-[0.14em] text-accent";
export const pageTitle =
  "text-3xl font-semibold tracking-tight text-balance text-foreground sm:text-4xl";
export const sectionTitle = "text-2xl font-semibold tracking-tight text-foreground sm:text-3xl";
export const subTitle = "text-lg font-semibold tracking-tight text-foreground";
export const cardTitle = "text-base font-semibold text-foreground";

export const bodyText = "text-[0.9375rem] leading-relaxed text-muted";
export const leadText = "mt-4 max-w-2xl text-base leading-relaxed text-muted sm:text-lg";
export const metaText = "text-sm text-muted";

export const card = "rounded-xl border border-border bg-surface p-6 shadow-sm";
export const panel = "rounded-xl border border-border bg-surface";

const buttonBase =
  "inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50";

export const buttonPrimary = `${buttonBase} bg-accent text-accent-foreground hover:bg-accent-hover`;
export const buttonSecondary = `${buttonBase} border border-border bg-surface text-foreground hover:bg-surface-muted`;
export const buttonDanger = `${buttonBase} border border-red-300 bg-surface text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40`;
export const buttonGhost = `${buttonBase} text-muted hover:bg-surface-muted hover:text-foreground`;

export const inlineLink =
  "font-medium text-accent underline-offset-4 hover:underline focus-visible:underline";

export const label = "block text-sm font-medium text-foreground";
export const input =
  "mt-2 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none";

export const listDivided = "divide-y divide-border";
export const listRow = "flex flex-wrap items-start justify-between gap-4 py-4";

/** Larger call-to-action sizing used by hero and final-CTA sections. */
export const buttonPrimaryLarge =
  "inline-flex items-center justify-center rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover";
export const buttonSecondaryLarge =
  "inline-flex items-center justify-center rounded-lg border border-border bg-surface px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-muted";
export const buttonOnInverse =
  "inline-flex items-center justify-center rounded-lg bg-background px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-muted";
