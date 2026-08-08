import { z } from "zod";

import type { LegalConfig, LegalFeatureFacts } from "./types";

const processorSchema = z.object({
  name: z.string().trim().min(1),
  purpose: z.string().trim().min(3),
  privacyUrl: z.url().optional(),
});

const documentSchema = z.object({
  version: z.string().trim().min(1),
  effectiveDate: z.iso.date(),
  reviewStatus: z.enum(["draft", "reviewed"]),
});

const sectionSchema = z.object({
  heading: z.string().trim().min(1),
  paragraphs: z.array(z.string().trim().min(1)).min(1),
});

const legalSchema = z.object({
  releaseStatus: z.enum(["draft", "reviewed"]),
  operator: z.object({
    legalName: z.string().trim().min(1),
    jurisdiction: z.string().trim().min(1),
    supportEmail: z.email(),
    postalAddress: z.string().trim().min(1).optional(),
  }),
  minimumAge: z.number().int().min(13).max(21),
  dataCategories: z.array(z.string().trim().min(1)).min(1),
  authMethods: z.array(z.string().trim().min(1)).min(1),
  processors: z.array(processorSchema),
  paymentModel: z.enum(["mor", "psp", "none"]),
  oneTimePurchases: z.boolean(),
  subscriptions: z.boolean(),
  credits: z.boolean(),
  refundPolicy: z.object({
    summary: z.string().trim().min(10),
    cancellationSummary: z.string().trim().min(10),
  }),
  subscriptionTerms: z.string().trim().min(10).nullable(),
  retentionRules: z
    .array(
      z.object({
        category: z.string().trim().min(1),
        period: z.string().trim().min(1),
        basis: z.string().trim().min(1),
      }),
    )
    .min(1),
  accountDeletion: z.object({
    enabled: z.boolean(),
    summary: z.string().trim().min(10),
  }),
  internationalTransfers: z.string().trim().min(10).nullable(),
  documents: z.object({
    privacy: documentSchema,
    terms: documentSchema,
    acceptable_use: documentSchema,
    refund_policy: documentSchema,
    account_deletion: documentSchema,
  }),
  content: z.object({
    privacy: z.array(sectionSchema).min(1),
    terms: z.array(sectionSchema).min(1),
    acceptable_use: z.array(sectionSchema).min(1),
    refund_policy: z.array(sectionSchema).min(1),
    account_deletion: z.array(sectionSchema).min(1),
  }),
});

const providerRequirements: readonly [keyof LegalFeatureFacts, string][] = [
  ["google", "Google"],
  ["resend", "Resend"],
  ["waffo", "Waffo"],
  ["ga4", "Google Analytics"],
  ["clarity", "Microsoft Clarity"],
  ["turnstile", "Cloudflare Turnstile"],
];

function hasProcessor(processors: LegalConfig["processors"], name: string): boolean {
  return processors.some((processor) => processor.name.toLowerCase() === name.toLowerCase());
}

function isPlaceholder(value: string): boolean {
  return /example\.com|support@example|change[_ -]?me|todo|your company|sample operator/i.test(value);
}

export function validateLegalConfig(input: {
  readonly legal: LegalConfig;
  readonly features: LegalFeatureFacts;
  readonly releaseMode?: boolean;
}): LegalConfig {
  const legal = legalSchema.parse(input.legal) as LegalConfig;

  for (const [key, provider] of providerRequirements) {
    if (input.features[key] === true && !hasProcessor(legal.processors, provider)) {
      throw new Error(`missing processor disclosure: ${provider}`);
    }
  }

  for (const custom of [input.features.hosting, input.features.database, input.features.storage, input.features.ai]) {
    if (custom && !hasProcessor(legal.processors, custom)) {
      throw new Error(`missing processor disclosure: ${custom}`);
    }
  }

  if ((input.features.subscriptions || legal.subscriptions) && !legal.subscriptionTerms) {
    throw new Error("subscription cancellation terms are required");
  }
  if (input.features.subscriptions !== undefined && input.features.subscriptions !== legal.subscriptions) {
    throw new Error("subscription feature and legal facts disagree");
  }
  if (input.features.credits !== undefined && input.features.credits !== legal.credits) {
    throw new Error("credit feature and legal facts disagree");
  }
  if (legal.paymentModel === "none" && (legal.oneTimePurchases || legal.subscriptions || legal.credits)) {
    throw new Error("payment model conflicts with commercial features");
  }

  if (input.releaseMode) {
    if (legal.releaseStatus !== "reviewed") throw new Error("legal config is not reviewed");
    if (
      isPlaceholder(legal.operator.legalName) ||
      isPlaceholder(legal.operator.jurisdiction) ||
      isPlaceholder(legal.operator.supportEmail)
    ) {
      throw new Error("legal config contains placeholder operator facts");
    }
    for (const document of Object.values(legal.documents)) {
      if (document.reviewStatus !== "reviewed") {
        throw new Error("legal document is not reviewed");
      }
    }
  }

  return legal;
}
