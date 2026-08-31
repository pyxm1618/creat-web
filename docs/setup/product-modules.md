# Where product code lives

The starter ships the shell around a product — SEO, routing, legal pages, auth,
commerce, credits — but not the product itself. A time-zone planner, a
calculator, a generator: that code is yours, and it needs a home that does not
corrode the parts you want to reuse on the next site.

That home is `src/modules/<product>/`.

## Why not somewhere else

Four locations look plausible and all of them cost you something:

| Location | What breaks |
| --- | --- |
| `src/config/*.config.tsx` | A `tool-demo` section takes a `ReactNode`, so a small surface fits. Real product code turns a configuration file into an application file, and the config surface stops being reviewable at a glance. |
| `src/components/` | These render configuration into pages. Product logic here erases the line between "renderer" and "product", and platform code is forbidden from depending on it anyway. |
| `src/platform/` | This is the reusable half. Product logic here means your next site inherits the previous site's business rules. |
| `src/modules/` | Nothing. This is the answer. |

`eslint.config.mjs` has always banned `@/modules/*` from platform code, so the
boundary predates the directory. This document fills in the rest.

## Layout

```
src/modules/<product>/
  domain/      pure logic — no React, no IO, no database
  ui/          React components, server or client
  index.ts     the public entry; the only file anything outside may import
```

`domain/` and `ui/` are a recommendation, not a rule — a small module can be a
single `index.ts`. The public entry is a rule, and it is enforced.

## Dependency directions

| Edge | Allowed | Enforced by |
| --- | --- | --- |
| `platform` → `modules` | ✗ | `no-restricted-imports` |
| `modules` → `config` | ✗ | `product-module-boundary` |
| outside → `modules/<p>/internals` | ✗ | `product-module-boundary` |
| outside → `@/modules/<p>` | ✓ | — |
| `modules` → `platform` | ✓ | — |
| `modules` → `components/ui/styles` | ✓ | — |
| `config` → `modules` | ✓ | — |
| `app` → `modules` | ✓ | — |

The two bans are the load-bearing ones. Configuration composes modules, so a
module importing configuration would close a cycle. And routing every outside
import through `index.ts` is what lets you rearrange a module's internals later
without touching anything else.

A module reaching into *another* module's internals is refused for the same
reason; go through that module's public entry.

## Wiring a module into the homepage

`index.ts` exports the surface:

```ts
// src/modules/planner/index.ts
export { PlannerSurface } from "./ui/planner-surface";
export type { PlannerProps } from "./ui/planner-surface";
```

Configuration composes it:

```tsx
// src/config/home.config.tsx
import { PlannerSurface } from "@/modules/planner";

{
  type: "tool-demo",
  heading: "Find your team's shared hours",
  body: "…",
  surface: <PlannerSurface />,
}
```

Configuration still owns the copy and the section order. The module owns the
behaviour. Neither file grows into the other.

## Server, client and the CSP

`src/proxy.ts` issues a per-request nonce and the CSP admits no `unsafe-inline`
for scripts. Keep the SEO-critical parts of a surface server-rendered and mark
only the interactive leaves `"use client"` — the same split the rest of the
starter uses. Interactive product code counts against the script budget in
`tests/performance/marketing-performance.spec.ts` (350 KB, 20 files), which the
current tree uses well under half of.

Anything touching the database or a secret belongs in `domain/` behind a server
boundary, reached through a route handler or server action, never bundled into a
client component.

## Enforcement

`tests/unit/architecture/product-module-boundary.test.ts` proves the rule
rejects config imports, deep imports and cross-module internals while allowing
platform use, shared styles and the public entry. `bun run verify:architecture`
runs it against the whole tree.
