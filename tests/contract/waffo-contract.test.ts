import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { InvalidWebhookSignatureError } from "@/platform/commerce/application/errors";
import { createWaffoPaymentProvider } from "@/platform/commerce/providers/waffo/adapter";

const merchantId = "MER_0123456789ABCDEFGHIJKL";
const productId = "PROD_0123456789ABCDEFGHIJKL";
const storeId = "STO_0123456789ABCDEFGHIJKL";
const orderId = "ORD_0123456789ABCDEFGHIJKL";
const paymentId = "PAY_0123456789ABCDEFGHIJKL";
const webhookId = "WHK_0123456789ABCDEFGHIJKL";

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
});
