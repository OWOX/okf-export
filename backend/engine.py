#!/usr/bin/env python3
"""engine.py — OKF export engine: turn OWOX Data Marts into an Open Knowledge
Format (OKF) bundle, optionally push it to GitHub, and render a viz.html graph.

Stdlib only (no pip deps). Shared by the CLI (../export.py) and the OWOX plugin
backend (main.py). `git` on PATH is needed only for run_export(push=True)."""

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
def _b64url_decode_json(s):
    padded = s + "=" * (-len(s) % 4)
    return json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))


def parse_api_key(owox_key):
    """owox_key_<base64url(JSON)> -> (apiOrigin, apiKeyId, apiKeySecret)."""
    owox_key = owox_key.strip()
    if not owox_key.startswith("owox_key_"):
        raise ValueError("OWOX API key must start with 'owox_key_'")
    try:
        obj = _b64url_decode_json(owox_key[len("owox_key_"):])
        return obj["apiOrigin"].rstrip("/"), obj["apiKeyId"], obj["apiKeySecret"]
    except KeyError as e:
        raise ValueError(f"Decoded API key is missing field {e}") from None


def exchange_for_token(api_origin, api_key_id, api_key_secret):
    data = _http_json("POST", api_origin + EXCHANGE_PATH,
                      headers={"X-OWOX-Api-Key-Id": api_key_id},
                      body={"apiKeySecret": api_key_secret})
    token = data.get("accessToken")
    if not token:
        raise RuntimeError("Token exchange succeeded but no accessToken in response")
    return token


def project_title_from_token(access_token):
    """Decode the JWT payload (no verification needed — we just need the project title)."""
    try:
        return _b64url_decode_json(access_token.split(".")[1]).get("projectTitle") or ""
    except Exception:
        return ""


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
        page = _http_json("GET", f"{api_origin}/api/data-marts?offset={offset}", headers=headers)
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
    rows = []
    try:
        url = api_origin + DATA_NDJSON_PATH.format(id=mart_id)
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120) as resp:
            for raw in resp:
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


class _Raw(str):
    """YAML scalar emitted unquoted (use for timestamps and other pre-formatted values)."""


def yaml_scalar(value):
    """Safely emit a single-line YAML string scalar."""
    if isinstance(value, _Raw):
        return str(value)
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
        else:
            lines.append(f"{key}: {yaml_scalar(val)}")
    lines.append("---")
    return "\n".join(lines)


def _source_url(mart):
    """Return (fqn, url) for the underlying warehouse table/view, or (None, None)."""
    storage = mart.get("storage") or {}
    storage_type = storage.get("type") or ""
    definition = mart.get("definition") or {}
    definition_type = mart.get("definitionType") or ""

    fqn = None
    if definition_type == "VIEW":
        fqn = definition.get("fullyQualifiedName")
    elif definition_type == "CONNECTOR":
        fqn = ((definition.get("connector") or {}).get("storage") or {}).get("fullyQualifiedName")

    if not fqn:
        return None, None

    if storage_type == "GOOGLE_BIGQUERY":
        parts = fqn.split(".")
        if len(parts) == 3:
            project, dataset, table = parts
        elif len(parts) == 2:
            dataset, table = parts
            project = (storage.get("config") or {}).get("projectId") or ""
        else:
            return fqn, None
        if project:
            url = (f"https://console.cloud.google.com/bigquery"
                   f"?p={project}&d={dataset}&t={table}&page=table")
            return fqn, url

    return fqn, None


def extract_columns(schema):
    """Best-effort: pull a list of (name, type, description) from OWOX's schema object."""
    if not isinstance(schema, dict):
        return []
    fields = next(
        (schema[k] for k in ("fields", "columns", "schema") if isinstance(schema.get(k), list)),
        None,
    )
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
    if schema:
        return "# Schema\n\n```json\n" + json.dumps(schema, indent=2, ensure_ascii=False) + "\n```"
    return ""


def render_data_mart_doc(mart, api_origin, sample_rows, source_link=False):
    mart_id = mart.get("id", "")
    title = mart.get("title") or mart_id
    description = mart.get("description") or ""
    definition_type = mart.get("definitionType") or ""
    status = mart.get("status") or ""
    storage = mart.get("storage") or {}
    storage_type = storage.get("type") or ""
    storage_title = storage.get("title") or ""
    modified = _Raw(mart.get("modifiedAt") or now_iso())
    data_url = f"{api_origin}{DATA_NDJSON_PATH.format(id=mart_id)}"

    source_fqn, source_bq_url = _source_url(mart) if source_link else (None, None)
    resource = source_bq_url or data_url

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
        "resource": resource,
        "tags": tags,
        "timestamp": modified,
    })

    body = [f"# {title}", ""]
    if description.strip():
        body += [description.strip(), ""]
    overview = [
        "## Overview",
        "",
        f"- **ID:** `{mart_id}`",
        f"- **Status:** {status}",
        f"- **Definition type:** {definition_type}",
        f"- **Storage:** {storage_title} ({storage_type})".replace(" ()", ""),
    ]
    if source_fqn:
        overview.append(f"- **Source:** `{source_fqn}`")
    overview += [f"- **Data endpoint:** `GET {data_url}`", ""]
    body += overview

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
def write_bundle(out_dir, marts_with_docs, project_folder):
    """marts_with_docs: list of (mart_dict, rendered_markdown).
    project_folder: slugified OWOX project name used as the subfolder name."""
    marts_dir = os.path.join(out_dir, project_folder)
    os.makedirs(marts_dir, exist_ok=True)
    ts = _Raw(now_iso())

    index_rows = []
    for mart, doc in marts_with_docs:
        mart_id = mart.get("id", "")
        fname = slugify(mart.get("title", ""), mart_id) + ".md"
        with open(os.path.join(marts_dir, fname), "w", encoding="utf-8") as fh:
            fh.write(doc)
        index_rows.append((mart.get("title") or mart_id, fname,
                           mart.get("definitionType") or "",
                           (mart.get("storage") or {}).get("type") or ""))

    # <project_folder>/index.md
    di = [render_frontmatter({
        "type": "index", "title": "OWOX Data Marts",
        "description": "Index of exported OWOX data marts.",
        "tags": ["owox", "index"], "timestamp": ts,
    }), "", "# OWOX Data Marts", "", "| Data Mart | Type | Storage |",
        "|-----------|------|---------|"]
    for title, fname, dtype, stype in sorted(index_rows):
        safe_title = title.replace("[", "\\[").replace("]", "\\]")
        di.append(f"| [{safe_title}](./{fname}) | {dtype} | {stype} |")
    with open(os.path.join(marts_dir, "index.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(di) + "\n")

    # bundle root index.md
    root = [render_frontmatter({
        "type": "index", "title": "OWOX Knowledge Bundle",
        "description": "OKF bundle generated from OWOX Data Marts.",
        "tags": ["owox", "index"], "timestamp": ts,
    }), "", "# OWOX Knowledge Bundle", "",
        f"Generated {ts}.", "",
        f"- [Data Marts](./{project_folder}/index.md) — {len(index_rows)} concept(s)", ""]
    with open(os.path.join(out_dir, "index.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(root) + "\n")

    return len(index_rows)


# --------------------------------------------------------------------------- #
# Viz HTML generation
# --------------------------------------------------------------------------- #
_VIZ_TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>OKF Bundle Viewer</title>
<script src="https://cdn.jsdelivr.net/npm/cytoscape@3.28.1/dist/cytoscape.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"></script>
<style>
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 14px; color: #0f172a; background: #f8fafc;
  display: flex; flex-direction: column; height: 100vh;
}
header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px; background: #fff;
  border-bottom: 1px solid #e2e8f0; flex-shrink: 0;
}
.title strong { font-size: 16px; margin-right: 8px; }
.muted { color: #64748b; font-size: 12px; }
.controls { display: flex; gap: 8px; }
.controls input, .controls select, .controls button {
  font-size: 13px; padding: 5px 8px;
  border: 1px solid #cbd5e1; border-radius: 4px; background: #fff;
}
.controls input { width: 200px; }
.controls button { cursor: pointer; background: #f1f5f9; }
.controls button:hover { background: #e2e8f0; }
main { display: flex; flex: 1; min-height: 0; }
#graph {
  flex: 1 1 60%; background: #fff;
  border-right: 1px solid #e2e8f0; min-width: 0;
}
#detail { flex: 0 0 40%; overflow-y: auto; padding: 18px 22px; background: #fff; }
#detail-empty { text-align: center; margin-top: 40px; color: #64748b; }
.detail-header { margin-bottom: 12px; }
.detail-header h1 { font-size: 18px; margin: 4px 0 2px; font-weight: 600; }
.type-chip {
  display: inline-block; padding: 2px 8px; border-radius: 10px;
  font-size: 11px; font-weight: 600; color: #fff; background: #94a3b8;
  text-transform: uppercase; letter-spacing: 0.5px;
}
dl.frontmatter {
  display: grid; grid-template-columns: 90px 1fr;
  row-gap: 4px; column-gap: 12px; margin: 8px 0 12px; font-size: 13px;
}
dl.frontmatter dt { color: #64748b; font-weight: 500; }
dl.frontmatter dd { margin: 0; word-break: break-all; }
.tag {
  display: inline-block; background: #f1f5f9; border: 1px solid #e2e8f0;
  border-radius: 4px; padding: 1px 6px; font-size: 11px; margin: 1px 2px 1px 0;
}
a.external { color: #3b82f6; word-break: break-all; }
.markdown-body { font-size: 13px; line-height: 1.6; }
.markdown-body h1 { font-size: 16px; margin: 16px 0 8px; }
.markdown-body h2 { font-size: 14px; margin: 14px 0 6px; }
.markdown-body h3 { font-size: 13px; margin: 12px 0 4px; }
.markdown-body code { background: #f1f5f9; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
.markdown-body pre { background: #f1f5f9; padding: 10px; border-radius: 4px; overflow-x: auto; }
.markdown-body pre code { background: none; padding: 0; }
.markdown-body table { border-collapse: collapse; width: 100%; font-size: 12px; }
.markdown-body th, .markdown-body td { border: 1px solid #e2e8f0; padding: 4px 8px; text-align: left; }
.markdown-body th { background: #f8fafc; }
.markdown-body blockquote { border-left: 3px solid #cbd5e1; margin: 0; padding: 4px 12px; color: #64748b; }
#detail-backlinks { margin-top: 16px; border-top: 1px solid #e2e8f0; padding-top: 12px; }
#detail-backlinks h3 { font-size: 13px; margin: 0 0 6px; }
#backlinks-list { margin: 0; padding-left: 16px; }
#backlinks-list li { margin: 3px 0; }
#backlinks-list a { color: #3b82f6; cursor: pointer; text-decoration: none; }
#backlinks-list a:hover { text-decoration: underline; }
.dim { opacity: 0.15; }
</style>
</head>
<body>
<header>
  <div class="title">
    <strong id="bundle-name"></strong>
    <span class="muted">OKF Bundle</span>
  </div>
  <div class="controls">
    <input id="search" type="search" placeholder="Search…">
    <select id="filter-type"><option value="">All types</option></select>
    <select id="layout">
      <option value="cose">Force</option>
      <option value="concentric">Concentric</option>
      <option value="breadthfirst">Tree</option>
      <option value="circle">Circle</option>
      <option value="grid">Grid</option>
    </select>
    <button id="reset">Reset view</button>
  </div>
</header>
<main>
  <div id="graph"></div>
  <div id="detail">
    <div id="detail-empty"><p>Click a node to explore.</p></div>
    <div id="detail-content" hidden>
      <div class="detail-header">
        <span class="type-chip" id="detail-type"></span>
        <h1 id="detail-title"></h1>
        <div class="muted" id="detail-id"></div>
      </div>
      <dl class="frontmatter">
        <dt>Description</dt><dd id="detail-description"></dd>
        <dt>Resource</dt><dd id="detail-resource"></dd>
        <dt>Tags</dt><dd id="detail-tags"></dd>
      </dl>
      <div id="detail-body" class="markdown-body"></div>
      <div id="detail-backlinks" hidden>
        <h3>Referenced by</h3>
        <ul id="backlinks-list"></ul>
      </div>
    </div>
  </div>
</main>
<script>
window.BUNDLE_NAME = "OWOX_BUNDLE_NAME";
window.BUNDLE = OWOX_BUNDLE_JSON;
</script>
<script>
(function () {
  const bundle = window.BUNDLE;
  document.title = window.BUNDLE_NAME + " — OKF Viewer";
  document.getElementById("bundle-name").textContent = window.BUNDLE_NAME;

  const typeSelect = document.getElementById("filter-type");
  for (const t of bundle.types) {
    const opt = document.createElement("option");
    opt.value = t; opt.textContent = t;
    typeSelect.appendChild(opt);
  }

  const backlinks = {};
  for (const edge of bundle.edges) {
    const { source, target } = edge.data;
    (backlinks[target] = backlinks[target] || []).push(source);
  }

  const nodeIndex = {};
  for (const n of bundle.nodes) nodeIndex[n.data.id] = n.data;

  const cy = cytoscape({
    container: document.getElementById("graph"),
    elements: [...bundle.nodes, ...bundle.edges],
    style: [
      { selector: "node", style: {
          "background-color": "data(color)", "label": "data(label)",
          "color": "#0f172a", "font-size": 11,
          "text-valign": "bottom", "text-margin-y": 4,
          "text-wrap": "wrap", "text-max-width": 120,
          "width": "data(size)", "height": "data(size)",
          "border-width": 1, "border-color": "#0f172a" } },
      { selector: "node:selected", style: { "border-width": 3, "border-color": "#f59e0b" } },
      { selector: "edge", style: {
          "width": 1.5, "line-color": "#cbd5e1",
          "target-arrow-color": "#cbd5e1", "target-arrow-shape": "triangle",
          "curve-style": "bezier", "arrow-scale": 0.9 } },
      { selector: "edge:selected", style: {
          "line-color": "#f59e0b", "target-arrow-color": "#f59e0b", "width": 2.5 } },
      { selector: ".dim", style: { "opacity": 0.15 } },
    ],
    layout: { name: "cose", animate: false, padding: 30 },
    wheelSensitivity: 0.2,
  });

  cy.on("tap", "node", (evt) => showDetail(evt.target.id()));
  cy.on("tap", (evt) => { if (evt.target === cy) clearSelection(); });

  document.getElementById("layout").addEventListener("change", (e) => {
    cy.layout({ name: e.target.value, animate: false, padding: 30 }).run();
  });
  document.getElementById("reset").addEventListener("click", () => {
    cy.fit(null, 30); clearSelection();
  });
  document.getElementById("search").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) { cy.elements().removeClass("dim"); return; }
    cy.nodes().forEach((n) => {
      const d = n.data();
      const hay = (d.label || "").toLowerCase() + " " + d.id.toLowerCase() + " " + (d.tags || []).join(" ").toLowerCase();
      n.toggleClass("dim", !hay.includes(q));
    });
    cy.edges().forEach((e) => {
      e.toggleClass("dim", e.source().hasClass("dim") || e.target().hasClass("dim"));
    });
  });
  document.getElementById("filter-type").addEventListener("change", (e) => {
    const t = e.target.value;
    if (!t) { cy.elements().removeClass("dim"); return; }
    cy.nodes().forEach((n) => n.toggleClass("dim", n.data("type") !== t));
    cy.edges().forEach((e) => {
      e.toggleClass("dim", e.source().hasClass("dim") || e.target().hasClass("dim"));
    });
  });

  function clearSelection() {
    cy.elements().unselect();
    document.getElementById("detail-empty").hidden = false;
    document.getElementById("detail-content").hidden = true;
  }

  function showDetail(conceptId) {
    const data = nodeIndex[conceptId];
    if (!data) return;
    cy.elements().unselect();
    const node = cy.getElementById(conceptId);
    if (node) node.select();

    document.getElementById("detail-empty").hidden = true;
    document.getElementById("detail-content").hidden = false;

    const chip = document.getElementById("detail-type");
    chip.textContent = data.type; chip.style.background = data.color;
    document.getElementById("detail-title").textContent = data.label;
    document.getElementById("detail-id").textContent = conceptId;
    document.getElementById("detail-description").textContent = data.description || "—";

    const resourceEl = document.getElementById("detail-resource");
    resourceEl.innerHTML = "";
    if (data.resource) {
      const a = document.createElement("a");
      a.href = data.resource; a.textContent = data.resource;
      a.target = "_blank"; a.rel = "noopener"; a.className = "external";
      resourceEl.appendChild(a);
    } else { resourceEl.textContent = "—"; }

    const tagsEl = document.getElementById("detail-tags");
    tagsEl.innerHTML = "";
    for (const t of (data.tags || [])) {
      const span = document.createElement("span");
      span.className = "tag"; span.textContent = t; tagsEl.appendChild(span);
    }
    if (!data.tags || !data.tags.length) tagsEl.textContent = "—";

    document.getElementById("detail-body").innerHTML =
      marked.parse(bundle.bodies[conceptId] || "", { breaks: false, gfm: true });

    const bl = backlinks[conceptId] || [];
    const blSection = document.getElementById("detail-backlinks");
    const blList = document.getElementById("backlinks-list");
    blList.innerHTML = "";
    blSection.hidden = !bl.length;
    for (const src of bl) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.textContent = nodeIndex[src] ? nodeIndex[src].label : src;
      a.onclick = () => showDetail(src);
      li.appendChild(a); blList.appendChild(li);
    }
  }
})();
</script>
</body>
</html>
"""

_TYPE_COLORS = {
    "VIEW":      "#3b82f6",
    "SQL":       "#10b981",
    "CONNECTOR": "#f59e0b",
}
_STORAGE_COLOR = "#8b5cf6"


def render_viz_html(out_dir, project_folder, marts_with_docs, api_origin, source_link=False):
    nodes, edges, bodies, storage_map = [], [], {}, {}
    types_seen = set()

    for mart, doc in marts_with_docs:
        mart_id = mart.get("id", "")
        title = mart.get("title") or mart_id
        definition_type = mart.get("definitionType") or "Data Mart"
        storage = mart.get("storage") or {}
        storage_title = storage.get("title") or ""
        storage_type = storage.get("type") or ""
        description = (mart.get("description") or "").strip()
        short_desc = description.splitlines()[0][:200] if description else ""
        data_url = f"{api_origin}{DATA_NDJSON_PATH.format(id=mart_id)}"
        _, source_bq_url = _source_url(mart) if source_link else (None, None)
        node_id = f"{project_folder}/{slugify(title, mart_id)}"
        tags = ["owox"] + ([storage_type.lower()] if storage_type else []) + ([definition_type.lower()] if definition_type else [])

        types_seen.add(definition_type)
        nodes.append({"data": {
            "id": node_id, "label": title, "type": definition_type,
            "description": short_desc, "resource": source_bq_url or data_url,
            "tags": tags, "color": _TYPE_COLORS.get(definition_type, "#94a3b8"), "size": 32,
        }})
        bodies[node_id] = doc

        if storage_title and storage_title not in storage_map:
            storage_id = f"storage/{slugify(storage_title, 'storage')}"
            storage_map[storage_title] = storage_id
            nodes.append({"data": {
                "id": storage_id, "label": storage_title,
                "type": storage_type or "Storage", "description": "",
                "resource": "", "tags": ["storage"],
                "color": _STORAGE_COLOR, "size": 40,
            }})
            types_seen.add(storage_type or "Storage")
            bodies[storage_id] = ""

        if storage_title:
            edges.append({"data": {"source": node_id, "target": storage_map[storage_title]}})

    bundle = {"nodes": nodes, "edges": edges, "bodies": bodies, "types": sorted(types_seen)}
    html = (
        _VIZ_TEMPLATE
        .replace("OWOX_BUNDLE_NAME", project_folder)
        .replace("OWOX_BUNDLE_JSON", json.dumps(bundle, ensure_ascii=False))
    )
    with open(os.path.join(out_dir, "viz.html"), "w", encoding="utf-8") as fh:
        fh.write(html)


# --------------------------------------------------------------------------- #
# GitHub push (via git CLI)
# --------------------------------------------------------------------------- #
def _parse_repo(repo_str):
    """Split 'owner/name' or 'owner/name/path/to/folder' into (github_repo, subdir).
    The first two slash-delimited segments are always the GitHub repo; everything
    after is treated as the target subdirectory path inside that repo."""
    parts = repo_str.split("/", 2)
    return "/".join(parts[:2]), (parts[2] if len(parts) > 2 else "")


def git_push(bundle_dir, repo, token, branch, commit_msg):
    if not shutil.which("git"):
        raise RuntimeError("git is not on PATH; cannot push.")

    github_repo, subdir = _parse_repo(repo)
    remote = f"https://x-access-token:{token}@github.com/{github_repo}.git"
    work = tempfile.mkdtemp(prefix="okf-push-")
    try:
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
        os.makedirs(target, exist_ok=True)  # create nested dirs if new
        shutil.copytree(bundle_dir, target, dirs_exist_ok=True)

        subprocess.run(["git", "-C", work, "add", "-A"], check=True)
        # Identity (harmless if already configured globally)
        subprocess.run(["git", "-C", work, "config", "user.email", "okf-bot@example.com"], check=True)
        subprocess.run(["git", "-C", work, "config", "user.name", "OKF Export"], check=True)

        if subprocess.run(["git", "-C", work, "diff", "--cached", "--quiet"]).returncode == 0:
            return "No changes to commit — bundle already up to date."
        subprocess.run(["git", "-C", work, "commit", "-q", "-m", commit_msg], check=True)
        subprocess.run(["git", "-C", work, "push", "-u", "origin", branch], check=True)
        return f"Pushed OKF bundle to {repo} ({branch}/{subdir or '.'})."
    finally:
        shutil.rmtree(work, ignore_errors=True)


# --------------------------------------------------------------------------- #
# Orchestration — used by both the CLI and the plugin backend
# --------------------------------------------------------------------------- #
def run_export(config, log=lambda *a, **k: None):
    """Run a full export. `config` keys (all optional unless noted):
        api_key (required), ids, out, sample_rows, shared_only, source_link,
        viz, push, repo, token, branch, commit_msg.
    Returns a structured summary including per-mart metadata and rendered docs."""
    api_key = config.get("api_key")
    if not api_key:
        raise ValueError("OWOX_API_KEY is missing.")

    log("Parsing API key and exchanging for an access token...")
    api_origin, api_key_id, api_key_secret = parse_api_key(api_key)
    token = exchange_for_token(api_origin, api_key_id, api_key_secret)
    headers = auth_headers(token, api_key_id)
    project_title = project_title_from_token(token)
    project_folder = slugify(project_title, "data-marts")
    log(f"  origin: {api_origin}")
    log(f"  project: {project_title or '(unknown)'} → folder: {project_folder}")

    skipped = 0
    ids_cfg = (config.get("ids") or "").strip()
    if ids_cfg:
        ids = [i.strip() for i in ids_cfg.split(",") if i.strip()]
    else:
        log("Listing data marts...")
        all_marts = list_data_marts(api_origin, headers)
        if config.get("shared_only", True):
            filtered = [m for m in all_marts if m.get("availableForReporting")]
            skipped = len(all_marts) - len(filtered)
            if skipped:
                log(f"  Skipped {skipped} data mart(s) not available for reporting "
                    f"(set shared_only off to include them).")
            all_marts = filtered
        ids = [m["id"] for m in all_marts]
    log(f"  {len(ids)} data mart(s) to export.")

    source_link = bool(config.get("source_link", False))
    sample_rows = int(config.get("sample_rows") or 0)
    marts_with_docs = []
    for mart_id in ids:
        log(f"Fetching {mart_id} ...")
        mart = get_data_mart(api_origin, headers, mart_id)
        sample = fetch_sample_rows(api_origin, headers, mart_id, sample_rows)
        marts_with_docs.append((mart, render_data_mart_doc(mart, api_origin, sample, source_link)))

    out_dir = config.get("out") or "bundels"
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    count = write_bundle(out_dir, marts_with_docs, project_folder)
    log(f"Wrote OKF bundle to {out_dir}/{project_folder}/ ({count} concept docs).")

    if config.get("viz", True):
        render_viz_html(out_dir, project_folder, marts_with_docs, api_origin, source_link)
        log(f"Wrote viz.html to {out_dir}/viz.html")

    pushed = None
    if config.get("push"):
        repo, gh_token = config.get("repo"), config.get("token")
        if not repo or not gh_token:
            raise ValueError("push requires both repo and token.")
        log(f"Pushing to GitHub {repo} ...")
        pushed = git_push(out_dir, repo, gh_token,
                          config.get("branch", "main"),
                          config.get("commit_msg", "Update OWOX OKF bundle"))
        log(pushed)

    marts, docs = [], {}
    for mart, doc in marts_with_docs:
        mid = mart.get("id", "")
        title = mart.get("title") or mid
        slug = slugify(title, mid)
        marts.append({
            "id": mid, "title": title, "slug": slug,
            "type": mart.get("definitionType") or "",
            "storage": (mart.get("storage") or {}).get("type") or "",
        })
        docs[slug] = doc

    return {
        "api_origin": api_origin, "project": project_title,
        "project_folder": project_folder, "out_dir": out_dir,
        "count": count, "skipped": skipped, "pushed": pushed,
        "marts": marts, "docs": docs,
    }
