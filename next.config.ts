import type { NextConfig } from "next";

const isProduction = process.env.APP_ENV === "production";

const baselineSecurityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  { key: "Cross-Origin-Resource-Policy", value: "same-site" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
  ...(isProduction
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=31536000; includeSubDomains",
        },
      ]
    : []),
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
  experimental: {
    sri: {
      algorithm: "sha256",
    },
  },
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
        "/api/internal/:path*",
        "/api/health/:path*",
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
