export type RouteClass = "public_indexable" | "public_noindex" | "private" | "system";

export type PageType =
  | "WebSite"
  | "WebApplication"
  | "SoftwareApplication"
  | "Article"
  | "Pricing"
  | "Legal";

export type SeoReviewStatus = "draft" | "reviewed";

export type SiteSeoConfig = {
  readonly siteName: string;
  readonly canonicalOrigin: string;
  readonly defaultLocale: string;
  readonly defaultTitle: string;
  readonly titleTemplate: string;
  readonly defaultDescription: string;
  readonly defaultOgImage: string;
  readonly releaseStatus: SeoReviewStatus;
};

export type IndexablePage = {
  readonly route: string;
  readonly class: "public_indexable";
  readonly searchIntent: string;
  readonly primaryKeyword: string;
  readonly secondaryKeywords?: readonly string[];
  readonly title: string;
  readonly description: string;
  readonly h1: string;
  readonly canonical?: string;
  readonly image?: string;
  readonly pageType: Exclude<PageType, "Legal">;
  readonly relatedRoutes: readonly string[];
  readonly lastModified: string;
  readonly reviewStatus?: SeoReviewStatus;
};

export type NonIndexablePage = {
  readonly route: string;
  readonly class: Exclude<RouteClass, "public_indexable">;
  readonly pageType?: "Legal";
  readonly title?: string;
  readonly description?: string;
};

export type RouteDefinition = IndexablePage | NonIndexablePage;

export type SitemapRoute = {
  readonly route: string;
  readonly canonical: string;
  readonly lastModified: string;
};

export type RouteRegistry = {
  readonly site: SiteSeoConfig;
  readonly routes: readonly RouteDefinition[];
  get(route: string): RouteDefinition;
  indexable(): readonly IndexablePage[];
  sitemapEntries(): readonly SitemapRoute[];
};
