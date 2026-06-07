#!/bin/bash
# Install hourly portfolio weather updates (launchd + cron-safe path).
#
# macOS blocks cron from executing scripts in ~/Documents ("Operation not permitted").
# This copies publisher files to ~/.local/portfolio-weather and registers a LaunchAgent.
#
# Usage: ./scripts/install-weather-scheduler.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="$HOME/.local/portfolio-weather"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.portfolio.weather.plist"
LOG_FILE="$HOME/Library/Logs/portfolio-weather.log"
ENV_FILE="$HOME/.portfolio-weather-env"
CRON_LINE="0 * * * * $INSTALL_DIR/publish_hourly.sh >> \"$LOG_FILE\" 2>&1"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  echo "Create it first (see MACOS_WEATHER_AUTOMATION.md)." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
mkdir -p "$(dirname "$LOG_FILE")"
mkdir -p "$HOME/Library/LaunchAgents"

install -m 755 "$REPO_DIR/scripts/publish_hourly.sh" "$INSTALL_DIR/publish_hourly.sh"
install -m 644 "$REPO_DIR/scripts/publish_location_weather.py" "$INSTALL_DIR/publish_location_weather.py"

cat > "$LAUNCH_AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.portfolio.weather</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$INSTALL_DIR/publish_hourly.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$LOG_FILE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/com.portfolio.weather" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT"
launchctl enable "gui/$(id -u)/com.portfolio.weather"

# Do not kickstart here — scheduled runs are at :00 each hour (see StartCalendarInterval).

# Keep cron as a backup, but only point at the non-Documents install path.
(
  crontab -l 2>/dev/null | grep -v "publish_hourly.sh" | grep -v "shortcuts run" | grep -v "Publish Portfolio Weather" || true
  echo "$CRON_LINE"
) | crontab -

echo "Installed publisher to $INSTALL_DIR"
echo "Registered LaunchAgent: $LAUNCH_AGENT"
echo "Updated crontab to:"
crontab -l | grep publish_hourly.sh || true
echo ""
echo "Publishing once now (scheduled runs happen at :00 each hour)..."
FORCE_PUBLISH=1 bash "$INSTALL_DIR/publish_hourly.sh"
echo ""

# shellcheck disable=SC1090
source "$ENV_FILE"
if ! curl -sf "${SUPABASE_URL}/rest/v1/portfolio_weather_private_config?select=id&limit=1" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" >/dev/null; then
  echo "One more step (one-time): create the private coordinate table in Supabase."
  echo "  1. Open SQL Editor: https://supabase.com/dashboard/project/pxrqwhjlqkthqculjewm/sql/new"
  echo "  2. Paste and run: $REPO_DIR/supabase/weather-private-config.sql"
  echo "  3. Re-run: bash $INSTALL_DIR/publish_hourly.sh"
  echo ""
  echo "Optional (cloud hourly backup when your Mac is asleep): see SUPABASE_WEATHER_SETUP.md"
fi

echo "Done. Check $LOG_FILE and refresh your site weather card."
