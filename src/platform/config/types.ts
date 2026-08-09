export type LocalePrefixStrategy = "as-needed";

export type ProductConfig = {
  readonly site: {
    readonly slug: string;
    readonly name: string;
    readonly canonicalOrigin: string;
    readonly defaultLocale: string;
    readonly supportedLocales: readonly string[];
    readonly localeLabels: Readonly<Record<string, string>>;
    readonly localePrefixStrategy: LocalePrefixStrategy;
  };
  readonly features: {
    readonly auth: {
      readonly enabled: boolean;
      readonly google: boolean;
      readonly magicLink: boolean;
      readonly password: false;
    };
    readonly email: {
      readonly enabled: boolean;
    };
    readonly commerce: {
      readonly enabled: boolean;
      readonly oneTime: boolean;
      readonly subscriptions: boolean;
      readonly credits: boolean;
    };
    readonly analytics: {
      readonly enabled: boolean;
      readonly ga4: boolean;
      readonly clarity: boolean;
      readonly consentRequired: boolean;
    };
  };
};
