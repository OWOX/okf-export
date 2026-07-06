# okf-export — OWOX plugin (v2)

Export [OWOX Data Marts](https://docs.owox.com/) to an **Open Knowledge Format (OKF)** bundle — one
concept document per data mart (frontmatter + overview + schema) — and either **download it as a `.zip`**
or **push it to a GitHub repo**.

This is a **v2 (capability-broker) OWOX plugin**: a `plugin.json`, a `ui/` (React + Tailwind, runs in a
sandboxed iframe) the host builds with esbuild, and an optional `backend.ts`. The plugin holds **no
credentials** — it declares what it needs and the host broker injects auth at the boundary. See the
host's [`AGENTS.md`](https://github.com/OWOX/owox-data-marts-experimental/blob/main/AGENTS.md) for the
full author contract.

## What it does — a 3-step wizard ([ui/App.tsx](ui/App.tsx))

The UI runs entirely in the browser against the **live frontend SDK** (`owox`/`git`/`credentials`) —
the `backend.call()` bridge isn't wired yet (AGENTS.md §6), so all work happens frontend-side:

1. **Filters** — availability (*shared for reporting* [default] / *shared for maintenance* / *all*, which
   forces & disables the first two), a storage multi-select (all selected by default), and a title search.
2. **Data marts** — the list matching those filters.
3. **Export** — pick a destination:
   - **Save to file** → renders the OKF bundle and downloads `okf-bundle.zip` (`index.md` + one file per mart, via [fflate](https://github.com/101arrowz/fflate)).
   - **Export to GitHub** → checks the `github` grant (error if not granted), then commits the bundle to the `owner/repo` + folder you enter, via `git.repo(repo).putFile(...)`.

The pure render + filter logic lives in [okf-core.ts](okf-core.ts), shared with the cron `exportMarts`
([backend.ts](backend.ts)) — a headless "export all reporting marts to a repo" for the host scheduler.

## Declared contract ([plugin.json](plugin.json))

| Credential | Scope | Required? | Used for |
|---|---|---|---|
| `data-mart` | `all` | **required** | Listing/reading marts via `owox`. |
| `github` | `one` | optional | The "Export to GitHub" destination via `git` (checked with `credentials.github.fetch`). |

No `settings` — the plugin is driven by its granted credentials and the in-UI wizard. "Save to file"
needs only `data-mart`; "Export to GitHub" additionally needs the optional `github` grant.

## Install

Paste `OWOX/okf-export` into the OWOX **Install from URL** field. The host fetches the source
tarball, **builds `ui/` and `backend.ts` itself with esbuild** (no Vite, no Tailwind), shows the
consent screen for the credentials above, and registers the instance. **No CI, no release tarball,
no Docker.**

## Develop

```bash
npm install                              # lucide-react bundled; @owox/plugin-sdk is host-provided
npm run dev                              # UI only, stubbed brokered calls → http://localhost:5173
cp owox.dev.example.json owox.dev.json   # then paste creds (gitignored); see below
npm run dev:broker                       # REAL data marts, real export   → http://localhost:5177
npm test                                 # vitest: UI + renderer
npm run typecheck
```

Two local modes:

- **`npm run dev`** (AGENTS.md §10 Step 2) — aliases `@owox/plugin-sdk` to [ui/sdk-mock.ts](ui/sdk-mock.ts):
  `settings`/`storage` are real (localStorage-backed); `backend.call` and brokered `owox`/`ai`/`git` are
  stubbed and console-logged. Fast UI iteration, no host, no creds.
- **`npm run dev:broker`** (§10 Step 3) — runs the real [backend.ts](backend.ts) in the browser against a
  Vite-side capability broker ([dev-broker.ts](dev-broker.ts)) fed from **[owox.dev.json](owox.dev.example.json)**
  (gitignored, §10 Step 3 shape: `owox.apiKey` = an `owox_key_…`; optional `github`/`ai-provider` secrets).
  So **Run export** lists your real data marts and generates real OKF docs with no host install. Copy the
  OWOX key from your host's `secrets/` into `owox.dev.json` once — the run reads only that local file, never
  the host at runtime. `ai` is stubbed; `git` pushes only if a `github` secret is set (else logs). Falls
  back to canned sample data if `owox.apiKey` is empty.

> **Host-build alignment (AGENTS.md §7.1).** The host builds `ui/` with esbuild and runs Tailwind with
> only the **default theme** (it ignores `tailwind.config`), so our custom OWOX tokens are precompiled:
> edit [ui/tailwind.css](ui/tailwind.css), run `npm run build:css`, and commit the generated
> [ui/styles.css](ui/styles.css) (imported by `ui/main.tsx`; `predev`/`prebuild` run it automatically).
> Bundled runtime deps (e.g. `lucide-react`) live in `dependencies`; `react`/`react-dom`/`@owox/plugin-sdk`
> are host-provided shared deps and stay external — `@owox/plugin-sdk` is typed via `tsconfig` `paths`.

Edit three files: [plugin.json](plugin.json) (name / menu / credentials),
[ui/App.tsx](ui/App.tsx) (the screen), [backend.ts](backend.ts) (the export function).
