export type OperationalMetricName =
  | "dead_letter_created"
  | "magic_link_requests"
  | "webhook_invalid_signatures"
  | "webhook_retained_payloads"
  | "oldest_webhook_payload_age_seconds"
  | "reconciliation_mismatches"
  | "job_backlog"
  | "oldest_job_age_seconds"
  | "provider_failures";

export type OperationalMetricLabels = Readonly<{
  environment?: "local" | "test" | "staging" | "production";
  queue?:
    | "webhook"
    | "fulfillment"
    | "commerce_command"
    | "credit_finalization"
    | "account_deletion";
  provider?: "waffo" | "resend" | "google" | "turnstile" | "database";
  outcome?: "success" | "failure" | "degraded";
}>;

export type OperationalMetricEvent = Readonly<{
  event: "operational_metric";
  name: OperationalMetricName;
  value: number;
  labels: OperationalMetricLabels;
  observedAt: string;
}>;

export function createMetricEvent(input: {
  readonly name: OperationalMetricName;
  readonly value: number;
  readonly labels?: OperationalMetricLabels;
  readonly observedAt?: Date;
}): OperationalMetricEvent {
  if (!Number.isFinite(input.value) || input.value < 0) {
    throw new Error("operational metric value must be a finite non-negative number");
  }
  return {
    event: "operational_metric",
    name: input.name,
    value: input.value,
    labels: input.labels ?? {},
    observedAt: (input.observedAt ?? new Date()).toISOString(),
  };
}

export function emitMetric(
  input: Parameters<typeof createMetricEvent>[0],
  write: (line: string) => void = console.log,
): OperationalMetricEvent {
  const event = createMetricEvent(input);
  write(JSON.stringify(event));
  return event;
}
