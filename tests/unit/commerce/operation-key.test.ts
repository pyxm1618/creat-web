import { expect, it } from "vitest";

import {
  checkoutOperationFingerprintParts,
  createOperationKeyState,
  createSessionOperationKeyState,
  digestOperationFingerprint,
  refundOperationFingerprintParts,
  runKeyedOperation,
  subscriptionOperationFingerprintParts,
  type OperationKeyStorage,
} from "@/components/account/operation-key";

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
  const createKey = keyFactory("key-1", "key-2");
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
  expect(firstPage.keyFor(fingerprint)).toBe("key-1");

  const refreshedPage = await createSessionOperationKeyState(
    ["refund", "payment-1"],
    createKey,
    storage,
  );
  expect(refreshedPage.keyFor(fingerprint)).toBe("key-1");
  refreshedPage.complete(fingerprint);

  const afterSuccess = await createSessionOperationKeyState(
    ["refund", "payment-1"],
    createKey,
    storage,
  );
  expect(afterSuccess.keyFor(fingerprint)).toBe("key-2");
});

it("isolates otherwise identical operations between browser tabs", async () => {
  const tabA = memoryStorage();
  const tabB = memoryStorage();
  const fingerprint = await digestOperationFingerprint(["subscription", "cancel", "sub-1"]);
  const stateA = await createSessionOperationKeyState(
    ["subscription", "sub-1", "cancel"],
    keyFactory("tab-a-key"),
    tabA.storage,
  );
  const stateB = await createSessionOperationKeyState(
    ["subscription", "sub-1", "cancel"],
    keyFactory("tab-b-key"),
    tabB.storage,
  );

  expect(stateA.keyFor(fingerprint)).toBe("tab-a-key");
  expect(stateB.keyFor(fingerprint)).toBe("tab-b-key");
});

it("persists no checkout, payment, subscription, or refund-reason plaintext", async () => {
  const { storage, values } = memoryStorage();
  const scope = ["refund", "payment-sensitive-123"];
  const fingerprint = await digestOperationFingerprint([
    "refund",
    "payment-sensitive-123",
    "10.00",
    "USD",
    "private customer reason",
  ]);
  const state = await createSessionOperationKeyState(scope, keyFactory("opaque-key"), storage);
  state.keyFor(fingerprint);

  const persisted = [...values.entries()].flat().join(" ");
  expect(persisted).not.toContain("payment-sensitive-123");
  expect(persisted).not.toContain("private customer reason");
  expect(persisted).not.toContain("refund");
});

it("derives distinct opaque fingerprints for checkout, refund, and subscription actions", async () => {
  const checkout = await digestOperationFingerprint(["checkout", "focus-credit-pack"]);
  const refund = await digestOperationFingerprint([
    "refund",
    "payment-1",
    "10.00",
    "USD",
    "duplicate charge",
  ]);
  const subscription = await digestOperationFingerprint(["subscription", "cancel", "sub-1"]);

  expect(new Set([checkout, refund, subscription]).size).toBe(3);
  expect(checkout).toMatch(/^[a-f0-9]{64}$/);
  expect(refund).toMatch(/^[a-f0-9]{64}$/);
  expect(subscription).toMatch(/^[a-f0-9]{64}$/);
});

it("reuses a key after network failure and rotates only after an accepted response", async () => {
  const state = createOperationKeyState(keyFactory("key-1", "key-2"));
  const seen: string[] = [];
  const fingerprint = "checkout:focus-credit-pack";

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

it("normalizes semantic UI inputs and separates checkout, refund, and subscription actions", () => {
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
  expect(checkoutOperationFingerprintParts("focus-credit-pack")).toEqual([
    "checkout",
    "focus-credit-pack",
  ]);
  expect(subscriptionOperationFingerprintParts("sub-1", "cancel")).toEqual([
    "subscription",
    "cancel",
    "sub-1",
  ]);
  expect(subscriptionOperationFingerprintParts("sub-1", "resume")).not.toEqual(
    subscriptionOperationFingerprintParts("sub-1", "cancel"),
  );
});
