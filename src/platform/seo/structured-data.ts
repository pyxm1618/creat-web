type JsonLdRecord = Record<string, unknown>;

export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function websiteJsonLd(input: {
  readonly name: string;
  readonly url: string;
  readonly description?: string;
}): JsonLdRecord {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: input.name,
    url: input.url,
    ...(input.description ? { description: input.description } : {}),
  };
}

export function webApplicationJsonLd(input: {
  readonly name: string;
  readonly url: string;
  readonly description?: string;
  readonly visiblePrice?: boolean;
  readonly price?: string;
  readonly currency?: string;
}): JsonLdRecord {
  if ((input.price || input.currency) && !input.visiblePrice) {
    throw new Error("visible offer required");
  }
  if (input.visiblePrice && (!input.price || !input.currency)) {
    throw new Error("visible offer requires price and currency");
  }

  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: input.name,
    url: input.url,
    ...(input.description ? { description: input.description } : {}),
    ...(input.visiblePrice
      ? {
          offers: {
            "@type": "Offer",
            price: input.price,
            priceCurrency: input.currency,
          },
        }
      : {}),
  };
}

export function articleJsonLd(input: {
  readonly headline: string;
  readonly url: string;
  readonly datePublished?: string;
  readonly dateModified?: string;
}): JsonLdRecord {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: input.headline,
    mainEntityOfPage: input.url,
    ...(input.datePublished ? { datePublished: input.datePublished } : {}),
    ...(input.dateModified ? { dateModified: input.dateModified } : {}),
  };
}

export function breadcrumbJsonLd(
  items: readonly { readonly name: string; readonly url: string }[],
): JsonLdRecord {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

export function offerJsonLd(input: {
  readonly visible: boolean;
  readonly price: string;
  readonly currency: string;
  readonly url?: string;
}): JsonLdRecord {
  if (!input.visible) throw new Error("visible offer required");
  return {
    "@context": "https://schema.org",
    "@type": "Offer",
    price: input.price,
    priceCurrency: input.currency,
    ...(input.url ? { url: input.url } : {}),
  };
}
