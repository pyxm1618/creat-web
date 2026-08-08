import type { AppEnvironment } from "@/platform/config/load-runtime-config";

export type SeoEnvironmentPolicy = {
  readonly index: boolean;
  readonly follow: boolean;
  readonly emitSitemap: boolean;
  readonly emitCanonical: boolean;
};

export function seoEnvironmentPolicy(mode: AppEnvironment): SeoEnvironmentPolicy {
  if (mode === "production") {
    return { index: true, follow: true, emitSitemap: true, emitCanonical: true };
  }

  return { index: false, follow: false, emitSitemap: false, emitCanonical: false };
}

export function currentSeoEnvironment(): AppEnvironment {
  const value = process.env.APP_ENV;
  if (value === "local" || value === "test" || value === "staging" || value === "production") {
    return value;
  }
  return "local";
}

export function metadataOrigin(input: {
  readonly mode: AppEnvironment;
  readonly appOrigin?: string;
  readonly canonicalOrigin: string;
}): URL {
  if (input.mode === "production") return new URL(input.canonicalOrigin);
  return new URL(input.appOrigin ?? "http://localhost:3000");
}
