# okf-export

Export [OWOX Data Marts](https://docs.owox.com/) to an **Open Knowledge Format (OKF)** bundle, and optionally push that bundle to a GitHub repository.

[OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) is a vendor-neutral, human- and agent-friendly way to represent metadata and context as a directory of markdown files with YAML frontmatter. This tool produces **one OKF concept document per data mart** — its title, description, definition type, storage, and schema — with a link to where the live data sits. It describes your data marts; it does not dump their rows.

## What you get

```
okf-bundle/
├── index.md                 # bundle root
└── data-marts/
    ├── index.md             # table of all exported marts
    ├── <mart-slug>.md       # one concept doc per data mart
    └── ...
```

Each concept document carries OKF frontmatter (`type`, `title`, `description`, `resource`, `tags`, `timestamp`) followed by an overview, a schema table, and — if you ask for it — a small row preview.

## Requirements

- Python 3.8+ (standard library only — no `pip install` needed)
- `git` on your PATH (only required when pushing the bundle to GitHub)
- An OWOX API key
- A GitHub token (only required when pushing the bundle to GitHub)

## Two GitHub repos, don't mix them up

- **This repo (`OWOX/okf-export`)** holds the exporter — the script and these docs.
- **The target repo (`--repo`)** is where the *generated OKF bundle* gets pushed. It can be any repo you choose, and can even be this one (into a subdirectory).

## Step-by-step

### 1. Get the code

```bash
git clone https://github.com/OWOX/okf-export.git
cd okf-export
```

### 2. Create an OWOX API key

In your OWOX Data Marts project: **Project settings → My API Keys → Create API Key**. Copy the full value (it starts with `owox_key_` and is shown only once). See the [API Keys docs](https://docs.owox.com/docs/api/api-keys/).

The key encodes your API origin and credentials; the script exchanges it for a short-lived access token automatically. You never need to copy the `pmk_...` ID separately.

### 3. (Only if pushing) Create a GitHub token

Create a **fine-grained personal access token** scoped to just the target repo, with **Contents: Read and write**. That is the minimum needed to push the bundle, and is far safer than a classic token with broad `repo` scope.

### 4. Configure credentials

Copy the example file and fill in your values:

```bash
cp .env.example .env
# edit .env with your editor
```

Then load it into your shell (this auto-exports every variable):

```bash
set -a; source .env; set +a
```

`.env` is gitignored. Never commit it.

### 5. Run the export

Export every data mart you can see, into `./okf-bundle`:

```bash
python3 owox_to_okf.py
```

Export specific marts, with a 5-row preview embedded in each doc:

```bash
python3 owox_to_okf.py --ids id1,id2 --sample-rows 5
```

### 6. Export and push the bundle to GitHub

```bash
python3 owox_to_okf.py --push \
    --repo your-org/your-okf-data-repo \
    --branch main \
    --subdir owox
```

With `GITHUB_REPO` and `GITHUB_TOKEN` set in your `.env`, the `--repo`/`--token` flags are optional:

```bash
python3 owox_to_okf.py --push
```

The script clones the target branch, replaces the bundle under `--subdir` (so deletions propagate), commits, and pushes. If the branch does not exist yet, it is created. Use `--subdir ""` to place the bundle at the repo root.

## Configuration reference

Every option can be set by flag or environment variable. Flags win when both are present.

| Flag | Env var | Default | Purpose |
|------|---------|---------|---------|
| `--api-key` | `OWOX_API_KEY` | — | OWOX API key (`owox_key_...`). Required. |
| `--ids` | — | all | Comma-separated data-mart IDs to export. |
| `--out` | — | `okf-bundle` | Local output directory. |
| `--sample-rows` | — | `0` | Embed first N rows as a preview per mart. |
| `--push` | — | off | Push the generated bundle to GitHub. |
| `--repo` | `GITHUB_REPO` | — | Target repo as `owner/name`. Required with `--push`. |
| `--token` | `GITHUB_TOKEN` | — | GitHub token. Required with `--push`. |
| `--branch` | — | `main` | Branch to push to. |
| `--subdir` | — | `okf` | Subdirectory in the target repo for the bundle. |
| `--commit-msg` | — | `Update OWOX OKF bundle` | Commit message. |

Run `python3 owox_to_okf.py --help` for the full list.

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
