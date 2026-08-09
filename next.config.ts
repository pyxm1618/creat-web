import type { NextConfig } from "next";

import { featuresConfig } from "./src/config/features.config";

const isProduction = process.env.APP_ENV === "production";
const isDevelopment = process.env.NODE_ENV === "development";

const analyticsScriptSources = [
  ...(featuresConfig.analytics.enabled && featuresConfig.analytics.ga4
    ? ["https://www.googletagmanager.com"]
    : []),
  ...(featuresConfig.analytics.enabled && featuresConfig.analytics.clarity
    ? ["https://www.clarity.ms"]
    : []),
];
const analyticsConnectSources = [
  ...(featuresConfig.analytics.enabled && featuresConfig.analytics.ga4
    ? ["https://www.google-analytics.com", "https://region1.google-analytics.com"]
    : []),
  ...(featuresConfig.analytics.enabled && featuresConfig.analytics.clarity
    ? ["https://*.clarity.ms"]
    : []),
];
const analyticsImageSources = [
  ...(featuresConfig.analytics.enabled && featuresConfig.analytics.ga4
    ? ["https://www.google-analytics.com"]
    : []),
  ...(featuresConfig.analytics.enabled && featuresConfig.analytics.clarity
    ? ["https://*.clarity.ms"]
    : []),
];

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}${analyticsScriptSources.length ? ` ${analyticsScriptSources.join(" ")}` : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob:${analyticsImageSources.length ? ` ${analyticsImageSources.join(" ")}` : ""}`,
  "font-src 'self' data:",
  `connect-src 'self'${analyticsConnectSources.length ? ` ${analyticsConnectSources.join(" ")}` : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "worker-src 'self' blob:",
  ...(isProduction ? ["upgrade-insecure-requests"] : []),
].join("; ");

const baselineSecurityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
  ...(isProduction ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }] : []),
] as const;

const sensitiveHeaders = [
  { key: "Cache-Control", value: "no-store, max-age=0" },
  { key: "Pragma", value: "no-cache" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
] as const;

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  trailingSlash: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  images: {
    formats: ["image/avif", "image/webp"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          ...baselineSecurityHeaders,
          ...(!isProduction ? [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] : []),
        ],
      },
      ...[
        "/account/:path*",
        "/sign-in",
        "/auth/:path*",
        "/checkout/:path*",
        "/api/account/:path*",
        "/api/auth/:path*",
        "/api/commerce/:path*",
        "/api/webhooks/:path*",
        "/api/cron/:path*",
        "/api/test/:path*",
      ].map((source) => ({ source, headers: [...sensitiveHeaders] })),
      {
        source: "/auth/magic-link/confirm",
        headers: [...sensitiveHeaders, { key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

export default nextConfig;
