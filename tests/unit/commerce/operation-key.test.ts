import { afterEach, expect, it, vi } from "vitest";

const hookRuntime = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  stateCursor: 0,
  refCursor: 0,
}));

vi.mock("react", () => ({
  useState(initial: unknown) {
    const index = hookRuntime.stateCursor++;
    if (hookRuntime.states[index] === undefined) hookRuntime.states[index] = initial;
    return [
      hookRuntime.states[index],
      (next: unknown) => {
        hookRuntime.states[index] =
          typeof next === "function"
            ? (next as (current: unknown) => unknown)(hookRuntime.states[index])
            : next;
      },
    ];
  },
  useRef(initial: unknown) {
    const index = hookRuntime.refCursor++;
    hookRuntime.refs[index] ??= { current: initial };
    return hookRuntime.refs[index];
  },
}));

import * as billingActions from "@/components/account/billing-actions";

import {
  createOperationKeyState,
  createSessionOperationKeyState,
  digestOperationFingerprint,
  refundOperationFingerprintParts,
  runKeyedOperation,
  subscriptionOperationFingerprintParts,
  type OperationKeyStorage,
} from "@/components/account/operation-key";
import { isCommerceIdempotencyKey } from "@/platform/commerce/domain/idempotency-key";

function keyFactory(...keys: string[]) {
  return () => {
    const key = keys.shift();
    if (!key) throw new Error("test key supply exhausted");
    return key;
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  const storage: OperationKeyStorage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
  return { storage, values };
}

type TestElement = {
  readonly type?: unknown;
  readonly props?: Readonly<Record<string, unknown>>;
};

function elements(node: unknown): TestElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as TestElement;
  return [element, ...elements(element.props?.children)];
}

function render<T>(component: () => T): T {
  hookRuntime.stateCursor = 0;
  hookRuntime.refCursor = 0;
  return component();
}

function resetHooks(): void {
  hookRuntime.states.length = 0;
  hookRuntime.refs.length = 0;
  hookRuntime.stateCursor = 0;
  hookRuntime.refCursor = 0;
}

function eventHandler(
  element: TestElement,
  name: "onClick" | "onChange",
): (...args: unknown[]) => unknown {
  const handler = element.props?.[name];
  if (typeof handler !== "function") throw new Error(`${name} handler not found`);
  return handler as (...args: unknown[]) => unknown;
}

function response(ok: boolean, status: number, body: unknown = {}): Response {
  return { ok, status, json: async () => body } as Response;
}

function requestKey(call: unknown[]): string | null {
  const init = call[1] as RequestInit;
  return new Headers(init.headers).get("idempotency-key");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetHooks();
});

it("reuses a key until the fingerprint changes or completes", () => {
  const state = createOperationKeyState(keyFactory("key-1", "key-2", "key-3", "key-4"));

  expect(state.keyFor("refund:p1:10.00:USD:duplicate")).toBe("key-1");
  expect(state.keyFor("refund:p1:10.00:USD:duplicate")).toBe("key-1");
  expect(state.keyFor("refund:p1:20.00:USD:duplicate")).toBe("key-2");
  expect(state.keyFor("refund:p1:10.00:USD:duplicate")).toBe("key-3");
  state.complete("refund:p1:10.00:USD:duplicate");
  expect(state.keyFor("refund:p1:10.00:USD:duplicate")).toBe("key-4");
});

it("does not clear a newer operation when an older fingerprint completes", () => {
  const state = createOperationKeyState(keyFactory("key-1", "key-2"));
  expect(state.keyFor("refund:old")).toBe("key-1");
  expect(state.keyFor("refund:new")).toBe("key-2");

  state.complete("refund:old");

  expect(state.keyFor("refund:new")).toBe("key-2");
});

it("reuses a session key after refresh and rotates it after accepted completion", async () => {
  const { storage } = memoryStorage();
  const createKey = keyFactory("refresh-operation-key-1", "refresh-operation-key-2");
  const fingerprint = await digestOperationFingerprint([
    "refund",
    "payment-1",
    "10.00",
    "USD",
    "duplicate charge",
  ]);
  const firstPage = await createSessionOperationKeyState(
    ["refund", "payment-1"],
    createKey,
    storage,
  );
  expect(firstPage.keyFor(fingerprint)).toBe("refresh-operation-key-1");

  const refreshedPage = await createSessionOperationKeyState(
    ["refund", "payment-1"],
    createKey,
    storage,
  );
  expect(refreshedPage.keyFor(fingerprint)).toBe("refresh-operation-key-1");
  refreshedPage.complete(fingerprint);

  const afterSuccess = await createSessionOperationKeyState(
    ["refund", "payment-1"],
    createKey,
    storage,
  );
  expect(afterSuccess.keyFor(fingerprint)).toBe("refresh-operation-key-2");
});

it("discards a persisted key that the Commerce APIs would reject", async () => {
  const { storage, values } = memoryStorage();
  const fingerprint = await digestOperationFingerprint(["subscription", "cancel", "sub-1"]);
  const firstPage = await createSessionOperationKeyState(
    ["subscription", "sub-1", "cancel"],
    keyFactory("valid-operation-key-1"),
    storage,
  );
  firstPage.keyFor(fingerprint);
  const storageKey = [...values.keys()][0];
  if (!storageKey) throw new Error("persisted operation not found");
  values.set(storageKey, JSON.stringify({ version: 1, fingerprint, key: "too-short" }));

  const refreshedPage = await createSessionOperationKeyState(
    ["subscription", "sub-1", "cancel"],
    keyFactory("valid-operation-key-2"),
    storage,
  );

  expect(refreshedPage.keyFor(fingerprint)).toBe("valid-operation-key-2");
  expect([...values.values()].join(" ")).not.toContain("too-short");
});

it("shares the Commerce API idempotency-key format at its exact boundaries", () => {
  expect(isCommerceIdempotencyKey("a".repeat(15))).toBe(false);
  expect(isCommerceIdempotencyKey("a".repeat(16))).toBe(true);
  expect(isCommerceIdempotencyKey("a".repeat(128))).toBe(true);
  expect(isCommerceIdempotencyKey("a".repeat(129))).toBe(false);
  expect(isCommerceIdempotencyKey("00000000-0000-4000-8000-000000000001")).toBe(true);
  expect(isCommerceIdempotencyKey("invalid.operation.key")).toBe(false);
});

it("isolates otherwise identical operations between browser tabs", async () => {
  const tabA = memoryStorage();
  const tabB = memoryStorage();
  const fingerprint = await digestOperationFingerprint(["subscription", "cancel", "sub-1"]);
  const stateA = await createSessionOperationKeyState(
    ["subscription", "sub-1", "cancel"],
    keyFactory("tab-a-operation-key"),
    tabA.storage,
  );
  const stateB = await createSessionOperationKeyState(
    ["subscription", "sub-1", "cancel"],
    keyFactory("tab-b-operation-key"),
    tabB.storage,
  );

  expect(stateA.keyFor(fingerprint)).toBe("tab-a-operation-key");
  expect(stateB.keyFor(fingerprint)).toBe("tab-b-operation-key");
});

it("persists no refund or subscription intent plaintext", async () => {
  const { storage, values } = memoryStorage();
  const refundFingerprint = await digestOperationFingerprint([
    "refund",
    "payment-sensitive-123",
    "10.00",
    "USD",
    "private customer reason",
  ]);
  const refundState = await createSessionOperationKeyState(
    ["refund", "payment-sensitive-123"],
    keyFactory("refund-operation-key"),
    storage,
  );
  refundState.keyFor(refundFingerprint);
  const subscriptionFingerprint = await digestOperationFingerprint(
    subscriptionOperationFingerprintParts("subscription-sensitive-456", "cancel"),
  );
  const subscriptionState = await createSessionOperationKeyState(
    ["subscription", "subscription-sensitive-456", "cancel"],
    keyFactory("subscription-operation-key"),
    storage,
  );
  subscriptionState.keyFor(subscriptionFingerprint);

  const persisted = [...values.entries()].flat().join(" ");
  expect(persisted).not.toContain("payment-sensitive-123");
  expect(persisted).not.toContain("private customer reason");
  expect(persisted).not.toContain("subscription-sensitive-456");
  expect(persisted).not.toContain("cancel");
});

it("derives distinct opaque fingerprints for refund and subscription actions", async () => {
  const refund = await digestOperationFingerprint([
    "refund",
    "payment-1",
    "10.00",
    "USD",
    "duplicate charge",
  ]);
  const subscription = await digestOperationFingerprint(["subscription", "cancel", "sub-1"]);

  expect(new Set([refund, subscription]).size).toBe(2);
  expect(refund).toMatch(/^[a-f0-9]{64}$/);
  expect(subscription).toMatch(/^[a-f0-9]{64}$/);
});

it("reuses a key after network failure and rotates only after an accepted response", async () => {
  const state = createOperationKeyState(keyFactory("key-1", "key-2"));
  const seen: string[] = [];
  const fingerprint = "subscription:cancel:sub-1";

  await expect(
    runKeyedOperation(state, fingerprint, async (key) => {
      seen.push(key);
      throw new Error("network response lost");
    }),
  ).rejects.toThrow("network response lost");
  await expect(
    runKeyedOperation(state, fingerprint, async (key) => {
      seen.push(key);
      return "accepted";
    }),
  ).resolves.toBe("accepted");
  await runKeyedOperation(state, fingerprint, async (key) => {
    seen.push(key);
  });

  expect(seen).toEqual(["key-1", "key-1", "key-2"]);
});

it("normalizes refund inputs and separates subscription actions", () => {
  expect(
    refundOperationFingerprintParts({
      paymentId: "payment-1",
      amount: " 010.00 ",
      currency: " usd ",
      reason: " duplicate charge ",
    }),
  ).toEqual(["refund", "payment-1", "10", "USD", "duplicate charge"]);
  expect(
    refundOperationFingerprintParts({
      paymentId: "payment-1",
      amount: "10.0",
      currency: "USD",
      reason: "duplicate charge",
    }),
  ).toEqual(["refund", "payment-1", "10", "USD", "duplicate charge"]);
  expect(
    refundOperationFingerprintParts({
      paymentId: "payment-1",
      amount: "10.01",
      currency: "USD",
      reason: "duplicate charge",
    }),
  ).not.toEqual(["refund", "payment-1", "10", "USD", "duplicate charge"]);
  expect(subscriptionOperationFingerprintParts("sub-1", "cancel")).toEqual([
    "subscription",
    "cancel",
    "sub-1",
  ]);
  expect(subscriptionOperationFingerprintParts("sub-1", "resume")).not.toEqual(
    subscriptionOperationFingerprintParts("sub-1", "cancel"),
  );
});

it("keeps the same subscription request key across network and 5xx retries, then rotates", async () => {
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new Error("network response lost"))
    .mockResolvedValueOnce(response(false, 503))
    .mockResolvedValueOnce(response(true, 202, { status: "pending" }))
    .mockResolvedValueOnce(response(true, 202, { status: "pending" }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(globalThis.crypto, "randomUUID")
    .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
    .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
  const component = render(() =>
    billingActions.SubscriptionAction({ subscriptionId: "sub-1", action: "cancel" }),
  );
  const button = elements(component).find((element) => element.type === "button");
  if (!button) throw new Error("subscription button not found");
  const click = eventHandler(button, "onClick");

  await click();
  await click();
  await click();
  await click();

  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(fetchMock.mock.calls.map(requestKey)).toEqual([
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
  ]);
  expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
    "/api/commerce/subscription/cancel",
    "/api/commerce/subscription/cancel",
    "/api/commerce/subscription/cancel",
    "/api/commerce/subscription/cancel",
  ]);
});

it("gives an edited refund request a new key through the actual component command path", async () => {
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new Error("network response lost"))
    .mockResolvedValueOnce(response(true, 202, { status: "pending" }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(globalThis.crypto, "randomUUID")
    .mockReturnValueOnce("00000000-0000-4000-8000-000000000011")
    .mockReturnValueOnce("00000000-0000-4000-8000-000000000012");

  let component = render(() =>
    billingActions.RefundAction({
      paymentId: "payment-1",
      currency: "USD",
      refundableAmount: "10.00",
    }),
  );
  let inputs = elements(component).filter((element) => element.type === "input");
  eventHandler(inputs[1]!, "onChange")({ target: { value: "duplicate charge" } });
  component = render(() =>
    billingActions.RefundAction({
      paymentId: "payment-1",
      currency: "USD",
      refundableAmount: "10.00",
    }),
  );
  let button = elements(component).find((element) => element.type === "button");
  if (!button) throw new Error("refund button not found");
  await eventHandler(button, "onClick")();

  inputs = elements(component).filter((element) => element.type === "input");
  eventHandler(inputs[0]!, "onChange")({ target: { value: "9.00" } });
  component = render(() =>
    billingActions.RefundAction({
      paymentId: "payment-1",
      currency: "USD",
      refundableAmount: "10.00",
    }),
  );
  button = elements(component).find((element) => element.type === "button");
  if (!button) throw new Error("refund button not found after edit");
  await eventHandler(button, "onClick")();

  expect(fetchMock.mock.calls.map(requestKey)).toEqual([
    "00000000-0000-4000-8000-000000000011",
    "00000000-0000-4000-8000-000000000012",
  ]);
  expect(
    fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body))),
  ).toEqual([
    {
      paymentId: "payment-1",
      amount: "10",
      currency: "USD",
      reason: "duplicate charge",
    },
    {
      paymentId: "payment-1",
      amount: "9",
      currency: "USD",
      reason: "duplicate charge",
    },
  ]);
});

it("does not expose a checkout action from the billing actions module", () => {
  expect(billingActions).not.toHaveProperty("CheckoutAction");
});
