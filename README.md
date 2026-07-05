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

| Credential | Scope | Required? | Used for |
|---|---|---|---|
| `data-mart` | `all` | **required** | Reading marts via `ctx.owox`. |
| `github` | `one` | optional | Pushing the bundle via `ctx.git` (repo bound to the grant). |
| `ai-provider` | `one` | optional | The catalog-overview `ctx.ai.chat` call. |

No `settings` — the plugin is configured entirely by its granted credentials. Export
defaults: marts available for reporting, no row samples, resource links to the OWOX data
endpoint. When pushing, you enter the target `owner/repo` (remembered in host `storage`,
§5); the bundle is written under `okf/` via `ctx.git.repo(repo)`.

## Install

Paste `OWOX/okf-export` into the OWOX **Install from URL** field. The host fetches the source
tarball, **builds `ui/` and `backend.ts` itself with esbuild** (no Vite, no Tailwind), shows the
consent screen for the credentials above, and registers the instance. **No CI, no release tarball,
no Docker.**

## Develop

```bash
npm install        # lucide-react is a real dependency (bundled); @owox/plugin-sdk is types-only
npm run build:css  # precompile Tailwind → ui/styles.css (committed; the host does NOT run Tailwind)
npm run dev        # standalone debug harness on http://localhost:5199 (see below)
npm test           # vitest: UI (ui/App.test.tsx) + renderer (backend.test.ts)
npm run typecheck
```

> **Host-build alignment (AGENTS.md §7.1).** The host builds `ui/` with esbuild and does **not** run
> Tailwind, so styling is precompiled: edit [ui/tailwind.css](ui/tailwind.css), run `npm run build:css`,
> and commit the generated [ui/styles.css](ui/styles.css) (imported by `ui/main.tsx`). `predev`/`prebuild`
> run it automatically. Runtime deps that get bundled (e.g. `lucide-react`) live in `dependencies`;
> `react`/`react-dom`/`@owox/plugin-sdk` are host-provided shared deps and stay external.

Edit three files: [plugin.json](plugin.json) (name / menu / credentials),
[ui/App.tsx](ui/App.tsx) (the screen), [backend.ts](backend.ts) (the export function).
