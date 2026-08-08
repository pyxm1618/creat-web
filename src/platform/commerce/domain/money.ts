const CURRENCY_EXPONENTS = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  SGD: 2,
  AUD: 2,
  CAD: 2,
  JPY: 0,
  KRW: 0,
} as const;

export type SupportedCurrency = keyof typeof CURRENCY_EXPONENTS;
export type Money = { readonly currency: SupportedCurrency; readonly minor: bigint };

export function currencyExponent(currencyInput: string): number {
  const currency = currencyInput.toUpperCase() as SupportedCurrency;
  const exponent = CURRENCY_EXPONENTS[currency];
  if (exponent === undefined) throw new Error(`unsupported currency: ${currencyInput}`);
  return exponent;
}

export function parseDisplayAmount(value: string, currencyInput: string): Money {
  const currency = currencyInput.toUpperCase() as SupportedCurrency;
  const exponent = currencyExponent(currency);
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error("invalid amount");
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > exponent) throw new Error(`invalid ${currency} precision`);
  const padded = `${fraction}${"0".repeat(exponent)}`.slice(0, exponent);
  return {
    currency,
    minor: BigInt(whole) * 10n ** BigInt(exponent) + BigInt(padded || "0"),
  };
}

export function formatDisplayAmount(money: Money): string {
  if (money.minor < 0n) throw new Error("negative money is not supported");
  const exponent = currencyExponent(money.currency);
  if (exponent === 0) return money.minor.toString();
  const divisor = 10n ** BigInt(exponent);
  const whole = money.minor / divisor;
  const fraction = (money.minor % divisor).toString().padStart(exponent, "0");
  return `${whole}.${fraction}`;
}

export function equalMoney(left: Money, right: Money): boolean {
  return left.currency === right.currency && left.minor === right.minor;
}
