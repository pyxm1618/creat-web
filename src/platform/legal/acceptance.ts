import type { DatabaseClient } from "@/platform/database/client";
import { legalAcceptances } from "@/platform/database/legal-schema";

import type { LegalDocumentKey } from "./types";

type AcceptanceInput = {
  readonly subjectId: string;
  readonly document: LegalDocumentKey;
  readonly version: string;
  readonly source: string;
  readonly acceptedAt?: Date;
};

export async function recordLegalAcceptance(
  input: AcceptanceInput,
  database?: DatabaseClient,
): Promise<void> {
  const target = database ?? (await import("@/platform/database/application-database")).db;

  await target
    .insert(legalAcceptances)
    .values({
      subjectId: input.subjectId,
      documentKey: input.document,
      version: input.version,
      source: input.source,
      acceptedAt: input.acceptedAt ?? new Date(),
    })
    .onConflictDoNothing({
      target: [legalAcceptances.subjectId, legalAcceptances.documentKey, legalAcceptances.version],
    });
}
