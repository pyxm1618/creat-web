import { isIP } from "node:net";

import type { AppEnvironment } from "@/platform/config/load-runtime-config";

function validIp(value: string | null): string | null {
  const candidate = value?.trim() ?? "";
  return isIP(candidate) ? candidate : null;
}

export function extractTrustedClientIp(headers: Headers, environment: AppEnvironment): string {
  if (environment === "local" || environment === "test") {
    return validIp(headers.get("x-real-ip")) ?? "unknown";
  }

  if (!headers.get("x-vercel-id")) return "unknown";
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0] ?? null;
  return validIp(forwarded) ?? "unknown";
}
