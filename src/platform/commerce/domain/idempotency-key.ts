export const COMMERCE_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9:_-]{16,128}$/;

export function isCommerceIdempotencyKey(value: string): boolean {
  return COMMERCE_IDEMPOTENCY_KEY_PATTERN.test(value);
}
