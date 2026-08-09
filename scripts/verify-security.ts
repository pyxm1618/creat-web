import nextConfig from "../next.config";

const headerRules = (await nextConfig.headers?.()) ?? [];
const global = headerRules.find((rule) => rule.source === "/:path*");
if (!global) throw new Error("global security headers are missing");

const headers = new Map(global.headers.map((header) => [header.key.toLowerCase(), header.value]));
for (const required of [
  "content-security-policy",
  "x-content-type-options",
  "referrer-policy",
  "x-frame-options",
  "permissions-policy",
]) {
  if (!headers.has(required)) throw new Error(`missing security header: ${required}`);
}

const csp = headers.get("content-security-policy") ?? "";
for (const directive of [
  "default-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
]) {
  if (!csp.includes(directive)) throw new Error(`CSP missing directive: ${directive}`);
}
if (/script-src[^;]*\s\*/.test(csp) || /connect-src[^;]*\s\*/.test(csp)) {
  throw new Error("CSP must not use wildcard script/connect sources");
}
if (process.env.APP_ENV === "production" && !headers.has("strict-transport-security")) {
  throw new Error("production HSTS is required");
}

const sensitivePatterns = [
  "/account/:path*",
  "/sign-in",
  "/auth/:path*",
  "/checkout/:path*",
  "/api/account/:path*",
  "/api/auth/:path*",
  "/api/commerce/:path*",
  "/api/webhooks/:path*",
];
for (const source of sensitivePatterns) {
  const rule = headerRules.find((candidate) => candidate.source === source);
  if (!rule) throw new Error(`missing sensitive-route headers: ${source}`);
  const ruleHeaders = new Map(
    rule.headers.map((header) => [header.key.toLowerCase(), header.value]),
  );
  if (!ruleHeaders.get("cache-control")?.includes("no-store")) {
    throw new Error(`sensitive route must be no-store: ${source}`);
  }
  if (ruleHeaders.get("x-robots-tag") !== "noindex, nofollow") {
    throw new Error(`sensitive route must be noindex: ${source}`);
  }
}

console.log(JSON.stringify({ event: "security_verified", headerRules: headerRules.length }));
