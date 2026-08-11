import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  InvalidWebhookSignatureError,
  ProviderContractError,
} from "@/platform/commerce/application/errors";
import { createWaffoPaymentProvider } from "@/platform/commerce/providers/waffo/adapter";

const merchantId = "MER_0123456789ABCDEFGHIJKL";
const productId = "PROD_0123456789ABCDEFGHIJKL";
const storeId = "STO_0123456789ABCDEFGHIJKL";
const orderId = "ORD_0123456789ABCDEFGHIJKL";
const paymentId = "PAY_0123456789ABCDEFGHIJKL";
const webhookId = "WHK_0123456789ABCDEFGHIJKL";
const merchantOrderReference = "01989ef5-c3f7-7000-8000-000000000001";

function keys() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function signatureHeader(raw: string, privateKey: string): string {
  const timestamp = Date.now().toString();
  const signature = createSign("RSA-SHA256")
    .update(`${timestamp}.${raw}`)
    .end()
    .sign(privateKey, "base64");
  return `t=${timestamp},v1=${signature}`;
}

function validPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: paymentId,
    orderId,
    status: "succeeded",
    orderMerchantExternalId: merchantOrderReference,
    snapshotAmountDetails: { currency: "USD", total: "29.00" },
    onetimeOrder: { id: orderId, testMode: true, store: { id: storeId } },
    subscriptionOrder: null,
    createdAt: "2026-08-08T04:00:00.000Z",
    ...overrides,
  };
}

function paymentQueryProvider(input: {
  readonly response: Record<string, unknown>;
  readonly onRequest?: (body: Record<string, unknown>, init: RequestInit | undefined) => void;
}) {
  const keyPair = keys();
  return createWaffoPaymentProvider({
    merchantId,
    privateKey: keyPair.privateKey,
    storeId,
    baseUrl: "https://api.example.test",
    fetch: async (_url, init) => {
      input.onRequest?.(JSON.parse(String(init?.body)) as Record<string, unknown>, init);
      return Response.json(input.response);
    },
  });
}

describe("Waffo Pancake 0.16 contract", () => {
  it("maps authenticated checkout without accepting browser-owned price facts", async () => {
    const keyPair = keys();
    const requestBodies: Record<string, unknown>[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const url = String(input);
      if (url.includes("issue-session-token")) {
        return Response.json({
          data: {
            token: "test-token",
            expiresAt: "2026-08-08T12:00:00.000Z",
          },
        });
      }
      return Response.json({
        data: {
          sessionId: "CHK_0123456789ABCDEFGHIJKL",
          checkoutUrl: "https://checkout.example.test/checkout",
          expiresAt: "2026-08-08T12:00:00.000Z",
        },
      });
    };
    const provider = createWaffoPaymentProvider({
      merchantId,
      privateKey: keyPair.privateKey,
      webhookPublicKey: keyPair.publicKey,
      fetch: fakeFetch,
      baseUrl: "https://api.example.test",
    });

    const result = await provider.createOneTimeCheckout({
      localOrderId: "01989ef5-c3f7-7000-8000-000000000001",
      providerProductId: productId,
      expectedDisplayAmount: "29.00",
      currency: "USD",
      buyerIdentity: "01989ef5-c3f7-7000-8000-000000000002",
      buyerEmail: "buyer@example.com",
      successUrl: "https://app.example.com/checkout/return?order=local",
      cancelUrl: "https://app.example.com/checkout/return?order=local&canceled=1",
    });

    expect(result).toEqual({
      externalCheckoutSessionId: "CHK_0123456789ABCDEFGHIJKL",
      checkoutUrl: "https://checkout.example.test/checkout#token=test-token",
    });
    const checkoutBody = requestBodies.find((body) => body.orderMerchantExternalId !== undefined);
    expect(checkoutBody).toMatchObject({
      productId,
      currency: "USD",
      buyerEmail: "buyer@example.com",
      orderMerchantExternalId: "01989ef5-c3f7-7000-8000-000000000001",
    });
    expect(checkoutBody).not.toHaveProperty("buyerIdentity");
    expect(checkoutBody).not.toHaveProperty("amount");
    expect(requestBodies).toContainEqual({
      productId,
      buyerIdentity: "01989ef5-c3f7-7000-8000-000000000002",
    });
  });

  it("verifies an exact raw signed order.completed event and normalizes decimal money", async () => {
    const keyPair = keys();
    const provider = createWaffoPaymentProvider({
      merchantId,
      privateKey: keyPair.privateKey,
      storeId,
      webhookPublicKey: { test: keyPair.publicKey },
    });
    const raw = JSON.stringify({
      id: webhookId,
      timestamp: "2026-08-08T04:00:00.000Z",
      eventType: "order.completed",
      eventId: paymentId,
      storeId,
      storeName: "Test Store",
      mode: "test",
      data: {
        orderId,
        orderStatus: "completed",
        buyerEmail: "buyer@example.com",
        merchantProvidedBuyerIdentity: "01989ef5-c3f7-7000-8000-000000000002",
        orderMerchantExternalId: "01989ef5-c3f7-7000-8000-000000000001",
        currency: "USD",
        amount: "29.00",
        taxAmount: "0.00",
        productName: "Test Product",
        paymentId,
        paymentStatus: "succeeded",
      },
    });

    const event = await provider.verifyAndNormalizeWebhook({
      rawBody: new TextEncoder().encode(raw),
      signature: signatureHeader(raw, keyPair.privateKey),
      environment: "test",
    });
    expect(event).toMatchObject({
      type: "one_time_payment_succeeded",
      eventId: webhookId,
      environment: "test",
      externalOrderId: orderId,
      merchantOrderReference: "01989ef5-c3f7-7000-8000-000000000001",
      externalPaymentId: paymentId,
      amount: { currency: "USD", minor: 2900n },
      storeId,
    });
  });

  it("rejects signature mismatch before mapping payload fields", async () => {
    const keyPair = keys();
    const provider = createWaffoPaymentProvider({
      merchantId,
      privateKey: keyPair.privateKey,
      webhookPublicKey: keyPair.publicKey,
    });

    await expect(
      provider.verifyAndNormalizeWebhook({
        rawBody: new TextEncoder().encode('{"mode":"test"}'),
        signature: "not-a-valid-signature",
        environment: "test",
      }),
    ).rejects.toBeInstanceOf(InvalidWebhookSignatureError);
  });

  it("queries a payment id as String with a bounded count-checked projection", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = paymentQueryProvider({
      response: {
        data: { payments: [validPayment()], paymentsCount: 1 },
        warnings: [
          {
            message: "query cost nearing limit",
            layer: "graphql",
            aiHint: "REDUCE_QUERY_SIZE",
            internal: "must not escape",
          },
        ],
      },
      onRequest(body) {
        requestBody = body;
      },
    });

    await expect(
      provider.getPayment({
        environment: "test",
        externalPaymentId: paymentId,
      }),
    ).resolves.toEqual({
      payments: [
        {
          environment: "test",
          model: "one_time",
          storeId,
          externalOrderId: orderId,
          merchantOrderReference,
          externalPaymentId: paymentId,
          status: "succeeded",
          amount: { currency: "USD", minor: 2900n },
          occurredAt: new Date("2026-08-08T04:00:00.000Z"),
        },
      ],
      warnings: [
        {
          message: "query cost nearing limit",
          layer: "graphql",
          aiHint: "REDUCE_QUERY_SIZE",
        },
      ],
    });

    expect(requestBody?.variables).toEqual({ paymentId });
    const query = String(requestBody?.query).replace(/\s+/g, " ");
    expect(query).toContain("query ($paymentId: String!)");
    expect(query).toContain("payments(limit: 100, filter: { id: { eq: $paymentId } })");
    expect(query).toContain("paymentsCount(filter: { id: { eq: $paymentId } })");
    expect(query).toContain("snapshotAmountDetails { currency total }");
    expect(query).toContain("onetimeOrder { id testMode store { id } }");
    expect(query).toContain("subscriptionOrder { id store { id } }");
    expect(query).toContain("createdAt");
  });

  it("uses both lookup identities in the list and count filters and cross-validates the row", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = paymentQueryProvider({
      response: { data: { payments: [validPayment()], paymentsCount: 1 } },
      onRequest(body) {
        requestBody = body;
      },
    });

    await expect(
      provider.getPayment({
        environment: "test",
        merchantOrderReference,
        externalPaymentId: paymentId,
      }),
    ).resolves.toMatchObject({ payments: [{ externalPaymentId: paymentId }] });

    expect(requestBody?.variables).toEqual({ reference: merchantOrderReference, paymentId });
    const query = String(requestBody?.query).replace(/\s+/g, " ");
    expect(query).toContain("query ($reference: String!, $paymentId: String!)");
    expect(query).toContain(
      "payments(limit: 100, filter: { orderMerchantExternalId: { eq: $reference }, id: { eq: $paymentId } })",
    );
    expect(query).toContain(
      "paymentsCount(filter: { orderMerchantExternalId: { eq: $reference }, id: { eq: $paymentId } })",
    );

    for (const [name, payment] of [
      ["merchant reference", validPayment({ orderMerchantExternalId: crypto.randomUUID() })],
      ["payment id", validPayment({ id: "PAY_DIFFERENT_IDENTIFIER1" })],
    ] as const) {
      const mismatched = paymentQueryProvider({
        response: { data: { payments: [payment], paymentsCount: 1 } },
      });
      await expect(
        mismatched.getPayment({
          environment: "test",
          merchantOrderReference,
          externalPaymentId: paymentId,
        }),
        name,
      ).rejects.toBeInstanceOf(ProviderContractError);
    }
  });

  it.each([
    [
      "partial data with GraphQL errors",
      { data: { payments: [validPayment()], paymentsCount: 1 }, errors: [{ message: "partial" }] },
    ],
    ["count above the bounded limit", { data: { payments: [validPayment()], paymentsCount: 101 } }],
    ["count/list mismatch", { data: { payments: [validPayment()], paymentsCount: 2 } }],
    [
      "duplicate payment ids",
      { data: { payments: [validPayment(), validPayment()], paymentsCount: 2 } },
    ],
    [
      "both provider order relations",
      {
        data: {
          payments: [
            validPayment({
              subscriptionOrder: { id: orderId, store: { id: storeId } },
            }),
          ],
          paymentsCount: 1,
        },
      },
    ],
    [
      "no provider order relation",
      {
        data: {
          payments: [validPayment({ onetimeOrder: null, subscriptionOrder: null })],
          paymentsCount: 1,
        },
      },
    ],
    [
      "relation order mismatch",
      {
        data: {
          payments: [
            validPayment({
              onetimeOrder: {
                id: "ORD_DIFFERENT_IDENTIFIER1",
                testMode: true,
                store: { id: storeId },
              },
            }),
          ],
          paymentsCount: 1,
        },
      },
    ],
    [
      "store mismatch",
      {
        data: {
          payments: [
            validPayment({
              onetimeOrder: {
                id: orderId,
                testMode: true,
                store: { id: "STO_DIFFERENT_IDENTIFIER1" },
              },
            }),
          ],
          paymentsCount: 1,
        },
      },
    ],
    [
      "one-time environment mismatch",
      {
        data: {
          payments: [
            validPayment({
              onetimeOrder: { id: orderId, testMode: false, store: { id: storeId } },
            }),
          ],
          paymentsCount: 1,
        },
      },
    ],
    [
      "invalid amount precision",
      {
        data: {
          payments: [validPayment({ snapshotAmountDetails: { currency: "USD", total: "29.001" } })],
          paymentsCount: 1,
        },
      },
    ],
    [
      "invalid currency",
      {
        data: {
          payments: [validPayment({ snapshotAmountDetails: { currency: "usd", total: "29.00" } })],
          paymentsCount: 1,
        },
      },
    ],
    [
      "invalid created time",
      {
        data: {
          payments: [validPayment({ createdAt: "not-a-time" })],
          paymentsCount: 1,
        },
      },
    ],
  ])("fails closed for %s", async (_name, response) => {
    const provider = paymentQueryProvider({ response });
    await expect(
      provider.getPayment({
        environment: "test",
        merchantOrderReference,
      }),
    ).rejects.toBeInstanceOf(ProviderContractError);
  });

  it("passes the caller abort signal through the request-scoped SDK fetch", async () => {
    const keyPair = keys();
    let observedSignal: AbortSignal | null | undefined;
    const provider = createWaffoPaymentProvider({
      merchantId,
      privateKey: keyPair.privateKey,
      storeId,
      baseUrl: "https://api.example.test",
      fetch: async (_url, init) => {
        observedSignal = init?.signal;
        if (!observedSignal) throw new Error("missing request signal");
        return new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener(
            "abort",
            () => reject(observedSignal?.reason ?? new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const controller = new AbortController();
    const lookup = provider.getPayment({
      environment: "test",
      externalPaymentId: paymentId,
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    controller.abort();

    await expect(lookup).rejects.toMatchObject({ name: "AbortError" });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("aborts the request-scoped SDK fetch when the lookup timeout expires", async () => {
    const keyPair = keys();
    let observedSignal: AbortSignal | null | undefined;
    const provider = createWaffoPaymentProvider({
      merchantId,
      privateKey: keyPair.privateKey,
      storeId,
      baseUrl: "https://api.example.test",
      fetch: async (_url, init) => {
        observedSignal = init?.signal;
        if (!observedSignal) throw new Error("missing request signal");
        return new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener(
            "abort",
            () => reject(observedSignal?.reason ?? new DOMException("timed out", "TimeoutError")),
            { once: true },
          );
        });
      },
    });

    await expect(
      provider.getPayment({
        environment: "test",
        externalPaymentId: paymentId,
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(observedSignal?.aborted).toBe(true);
  });
});
