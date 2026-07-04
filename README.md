# okf-export — OWOX plugin (v2)

Export [OWOX Data Marts](https://docs.owox.com/) to an **Open Knowledge Format (OKF)** bundle — one
concept document per data mart (frontmatter + overview + schema) with an AI-written catalog overview —
and optionally push the bundle to a GitHub repo.

This is a **v2 (capability-broker) OWOX plugin**: a `plugin.json`, a built `ui/` (React + Tailwind,
runs in a sandboxed iframe), and a `backend.ts` the host bundles with esbuild. The plugin holds **no
credentials** — it declares what it needs and the host broker injects auth at the boundary. See the
host's [`AGENTS.md`](https://github.com/OWOX/owox-data-marts-experimental/blob/main/AGENTS.md) for the
full author contract.

## What it does

`exportMarts` ([backend.ts](backend.ts)) chains three brokered capabilities and stores zero secrets:

1. **`ctx.owox`** — list data marts and fetch each one's metadata/schema (and a row sample if asked).
2. **`ctx.ai`** — one `chat` call to write a plain-English overview for the bundle index.
3. **`ctx.git`** — `putFile` each OKF doc into the configured repo (token injected by the broker).

Rendered docs are cached in host-owned `storage` (scoped to `(project, plugin)`); the frontend reads
them back so you can browse the exported marts in-page.

## Declared contract ([plugin.json](plugin.json))

| Credential | Scope | Used for |
|---|---|---|
| `data-mart` | `all` | Reading marts via `ctx.owox`. |
| `ai-provider` | `one` | The catalog-overview `ctx.ai.chat` call. |
| `github` | `one` | Pushing the bundle via `ctx.git`. |

Credential-free **settings**: `github-repo`, `sample-rows`, `shared-only`, `source-link`.

## Install

Paste `OWOX/okf-export` into the OWOX **Install from URL** field. The host fetches the source
tarball, validates the manifest, shows the consent screen for the credentials above, collects
settings, bundles `backend.ts`, and registers the instance. **No CI, no release tarball, no Docker.**

## Develop

```bash
npm install      # @owox/plugin-sdk is a types-only devDependency — install never blocks
npm run build    # vite → dist/ui (the iframe assets)
npm test         # vitest: UI (ui/App.test.tsx) + renderer (backend.test.ts), against ui/sdk-mock.ts
npm run typecheck
```

Edit three files: [plugin.json](plugin.json) (name / menu / credentials / settings),
[ui/App.tsx](ui/App.tsx) (the screen), [backend.ts](backend.ts) (the export function).
