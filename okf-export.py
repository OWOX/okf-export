#!/usr/bin/env python3
"""
owox_to_okf.py — Export OWOX Data Marts to an Open Knowledge Format (OKF) bundle,
                 and optionally push that bundle to a GitHub repo.

WHAT THIS DOES
--------------
OKF (https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) is a
*knowledge/metadata* format: a directory of markdown files, one per "concept",
each with a small YAML frontmatter block (type/title/description/resource/tags/
timestamp) and a markdown body. It is NOT a place to dump raw rows.

So this script writes ONE OKF concept document per data mart, describing it
(title, description, definition type, storage, schema) and linking to the live
data endpoint. With --sample-rows N it also embeds the first N rows as a small
preview for context — never the whole dataset.

AUTH (OWOX raw HTTP API)
------------------------
1. Take the `owox_key_...` value, strip the prefix, base64url-decode the rest,
   parse JSON -> apiOrigin, apiKeyId, apiKeySecret.
2. POST {apiOrigin}/api/auth/api-keys/exchange  -> accessToken
3. Call protected endpoints with the access token.

USAGE
-----
  export OWOX_API_KEY='owox_key_....'          # required (DO NOT commit this)

  # Export every data mart you can see, into ./okf-bundle:
  python3 owox_to_okf.py

  # Only specific marts, with a 5-row preview each:
  python3 owox_to_okf.py --ids id1,id2 --sample-rows 5

  # Export and push to GitHub (token provided by you, never hardcode it):
  export GITHUB_TOKEN='ghp_....'
  python3 owox_to_okf.py --push --repo owner/name --branch main \
      --subdir owox --commit-msg "Update OWOX OKF bundle"

Run `python3 owox_to_okf.py --help` for all options.

Dependencies: Python 3.8+ standard library only. `git` on PATH is needed for --push.
"""

import argparse
import base64
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

EXCHANGE_PATH = "/api/auth/api-keys/exchange"
DATA_MART_LIST_PATH = "/api/data-marts"
DATA_MART_GET_PATH = "/api/data-marts/{id}"
DATA_NDJSON_PATH = "/api/external/http-data/data-marts/{id}.ndjson"


# --------------------------------------------------------------------------- #
# HTTP helpers (stdlib only)
# --------------------------------------------------------------------------- #
def _http(method, url, headers=None, body=None, timeout=60):
    data = None
    headers = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _http_json(method, url, headers=None, body=None, timeout=60):
    status, raw = _http(method, url, headers, body, timeout)
    if status >= 400:
        raise RuntimeError(f"{method} {url} -> HTTP {status}: {raw[:500].decode('utf-8', 'replace')}")
    if not raw:
        return None
    return json.loads(raw.decode("utf-8"))


# --------------------------------------------------------------------------- #
# OWOX auth
# --------------------------------------------------------------------------- #
def parse_api_key(owox_key):
    """owox_key_<base64url(JSON)> -> (apiOrigin, apiKeyId, apiKeySecret)."""
    owox_key = owox_key.strip()
    prefix = "owox_key_"
    if not owox_key.startswith(prefix):
        raise ValueError("OWOX API key must start with 'owox_key_'")
    encoded = owox_key[len(prefix):]
    padded = encoded + "=" * (-len(encoded) % 4)
    decoded = base64.urlsafe_b64decode(padded).decode("utf-8")
    obj = json.loads(decoded)
    try:
        return obj["apiOrigin"].rstrip("/"), obj["apiKeyId"], obj["apiKeySecret"]
    except KeyError as e:
        raise ValueError(f"Decoded API key is missing field {e}") from None


def exchange_for_token(api_origin, api_key_id, api_key_secret):
    headers = {"X-OWOX-Api-Key-Id": api_key_id}
    data = _http_json("POST", api_origin + EXCHANGE_PATH, headers=headers,
                      body={"apiKeySecret": api_key_secret})
    token = data.get("accessToken")
    if not token:
        raise RuntimeError("Token exchange succeeded but no accessToken in response")
    return token


def auth_headers(access_token, api_key_id):
    # Send both header styles so the same token works on the management API
    # (standard bearer) and the external data API (x-owox-authorization).
    return {
        "Authorization": f"Bearer {access_token}",
        "x-owox-authorization": f"Bearer {access_token}",
        "X-OWOX-Api-Key-Id": api_key_id,
    }


# --------------------------------------------------------------------------- #
# OWOX data-mart fetching
# --------------------------------------------------------------------------- #
def list_data_marts(api_origin, headers):
    """Page through /api/data-marts and return [{id, title, ...}, ...]."""
    items, offset = [], 0
    while True:
        url = f"{api_origin}{DATA_MART_LIST_PATH}?offset={offset}"
        page = _http_json("GET", url, headers=headers)
        batch = page.get("items", []) if isinstance(page, dict) else (page or [])
        items.extend(batch)
        nxt = page.get("nextOffset") if isinstance(page, dict) else None
        if not nxt:
            break
        offset = nxt
    return items


def get_data_mart(api_origin, headers, mart_id):
    return _http_json("GET", api_origin + DATA_MART_GET_PATH.format(id=mart_id), headers=headers)


def fetch_sample_rows(api_origin, headers, mart_id, n):
    """Stream the .ndjson endpoint and stop after n rows (does not download all)."""
    if n <= 0:
        return []
    url = api_origin + DATA_NDJSON_PATH.format(id=mart_id)
    req = urllib.request.Request(url, headers=headers, method="GET")
    rows = []
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            for raw in resp:  # iterates line by line
                line = raw.decode("utf-8").strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
                if len(rows) >= n:
                    break
    except urllib.error.HTTPError as e:
        print(f"  ! could not fetch sample rows for {mart_id}: HTTP {e.code}", file=sys.stderr)
    return rows


# --------------------------------------------------------------------------- #
# OKF rendering
# --------------------------------------------------------------------------- #
def slugify(text, fallback):
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return s or fallback


def yaml_scalar(value):
    """Safely emit a single-line YAML string scalar."""
    s = "" if value is None else str(value)
    s = s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ").replace("\r", " ")
    return f'"{s}"'


def yaml_list(values):
    return "[" + ", ".join(yaml_scalar(v) for v in values) + "]"


def render_frontmatter(fields):
    lines = ["---"]
    for key, val in fields.items():
        if val is None:
            continue
        if isinstance(val, (list, tuple)):
            lines.append(f"{key}: {yaml_list(val)}")
        elif key == "timestamp":
            lines.append(f"{key}: {val}")  # ISO timestamp, unquoted
        else:
            lines.append(f"{key}: {yaml_scalar(val)}")
    lines.append("---")
    return "\n".join(lines)


def extract_columns(schema):
    """Best-effort: pull a list of (name, type, description) from OWOX's schema object."""
    if not isinstance(schema, dict):
        return []
    fields = None
    for key in ("fields", "columns", "schema"):
        if isinstance(schema.get(key), list):
            fields = schema[key]
            break
    if fields is None:
        return []
    cols = []
    for f in fields:
        if not isinstance(f, dict):
            continue
        name = f.get("name") or f.get("alias") or f.get("field") or ""
        ftype = f.get("type") or f.get("dataType") or f.get("mode") or ""
        desc = f.get("description") or f.get("title") or ""
        cols.append((str(name), str(ftype), str(desc)))
    return cols


def render_schema_section(schema):
    cols = extract_columns(schema)
    if cols:
        out = ["# Schema", "", "| Column | Type | Description |", "|--------|------|-------------|"]
        for name, ftype, desc in cols:
            desc = desc.replace("|", "\\|").replace("\n", " ")
            out.append(f"| `{name}` | {ftype} | {desc} |")
        return "\n".join(out)
    if schema:  # unknown shape -> show raw so nothing is lost
        return "# Schema\n\n```json\n" + json.dumps(schema, indent=2, ensure_ascii=False) + "\n```"
    return ""


def render_data_mart_doc(mart, api_origin, sample_rows):
    mart_id = mart.get("id", "")
    title = mart.get("title") or mart_id
    description = mart.get("description") or ""
    definition_type = mart.get("definitionType") or ""
    status = mart.get("status") or ""
    storage = mart.get("storage") or {}
    storage_type = storage.get("type") or ""
    storage_title = storage.get("title") or ""
    modified = mart.get("modifiedAt") or now_iso()
    data_url = f"{api_origin}{DATA_NDJSON_PATH.format(id=mart_id)}"

    tags = ["owox"]
    if storage_type:
        tags.append(storage_type.lower())
    if definition_type:
        tags.append(definition_type.lower())
    if mart.get("connectorSourceName"):
        tags.append(slugify(mart["connectorSourceName"], "connector"))

    short_desc = (description.strip().splitlines()[0] if description.strip()
                  else f"OWOX data mart '{title}'.")
    if len(short_desc) > 200:
        short_desc = short_desc[:197] + "..."

    frontmatter = render_frontmatter({
        "type": "OWOX Data Mart",
        "title": title,
        "description": short_desc,
        "resource": data_url,
        "tags": tags,
        "timestamp": modified,
    })

    body = [f"# {title}", ""]
    if description.strip():
        body += [description.strip(), ""]
    body += [
        "## Overview",
        "",
        f"- **ID:** `{mart_id}`",
        f"- **Status:** {status}",
        f"- **Definition type:** {definition_type}",
        f"- **Storage:** {storage_title} ({storage_type})".replace(" ()", ""),
        f"- **Data endpoint:** `GET {data_url}`",
        "",
    ]

    schema_section = render_schema_section(mart.get("schema"))
    if schema_section:
        body += [schema_section, ""]

    if sample_rows:
        preview = "\n".join(json.dumps(r, ensure_ascii=False) for r in sample_rows)
        body += [
            f"## Sample (first {len(sample_rows)} rows)",
            "",
            "> Preview only — the full dataset lives at the data endpoint above.",
            "",
            "```json",
            preview,
            "```",
            "",
        ]

    return frontmatter + "\n\n" + "\n".join(body).rstrip() + "\n"


def now_iso():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------- #
# Bundle writing
# --------------------------------------------------------------------------- #
def write_bundle(out_dir, marts_with_docs):
    """marts_with_docs: list of (mart_dict, rendered_markdown)."""
    marts_dir = os.path.join(out_dir, "data-marts")
    os.makedirs(marts_dir, exist_ok=True)

    index_rows = []
    for mart, doc in marts_with_docs:
        mart_id = mart.get("id", "")
        fname = slugify(mart.get("title", ""), mart_id) + ".md"
        with open(os.path.join(marts_dir, fname), "w", encoding="utf-8") as fh:
            fh.write(doc)
        index_rows.append((mart.get("title") or mart_id, fname,
                           mart.get("definitionType") or "",
                           (mart.get("storage") or {}).get("type") or ""))

    # data-marts/index.md
    di = [render_frontmatter({
        "type": "index", "title": "OWOX Data Marts",
        "description": "Index of exported OWOX data marts.",
        "tags": ["owox", "index"], "timestamp": now_iso(),
    }), "", "# OWOX Data Marts", "", "| Data Mart | Type | Storage |",
        "|-----------|------|---------|"]
    for title, fname, dtype, stype in sorted(index_rows):
        di.append(f"| [{title}](./{fname}) | {dtype} | {stype} |")
    with open(os.path.join(marts_dir, "index.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(di) + "\n")

    # bundle root index.md
    root = [render_frontmatter({
        "type": "index", "title": "OWOX Knowledge Bundle",
        "description": "OKF bundle generated from OWOX Data Marts.",
        "tags": ["owox", "index"], "timestamp": now_iso(),
    }), "", "# OWOX Knowledge Bundle", "",
        f"Generated {now_iso()}.", "",
        f"- [Data Marts](./data-marts/index.md) — {len(index_rows)} concept(s)", ""]
    with open(os.path.join(out_dir, "index.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(root) + "\n")

    return len(index_rows)


# --------------------------------------------------------------------------- #
# GitHub push (via git CLI)
# --------------------------------------------------------------------------- #
def git_push(bundle_dir, repo, token, branch, subdir, commit_msg):
    if not shutil.which("git"):
        raise RuntimeError("git is not on PATH; cannot push.")
    if "/" not in repo:
        raise RuntimeError("--repo must look like 'owner/name'")

    remote = f"https://x-access-token:{token}@github.com/{repo}.git"
    work = tempfile.mkdtemp(prefix="okf-push-")
    try:
        # Try to clone the existing branch; fall back to a fresh repo if empty/new.
        cloned = subprocess.run(
            ["git", "clone", "--depth", "1", "-b", branch, remote, work],
            capture_output=True, text=True
        ).returncode == 0
        if not cloned:
            subprocess.run(["git", "init", "-q", work], check=True)
            subprocess.run(["git", "-C", work, "remote", "add", "origin", remote], check=True)
            subprocess.run(["git", "-C", work, "checkout", "-q", "-b", branch], check=True)

        target = os.path.join(work, subdir) if subdir else work
        if os.path.isdir(target) and subdir:
            shutil.rmtree(target)  # replace prior export cleanly
        shutil.copytree(bundle_dir, target, dirs_exist_ok=True)

        subprocess.run(["git", "-C", work, "add", "-A"], check=True)
        # Identity (harmless if already configured globally)
        subprocess.run(["git", "-C", work, "config", "user.email", "okf-bot@example.com"], check=True)
        subprocess.run(["git", "-C", work, "config", "user.name", "OKF Export"], check=True)

        if subprocess.run(["git", "-C", work, "diff", "--cached", "--quiet"]).returncode == 0:
            print("No changes to commit — bundle already up to date.")
            return
        subprocess.run(["git", "-C", work, "commit", "-q", "-m", commit_msg], check=True)
        subprocess.run(["git", "-C", work, "push", "-u", "origin", branch], check=True)
        print(f"Pushed OKF bundle to {repo} ({branch}/{subdir or '.'}).")
    finally:
        shutil.rmtree(work, ignore_errors=True)


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main():
    p = argparse.ArgumentParser(description="Export OWOX data marts to an OKF bundle.")
    p.add_argument("--api-key", default=os.environ.get("OWOX_API_KEY"),
                   help="OWOX API key (owox_key_...). Defaults to $OWOX_API_KEY.")
    p.add_argument("--ids", default="", help="Comma-separated data-mart IDs (default: all).")
    p.add_argument("--out", default="okf-bundle", help="Output directory (default: okf-bundle).")
    p.add_argument("--sample-rows", type=int, default=0,
                   help="Embed first N rows as preview per mart (default: 0 = none).")
    # GitHub
    p.add_argument("--push", action="store_true", help="Push the bundle to GitHub.")
    p.add_argument("--repo", default=os.environ.get("GITHUB_REPO"), help="owner/name")
    p.add_argument("--token", default=os.environ.get("GITHUB_TOKEN"), help="GitHub token ($GITHUB_TOKEN).")
    p.add_argument("--branch", default="main", help="Branch to push (default: main).")
    p.add_argument("--subdir", default="okf", help="Repo subdir for the bundle (default: okf).")
    p.add_argument("--commit-msg", default="Update OWOX OKF bundle", help="Commit message.")
    args = p.parse_args()

    if not args.api_key:
        p.error("OWOX API key required (--api-key or $OWOX_API_KEY).")

    print("Parsing API key and exchanging for an access token...")
    api_origin, api_key_id, api_key_secret = parse_api_key(args.api_key)
    token = exchange_for_token(api_origin, api_key_id, api_key_secret)
    headers = auth_headers(token, api_key_id)
    print(f"  origin: {api_origin}")

    if args.ids.strip():
        ids = [i.strip() for i in args.ids.split(",") if i.strip()]
    else:
        print("Listing data marts...")
        ids = [m["id"] for m in list_data_marts(api_origin, headers)]
    print(f"  {len(ids)} data mart(s) to export.")

    marts_with_docs = []
    for mart_id in ids:
        print(f"Fetching {mart_id} ...")
        mart = get_data_mart(api_origin, headers, mart_id)
        sample = fetch_sample_rows(api_origin, headers, mart_id, args.sample_rows)
        marts_with_docs.append((mart, render_data_mart_doc(mart, api_origin, sample)))

    if os.path.isdir(args.out):
        shutil.rmtree(args.out)
    count = write_bundle(args.out, marts_with_docs)
    print(f"Wrote OKF bundle to {args.out}/ ({count} concept docs).")

    if args.push:
        if not args.repo or not args.token:
            p.error("--push requires --repo and --token (or $GITHUB_REPO/$GITHUB_TOKEN).")
        print(f"Pushing to GitHub {args.repo} ...")
        git_push(args.out, args.repo, args.token, args.branch, args.subdir, args.commit_msg)


if __name__ == "__main__":
    main()
