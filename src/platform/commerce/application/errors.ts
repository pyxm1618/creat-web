export class InvalidWebhookSignatureError extends Error {
  constructor() {
    super("invalid webhook signature");
    this.name = "InvalidWebhookSignatureError";
  }
}

export class ProviderContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderContractError";
  }
}

export class ProviderStatusUnknownError extends Error {
  constructor(message = "provider payment status is unknown") {
    super(message);
    this.name = "ProviderStatusUnknownError";
  }
}
