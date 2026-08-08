export type FulfillmentInput = {
  readonly sourceType: string;
  readonly sourceId: string;
  readonly operation: string;
  readonly operationKey: string;
};

export interface OrderFulfillment {
  fulfill(input: FulfillmentInput): Promise<void>;
}

export type FulfillmentHandler = (input: FulfillmentInput) => Promise<void>;

export class RegistryOrderFulfillment implements OrderFulfillment {
  constructor(private readonly handlers: Readonly<Record<string, FulfillmentHandler>>) {}

  async fulfill(input: FulfillmentInput): Promise<void> {
    const handler = this.handlers[input.operation];
    if (!handler) throw new Error(`fulfillment handler is not configured: ${input.operation}`);
    await handler(input);
  }
}

export class RecordingOrderFulfillment implements OrderFulfillment {
  readonly operations: FulfillmentInput[] = [];

  async fulfill(input: FulfillmentInput): Promise<void> {
    this.operations.push(input);
  }
}

export class DisabledProductionFulfillment implements OrderFulfillment {
  async fulfill(): Promise<void> {
    throw new Error("production fulfillment is not configured");
  }
}
