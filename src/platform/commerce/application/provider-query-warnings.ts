import { ProviderContractError } from "./errors";
import type { ProviderQueryWarning } from "./payment-provider";

export const MAX_PROVIDER_QUERY_WARNINGS = 16;
export const MAX_PROVIDER_WARNING_MESSAGE_LENGTH = 512;
export const MAX_PROVIDER_WARNING_LAYER_LENGTH = 64;
export const MAX_PROVIDER_WARNING_AI_HINT_LENGTH = 512;

function boundedRequiredString(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new ProviderContractError(`invalid provider query warning ${field}`);
  }
  return value;
}

export function validateProviderQueryWarnings(value: unknown): readonly ProviderQueryWarning[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PROVIDER_QUERY_WARNINGS) {
    throw new ProviderContractError("invalid provider query warnings");
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ProviderContractError(`invalid provider query warning ${index}`);
    }
    const warning = entry as Record<string, unknown>;
    const message = boundedRequiredString(
      warning.message,
      `${index}.message`,
      MAX_PROVIDER_WARNING_MESSAGE_LENGTH,
    );
    const layer = boundedRequiredString(
      warning.layer,
      `${index}.layer`,
      MAX_PROVIDER_WARNING_LAYER_LENGTH,
    );
    if (warning.aiHint === undefined) return { message, layer };
    return {
      message,
      layer,
      aiHint: boundedRequiredString(
        warning.aiHint,
        `${index}.aiHint`,
        MAX_PROVIDER_WARNING_AI_HINT_LENGTH,
      ),
    };
  });
}
