#!/usr/bin/env python3
"""export.py — CLI for the OKF export engine (backend/engine.py).

Export OWOX Data Marts to an Open Knowledge Format (OKF) bundle, and optionally
push it to a GitHub repo. The same engine powers the OWOX plugin backend.

Configure credentials in a .env file next to this script (see .env.example), or
pass flags. Run `python3 export.py --help` for all options.
Dependencies: Python 3.8+ standard library only. `git` on PATH is needed for --push."""

import argparse
import os

from backend import engine


def _load_dotenv():
    """Load KEY=VALUE pairs from a .env file next to this script into os.environ.
    Existing env vars are never overwritten (shell always wins over .env)."""
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.isfile(env_path):
        return
    with open(env_path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def _validate_config(args, p):
    errors = []

    if not args.api_key:
        errors.append(
            "OWOX_API_KEY is missing.\n"
            "  Open .env and paste your key next to OWOX_API_KEY=\n"
            "  (Get it in OWOX: Project Settings → My API Keys → Create API Key)"
        )
    elif not args.api_key.strip().startswith("owox_key_"):
        errors.append(
            f"OWOX_API_KEY looks wrong — it must start with 'owox_key_' (got: '{args.api_key[:20]}...').\n"
            "  Make sure you copied the full key from OWOX."
        )

    if args.push:
        if not args.token:
            errors.append(
                "GITHUB_TOKEN is missing.\n"
                "  Open .env and paste your token next to GITHUB_TOKEN=\n"
                "  (Create one at GitHub → Settings → Developer settings → Personal access tokens)"
            )
        elif not (args.token.startswith("ghp_") or args.token.startswith("github_pat_")):
            errors.append(
                f"GITHUB_TOKEN looks wrong — expected it to start with 'ghp_' or 'github_pat_' "
                f"(got: '{args.token[:12]}...').\n"
                "  Make sure you copied the full token from GitHub."
            )

        if not args.repo:
            errors.append(
                "GITHUB_REPO is missing.\n"
                "  Open .env and set GITHUB_REPO=your-org/your-repo-name\n"
                "  To place the bundle in a subfolder: your-org/your-repo-name/path/to/folder"
            )
        else:
            github_repo, _ = engine._parse_repo(args.repo)
            parts = github_repo.split("/")
            if len(parts) != 2 or not parts[0] or not parts[1]:
                errors.append(
                    f"GITHUB_REPO must start with 'owner/repo-name' (got: '{args.repo}').\n"
                    "  Example: acme-corp/data-catalog\n"
                    "  With subfolder: acme-corp/data-catalog/okf/my-bundle"
                )

    if errors:
        msg = "\n\n".join(f"  ✗ {e}" for e in errors)
        p.error(f"\n\nConfiguration error(s) found:\n\n{msg}\n")


def main():
    _load_dotenv()
    p = argparse.ArgumentParser(description="Export OWOX data marts to an OKF bundle.")
    p.add_argument("--api-key", default=os.environ.get("OWOX_API_KEY"),
                   help="OWOX API key (owox_key_...). Defaults to $OWOX_API_KEY.")
    p.add_argument("--ids", default="", help="Comma-separated data-mart IDs (default: all).")
    p.add_argument("--out", default="bundels", help="Output directory (default: bundels).")
    p.add_argument("--sample-rows", type=int, default=0,
                   help="Embed first N rows as preview per mart (default: 0 = none).")
    # default true unless SHARED_ONLY=false
    _shared_default = os.environ.get("SHARED_ONLY", "true").lower() != "false"
    p.add_argument("--shared-only", dest="shared_only", action="store_true", default=_shared_default,
                   help="Export only data marts available for reporting (default: on).")
    p.add_argument("--no-shared-only", dest="shared_only", action="store_false",
                   help="Export all data marts regardless of reporting availability.")
    # Resource link mode
    _sl_default = os.environ.get("SOURCE_LINK", "false").lower() == "true"
    p.add_argument("--source-link", dest="source_link", action="store_true", default=_sl_default,
                   help="Set resource link to the underlying warehouse table/view ($SOURCE_LINK).")
    p.add_argument("--no-source-link", dest="source_link", action="store_false",
                   help="Set resource link to the OWOX data endpoint (default).")
    # Viz
    _viz_default = os.environ.get("VIZ", "true").lower() != "false"
    p.add_argument("--viz", dest="viz", action="store_true", default=_viz_default,
                   help="Generate viz.html interactive knowledge graph (default: on, $VIZ).")
    p.add_argument("--no-viz", dest="viz", action="store_false",
                   help="Skip viz.html generation.")
    # GitHub
    p.add_argument("--push", action="store_true", help="Push the bundle to GitHub.")
    p.add_argument("--repo", default=os.environ.get("GITHUB_REPO"),
                   help="Target as owner/repo-name or owner/repo-name/path/to/folder ($GITHUB_REPO).")
    p.add_argument("--token", default=os.environ.get("GITHUB_TOKEN"), help="GitHub token ($GITHUB_TOKEN).")
    p.add_argument("--branch", default="main", help="Branch to push (default: main).")
    p.add_argument("--commit-msg", default="Update OWOX OKF bundle", help="Commit message.")
    args = p.parse_args()

    _validate_config(args, p)

    try:
        engine.run_export({
            "api_key": args.api_key, "ids": args.ids, "out": args.out,
            "sample_rows": args.sample_rows, "shared_only": args.shared_only,
            "source_link": args.source_link, "viz": args.viz,
            "push": args.push, "repo": args.repo, "token": args.token,
            "branch": args.branch, "commit_msg": args.commit_msg,
        }, log=print)
    except (ValueError, RuntimeError) as e:
        p.error(str(e))


if __name__ == "__main__":
    main()
