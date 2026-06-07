#!/bin/bash
# Hourly weather publish for cron/launchd (no Shortcuts required).
#
# Coordinates are resolved in this order:
#   1. ~/.portfolio-weather-location  (written by publish_from_mac.sh / Shortcuts)
#   2. PORTFOLIO_LAT and PORTFOLIO_LNG in ~/.portfolio-weather-env
#   3. Default Waterloo coordinates (with a warning in the log)
#
# Crontab / launchd should call the installed copy (avoids macOS blocking ~/Documents):
#   0 * * * * "$HOME/.local/portfolio-weather/publish_hourly.sh" >> "$HOME/Library/Logs/portfolio-weather.log" 2>&1
#
# One-time setup: ./scripts/install-weather-scheduler.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HOME/.portfolio-weather-env"
LOCATION_FILE="$HOME/.portfolio-weather-location"
LAST_RUN_FILE="$HOME/.portfolio-weather-last-run-hour"
DEFAULT_LAT="43.47"
DEFAULT_LNG="-80.54"
FORCE_PUBLISH="${FORCE_PUBLISH:-0}"
CURRENT_MINUTE="$(date +"%M")"
CURRENT_HOUR_KEY="$(date +"%Y-%m-%d-%H")"

if [[ "$FORCE_PUBLISH" != "1" && "$CURRENT_MINUTE" != "00" ]]; then
  echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") INFO: Skipping publish at local minute $CURRENT_MINUTE (only runs on the hour while awake)."
  exit 0
fi

if [[ "$FORCE_PUBLISH" != "1" && -f "$LAST_RUN_FILE" ]]; then
  LAST_RUN_HOUR="$(<"$LAST_RUN_FILE")"
  if [[ "$LAST_RUN_HOUR" == "$CURRENT_HOUR_KEY" ]]; then
    echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") INFO: Already published this hour ($CURRENT_HOUR_KEY); skipping duplicate run."
    exit 0
  fi
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") ERROR: Missing $ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

LAT=""
LNG=""

if [[ -f "$LOCATION_FILE" ]]; then
  # shellcheck disable=SC1090
  read -r LAT LNG < "$LOCATION_FILE" || true
fi

if [[ -z "$LAT" || -z "$LNG" ]]; then
  LAT="${PORTFOLIO_LAT:-}"
  LNG="${PORTFOLIO_LNG:-}"
fi

if [[ -z "$LAT" || -z "$LNG" ]]; then
  LAT="$DEFAULT_LAT"
  LNG="$DEFAULT_LNG"
  echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") WARN: Using default Waterloo coordinates. Set PORTFOLIO_LAT/LNG in $ENV_FILE or run publish_from_mac.sh once with GPS." >&2
fi

echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") INFO: Publishing weather for lat=$LAT lng=$LNG"
python3 "$SCRIPT_DIR/publish_location_weather.py" --lat "$LAT" --lng "$LNG"
printf '%s\n' "$CURRENT_HOUR_KEY" > "$LAST_RUN_FILE"
chmod 600 "$LAST_RUN_FILE"
