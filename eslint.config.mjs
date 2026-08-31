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

const modulesRoot = path.join(workspaceRoot, "src/modules");
const productConfigRoot = path.join(workspaceRoot, "src/config");

/**
 * Product code lives in `src/modules/<product>/`. Two edges are enforced:
 *
 * - A module may not import product configuration. Configuration composes
 *   modules (a `tool-demo` surface pulls in product UI), so the reverse edge
 *   would close a cycle.
 * - Everything outside a module reaches it only through its public entry,
 *   `@/modules/<product>`, leaving the module free to rearrange its internals.
 *
 * Platform code is covered separately by `no-restricted-imports`, which bans
 * `@/modules/*` outright.
 */
const productModuleBoundaryRule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      configDependency:
        "Product modules must not import product configuration; configuration composes modules, not the reverse.",
      deepImport:
        "Import a product module through its public entry (@/modules/<product>) instead of reaching into its internals.",
    },
  },
  create(context) {
    const filename = context.filename;
    const insideModules = isWithin(modulesRoot, filename);
    const ownModule = insideModules
      ? path.relative(modulesRoot, filename).split(path.sep)[0]
      : undefined;

    function check(node, sourceNode) {
      const specifier = staticModuleSpecifier(sourceNode);
      if (!specifier) return;
      const target = resolveModuleSpecifier(specifier, filename);
      if (!target) return;

      if (insideModules && isWithin(productConfigRoot, target)) {
        context.report({ node: sourceNode, messageId: "configDependency" });
        return;
      }

      if (!isWithin(modulesRoot, target)) return;
      const segments = path.relative(modulesRoot, target).split(path.sep);
      const targetModule = segments[0];
      if (!targetModule) return;
      if (insideModules && targetModule === ownModule) return;

      const entry = segments
        .slice(1)
        .join("/")
        .replace(/\.(?:ts|tsx)$/, "");
      if (entry !== "" && entry !== "index") {
        context.report({ node: sourceNode, messageId: "deepImport" });
      }
    }

    return {
      ImportDeclaration(node) {
        check(node, node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source);
      },
      ExportAllDeclaration(node) {
        check(node, node.source);
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
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      "creat-web-modules": {
        rules: { "product-module-boundary": productModuleBoundaryRule },
      },
    },
    rules: {
      "creat-web-modules/product-module-boundary": "error",
    },
  },
]);
