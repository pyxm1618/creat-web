import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const workspaceRoot = path.dirname(fileURLToPath(import.meta.url));
const creditsRoot = path.join(workspaceRoot, "src/platform/credits");
const commerceRuntime = "src/platform/commerce/commerce-runtime.ts";
const publicCreditsEntry = path.join(creditsRoot, "integration/commerce/credit-fulfillment");

function staticModuleSpecifier(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
  }
  return undefined;
}

function resolveModuleSpecifier(specifier, filename) {
  if (specifier === "@") return path.join(workspaceRoot, "src");
  if (specifier.startsWith("@/")) {
    return path.resolve(workspaceRoot, "src", specifier.slice(2));
  }
  if (specifier.startsWith(".")) return path.resolve(path.dirname(filename), specifier);
  return undefined;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isTypeOnlyDeclaration(node) {
  if (node.importKind === "type" || node.exportKind === "type") return true;
  return (
    node.specifiers?.length > 0 &&
    node.specifiers.every(
      (specifier) => specifier.importKind === "type" || specifier.exportKind === "type",
    )
  );
}

const commerceCreditsBoundaryRule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      forbidden: "Commerce core must depend on its fulfillment port, not Credits implementations.",
      runtime:
        "The Commerce composition root may import only the public Credits integration entry.",
    },
  },
  create(context) {
    const filename = context.filename;
    const relativeFilename = path.relative(workspaceRoot, filename).split(path.sep).join("/");
    const commerceCore = /^src\/platform\/commerce\/(?:application|domain|providers)\//.test(
      relativeFilename,
    );
    const compositionRoot = relativeFilename === commerceRuntime;

    function check(node, sourceNode, typeOnly = false) {
      if (typeOnly) return;
      const specifier = staticModuleSpecifier(sourceNode);
      if (!specifier) return;
      const target = resolveModuleSpecifier(specifier, filename);
      if (!target || !isWithin(creditsRoot, target)) return;

      if (commerceCore) {
        context.report({ node: sourceNode, messageId: "forbidden" });
        return;
      }
      const entryWithoutExtension = target.replace(/\.(?:ts|tsx)$/, "");
      if (compositionRoot && entryWithoutExtension !== publicCreditsEntry) {
        context.report({ node: sourceNode, messageId: "runtime" });
      }
    }

    return {
      ImportDeclaration(node) {
        check(node, node.source, isTypeOnlyDeclaration(node));
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source, isTypeOnlyDeclaration(node));
      },
      ExportAllDeclaration(node) {
        check(node, node.source, isTypeOnlyDeclaration(node));
      },
      ImportExpression(node) {
        check(node, node.source);
      },
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require") {
          check(node, node.arguments[0]);
        }
      },
      TSImportEqualsDeclaration(node) {
        if (node.importKind === "type") return;
        if (node.moduleReference.type === "TSExternalModuleReference") {
          check(node, node.moduleReference.expression);
        }
      },
    };
  },
};

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
      "src/platform/commerce/commerce-runtime.ts",
    ],
    plugins: {
      "creat-web": {
        rules: { "commerce-credits-boundary": commerceCreditsBoundaryRule },
      },
    },
    rules: {
      "creat-web/commerce-credits-boundary": "error",
    },
  },
]);
