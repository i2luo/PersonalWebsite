# Supabase Setup (Weather + Gallery Sticky Wall)

This setup shows **your city weather** to every visitor while keeping exact coordinates private.

## 1) Create tables and policies

1. Open Supabase SQL Editor.
2. Run `supabase/setup.sql`.

This creates:

- `public.portfolio_weather_current`
- `public.portfolio_gallery_notes`

It enables:

- public read access (`anon`, `authenticated`) for weather and sticky notes
- public insert access for sticky notes (validated to keep content short and clean)
- no public weather write access

## 2) Configure website read access

Edit `weather-config.js` with your project values:

- `window.PORTFOLIO_SUPABASE_URL`
- `window.PORTFOLIO_SUPABASE_ANON_KEY`

Use Supabase:
- Project URL (base only, e.g. `https://xxxxx.supabase.co` — do **not** include `/rest/v1`)
- anon/public API key

The site reads weather from `portfolio_weather_current` and reads/inserts gallery sticky notes in
`portfolio_gallery_notes`.

## 3) Publish your location weather from Mac

Use the script:

```bash
export SUPABASE_URL="https://YOUR-PROJECT.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY"
python3 scripts/publish_location_weather.py --lat 43.47 --lng -80.54
```

This script:
- reverse-geocodes coordinates to city/region/country
- fetches current weather from Open-Meteo
- upserts one row in Supabase

## 4) Automate hourly updates on your Mac

Run once on your Mac (see `MACOS_WEATHER_AUTOMATION.md` for full steps):

```bash
./scripts/install-weather-scheduler.sh
```

This installs an hourly **LaunchAgent** plus a cron backup using `~/.local/portfolio-weather` (macOS blocks cron from `~/Documents`).

Also run `supabase/weather-private-config.sql` once in the SQL Editor if the installer asks for it.

## 5) Optional: cloud hourly backup (Mac asleep / off)

When your Mac is off, Supabase can still refresh weather using the last coordinates your Mac published.

1. Run `supabase/weather-private-config.sql` in the SQL Editor (if not done already).
2. Deploy the Edge Function:

   ```bash
   npx supabase@latest functions deploy refresh-portfolio-weather --project-ref pxrqwhjlqkthqculjewm
   ```

3. Edit `supabase/edge-function-refresh-weather.sql` (replace `YOUR_PROJECT_REF` and `YOUR_SERVICE_ROLE_KEY`), then run it in the SQL Editor to schedule hourly `pg_cron`.

## 6) Daily quote (home page)

ZenQuotes does not allow direct browser requests (no CORS). Use one of:

**Local dev** — run the project server with the built-in proxy:

```bash
python3 scripts/serve.py 8080
```

**Production** — deploy the Supabase Edge Function (one-time, after `supabase login`):

```bash
npx supabase@latest functions deploy get-daily-quote --project-ref pxrqwhjlqkthqculjewm --no-verify-jwt
```

The site calls `/functions/v1/get-daily-quote` using your anon key from `weather-config.js`.

## 7) Privacy notes

- Visitors only see city-level weather from the Supabase row.
- Exact coordinates are not returned by the site.
- Keep `SUPABASE_SERVICE_ROLE_KEY` secret and only on your Mac.
