import { describe, expect, it } from "vitest";

import { findPotentialSecrets } from "@/platform/security/secret-scan";

describe("findPotentialSecrets", () => {
  it("detects private keys and live-provider tokens", () => {
    const privateKey = ["-----BEGIN", " PRIVATE KEY-----"].join("");
    const liveToken = ["sk", "_live_", "abcdefghijklmnop"].join("");

    expect(findPotentialSecrets("config.ts", `${privateKey}\n${liveToken}`)).toEqual([
      expect.objectContaining({ kind: "private_key" }),
      expect.objectContaining({ kind: "live_provider_token" }),
    ]);
  });

  it("detects nonempty secret assignments", () => {
    const value = ["GOOGLE_CLIENT_SECRET", "=actual-secret-value"].join("");

    expect(findPotentialSecrets(".env.production", value)).toEqual([
      expect.objectContaining({ kind: "nonempty_secret_assignment" }),
    ]);
  });

  it("allows documented empty placeholders", () => {
    expect(
      findPotentialSecrets(
        ".env.example",
        "GOOGLE_CLIENT_SECRET=\nRESEND_API_KEY=\nWAFFO_PRIVATE_KEY=",
      ),
    ).toEqual([]);
  });
});
