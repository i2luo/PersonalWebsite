#!/usr/bin/env python3
"""List the ElevenLabs voices your API key can actually use.

The Daily Tech TL;DR only stays at $0 if every persona maps to a voice your
plan is allowed to synthesize. Premium / Voice Library voices that need a paid
plan return HTTP 402 at synthesis time, which can kill an otherwise-fine run.

Run this locally with your key to see the usable voice_ids on your account,
then lock DEFAULT_PERSONAS in scripts/generate_tech_tldr.py to those ids.

Usage:
  ELEVENLABS_API_KEY=sk_xxx python3 scripts/list_elevenlabs_voices.py

Optional:
  --json    Also print a ready-to-paste TECH_TLDR_PERSONAS JSON snippet.

This only calls the read-only GET /v1/voices endpoint, so it spends zero
characters of your synthesis budget.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from urllib import error, request

ELEVENLABS_VOICES = "https://api.elevenlabs.io/v1/voices"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="List ElevenLabs voices usable by your API key."
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Also print a TECH_TLDR_PERSONAS JSON snippet you can paste.",
    )
    args = parser.parse_args()

    api_key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not api_key:
        print("Missing ELEVENLABS_API_KEY env var.", file=sys.stderr)
        print(
            "Run as: ELEVENLABS_API_KEY=sk_xxx python3 "
            "scripts/list_elevenlabs_voices.py",
            file=sys.stderr,
        )
        return 1

    req = request.Request(
        ELEVENLABS_VOICES,
        method="GET",
        headers={"xi-api-key": api_key, "Accept": "application/json"},
    )
    try:
        with request.urlopen(req, timeout=30) as response:
            data = json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(f"ElevenLabs returned HTTP {exc.code}: {body[:500]}", file=sys.stderr)
        return 1
    except error.URLError as exc:
        print(f"Could not reach ElevenLabs: {exc}", file=sys.stderr)
        return 1

    voices = data.get("voices", [])
    if not voices:
        print("No voices returned for this account.", file=sys.stderr)
        return 1

    print(f"Usable voices for this account ({len(voices)}):\n")
    print(f"{'voice_id':<24} {'category':<12} name")
    print("-" * 60)
    for v in voices:
        voice_id = v.get("voice_id", "?")
        name = v.get("name", "?")
        category = v.get("category", "?")
        print(f"{voice_id:<24} {category:<12} {name}")

    if args.json:
        snippet = [
            {"name": v.get("name", "?"), "voice_id": v.get("voice_id", "")}
            for v in voices
            if v.get("voice_id")
        ]
        print("\nTECH_TLDR_PERSONAS snippet (edit names to your personas):\n")
        print(json.dumps(snippet, indent=2))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
