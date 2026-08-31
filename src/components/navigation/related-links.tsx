import Link from "next/link";

export type RelatedLink = {
  readonly label: string;
  readonly href: string;
  readonly rel?: "nofollow" | "ugc" | "sponsored";
};

export function RelatedLinks({ links }: Readonly<{ links: readonly RelatedLink[] }>) {
  return (
    <nav aria-label="Related pages" className="mt-16 border-t border-border pt-8">
      <h2 className="text-sm font-semibold tracking-tight text-foreground">Related</h2>
      <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              rel={link.rel}
              className="text-sm text-accent underline-offset-4 hover:underline"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
