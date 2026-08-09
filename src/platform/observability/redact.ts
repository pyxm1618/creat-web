const SENSITIVE_KEY =
  /(?:authorization|cookie|email|password|secret|token|api[_-]?key|session|checkouturl|signature|private[_-]?key|buyer|customer|payment[_-]?card|card[_-]?(?:number|details)|ip(?:address)?)/i;

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  if (typeof value !== "object") return value;

  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(nested, seen);
  }
  return output;
}

export function redactForLogging(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}
