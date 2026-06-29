"""main.py — OWOX plugin backend (Python/FastAPI sidecar).

The host spawns this as `backend.main:app` and reverse-proxies
/api/plugin/okf-export/* to it unchanged, so every route declares the FULL path.

Settings come from the host via the PLUGIN_SETTINGS env var (merged global←project
JSON); there is no .env in the plugin runtime. See AGENTS.md §3.2 and §5."""

import json
import os
import tempfile

from fastapi import FastAPI
from pydantic import BaseModel

from . import engine

app = FastAPI()

PLUGIN_ID = "okf-export"
SETTINGS = json.loads(os.environ.get("PLUGIN_SETTINGS", "{}"))
DB_PATH = os.environ.get("PLUGIN_DB_PATH")

# Where bundles are written. Prefer the per-plugin data dir (next to the SQLite
# file); fall back to a temp dir in bare dev runs.
# ponytail: in-memory last-run cache; lost on restart — just re-run the export.
_OUT_DIR = os.path.join(os.path.dirname(DB_PATH), "bundle") if DB_PATH \
    else os.path.join(tempfile.gettempdir(), "okf-export-bundle")
_LAST = {"result": None, "docs": {}}


def _config(push=False, ids=""):
    """Map host settings → engine config."""
    return {
        "api_key": SETTINGS.get("owox-api-key"),
        "ids": ids,
        "out": _OUT_DIR,
        "sample_rows": SETTINGS.get("sample-rows") or 0,
        "shared_only": SETTINGS.get("shared-only", True),
        "source_link": bool(SETTINGS.get("source-link", False)),
        "viz": False,  # the frontend renders docs itself; no viz.html needed
        "push": push,
        "repo": SETTINGS.get("github-repo"),
        "token": SETTINGS.get("github-token"),
    }


class RunBody(BaseModel):
    push: bool = False
    ids: str = ""


@app.get(f"/api/plugin/{PLUGIN_ID}/ping")
def ping():
    return {"ok": True}


@app.get(f"/api/plugin/{PLUGIN_ID}/status")
def status():
    """Authoritative config status (does not leak secret values)."""
    return {
        "owox": bool(SETTINGS.get("owox-api-key")),
        "github": bool(SETTINGS.get("github-repo") and SETTINGS.get("github-token")),
        "last": _LAST["result"],
    }


@app.post(f"/api/plugin/{PLUGIN_ID}/run")
def run(body: RunBody):
    try:
        result = engine.run_export(_config(push=body.push, ids=body.ids))
    except (ValueError, RuntimeError) as e:
        return {"ok": False, "error": str(e)}
    _LAST["docs"] = result.pop("docs")
    _LAST["result"] = result
    return {"ok": True, **result}


@app.get(f"/api/plugin/{PLUGIN_ID}/marts")
def marts():
    return {"marts": (_LAST["result"] or {}).get("marts", [])}


@app.get(f"/api/plugin/{PLUGIN_ID}/doc")
def doc(slug: str):
    return {"slug": slug, "markdown": _LAST["docs"].get(slug, "")}
