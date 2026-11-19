# Latest Hevy Workout Setup

The home page shows my most recent Hevy session. A daily workflow on my phone
(Muse) logs into Hevy, extracts the latest workout as JSON, and POSTs it to a
Supabase Edge Function. The function validates it and stores one row; the site
reads that row with the public anon key.

```
Muse daily workflow ─▶ publish-latest-workout (Edge Function) ─▶ portfolio_latest_workout ─▶ Home page card
```

The table has no public write policy. The only writer is the Edge Function,
which requires a secret header, so the anon key shipped with the site cannot
change the card.

## 1) Supabase: table

Run `supabase/latest-workout-setup.sql` once in the Supabase SQL Editor. It
creates `public.portfolio_latest_workout` (public read, single row `id = 1`).

Until the first publish the card shows "No workout logged yet."

## 2) Deploy the Edge Function

Pick a secret and keep it; Muse needs the same value:

```bash
openssl rand -hex 32
```

Then (one-time `npx supabase@latest login` if needed):

```bash
npx supabase@latest secrets set HEVY_PUBLISH_SECRET="paste-the-secret" --project-ref pxrqwhjlqkthqculjewm
npx supabase@latest functions deploy publish-latest-workout --project-ref pxrqwhjlqkthqculjewm
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to Edge Functions
automatically.

## 3) Point Muse at it

**Request**

```text
POST https://pxrqwhjlqkthqculjewm.supabase.co/functions/v1/publish-latest-workout
```

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer <anon key>` (the `PORTFOLIO_SUPABASE_ANON_KEY` value in `weather-config.js`) |
| `x-publish-secret` | the secret from step 2 |

**Body** (the workout object itself, or wrapped as `{ "workout": { ... } }`)

```json
{
  "title": "Push Day",
  "started_at": "2026-11-18T16:02:00-05:00",
  "ended_at": "2026-11-18T17:05:00-05:00",
  "exercises": [
    {
      "name": "Bench Press (Barbell)",
      "sets": [
        { "type": "warmup", "reps": 10, "weight_kg": 60 },
        { "type": "normal", "reps": 8, "weight_kg": 100, "rpe": 8 }
      ]
    }
  ]
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `title` | yes | Up to 120 characters |
| `started_at`, `ended_at` | no | ISO-8601 **with a timezone** (`Z` or an offset like `-05:00`). A time without one is rejected rather than guessed. |
| `duration_min` | no | Derived from the two timestamps when omitted |
| `exercise_count` | no | Defaults to the number of `exercises` |
| `exercises` | no | Up to 40; each needs a `name` |
| `exercises[].sets` | no | Up to 30 per exercise |
| `sets[].type` | no | `normal`, `warmup`, `dropset` or `failure`; anything else is stored as `normal` |
| `sets[].reps` | no | Whole number |
| `sets[].weight_kg` or `sets[].weight_lbs` | no | Send whichever unit Hevy shows; the card displays that unit |
| `sets[].rpe` | no | 0 to 10 |
| `sets[].duration_seconds`, `sets[].distance_km` | no | For timed or distance sets |

`id` and any other fields are ignored. Numbers may be sent as numeric strings.

**Responses**

| Status | Meaning |
| --- | --- |
| `200` | `{ "ok": true, "title": ..., "started_at": ..., "exercise_count": ..., "updated_at": ... }` |
| `400` | Body is not JSON, or a field is wrong. `error` names the field, e.g. `exercises[2].sets[0].reps must be a whole number` |
| `401` | `x-publish-secret` is missing or wrong (from the function), or the `Authorization` anon key is missing (from Supabase) |
| `413` | Body larger than 64 KB |
| `500` | Secret not set, or the table from step 1 does not exist yet |

Publishing the same workout again just overwrites the row, so the daily run is
safe on rest days.

## 4) Test from a Mac (optional)

`scripts/publish_latest_workout.py` sends the same request Muse does. The URL
and anon key default to the values in `weather-config.js`.

```bash
export HEVY_PUBLISH_SECRET="paste-the-secret"
python3 scripts/publish_latest_workout.py --file scripts/latest-workout.example.json
```

This publishes the sample "Push Day" to the live card. It stays there until the
next Muse run replaces it.
