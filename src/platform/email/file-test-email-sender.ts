import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeEmail } from "@/platform/auth/email-normalization";

import type { EmailSender, TransactionalEmail } from "./email-sender";

type StoredTestEmail = TransactionalEmail & {
  readonly providerMessageId: string;
  readonly createdAt: string;
};

function recipientDirectory(root: string, recipient: string): string {
  const digest = createHash("sha256").update(normalizeEmail(recipient)).digest("hex");
  return path.join(root, digest);
}

export function createFileTestEmailSender(root: string): EmailSender {
  return {
    async send(message) {
      const to = normalizeEmail(message.to);
      const providerMessageId = `test_${randomUUID()}`;
      const createdAt = new Date().toISOString();
      const directory = recipientDirectory(root, to);
      await mkdir(directory, { recursive: true, mode: 0o700 });

      const stored: StoredTestEmail = {
        ...message,
        to,
        providerMessageId,
        createdAt,
      };
      const fileName = `${createdAt.replaceAll(":", "-")}-${providerMessageId}.json`;
      await writeFile(path.join(directory, fileName), JSON.stringify(stored), {
        encoding: "utf8",
        mode: 0o600,
      });
      return { providerMessageId };
    },
  };
}

export async function readLatestTestEmail(
  root: string,
  recipient: string,
): Promise<StoredTestEmail | null> {
  const directory = recipientDirectory(root, recipient);
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  const fileName = files
    .filter((file) => file.endsWith(".json"))
    .sort()
    .at(-1);
  if (!fileName) return null;
  return JSON.parse(await readFile(path.join(directory, fileName), "utf8")) as StoredTestEmail;
}
