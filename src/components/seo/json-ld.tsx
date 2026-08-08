import { serializeJsonLd } from "@/platform/seo/structured-data";

export function JsonLd({ value }: Readonly<{ value: unknown }>) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(value) }}
    />
  );
}
