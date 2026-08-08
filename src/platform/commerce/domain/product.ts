import {
  formatDisplayAmount,
  parseDisplayAmount,
  type Money,
  type SupportedCurrency,
} from "./money";

export type CommerceEnvironment = "test" | "production";
export type CommercialModel = "one_time" | "subscription";

export type ProductDefinition = {
  readonly key: string;
  readonly version: number;
  readonly enabled: boolean;
  readonly commercialModel: CommercialModel;
  readonly currency: SupportedCurrency;
  readonly expectedPrice: string;
  readonly providerProductIdByEnvironment: Readonly<Partial<Record<CommerceEnvironment, string>>>;
  readonly fulfillmentKey: string;
  readonly refundPolicyKey: string;
};

export type ProductSnapshot = {
  readonly key: string;
  readonly version: number;
  readonly commercialModel: CommercialModel;
  readonly expected: Money;
  readonly expectedDisplayAmount: string;
  readonly providerProductId: string;
  readonly fulfillmentKey: string;
  readonly refundPolicyKey: string;
};

export function productSnapshot(
  definition: ProductDefinition,
  environment: CommerceEnvironment,
): ProductSnapshot {
  if (!definition.enabled) throw new Error("product is disabled");
  if (!Number.isSafeInteger(definition.version) || definition.version <= 0) {
    throw new Error("invalid product version");
  }
  const providerProductId = definition.providerProductIdByEnvironment[environment];
  if (!providerProductId) throw new Error(`missing ${environment} provider product id`);
  const expected = parseDisplayAmount(definition.expectedPrice, definition.currency);
  if (expected.minor <= 0n) throw new Error("product price must be positive");

  return {
    key: definition.key,
    version: definition.version,
    commercialModel: definition.commercialModel,
    expected,
    expectedDisplayAmount: formatDisplayAmount(expected),
    providerProductId,
    fulfillmentKey: definition.fulfillmentKey,
    refundPolicyKey: definition.refundPolicyKey,
  };
}
