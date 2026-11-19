#!/usr/bin/env python3
"""
Publish a workout JSON file to the publish-latest-workout Edge Function.

This sends the same request the phone workflow sends, so it is the quickest way
to test the function and the home page card from a Mac.

Usage:
  python3 scripts/publish_latest_workout.py --file scripts/latest-workout.example.json
  cat workout.json | python3 scripts/publish_latest_workout.py

Required env vars:
  HEVY_PUBLISH_SECRET   same value as the Edge Function secret

Optional env vars (default to the values in weather-config.js):
  SUPABASE_URL
  SUPABASE_ANON_KEY
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from urllib import error, request

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FUNCTION_PATH = "/functions/v1/publish-latest-workout"


def read_site_config(name: str) -> str:
    """Read a window.<name> = "..." value from weather-config.js."""
    try:
        source = (PROJECT_ROOT / "weather-config.js").read_text(encoding="utf-8")
    except OSError:
        return ""
    match = re.search(rf'window\.{name}\s*=\s*"([^"]*)"', source)
    return match.group(1) if match else ""


def read_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Publish the latest workout JSON to Supabase.")
    parser.add_argument("--file", help="Path to a workout JSON file (defaults to stdin)")
    return parser.parse_args()


def main() -> int:
    args = read_args()
    publish_secret = os.environ.get("HEVY_PUBLISH_SECRET", "")
    supabase_url = (
        os.environ.get("SUPABASE_URL") or read_site_config("PORTFOLIO_SUPABASE_URL")
    ).rstrip("/")
    anon_key = os.environ.get("SUPABASE_ANON_KEY") or read_site_config("PORTFOLIO_SUPABASE_ANON_KEY")

    missing = [
        name
        for name, value in (
            ("HEVY_PUBLISH_SECRET", publish_secret),
            ("SUPABASE_URL", supabase_url),
            ("SUPABASE_ANON_KEY", anon_key),
        )
        if not value
    ]
    if missing:
        print(f"Missing required environment variables: {', '.join(missing)}", file=sys.stderr)
        return 1

    try:
        raw = Path(args.file).read_text(encoding="utf-8") if args.file else sys.stdin.read()
        payload = json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Could not read workout JSON: {exc}", file=sys.stderr)
        return 1

    req = request.Request(
        f"{supabase_url}{FUNCTION_PATH}",
        method="POST",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {anon_key}",
            "x-publish-secret": publish_secret,
        },
    )
    try:
        with request.urlopen(req, timeout=20) as response:
            print(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        print(f"Publish failed ({exc.code}): {details}", file=sys.stderr)
        return 1
    except error.URLError as exc:
        print(f"Publish failed: {exc.reason}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
