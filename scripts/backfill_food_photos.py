#!/usr/bin/env python3
"""
Upload a folder of exported Food album photos through the ingest-food-photo
Edge Function. Use it once to backfill the album, and again whenever you want
to test the pipeline from a Mac. Re-running is safe: photos that are already
synced come back as duplicates.

Each photo is prepared locally before it is sent: HEIC is converted to JPEG,
the EXIF rotation is applied, the long edge is capped at 2048 px, and all EXIF
data (including GPS) is removed. The capture time is read from EXIF first and
sent as taken_at.

Usage:
  python3 scripts/backfill_food_photos.py ~/Desktop/food-export
  python3 scripts/backfill_food_photos.py ~/Desktop/food-export --dry-run

Requires:
  pip install pillow pillow-heif      (pillow-heif is only needed for .heic files)

Required env vars:
  FOOD_INGEST_SECRET    same value as the Edge Function secret

Optional env vars (default to the values in weather-config.js):
  SUPABASE_URL
  SUPABASE_ANON_KEY
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib import error, request

try:
    from PIL import Image, ImageOps
except ImportError:
    print("Pillow is required: pip install pillow pillow-heif", file=sys.stderr)
    raise SystemExit(1)

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
    HEIF_SUPPORTED = True
except ImportError:
    HEIF_SUPPORTED = False

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FUNCTION_PATH = "/functions/v1/ingest-food-photo"
HEIF_EXTENSIONS = {".heic", ".heif"}
PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"} | HEIF_EXTENSIONS
MAX_LONG_EDGE = 2048
JPEG_QUALITY = 90

EXIF_IFD = 0x8769
# (timestamp tag, matching UTC-offset tag), most trustworthy first.
EXIF_DATE_TAGS = (
    (0x9003, 0x9011),  # DateTimeOriginal, OffsetTimeOriginal
    (0x9004, 0x9012),  # DateTimeDigitized, OffsetTimeDigitized
)
EXIF_OFFSET = re.compile(r"^([+-])(\d{2}):?(\d{2})$")


def read_site_config(name: str) -> str:
    """Read a window.<name> = "..." value from weather-config.js."""
    try:
        source = (PROJECT_ROOT / "weather-config.js").read_text(encoding="utf-8")
    except OSError:
        return ""
    match = re.search(rf'window\.{name}\s*=\s*"([^"]*)"', source)
    return match.group(1) if match else ""


def read_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill Food album photos into Supabase.")
    parser.add_argument("folder", help="Folder of exported photos (searched recursively)")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be uploaded without sending anything",
    )
    return parser.parse_args()


def find_photos(folder: Path) -> list[Path]:
    return sorted(
        path
        for path in folder.rglob("*")
        if path.is_file()
        and path.suffix.lower() in PHOTO_EXTENSIONS
        and not path.name.startswith(".")
    )


def parse_exif_offset(value: object) -> timezone | None:
    match = EXIF_OFFSET.match(str(value).strip()) if value else None
    if not match:
        return None
    sign = -1 if match.group(1) == "-" else 1
    return timezone(sign * timedelta(hours=int(match.group(2)), minutes=int(match.group(3))))


def read_taken_at(image: Image.Image, path: Path) -> tuple[datetime, str]:
    """Return the capture time and where it came from ("exif" or "file date")."""
    exif = image.getexif()
    exif_ifd = exif.get_ifd(EXIF_IFD)
    for date_tag, offset_tag in EXIF_DATE_TAGS:
        raw = str(exif_ifd.get(date_tag) or "").strip().rstrip("\x00")
        try:
            naive = datetime.strptime(raw, "%Y:%m:%d %H:%M:%S")
        except ValueError:
            continue
        offset = parse_exif_offset(exif_ifd.get(offset_tag))
        if offset:
            return naive.replace(tzinfo=offset), "exif"
        # EXIF without an offset is local time; assume this Mac's timezone.
        return naive.astimezone(), "exif"

    return datetime.fromtimestamp(path.stat().st_mtime).astimezone(), "file date"


def prepare_jpeg(image: Image.Image) -> bytes:
    """Rotate upright, cap the size and re-encode without EXIF/GPS."""
    icc_profile = image.info.get("icc_profile")
    upright = ImageOps.exif_transpose(image)
    if upright.mode != "RGB":
        upright = upright.convert("RGB")
    upright.thumbnail((MAX_LONG_EDGE, MAX_LONG_EDGE), Image.Resampling.LANCZOS)

    buffer = io.BytesIO()
    save_options = {"icc_profile": icc_profile} if icc_profile else {}
    upright.save(buffer, format="JPEG", quality=JPEG_QUALITY, **save_options)
    return buffer.getvalue()


def encode_multipart(fields: dict[str, str], filename: str, file_bytes: bytes) -> tuple[bytes, str]:
    boundary = f"----food-backfill-{uuid.uuid4().hex}"
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )
    parts.append(
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
            f'filename="{filename}"\r\nContent-Type: image/jpeg\r\n\r\n'
        ).encode()
    )
    parts.append(file_bytes)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def upload(url: str, anon_key: str, secret: str, fields: dict[str, str], jpeg: bytes) -> str:
    """POST one photo. Returns "inserted" or "duplicate"; raises RuntimeError otherwise."""
    body, content_type = encode_multipart(fields, "photo.jpg", jpeg)
    req = request.Request(
        url,
        method="POST",
        data=body,
        headers={
            "Content-Type": content_type,
            "Authorization": f"Bearer {anon_key}",
            "x-food-ingest-secret": secret,
        },
    )
    try:
        with request.urlopen(req, timeout=120) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {details}") from exc
    except error.URLError as exc:
        raise RuntimeError(str(exc.reason)) from exc
    except (TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError(str(exc) or type(exc).__name__) from exc

    status = payload.get("status") if isinstance(payload, dict) else None
    if status not in ("inserted", "duplicate"):
        raise RuntimeError(f"Unexpected response: {payload}")
    return status


def main() -> int:
    args = read_args()
    folder = Path(args.folder).expanduser()
    if not folder.is_dir():
        print(f"Not a folder: {folder}", file=sys.stderr)
        return 1

    photos = find_photos(folder)
    if not photos:
        print(f"No photos found in {folder}", file=sys.stderr)
        return 1
    if not HEIF_SUPPORTED and any(path.suffix.lower() in HEIF_EXTENSIONS for path in photos):
        print(
            "This folder has HEIC photos. Install support first: pip install pillow-heif",
            file=sys.stderr,
        )
        return 1

    ingest_secret = os.environ.get("FOOD_INGEST_SECRET", "")
    supabase_url = (
        os.environ.get("SUPABASE_URL") or read_site_config("PORTFOLIO_SUPABASE_URL")
    ).rstrip("/")
    anon_key = os.environ.get("SUPABASE_ANON_KEY") or read_site_config("PORTFOLIO_SUPABASE_ANON_KEY")

    if not args.dry_run:
        missing = [
            name
            for name, value in (
                ("FOOD_INGEST_SECRET", ingest_secret),
                ("SUPABASE_URL", supabase_url),
                ("SUPABASE_ANON_KEY", anon_key),
            )
            if not value
        ]
        if missing:
            print(f"Missing required environment variables: {', '.join(missing)}", file=sys.stderr)
            return 1

    counts = {"inserted": 0, "duplicate": 0, "failed": 0}
    for index, path in enumerate(photos, start=1):
        label = f"[{index}/{len(photos)}] {path.relative_to(folder)}"
        try:
            original = path.read_bytes()
            with Image.open(io.BytesIO(original)) as image:
                taken_at, date_source = read_taken_at(image, path)
                jpeg = prepare_jpeg(image)
        except Exception as exc:  # unreadable or corrupt file: report it and keep going
            counts["failed"] += 1
            print(f"{label}: FAILED to read ({exc})", file=sys.stderr)
            continue

        taken_label = f"taken {taken_at.isoformat(timespec='seconds')} ({date_source})"
        if args.dry_run:
            print(f"{label}: would upload {len(jpeg) // 1024} KB, {taken_label}")
            continue

        fields = {
            "taken_at": taken_at.isoformat(timespec="seconds"),
            # Hash of the untouched original, so a re-run dedupes even if the
            # JPEG conversion above produces different bytes next time.
            "photo_hash": hashlib.sha256(original).hexdigest(),
        }
        try:
            status = upload(f"{supabase_url}{FUNCTION_PATH}", anon_key, ingest_secret, fields, jpeg)
        except RuntimeError as exc:
            counts["failed"] += 1
            print(f"{label}: FAILED ({exc})", file=sys.stderr)
            continue
        counts[status] += 1
        print(f"{label}: {status}, {taken_label}")

    if args.dry_run:
        print(f"\nDry run: {len(photos) - counts['failed']} photos ready, {counts['failed']} unreadable.")
    else:
        print(
            f"\nDone: {counts['inserted']} inserted, {counts['duplicate']} duplicate, "
            f"{counts['failed']} failed."
        )
    return 1 if counts["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
