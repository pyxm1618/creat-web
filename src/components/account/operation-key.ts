import { isCommerceIdempotencyKey } from "@/platform/commerce/domain/idempotency-key";

export type OperationKeyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type OperationKeyState = {
  keyFor(fingerprint: string): string;
  complete(fingerprint: string): void;
};

type PersistedOperation = {
  readonly version: 1;
  readonly fingerprint: string;
  readonly key: string;
};

type Persistence = {
  readonly storage: OperationKeyStorage;
  readonly storageKey: string;
  readonly requireOpaqueFingerprint: boolean;
};

const STORAGE_PREFIX = "creat-web:commerce-operation:v1:";
const SHA256_HEX = /^[a-f0-9]{64}$/;

function normalizeDisplayAmount(value: string): string {
  const trimmed = value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) return trimmed;
  const integer = BigInt(match[1]!).toString();
  const fractional = match[2]?.replace(/0+$/, "") ?? "";
  return fractional ? `${integer}.${fractional}` : integer;
}

export function subscriptionOperationFingerprintParts(
  subscriptionId: string,
  action: "cancel" | "resume",
) {
  return ["subscription", action, subscriptionId] as const;
}

export function refundOperationFingerprintParts(input: {
  readonly paymentId: string;
  readonly amount: string;
  readonly currency: string;
  readonly reason: string;
}) {
  return [
    "refund",
    input.paymentId,
    normalizeDisplayAmount(input.amount),
    input.currency.trim().toUpperCase(),
    input.reason.trim(),
  ] as const;
}

function persistedOperation(value: string | null): PersistedOperation | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      parsed.version === 1 &&
      "fingerprint" in parsed &&
      typeof parsed.fingerprint === "string" &&
      SHA256_HEX.test(parsed.fingerprint) &&
      "key" in parsed &&
      typeof parsed.key === "string" &&
      isCommerceIdempotencyKey(parsed.key)
    ) {
      return parsed as PersistedOperation;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function createState(createKey: () => string, persistence?: Persistence): OperationKeyState {
  let current: { fingerprint: string; key: string } | undefined;
  if (persistence) {
    try {
      current = persistedOperation(persistence.storage.getItem(persistence.storageKey));
      if (!current) persistence.storage.removeItem(persistence.storageKey);
    } catch {
      current = undefined;
    }
  }

  function persist(): void {
    if (!persistence) return;
    try {
      if (current) {
        persistence.storage.setItem(
          persistence.storageKey,
          JSON.stringify({ version: 1, ...current } satisfies PersistedOperation),
        );
      } else {
        persistence.storage.removeItem(persistence.storageKey);
      }
    } catch {
      // Storage can be unavailable in privacy modes; in-memory retry stability still applies.
    }
  }

  return {
    keyFor(fingerprint) {
      if (
        !fingerprint ||
        (persistence?.requireOpaqueFingerprint && !SHA256_HEX.test(fingerprint))
      ) {
        throw new Error("invalid operation fingerprint");
      }
      if (!current || current.fingerprint !== fingerprint) {
        current = { fingerprint, key: createKey() };
        persist();
      }
      return current.key;
    },
    complete(fingerprint) {
      if (current?.fingerprint !== fingerprint) return;
      current = undefined;
      persist();
    },
  };
}

export function createOperationKeyState(
  createKey: () => string = () => crypto.randomUUID(),
): OperationKeyState {
  return createState(createKey);
}

export async function digestOperationFingerprint(parts: readonly string[]): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(parts));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function browserSessionStorage(): OperationKeyStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export async function createSessionOperationKeyState(
  scope: readonly string[],
  createKey: () => string = () => crypto.randomUUID(),
  storage: OperationKeyStorage | undefined = browserSessionStorage(),
): Promise<OperationKeyState> {
  if (!storage) return createOperationKeyState(createKey);
  const scopeDigest = await digestOperationFingerprint(scope);
  return createState(createKey, {
    storage,
    storageKey: `${STORAGE_PREFIX}${scopeDigest}`,
    requireOpaqueFingerprint: true,
  });
}

export async function runKeyedOperation<T>(
  state: OperationKeyState,
  fingerprint: string,
  operation: (key: string) => Promise<T>,
): Promise<T> {
  const result = await operation(state.keyFor(fingerprint));
  state.complete(fingerprint);
  return result;
}
