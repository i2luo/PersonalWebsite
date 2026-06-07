# macOS: Auto-publish your location weather every hour

This guide sets up **Option A**: your Mac reads **real GPS location**, publishes city weather to Supabase, and runs **every hour on the hour**.

You will create:

1. `~/.portfolio-weather-env` — secret Supabase keys (Mac only)
2. A **Shortcuts** shortcut — Get Location → publish to Supabase
3. A **schedule** — run that shortcut at `:00` every hour

---

## Part 1: Create your secrets file on the Mac

### Step 1.1 — Create the env file

Open **Terminal** and run:

```bash
nano ~/.portfolio-weather-env
```

Paste (replace with your real values from Supabase → **Project Settings → API**):

```bash
export SUPABASE_URL="https://pxrqwhjlqkthqculjewm.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="paste-your-service-role-key-here"
```

- Use **Project URL** only (no `/rest/v1` at the end).
- Use **`service_role`** key — **not** the anon key.

Save in nano: **Ctrl+O**, Enter, **Ctrl+X**.

### Step 1.2 — Lock down permissions

```bash
chmod 600 ~/.portfolio-weather-env
```

Only your user account can read this file.

### Step 1.3 — Make the shell script executable

```bash
chmod +x /Users/ivany/Documents/PersonalWebsite/scripts/publish_from_mac.sh
```

### Step 1.4 — Test manually (before Shortcuts)

Pick coordinates near you (example: Waterloo):

```bash
/Users/ivany/Documents/PersonalWebsite/scripts/publish_from_mac.sh 43.47 -80.54
```

Expected output:

```text
Published weather for Waterloo, Ontario, Canada.
```

Confirm in Supabase **Table Editor** → `portfolio_weather_current` → row updated.

---

## Part 2: Build the Shortcuts shortcut

### Step 2.1 — Open Shortcuts

1. Open **Shortcuts** (Applications or Spotlight: `Shortcuts`).
2. Click **Shortcuts** in the sidebar (not Automations yet).

### Step 2.2 — Create a new shortcut

1. Click **+** or **File → New Shortcut**.
2. Name it exactly: **`Publish Portfolio Weather`**  
   (the hourly scheduler below uses this name.)

### Step 2.3 — Add “Get Current Location”

1. In the action search box, type **Current Location**.
2. Add **Get Current Location**.
3. Leave accuracy as default (or “Best” if offered).

macOS will ask for **Location Services** permission for Shortcuts — click **Allow**.

### Step 2.4 — Get latitude and longitude

Shortcuts stores location as a **Location** object. You need two numbers.

1. Search for **Details of Locations** (or “Get Details of Locations”).
2. Add it below Get Current Location.
3. Set **Get** to **Latitude**.
4. Add a **second** **Details of Locations** action.
5. Set **Get** to **Longitude**.

You should have a chain like:

```text
Get Current Location
  → Get Details of Locations (Latitude)
  → Get Details of Locations (Longitude)
```

### Step 2.5 — Run the shell script

1. Search for **Run Shell Script**.
2. Add it below the longitude action.
3. Set **Shell** to `/bin/bash`.
4. Set **Input** to **Text** (or “Shortcut Input” — we use explicit variables below).
5. Paste this script:

```bash
cd "/Users/ivany/Documents/PersonalWebsite"
source "$HOME/.portfolio-weather-env"
/Users/ivany/Documents/PersonalWebsite/scripts/publish_from_mac.sh "LATITUDE" "LONGITUDE"
```

6. **Replace the placeholders with magic variables:**
   - Click inside the quotes around `LATITUDE` and delete `LATITUDE`.
   - Right-click or use the variable picker → insert **Latitude** from the “Get Details of Locations” action above.
   - Do the same for `LONGITUDE` with the **Longitude** variable.

The final line should look like (with blue variable pills, not literal text):

```bash
.../publish_from_mac.sh «Latitude» «Longitude»
```

7. Turn **off** “Show When Run” if you want it silent in the background (optional).

### Step 2.6 — Test the shortcut

1. Click the **Play** button (▶) at the top of the shortcut editor.
2. Allow location if prompted.
3. Check Terminal output in Shortcuts (View → Log) or verify Supabase table row updated.

If it fails:

| Error | Fix |
|-------|-----|
| Permission denied on `.portfolio-weather-env` | `chmod 600` and correct path |
| `python3: command not found` in Shortcuts | Add to script: `export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"` |
| Invalid lat/lng | Re-insert Latitude/Longitude variables (not plain text) |

---

## Part 3: Run every hour on the hour

macOS **blocks cron** from executing scripts in `~/Documents` (`Operation not permitted`).  
Do **not** schedule `PersonalWebsite/scripts/publish_hourly.sh` directly.

### Step 3.1 — Install the scheduler (one command)

```bash
chmod +x /Users/ivany/Documents/PersonalWebsite/scripts/install-weather-scheduler.sh
/Users/ivany/Documents/PersonalWebsite/scripts/install-weather-scheduler.sh
```

This will:

1. Copy publisher files to `~/.local/portfolio-weather` (cron-safe path)
2. Register a **LaunchAgent** (`com.portfolio.weather`) that runs at **minute :00** every hour
3. Update **crontab** to call the installed copy as a backup
4. Publish weather immediately so your site updates

### Step 3.2 — One-time Supabase SQL (private coordinates)

If the installer asks you to create `portfolio_weather_private_config`:

1. Open [Supabase SQL Editor](https://supabase.com/dashboard/project/pxrqwhjlqkthqculjewm/sql/new)
2. Paste and run `supabase/weather-private-config.sql`
3. Re-run: `~/.local/portfolio-weather/publish_hourly.sh`

This table is not shown on your website. It stores last-known lat/lng for optional cloud hourly refresh.

### Step 3.3 — Verify scheduling

```bash
launchctl print "gui/$(id -u)/com.portfolio.weather" | head -20
crontab -l
tail -5 ~/Library/Logs/portfolio-weather.log
```

You should see recent `INFO: Publishing weather` lines and **no** `Operation not permitted`.

### Step 3.4 — Shortcuts (optional, for GPS when you travel)

Use the shortcut from Part 2 when you want fresh GPS coordinates.  
Hourly jobs reuse `~/.portfolio-weather-location` until you publish again.

> **Why not `shortcuts run` in cron?**  
> Cron cannot run Shortcuts reliably (`Couldn't find shortcut`).

### Step 3.5 — Location permission for Shortcuts

**System Settings → Privacy & Security → Location Services → Shortcuts → On**

---

## Part 4 (optional): Shortcuts-only automation (not hourly)

If you only want automation when you **arrive** somewhere (not every hour):

1. Shortcuts → **Automation** tab → **+** → **Personal Automation**.
2. Choose **Arrive** (or **Leave**) → pick a location radius.
3. Action: **Run Shortcut** → **Publish Portfolio Weather**.
4. Turn off “Ask Before Running” if you want it automatic.

This updates weather when you travel, but not on a clock schedule.

---

## Part 5: Privacy reminder

- Visitors only see **city + weather** from Supabase (no lat/lng on the website).
- Your Mac sends coordinates to the **publisher script** only; they are not stored in the public table.
- Never commit `~/.portfolio-weather-env` or the **service_role** key to GitHub.

---

## Troubleshooting

### Website still shows old weather

1. Run shortcut manually once.
2. Hard refresh the browser (**Cmd+Shift+R**).
3. Check `updated_at` in Supabase Table Editor.

### Cron runs but nothing updates

```bash
tail -20 ~/Library/Logs/portfolio-weather.log
```

Common fixes:

| Log message | Fix |
|-------------|-----|
| `Operation not permitted` on `Documents/.../publish_hourly.sh` | Run `scripts/install-weather-scheduler.sh` (uses `~/.local/portfolio-weather`). |
| `Couldn't find shortcut` | Do not use `shortcuts run` in cron. Run `install-weather-scheduler.sh` instead. |
| `Missing ~/.portfolio-weather-env` | Create the env file (Part 1). |
| `WARN: Using default Waterloo coordinates` | Run `publish_from_mac.sh` once with real lat/lng, or set `PORTFOLIO_LAT` / `PORTFOLIO_LNG` in the env file. |
| `Supabase upsert failed` | Check `SUPABASE_SERVICE_ROLE_KEY` in the env file. |
| `portfolio_weather_private_config` not found | Run `supabase/weather-private-config.sql` once in SQL Editor (optional for Mac hourly; required for cloud backup). |

Test hourly script manually:

```bash
~/.local/portfolio-weather/publish_hourly.sh
```

### Shortcut works manually but not from cron

- Re-run `scripts/install-weather-scheduler.sh` so cron/launchd use `~/.local`, not `~/Documents`.
- Run the shortcut occasionally (or `publish_from_mac.sh`) to refresh `~/.portfolio-weather-location` when you travel.
- Keep Mac awake or disable sleep during hours you care about (scheduled jobs may not run during deep sleep on laptops).

### Laptop sleep

Cron on a sleeping MacBook may skip runs. For stricter hourly updates while traveling, plug in and adjust **Battery → prevent sleep when display is off** or use a desktop/Mac mini as publisher.

---

## Quick reference

| Item | Value |
|------|--------|
| Shortcut name | `Publish Portfolio Weather` |
| Env file | `~/.portfolio-weather-env` |
| Wrapper script | `scripts/publish_from_mac.sh` |
| Install scheduler | `scripts/install-weather-scheduler.sh` |
| Hourly script (installed) | `~/.local/portfolio-weather/publish_hourly.sh` |
| LaunchAgent label | `com.portfolio.weather` |
| Cron schedule | `0 * * * *` (backup, same installed path) |
| Last GPS file | `~/.portfolio-weather-location` |
| Log file | `~/Library/Logs/portfolio-weather.log` |
