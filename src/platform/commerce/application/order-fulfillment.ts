export type FulfillmentInput = {
  readonly sourceType: string;
  readonly sourceId: string;
  readonly operation: string;
  readonly operationKey: string;
};

export interface OrderFulfillment {
  fulfill(input: FulfillmentInput): Promise<void>;
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
