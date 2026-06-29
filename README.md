# okf-export

Export [OWOX Data Marts](https://docs.owox.com/) to an **Open Knowledge Format (OKF)** bundle, and optionally push that bundle to a GitHub repository.

[OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) is a vendor-neutral, human- and agent-friendly way to represent metadata and context as a directory of markdown files with YAML frontmatter. This tool produces **one OKF concept document per data mart** — its title, description, definition type, storage, and schema — with a link to where the live data sits. It describes your data marts; it does not dump their rows.

## What you get

```
bundels/
├── index.md                 # bundle root
├── viz.html                 # interactive knowledge graph (optional, on by default)
└── <project-name>/
    ├── index.md             # table of all exported marts
    ├── <mart-slug>.md       # one concept doc per data mart
    └── ...
```

Each concept document carries OKF frontmatter (`type`, `title`, `description`, `resource`, `tags`, `timestamp`) followed by an overview, a schema table, and — if you ask for it — a small row preview.

`viz.html` is a self-contained interactive knowledge graph: nodes are data marts, edges connect each mart to its storage destination, and clicking a node opens a detail panel with its full documentation. It loads from a local file — no server needed, just open it in a browser.

## Two ways to run it

The same export engine ([backend/engine.py](backend/engine.py)) runs either as:

- **A standalone CLI** — `python3 export.py` (this README's main flow), configured via `.env`.
- **An OWOX Data Marts plugin** — installed into the OWOX client, configured via the host Settings page. See [Run as an OWOX plugin](#run-as-an-owox-plugin).

## Run as an OWOX plugin

This repo is a valid OWOX plugin per the [Plugin Author Contract](https://github.com/OWOX/owox-data-marts-experimental/blob/main/AGENTS.md): a React frontend ([frontend/index.tsx](frontend/index.tsx)) plus a Python/FastAPI backend sidecar ([backend/main.py](backend/main.py)) that reuses the export engine.

**Install:** on the OWOX **Plugins** page, paste `OWOX/okf-export` into *Install from GitHub*. The host downloads the latest release `.tgz`, installs Python deps, and registers the plugin.

**Configure:** open the plugin's **Settings** page (rendered by the host) and fill in:

| Setting | Required | Purpose |
|---|---|---|
| `owox-api-key` | yes | OWOX API key (`owox_key_...`). |
| `github-repo` | no | Target `owner/repo` or `owner/repo/path` for push. |
| `github-token` | no | GitHub token; enables the *Push to GitHub* option. |
| `sample-rows` | no | Embed first N rows per mart. |
| `shared-only` | no | Only marts available for reporting (default on). |
| `source-link` | no | Link `resource` to the warehouse table/view. |

**Use:** the plugin page shows config status, a **Run export** button (and *Push to GitHub* when configured), and — after a run — a table of exported marts you can click to read each generated OKF document.

**Build & release:**

```bash
npm install          # published builds resolve @owox-plugins/sdk from npm;
                     # inside the owox monorepo use: npm i -D file:../packages/sdk
npm run build        # → dist/frontend/index.js
git tag v1.0.0 && git push origin v1.0.0   # workflow packs and publishes the release
```

The tag (minus `v`) must equal `version` in [plugin.json](plugin.json). [.github/workflows/release.yml](.github/workflows/release.yml) packs `dist plugin.json package.json backend requirements.txt` into `okf-export-<version>.tgz`.

## Requirements

- Python 3.8+ (standard library only — no `pip install` needed)
- `git` on your PATH (only required when pushing the bundle to GitHub)
- An OWOX API key
- A GitHub token (only required when pushing the bundle to GitHub)

## Two GitHub repos, don't mix them up

- **This repo (`OWOX/okf-export`)** holds the exporter — the script and these docs.
- **The target repo (`GITHUB_REPO`)** is where the *generated OKF bundle* gets pushed. It can be any repo you choose.

## Step-by-step

### 1. Get the code

```bash
git clone https://github.com/OWOX/okf-export.git
cd okf-export
```

### 2. Create an OWOX API key

In your OWOX Data Marts project: **Project settings → My API Keys → Create API Key**. Copy the full value (it starts with `owox_key_` and is shown only once). See the [API Keys docs](https://docs.owox.com/docs/api/api-keys/).

The key encodes your API origin and credentials; the script exchanges it for a short-lived access token automatically. You never need to copy the `pmk_...` ID separately.

The API key is project-scoped — it only exports data marts from the project where it was created.

### 3. (Only if pushing) Create a GitHub token

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**
2. Click **Generate new token**
3. Under **Repository access**, select **Only select repositories** and pick your target repo
4. Under **Permissions → Repository permissions**, click **+ Add permissions**, select **Contents** from the list, and set it to write access — that lets the script push commits
5. Leave everything else at no access
6. Click **Generate token** and copy the value

### 4. Configure credentials

Copy the example file and fill in your values:

```bash
cp .env.example .env
# edit .env with your editor
```

The script reads `.env` automatically — no shell export commands needed.

`.env` is gitignored. Never commit it.

### 5. Run the export

Export all data marts available for reporting, into `./bundels`:

```bash
python3 export.py
```

Export specific marts, with a 5-row preview embedded in each doc:

```bash
python3 export.py --ids id1,id2 --sample-rows 5
```

Include data marts not marked as available for reporting:

```bash
python3 export.py --no-shared-only
```

### 6. Export and push the bundle to GitHub

Set `GITHUB_REPO` in your `.env` to the target repo and folder, then run:

```bash
python3 export.py --push
```

The script clones the target branch, replaces the bundle at the specified path (so deletions propagate), commits, and pushes. If the branch or folder does not exist yet, both are created automatically.

## Configuration reference

Every option can be set by flag or environment variable. Flags win when both are present.

| Flag | Env var | Default | Purpose |
|------|---------|---------|---------|
| `--api-key` | `OWOX_API_KEY` | — | OWOX API key (`owox_key_...`). Required. |
| `--ids` | — | all | Comma-separated data-mart IDs to export. |
| `--out` | — | `bundels` | Local output directory. |
| `--sample-rows` | — | `0` | Embed first N rows as a preview per mart. |
| `--shared-only` / `--no-shared-only` | `SHARED_ONLY` | `true` | When on, exports only data marts marked as available for reporting in OWOX. |
| `--source-link` / `--no-source-link` | `SOURCE_LINK` | `false` | When on, the `resource` field in each doc (and in `viz.html`) links to the underlying warehouse table or view instead of the OWOX data endpoint. Coverage depends on definition type — see below. Off by default. |
| `--viz` / `--no-viz` | `VIZ` | `true` | Generate `viz.html` — an interactive knowledge graph you can open directly in a browser. |
| `--push` | — | off | Push the generated bundle to GitHub. |
| `--repo` | `GITHUB_REPO` | — | Target repo and folder as `owner/repo-name/path/to/folder`. Required with `--push`. |
| `--token` | `GITHUB_TOKEN` | — | GitHub token. Required with `--push`. |
| `--branch` | — | `main` | Branch to push to. |
| `--commit-msg` | — | `Update OWOX OKF bundle` | Commit message. |

Run `python3 export.py --help` for the full list.

### Source link coverage (`--source-link`)

When `--source-link` is on, the `resource` field is set to the underlying warehouse table or view rather than the OWOX data endpoint. What's available depends on the data mart's definition type:

| Definition type | Source link target |
|---|---|
| **VIEW** | BigQuery console URL for the view (`project.dataset.table`) |
| **CONNECTOR** | BigQuery console URL for the connector's output table |
| **SQL** | Not available — the OWOX API does not return the output table for SQL data marts. Falls back to the OWOX data endpoint. |

The OWOX data endpoint (`…/api/external/http-data/data-marts/{id}.ndjson`) is always shown in the **Overview** section of each document regardless of this setting.

## How it works

OWOX's raw HTTP API does not accept the `owox_key_...` value directly. The script:

1. Strips the `owox_key_` prefix, base64url-decodes the rest, and parses the JSON to read `apiOrigin`, `apiKeyId`, and `apiKeySecret`.
2. Exchanges those at `POST {apiOrigin}/api/auth/api-keys/exchange` for an access token.
3. Calls `/api/data-marts` (list) and `/api/data-marts/{id}` (metadata + schema), and streams `/api/external/http-data/data-marts/{id}.ndjson` only when a row sample is requested.
4. Renders each mart as an OKF concept document and writes the bundle, with `index.md` files for navigation.

## Security notes

- Never commit your OWOX API key or GitHub token. `.env` is gitignored; keep it that way.
- The exported bundle contains metadata and (optionally) a tiny row sample — review it before pushing to a public repo to be sure no sensitive rows leak via `--sample-rows`.
- Access available through an API key is bound to the permissions of the project member who owns it. If listing returns `403`, the key lacks read access to the management API; pass explicit `--ids` instead.

## License

See the repository's license file.
