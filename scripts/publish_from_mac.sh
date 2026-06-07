#!/bin/bash
# Publish portfolio weather to Supabase using lat/lng arguments.
#
# Usage:
#   ./scripts/publish_from_mac.sh 43.47 -80.54
#
# Requires: ~/.portfolio-weather-env with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HOME/.portfolio-weather-env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  echo "Create it with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY exports." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

LAT="${1:-}"
LNG="${2:-}"

if [[ -z "$LAT" || -z "$LNG" ]]; then
  echo "Usage: $0 <latitude> <longitude>" >&2
  exit 1
fi

python3 "$SCRIPT_DIR/publish_location_weather.py" --lat "$LAT" --lng "$LNG"

# Remember last successful coordinates for hourly cron jobs.
LOCATION_FILE="$HOME/.portfolio-weather-location"
printf '%s %s\n' "$LAT" "$LNG" > "$LOCATION_FILE"
chmod 600 "$LOCATION_FILE"
