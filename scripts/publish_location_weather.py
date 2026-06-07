#!/usr/bin/env python3
"""
Publish current city weather to Supabase for portfolio display.

Usage:
  python3 scripts/publish_location_weather.py --lat 43.47 --lng -80.54

Required env vars:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from urllib import parse, request


def fetch_json(url: str) -> dict:
    req = request.Request(url, method="GET")
    with request.urlopen(req, timeout=15) as response:
        data = response.read().decode("utf-8")
        return json.loads(data)


def post_json(url: str, payload: list[dict], service_role_key: str) -> dict:
    req = request.Request(
        url,
        method="POST",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
            "Prefer": "resolution=merge-duplicates,return=representation",
        },
    )
    try:
        with request.urlopen(req, timeout=15) as response:
            body = response.read().decode("utf-8")
            return json.loads(body) if body else {}
    except request.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        setattr(error, "details_text", details)
        print(f"Supabase upsert failed ({error.code}): {details}", file=sys.stderr)
        raise


def weather_label_from_code(code: int | None) -> str:
    labels = {
        0: "Clear sky",
        1: "Mainly clear",
        2: "Partly cloudy",
        3: "Overcast",
        45: "Fog",
        48: "Depositing rime fog",
        51: "Light drizzle",
        53: "Moderate drizzle",
        55: "Dense drizzle",
        56: "Light freezing drizzle",
        57: "Dense freezing drizzle",
        61: "Slight rain",
        63: "Moderate rain",
        65: "Heavy rain",
        66: "Light freezing rain",
        67: "Heavy freezing rain",
        71: "Slight snow fall",
        73: "Moderate snow fall",
        75: "Heavy snow fall",
        77: "Snow grains",
        80: "Slight rain showers",
        81: "Moderate rain showers",
        82: "Violent rain showers",
        85: "Slight snow showers",
        86: "Heavy snow showers",
        95: "Thunderstorm",
        96: "Thunderstorm with hail",
        99: "Thunderstorm with heavy hail",
    }
    return labels.get(code, "Weather update available")


def read_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Publish current city weather to Supabase.")
    parser.add_argument("--lat", type=float, required=True, help="Latitude")
    parser.add_argument("--lng", type=float, required=True, help="Longitude")
    return parser.parse_args()


def main() -> int:
    args = read_args()
    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

    if not supabase_url or not service_role_key:
        print(
            "Missing required environment variables: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
            file=sys.stderr,
        )
        return 1

    lat = args.lat
    lng = args.lng

    weather_url = (
        "https://api.open-meteo.com/v1/forecast?"
        + parse.urlencode(
            {
                "latitude": lat,
                "longitude": lng,
                "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
                "temperature_unit": "celsius",
                "wind_speed_unit": "kmh",
                "timezone": "auto",
            }
        )
    )
    geocode_url = (
        "https://api-bdc.io/data/reverse-geocode-client?"
        + parse.urlencode(
            {
                "latitude": lat,
                "longitude": lng,
                "localityLanguage": "en",
            }
        )
    )

    weather_data = fetch_json(weather_url)
    geocode_data = fetch_json(geocode_url)
    current = weather_data.get("current")
    if not current:
        print("Open-Meteo response did not include current weather data.", file=sys.stderr)
        return 1

    city = geocode_data.get("city") or geocode_data.get("locality") or "Unknown city"
    region = geocode_data.get("principalSubdivision") or ""
    country = geocode_data.get("countryName") or ""
    weather_code = current.get("weather_code")
    temperature_c = current.get("temperature_2m")
    feels_like_c = current.get("apparent_temperature")
    wind_kmh = current.get("wind_speed_10m")
    weather_timezone = (weather_data.get("timezone") or "").strip()
    if temperature_c is None or feels_like_c is None or wind_kmh is None:
        print("Open-Meteo response missing required numeric fields.", file=sys.stderr)
        return 1

    payload = [
        {
            "id": 1,
            "city": city,
            "region": region,
            "country": country,
            "temperature_c": temperature_c,
            "feels_like_c": feels_like_c,
            "wind_kmh": wind_kmh,
            "weather_code": weather_code,
            "weather_summary": weather_label_from_code(weather_code),
            "weather_timezone": weather_timezone,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
    ]

    upsert_url = f"{supabase_url}/rest/v1/portfolio_weather_current"
    try:
        post_json(upsert_url, payload, service_role_key)
    except request.HTTPError as error:
        details = getattr(error, "details_text", "")
        missing_timezone_column = (
            error.code == 400
            and "weather_timezone" in details
            and "PGRST204" in details
        )
        if not missing_timezone_column:
            raise
        print(
            "Warning: weather_timezone column is not in Supabase yet. "
            "Publishing weather without timezone until setup.sql is applied.",
            file=sys.stderr,
        )
        legacy_payload = [{k: v for k, v in payload[0].items() if k != "weather_timezone"}]
        post_json(upsert_url, legacy_payload, service_role_key)

    # Remember coordinates for Supabase hourly refresh (not exposed to website visitors).
    config_url = f"{supabase_url}/rest/v1/portfolio_weather_private_config"
    try:
        post_json(
            config_url,
            [
                {
                    "id": 1,
                    "latitude": lat,
                    "longitude": lng,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            ],
            service_role_key,
        )
    except request.HTTPError:
        print(
            "Warning: weather published but coordinate config was not saved. "
            "Run supabase/setup.sql in the SQL Editor.",
            file=sys.stderr,
        )

    print(f"Published weather for {city}, {region}, {country}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
