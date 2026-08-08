export type ProcessorDisclosure = {
  readonly name: string;
  readonly purpose: string;
  readonly privacyUrl?: string;
};

export type RetentionRule = {
  readonly category: string;
  readonly period: string;
  readonly basis: string;
};

export type LegalDocumentKey =
  | "privacy"
  | "terms"
  | "acceptable_use"
  | "refund_policy"
  | "account_deletion";

export type LegalDocumentVersion = {
  readonly version: string;
  readonly effectiveDate: string;
  readonly reviewStatus: "draft" | "reviewed";
};

export type LegalSectionContent = {
  readonly heading: string;
  readonly paragraphs: readonly string[];
};

export type LegalConfig = {
  readonly releaseStatus: "draft" | "reviewed";
  readonly operator: {
    readonly legalName: string;
    readonly jurisdiction: string;
    readonly supportEmail: string;
    readonly postalAddress?: string;
  };
  readonly minimumAge: number;
  readonly dataCategories: readonly string[];
  readonly authMethods: readonly string[];
  readonly processors: readonly ProcessorDisclosure[];
  readonly paymentModel: "mor" | "psp" | "none";
  readonly oneTimePurchases: boolean;
  readonly subscriptions: boolean;
  readonly credits: boolean;
  readonly refundPolicy: {
    readonly summary: string;
    readonly cancellationSummary: string;
  };
  readonly subscriptionTerms: string | null;
  readonly retentionRules: readonly RetentionRule[];
  readonly accountDeletion: {
    readonly enabled: boolean;
    readonly summary: string;
  };
  readonly internationalTransfers: string | null;
  readonly documents: Readonly<Record<LegalDocumentKey, LegalDocumentVersion>>;
  readonly content: Readonly<Record<LegalDocumentKey, readonly LegalSectionContent[]>>;
};

export type LegalFeatureFacts = {
  readonly google?: boolean;
  readonly resend?: boolean;
  readonly waffo?: boolean;
  readonly ga4?: boolean;
  readonly clarity?: boolean;
  readonly turnstile?: boolean;
  readonly hosting?: string;
  readonly database?: string;
  readonly storage?: string;
  readonly ai?: string;
  readonly subscriptions?: boolean;
  readonly credits?: boolean;
};
