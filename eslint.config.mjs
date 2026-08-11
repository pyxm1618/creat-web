import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores([".next/**", "coverage/**", "playwright-report/**", "test-results/**"]),
  {
    files: ["src/platform/**/*.ts", "src/platform/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/modules/*", "@/modules/**"],
              message: "Platform code must not depend on product modules.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/platform/commerce/application/**/*.{ts,tsx}",
      "src/platform/commerce/domain/**/*.{ts,tsx}",
      "src/platform/commerce/providers/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/modules/*", "@/modules/**"],
              message: "Platform code must not depend on product modules.",
            },
            {
              group: [
                "@/platform/credits/*",
                "@/platform/credits/**",
                "**/credits/*",
                "**/credits/**",
              ],
              allowTypeImports: true,
              message:
                "Commerce core must depend on its fulfillment port, not Credits implementations.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression > Literal[value=/^@\\/platform\\/credits\\//]",
          message:
            "Commerce core must depend on its fulfillment port, not Credits implementations.",
        },
        {
          selector: "ImportExpression > Literal[value=/^(?:\\.\\.\\/)+credits\\//]",
          message:
            "Commerce core must depend on its fulfillment port, not Credits implementations.",
        },
        {
          selector:
            'CallExpression[callee.name="require"] > Literal[value=/^@\\/platform\\/credits\\//]',
          message:
            "Commerce core must depend on its fulfillment port, not Credits implementations.",
        },
        {
          selector:
            'CallExpression[callee.name="require"] > Literal[value=/^(?:\\.\\.\\/)+credits\\//]',
          message:
            "Commerce core must depend on its fulfillment port, not Credits implementations.",
        },
      ],
    },
  },
]);
