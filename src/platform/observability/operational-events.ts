import type { DatabaseClient } from "@/platform/database/client";
import { authSecurityEvents } from "@/platform/database/schema";

export type OperationalSecurityEventType =
  | "magic_link_request"
  | "provider_failure"
  | "dead_letter_created"
  | "dead_letter_retried";

export async function recordOperationalSecurityEvent(
  database: DatabaseClient,
  input: Readonly<{
    eventType: OperationalSecurityEventType;
    outcome: "success" | "failure" | "limited" | "accepted";
    details?: Readonly<Record<string, string | number | boolean>>;
  }>,
): Promise<void> {
  await database.insert(authSecurityEvents).values({
    eventType: input.eventType,
    outcome: input.outcome,
    details: input.details ?? {},
  });
}
