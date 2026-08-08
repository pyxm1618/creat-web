import "server-only";

import { db } from "@/platform/database/application-database";
import type { DatabaseClient } from "@/platform/database/client";
import { legalAcceptances } from "@/platform/database/legal-schema";

import type { LegalDocumentKey } from "./types";

export async function recordLegalAcceptance(
  input: {
    readonly subjectId: string;
    readonly document: LegalDocumentKey;
    readonly version: string;
    readonly source: string;
    readonly acceptedAt?: Date;
  },
  database: DatabaseClient = db,
): Promise<void> {
  await database
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
