import type { CommerceEnvironment, ProductDefinition, ProductSnapshot } from "../domain/product";
import { productSnapshot } from "../domain/product";

export type ProductCatalog = {
  readonly definitions: readonly ProductDefinition[];
  getEnabled(key: string, environment: CommerceEnvironment): ProductSnapshot;
};

export function createProductCatalog(definitions: readonly ProductDefinition[]): ProductCatalog {
  const seen = new Set<string>();
  for (const definition of definitions) {
    const id = `${definition.key}@${definition.version}`;
    if (seen.has(id)) throw new Error(`duplicate product version: ${id}`);
    seen.add(id);
    if (!definition.key.trim()) throw new Error("product key is required");
    if (!definition.fulfillmentKey.trim() || !definition.refundPolicyKey.trim()) {
      throw new Error("product policy keys are required");
    }
    if (definition.commercialModel === "one_time") {
      // Parse every enabled environment mapping now so invalid price/currency fails at boot.
      for (const environment of ["test", "production"] as const) {
        if (definition.providerProductIdByEnvironment[environment]) {
          productSnapshot(definition, environment);
        }
      }
    }
  }

  return {
    definitions,
    getEnabled(key, environment) {
      const candidates = definitions
        .filter((definition) => definition.key === key && definition.enabled)
        .sort((left, right) => right.version - left.version);
      const definition = candidates[0];
      if (!definition) throw new Error("unknown or disabled product");
      return productSnapshot(definition, environment);
    },
  };
}
