import Link from "next/link";

export type RelatedLink = {
  readonly label: string;
  readonly href: string;
  readonly rel?: "nofollow" | "ugc" | "sponsored";
};

export function RelatedLinks({ links }: Readonly<{ links: readonly RelatedLink[] }>) {
  return (
    <nav aria-label="Related pages" className="related-links">
      <h2>Related</h2>
      <ul>
        {links.map((link) => (
          <li key={link.href}>
            <Link href={link.href} rel={link.rel}>
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
