import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFileTestEmailSender,
  readLatestTestEmail,
} from "@/platform/email/file-test-email-sender";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("file test email sender", () => {
  it("persists and retrieves the latest message across sender instances", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "creat-web-email-"));
    directories.push(directory);

    const sender = createFileTestEmailSender(directory);
    await sender.send({
      to: "User@Example.com",
      template: "magic-link",
      subject: "First",
      html: "<p>first</p>",
    });
    await sender.send({
      to: "user@example.com",
      template: "magic-link",
      subject: "Latest",
      html: "<p>latest</p>",
    });

    await expect(readLatestTestEmail(directory, " USER@example.com ")).resolves.toMatchObject({
      to: "user@example.com",
      subject: "Latest",
      html: "<p>latest</p>",
    });
  });
});
