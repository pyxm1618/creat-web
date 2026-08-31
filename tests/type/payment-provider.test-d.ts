import type { PaymentProvider } from "@/platform/commerce/application/payment-provider";

declare const provider: PaymentProvider;

provider.getPayment({ environment: "test", merchantOrderReference: "local-order-id" });
provider.getPayment({ environment: "test", externalPaymentId: "PAY_provider-id" });
provider.getPayment({
  environment: "test",
  merchantOrderReference: "local-order-id",
  externalPaymentId: "PAY_provider-id",
  externalOrderId: "ORD_provider-id",
});

// @ts-expect-error externalOrderId is only a cross-check, never a lookup identity
provider.getPayment({ environment: "test", externalOrderId: "ORD_provider-id" });
