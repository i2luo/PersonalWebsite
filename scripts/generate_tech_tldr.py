#!/usr/bin/env python3
"""
Generate the Daily Tech TL;DR: grab the top Hacker News story, summarize it in a
random celebrity persona with Gemini, narrate it with ElevenLabs, upload the MP3
to Supabase Storage, and upsert the payload row the website reads.

Designed to run on weekdays only (Mon-Fri) to stay inside the ElevenLabs free
tier (~350 chars/day * ~23 weekdays ~= 8k chars/month).

Usage:
  python3 scripts/generate_tech_tldr.py            # skips weekends
  python3 scripts/generate_tech_tldr.py --force    # run regardless of weekday

Required env vars:
  SUPABASE_URL                 e.g. https://xxxx.supabase.co
  SUPABASE_SERVICE_ROLE_KEY    service role key (write access, keep secret)
  GEMINI_API_KEY               Google AI Studio key (Gemini 2.5 Flash)
  ELEVENLABS_API_KEY           ElevenLabs API key

Optional env vars:
  TECH_TLDR_BUCKET             storage bucket name (default: tech-tldr-audio)
  TECH_TLDR_PERSONAS           JSON array of {"name", "voice_id"} to override
                               the built-in persona list.
  ELEVENLABS_MODEL_ID          default: eleven_multilingual_v2
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from datetime import datetime, timezone
from urllib import error, request

HN_TOPSTORIES = "https://hacker-news.firebaseio.com/v0/topstories.json"
HN_ITEM = "https://hacker-news.firebaseio.com/v0/item/{id}.json"
GEMINI_ENDPOINT = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-2.5-flash:generateContent"
)
ELEVENLABS_TTS = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"

MAX_SUMMARY_CHARS = 350

# Known-good default voice every free ElevenLabs account can synthesize. Used as
# the safety net when a persona's voice_id is rejected with HTTP 402 (a premium
# / Voice Library voice that this plan can't use). A run should never die on
# voice selection alone, so we always have this to fall back to.
FALLBACK_VOICE = {"name": "Arnold", "voice_id": "VR6AewLTigWG4xSOukaG"}

# Persona name (drives the Gemini writing style) -> ElevenLabs voice_id.
# The voice_ids below are real ElevenLabs default ("premade") voices that free
# accounts can synthesize, so the script stays at $0 out of the box. To confirm
# which ids YOUR key can actually use, run:
#   ELEVENLABS_API_KEY=sk_xxx python3 scripts/list_elevenlabs_voices.py
# then lock this list (or the TECH_TLDR_PERSONAS env var) to those ids. If any
# voice still gets rejected with HTTP 402, synthesis falls back to FALLBACK_VOICE.
DEFAULT_PERSONAS = [
    {"name": "Gordon Ramsay", "voice_id": "VR6AewLTigWG4xSOukaG"},      # Arnold
    {"name": "David Attenborough", "voice_id": "pNInz6obpgDQGcFmaJgB"}, # Adam
    {"name": "Snoop Dogg", "voice_id": "TxGEqnHWrfWFTfGW9XjX"},         # Josh
    {"name": "Morgan Freeman", "voice_id": "ErXwobaYiN019PkySvjV"},     # Antoni
    {"name": "Oprah Winfrey", "voice_id": "EXAVITQu4vr4xnSDxMaL"},      # Bella
    {"name": "Sir Patrick Stewart", "voice_id": "21m00Tcm4TlvDq8ikWAM"},  # Rachel
]

SYSTEM_PROMPT = (
    "You are a creative writer summarizing tech news. Summarize the following "
    "news article title into a single, highly engaging paragraph written "
    "explicitly in the distinct voice, slang, rhythms, and personality of "
    "{persona}.\n"
    "CRITICAL RESTRAINT: The entire paragraph summary must be under 55 words "
    "(maximum 350 characters including spaces). Do not exceed this boundary "
    "under any circumstances so it fits the audio synthesis budget. Output only "
    "the paragraph, no preamble.\n\n"
    "Article title: {title}\n"
    "Article URL: {url}"
)


def http_get_json(url: str, headers: dict | None = None) -> dict | list:
    req = request.Request(url, method="GET", headers=headers or {})
    with request.urlopen(req, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def http_post_json(url: str, payload: dict, headers: dict) -> dict:
    req = request.Request(
        url,
        method="POST",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers},
    )
    with request.urlopen(req, timeout=60) as response:
        body = response.read().decode("utf-8")
        return json.loads(body) if body else {}


def normalize_supabase_url(url: str) -> str:
    """Return the project base URL, tolerating a trailing slash or /rest/v1.

    Storage and REST paths are appended by this script, so the env value must be
    the bare project URL (e.g. https://xxxx.supabase.co).
    """
    cleaned = url.strip().rstrip("/")
    if cleaned.lower().endswith("/rest/v1"):
        cleaned = cleaned[: -len("/rest/v1")]
    return cleaned.rstrip("/")


def load_personas() -> list[dict]:
    raw = os.environ.get("TECH_TLDR_PERSONAS", "").strip()
    if not raw:
        return DEFAULT_PERSONAS
    try:
        parsed = json.loads(raw)
        personas = [
            p for p in parsed
            if isinstance(p, dict) and p.get("name") and p.get("voice_id")
        ]
        return personas or DEFAULT_PERSONAS
    except json.JSONDecodeError:
        print("Warning: TECH_TLDR_PERSONAS is not valid JSON; using defaults.", file=sys.stderr)
        return DEFAULT_PERSONAS


def fetch_top_story() -> dict:
    top_ids = http_get_json(HN_TOPSTORIES)
    if not isinstance(top_ids, list) or not top_ids:
        raise RuntimeError("Hacker News returned no top stories.")

    # Walk the top of the list until we find a story with a title.
    for story_id in top_ids[:10]:
        item = http_get_json(HN_ITEM.format(id=story_id))
        if isinstance(item, dict) and item.get("title"):
            return {
                "id": story_id,
                "title": item["title"].strip(),
                "url": item.get("url")
                or f"https://news.ycombinator.com/item?id={story_id}",
            }
    raise RuntimeError("Could not find a usable Hacker News story.")


def generate_summary(title: str, url: str, persona: str, gemini_key: str) -> str:
    prompt = SYSTEM_PROMPT.format(persona=persona, title=title, url=url)
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.9,
            "maxOutputTokens": 256,
            # gemini-2.5-flash spends output tokens on hidden "thinking" by
            # default, which can starve the actual answer. Disable it.
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }

    # Gemini's free tier returns transient 503/429s under load; retry briefly.
    url = f"{GEMINI_ENDPOINT}?key={gemini_key}"
    attempts = 4
    for attempt in range(1, attempts + 1):
        try:
            data = http_post_json(url, payload, headers={})
            break
        except error.HTTPError as exc:
            if exc.code in (429, 500, 503) and attempt < attempts:
                wait = 2 ** attempt
                print(
                    f"Gemini returned {exc.code}; retrying in {wait}s "
                    f"(attempt {attempt}/{attempts - 1}).",
                    file=sys.stderr,
                )
                time.sleep(wait)
                continue
            raise
    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"Unexpected Gemini response: {json.dumps(data)[:500]}") from exc

    if not text:
        raise RuntimeError("Gemini returned an empty summary.")

    # Hard cap so we never blow the ElevenLabs character budget.
    if len(text) > MAX_SUMMARY_CHARS:
        clipped = text[:MAX_SUMMARY_CHARS]
        last_space = clipped.rfind(" ")
        text = (clipped[:last_space] if last_space > 0 else clipped).rstrip() + "..."
    return text


def synthesize_audio(text: str, voice_id: str, api_key: str) -> bytes:
    """Synthesize one voice, retrying only transient (429/5xx) failures.

    Raises the HTTPError for any non-transient status (e.g. 402) so the caller
    can decide whether to fall back to another voice.
    """
    model_id = os.environ.get("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2")
    payload = {
        "text": text,
        "model_id": model_id,
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
    }
    attempts = 4
    for attempt in range(1, attempts + 1):
        req = request.Request(
            ELEVENLABS_TTS.format(voice_id=voice_id),
            method="POST",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "xi-api-key": api_key,
                "Content-Type": "application/json",
                "Accept": "audio/mpeg",
            },
        )
        try:
            with request.urlopen(req, timeout=120) as response:
                return response.read()
        except error.HTTPError as exc:
            if exc.code in (429, 500, 502, 503) and attempt < attempts:
                wait = 2 ** attempt
                print(
                    f"ElevenLabs returned {exc.code} for voice {voice_id}; "
                    f"retrying in {wait}s (attempt {attempt}/{attempts - 1}).",
                    file=sys.stderr,
                )
                time.sleep(wait)
                continue
            raise
    raise RuntimeError("Exhausted ElevenLabs synthesis retries.")


def synthesize_with_fallback(
    text: str, persona: dict, api_key: str
) -> tuple[bytes, str]:
    """Try the persona's voice; on HTTP 402 fall back to FALLBACK_VOICE.

    A 402 means the voice isn't usable on this plan (premium / Voice Library).
    Rather than fail the whole run, we narrate with a known-good default voice.
    Returns (audio_bytes, voice_name_used) so callers can note the substitution.
    """
    voice_id = persona["voice_id"]
    try:
        return synthesize_audio(text, voice_id, api_key), persona["name"]
    except error.HTTPError as exc:
        if exc.code == 402 and voice_id != FALLBACK_VOICE["voice_id"]:
            print(
                f"Voice {voice_id} ({persona['name']}) rejected with HTTP 402 "
                f"(not usable on this plan); falling back to "
                f"{FALLBACK_VOICE['name']}.",
                file=sys.stderr,
            )
            audio = synthesize_audio(
                text, FALLBACK_VOICE["voice_id"], api_key
            )
            return audio, FALLBACK_VOICE["name"]
        raise


def upload_audio(
    supabase_url: str, bucket: str, object_path: str, audio: bytes, service_key: str
) -> str:
    upload_url = f"{supabase_url}/storage/v1/object/{bucket}/{object_path}"
    req = request.Request(
        upload_url,
        method="POST",
        data=audio,
        headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "audio/mpeg",
            "x-upsert": "true",
            "Cache-Control": "max-age=86400",
        },
    )
    with request.urlopen(req, timeout=60):
        pass
    return f"{supabase_url}/storage/v1/object/public/{bucket}/{object_path}"


def delete_object(supabase_url: str, bucket: str, object_path: str, service_key: str) -> None:
    req = request.Request(
        f"{supabase_url}/storage/v1/object/{bucket}/{object_path}",
        method="DELETE",
        headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
        },
    )
    with request.urlopen(req, timeout=30):
        pass


def check_public_read(public_url: str) -> int:
    req = request.Request(public_url, method="GET")
    with request.urlopen(req, timeout=30) as response:
        response.read()
        return response.status


def upsert_row(supabase_url: str, row: dict, service_key: str) -> None:
    http_post_json(
        f"{supabase_url}/rest/v1/portfolio_tech_tldr",
        row,
        headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )


def describe_http_error(exc: error.HTTPError) -> str:
    details = exc.read().decode("utf-8", errors="replace")
    return f"HTTP {exc.code}: {details[:500]}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the Daily Tech TL;DR.")
    parser.add_argument(
        "--force", action="store_true", help="Run even on weekends."
    )
    parser.add_argument(
        "--skip-tts",
        action="store_true",
        help=(
            "Validate the whole pipeline EXCEPT ElevenLabs synthesis. Tests "
            "Gemini, Supabase Storage upload/public-read/delete, and the table "
            "write without spending any character budget."
        ),
    )
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    # Monday=0 ... Sunday=6
    if now.weekday() >= 5 and not args.force:
        print("Weekend detected; skipping generation to save the character budget.")
        return 0

    supabase_url = normalize_supabase_url(os.environ.get("SUPABASE_URL", ""))
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    gemini_key = os.environ.get("GEMINI_API_KEY", "")
    elevenlabs_key = os.environ.get("ELEVENLABS_API_KEY", "")
    bucket = os.environ.get("TECH_TLDR_BUCKET", "tech-tldr-audio")

    required = [
        ("SUPABASE_URL", supabase_url),
        ("SUPABASE_SERVICE_ROLE_KEY", service_key),
        ("GEMINI_API_KEY", gemini_key),
    ]
    if not args.skip_tts:
        required.append(("ELEVENLABS_API_KEY", elevenlabs_key))

    missing = [name for name, value in required if not value]
    if missing:
        print(f"Missing required env vars: {', '.join(missing)}", file=sys.stderr)
        return 1

    story_date = now.date().isoformat()

    try:
        story = fetch_top_story()
        print(f"[1/5] Hacker News top story: {story['title']}")

        persona = random.choice(load_personas())
        print(f"[2/5] Persona: {persona['name']}")

        summary = generate_summary(
            story["title"], story["url"], persona["name"], gemini_key
        )
        print(f"[3/5] Gemini summary ({len(summary)} chars): {summary}")

        if args.skip_tts:
            # Validate Supabase Storage (write -> public read -> delete) with a
            # throwaway object, then write the row without an audio URL.
            probe_path = f"selftest-{story_date}.txt"
            probe_url = upload_audio(
                supabase_url, bucket, probe_path, b"tech-tldr storage self-test", service_key
            )
            print(f"[4/5] Storage upload OK -> {probe_url}")
            status = check_public_read(probe_url)
            print(f"      Public read OK (HTTP {status})")
            delete_object(supabase_url, bucket, probe_path, service_key)
            print("      Cleanup OK (probe object deleted)")
            audio_url = None
        else:
            audio, voice_used = synthesize_with_fallback(
                summary, persona, elevenlabs_key
            )
            note = "" if voice_used == persona["name"] else f" (voice: {voice_used})"
            print(f"[4/5] Synthesized {len(audio)} bytes of audio{note}.")
            object_path = f"top-story-{story_date}.mp3"
            audio_url = upload_audio(supabase_url, bucket, object_path, audio, service_key)
            print(f"      Uploaded audio: {audio_url}")

        upsert_row(
            supabase_url,
            {
                "story_date": story_date,
                "headline": story["title"],
                "persona": persona["name"],
                "summary": summary,
                "audio_url": audio_url,
                "source_url": story["url"],
                "created_at": now.isoformat(),
            },
            service_key,
        )
        suffix = " (audio skipped)" if args.skip_tts else ""
        print(f"[5/5] Published Tech TL;DR row for {story_date}{suffix}.")
        return 0
    except error.HTTPError as exc:
        print(f"Generation failed: {describe_http_error(exc)}", file=sys.stderr)
        return 1
    except (error.URLError, RuntimeError) as exc:
        print(f"Generation failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
