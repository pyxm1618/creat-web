import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAccountContext: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/platform/auth/account-context", () => ({
  getAccountContext: mocks.getAccountContext,
}));

import {
  FreshAuthenticationRequiredError,
  type AccountContext,
  requireFreshAccountSession,
} from "@/platform/auth/fresh-account-session";

const authenticatedAt = new Date("2030-08-10T10:00:00Z");
const account = {
  user: {
    id: "user_fresh_boundary",
    name: "Fresh Boundary",
    email: "fresh-boundary@example.com",
    emailVerified: true,
    image: null,
    createdAt: authenticatedAt,
    updatedAt: authenticatedAt,
  },
  session: {
    id: "session_fresh_boundary",
    userId: "user_fresh_boundary",
    token: "fresh-boundary-session-token",
    expiresAt: new Date("2030-08-17T10:00:00Z"),
    createdAt: authenticatedAt,
    updatedAt: authenticatedAt,
    ipAddress: "203.0.113.10",
    userAgent: "boundary-test",
  },
  subject: {
    id: "00000000-0000-4000-8000-000000000001",
    authUserId: "user_fresh_boundary",
    status: "active",
    pseudonymousKey: "00000000-0000-4000-8000-000000000002",
    createdAt: authenticatedAt,
    deletionRequestedAt: null,
    deletedAt: null,
  },
} satisfies AccountContext;

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("requireFreshAccountSession", () => {
  it("samples the default clock after account lookup crosses the freshness deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-08-10T10:14:59Z"));
    mocks.getAccountContext.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2030-08-10T10:15:01Z"));
      return account;
    });

    await expect(requireFreshAccountSession(new Headers())).rejects.toBeInstanceOf(
      FreshAuthenticationRequiredError,
    );
  });

  it("uses an explicitly injected clock even when account lookup advances system time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-08-10T10:14:59Z"));
    mocks.getAccountContext.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2030-08-10T10:15:01Z"));
      return account;
    });

    await expect(
      requireFreshAccountSession(new Headers(), new Date("2030-08-10T10:14:59Z")),
    ).resolves.toBe(account);
  });
});
