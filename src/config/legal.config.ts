import type { LegalConfig } from "@/platform/legal/types";

export const legalConfig = {
  releaseStatus: "draft",
  operator: {
    legalName: "Sample Operator — replace before launch",
    jurisdiction: "Sample jurisdiction — replace before launch",
    supportEmail: "support@example.com",
  },
  minimumAge: 18,
  dataCategories: [
    "account identifiers",
    "authentication records",
    "transaction and entitlement records when commerce is enabled",
    "security and abuse-prevention events",
  ],
  authMethods: ["email magic link"],
  processors: [
    {
      name: "Resend",
      purpose: "Transactional authentication and account email delivery",
      privacyUrl: "https://resend.com/legal/privacy-policy",
    },
  ],
  paymentModel: "none",
  oneTimePurchases: false,
  subscriptions: false,
  credits: false,
  refundPolicy: {
    summary:
      "No paid product is enabled in the neutral starter. Replace this section with reviewed product-specific refund terms before enabling commerce.",
    cancellationSummary:
      "No subscription is enabled in the neutral starter. Add reviewed cancellation terms before enabling subscriptions.",
  },
  subscriptionTerms: null,
  retentionRules: [
    {
      category: "authentication records",
      period: "project-defined and reviewed before production",
      basis: "security, account operation and applicable legal obligations",
    },
    {
      category: "financial records",
      period: "project-defined and reviewed before production",
      basis: "accounting, dispute and applicable legal obligations",
    },
  ],
  accountDeletion: {
    enabled: true,
    summary:
      "Authenticated users can request deletion from account security. Authentication access is revoked promptly while records that must be retained are detached from the active identity.",
  },
  internationalTransfers:
    "Document hosting, email, analytics, payment and infrastructure transfer locations before production launch.",
  documents: {
    privacy: { version: "draft-1", effectiveDate: "2026-08-08", reviewStatus: "draft" },
    terms: { version: "draft-1", effectiveDate: "2026-08-08", reviewStatus: "draft" },
    acceptable_use: { version: "draft-1", effectiveDate: "2026-08-08", reviewStatus: "draft" },
    refund_policy: { version: "draft-1", effectiveDate: "2026-08-08", reviewStatus: "draft" },
    account_deletion: { version: "draft-1", effectiveDate: "2026-08-08", reviewStatus: "draft" },
  },
  content: {
    privacy: [
      {
        heading: "Scope and status",
        paragraphs: [
          "This starter privacy notice is a configurable framework, not launch-ready legal advice. Replace the operator, jurisdiction, provider, retention, transfer and product facts before production release.",
        ],
      },
      {
        heading: "Data categories",
        paragraphs: [
          "The starter can process account identifiers, authentication records, security events and, when enabled, transaction or entitlement records. A product must disclose only the categories it actually uses.",
        ],
      },
      {
        heading: "Processors and retention",
        paragraphs: [
          "Enabled external services must be listed with their actual purpose. Retention periods are product-owned facts and must be reviewed before launch rather than inferred from this starter.",
        ],
      },
    ],
    terms: [
      {
        heading: "Starter terms",
        paragraphs: [
          "These draft terms demonstrate the document structure only. A production product must provide reviewed operator identity, service description, eligibility, payment, liability, governing-law and dispute terms appropriate to that product.",
        ],
      },
      {
        heading: "Account responsibilities",
        paragraphs: [
          "Users are responsible for access to their email account and for using the service in accordance with the final acceptable-use rules configured by the operator.",
        ],
      },
    ],
    acceptable_use: [
      {
        heading: "Baseline restrictions",
        paragraphs: [
          "Do not use the service to violate applicable law, interfere with platform security, abuse authentication or payment systems, distribute malware, or access another person’s account without authorization.",
        ],
      },
      {
        heading: "Product-specific rules",
        paragraphs: [
          "Add reviewed restrictions for the actual product before launch. The starter intentionally does not invent domain-specific prohibited-use rules.",
        ],
      },
    ],
    refund_policy: [
      {
        heading: "Current commercial status",
        paragraphs: [
          "The neutral starter has no enabled paid product. Before commerce is enabled, configure and review refund eligibility, request windows, cancellation behavior, payment-provider responsibilities and any statutory rights that apply.",
        ],
      },
    ],
    account_deletion: [
      {
        heading: "How deletion works",
        paragraphs: [
          "Sign in, open Account Security, review the consequences, and submit the deletion request. The workflow revokes browser sessions and processes identity deletion through the authentication system.",
        ],
      },
      {
        heading: "Retained records",
        paragraphs: [
          "A production product must document any records retained after account deletion and the reason for retention. Retained business records must not silently reattach to a newly created authentication identity.",
        ],
      },
    ],
  },
} as const satisfies LegalConfig;
