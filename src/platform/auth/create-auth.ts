import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";
import { magicLink } from "better-auth/plugins";

import type { DatabaseClient } from "@/platform/database/client";

export function createAuth(input: {
  readonly appName: string;
  readonly baseURL: string;
  readonly secret: string;
  readonly cookiePrefix: string;
  readonly database: DatabaseClient;
  readonly schema?: Record<string, unknown>;
  readonly google?: { readonly clientId: string; readonly clientSecret: string };
  readonly sendMagicLink: (input: {
    readonly email: string;
    readonly token: string;
    readonly returnTo: string;
  }) => Promise<void>;
  readonly ensureAccountSubject?: (authUserId: string) => Promise<void>;
  readonly onAccountSubjectProvisioningError?: (input: {
    readonly authUserId: string;
    readonly error: unknown;
  }) => void;
}) {
  const socialProviders = input.google ? { google: input.google } : {};

  return betterAuth({
    appName: input.appName,
    baseURL: input.baseURL,
    secret: input.secret,
    database: drizzleAdapter(input.database, {
      provider: "pg",
      ...(input.schema ? { schema: input.schema } : {}),
    }),
    databaseHooks: input.ensureAccountSubject
      ? {
          user: {
            create: {
              after: async (user) => {
                try {
                  await input.ensureAccountSubject?.(user.id);
                } catch (error) {
                  input.onAccountSubjectProvisioningError?.({
                    authUserId: user.id,
                    error,
                  });
                }
              },
            },
          },
        }
      : undefined,
    trustedOrigins: [input.baseURL],
    emailAndPassword: { enabled: false },
    socialProviders,
    user: {
      deleteUser: {
        enabled: true,
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 15,
    },
    verification: {
      storeIdentifier: "hashed",
      storeInDatabase: true,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "rateLimit",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/magic-link": { window: 60, max: 5 },
      },
    },
    advanced: {
      cookiePrefix: input.cookiePrefix,
    },
    plugins: [
      magicLink({
        expiresIn: 60 * 10,
        storeToken: "hashed",
        sendMagicLink: async ({ email, token, metadata }) => {
          const returnTo =
            metadata && typeof metadata === "object" && "returnTo" in metadata
              ? String(metadata.returnTo)
              : "/account";
          await input.sendMagicLink({ email, token, returnTo });
        },
      }),
    ],
  });
}
