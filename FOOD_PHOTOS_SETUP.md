# Food Photos Setup

The home page shows one dish a day under "Something that I made recently:".
There are two independent loops, both backed by Supabase:

```
Muse weekly sync ──┐
                   ├─▶ ingest-food-photo (Edge Function) ─▶ food-photos bucket + food_photos
Backfill script ───┘

Home page ─▶ get_or_create_daily_food_pick() ─▶ daily_food_picks (one locked pick per day)
```

- **Write path:** a weekly Muse routine (or the backfill script) POSTs photos
  from the Food album to an Edge Function, which dedupes them, strips the
  metadata, converts them to WebP and stores them. Muse also names the dishes
  in each photo and attaches three recipe links, which the card shows.
- **Read path:** the first visitor of each day triggers a recency-weighted
  pick that is locked for the rest of that day. There is no cron job.

If Muse skips a week the site keeps rotating through what is already synced.
While there are no photos at all, the card is hidden.

None of the tables has a public write policy. The only writer is the Edge
Function, which requires a secret header, so the anon key shipped with the
site cannot add or change photos.

## 1) Supabase: tables, bucket and pick function

Run `supabase/food-photos-setup.sql` in the Supabase SQL Editor, and run it
again whenever the file changes: it adds what is missing and replaces the
function without touching the stored photos, picks or settings. The editor
warns about a destructive operation because the file drops and recreates the
function and policies; that is expected. It creates:

| Object | Purpose |
| --- | --- |
| `food_photos` | Catalog of synced photos, with their dishes and recipe links (public read of active rows only) |
| `daily_food_picks` | One locked pick per local calendar day (public read) |
| `food_rotation_config` | Single row of tuning knobs (no public access) |
| `food-photos` bucket | Public bucket holding `{photo_hash}.webp` |
| `get_or_create_daily_food_pick()` | The function the home page calls |

## 2) Deploy the Edge Function

Pick a secret and keep it; Muse and the backfill script need the same value:

```bash
openssl rand -hex 32
```

Start Docker Desktop, then (one-time `npx supabase@latest login` if needed):

```bash
npx supabase@latest secrets set FOOD_INGEST_SECRET="paste-the-secret" --remote=pxrqwhjlqkthqculjewm
npx supabase@latest functions deploy ingest-food-photo --remote=pxrqwhjlqkthqculjewm
```

Docker has to be running for this deploy. The function bundles a 16 MB image
library, which is over the 5 MB limit for bundling without Docker (`--use-api`).

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to Edge Functions
automatically.

## 3) The ingest request

```text
POST https://pxrqwhjlqkthqculjewm.supabase.co/functions/v1/ingest-food-photo
```

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <anon key>` (the `PORTFOLIO_SUPABASE_ANON_KEY` value in `weather-config.js`) |
| `x-food-ingest-secret` | the secret from step 2 |
| `Content-Type` | `multipart/form-data` (set by the HTTP client, with its boundary) |

| Form field | Required | Notes |
| --- | --- | --- |
| `file` | yes | JPEG, PNG or WebP, at most 10 MB. HEIC is rejected: convert it to JPEG first. |
| `caption` | no | Short description, up to 120 characters. Ignored when `dishes` is sent: the photo is then labelled with its main dish. |
| `taken_at` | no | Capture time as ISO-8601 **with a timezone** (`Z` or an offset like `-05:00`). Defaults to the upload time, so send it whenever it is known: it drives the recency weighting. |
| `photo_hash` | no | SHA-256 (64 hex characters) of the **original** album file. Send it when the upload is a converted copy, so the same photo dedupes even if the conversion output changes between runs. Defaults to the SHA-256 of the uploaded bytes. |
| `dishes` | no | JSON text naming the dishes in the photo, with recipe links. See [Dishes and recipes](#dishes-and-recipes). |

What the function does, in order: checks the secret and the fields, looks up
the hash and returns early for a photo it already has (adding the dishes first
if that photo has none yet), applies the EXIF rotation, resizes to at most
1200 px wide, re-encodes to WebP without any EXIF/GPS data, uploads
`{photo_hash}.webp` to the bucket and inserts the `food_photos` row.

**Responses**

| Status | Meaning |
| --- | --- |
| `200` | `{ "ok": true, "status": "inserted", "photo_hash": ..., "public_url": ..., "caption": ..., "taken_at": ..., "dishes": ..., "width": ..., "height": ..., "bytes": ... }` |
| `200` | `{ "ok": true, "status": "updated", "photo_hash": ..., "caption": ..., "dishes": ... }` when the photo was already synced without dishes and the request added them. The image is not touched. |
| `200` | `{ "ok": true, "status": "duplicate", "photo_hash": ... }` when the photo is already synced. Nothing is changed. |
| `400` | `file` is missing or empty, the image cannot be decoded, or a field is wrong. `error` says which. |
| `401` | `x-food-ingest-secret` is missing or wrong (from the function), or the `Authorization` anon key is missing (from Supabase) |
| `413` | File larger than 10 MB, or a PNG/WebP with more than 16 megapixels |
| `415` | Not a JPEG, PNG or WebP |
| `500` | Secret not set, or the SQL from step 1 has not been run since it last changed (`column food_photos.dishes does not exist`) |
| `546` | Sent by Supabase when the function runs out of CPU or memory. Send a smaller copy (long edge 2048 px). |

Sending the same photo again is always safe, which is what lets the weekly
routine use an overlapping window.

### Dishes and recipes

`dishes` lists 1 to 3 dishes that are visible in the photo. Exactly one is the
main dish, and every photo carries exactly 3 recipes:

| Dishes in the photo | Recipes |
| --- | --- |
| 3 | 1 for each dish |
| 2 | 2 for the main dish (the top two guesses at what it is), 1 for the other |
| 1 | 3 for that dish (the top three guesses at what it is) |

A dish has one name, the best guess, however many recipes it has.

```json
{
  "items": [
    {
      "name": "Pan-seared salmon",
      "main": true,
      "recipes": [
        { "title": "Crispy Pan-Seared Salmon", "url": "https://example.com/crispy-salmon" },
        { "title": "Miso-Glazed Salmon", "url": "https://example.com/miso-salmon" }
      ]
    },
    {
      "name": "Garlic fried rice",
      "main": false,
      "recipes": [
        { "title": "Easy Garlic Fried Rice", "url": "https://example.com/garlic-rice" }
      ]
    }
  ]
}
```

The function rejects anything else with a `400` whose `error` starts with
`dishes:` and says what to fix. The rules: names are different from each other
and at most 80 characters, titles at most 120, URLs are `http(s)` and different
from each other, and the recipe counts match the table. With one dish, `main`
can be left out.

What is stored and shown:

- The main dish becomes the photo's `caption` and the card's heading, with its
  recipes under it. The other dishes follow, each with its name and recipe.
- A photo that was synced without dishes (the backfill) gets them the first
  time a request for it includes `dishes`; the response is `updated`. A caption
  typed by hand is kept as the heading.
- Dishes that are already stored are never overwritten, so repeat runs change
  nothing. To redo a photo, see [section 8](#8-hiding-removing-or-fixing-a-photo).

## 4) Test with curl

Use any JPEG. The first call inserts, the second reports a duplicate:

```bash
export FOOD_INGEST_SECRET="paste-the-secret"
export ANON_KEY="paste-the-anon-key-from-weather-config.js"

curl -sS https://pxrqwhjlqkthqculjewm.supabase.co/functions/v1/ingest-food-photo \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "x-food-ingest-secret: $FOOD_INGEST_SECRET" \
  -F "file=@/path/to/dish.jpg" \
  -F "caption=Pan-seared salmon rice bowl" \
  -F "taken_at=2026-11-20T18:30:00-05:00"
```

Check the row in **Table Editor → food_photos** and open its `public_url`.
Reload the home page: the card appears with that dish and stays on it for the
rest of the day.

To test dishes, send the same photo again with a `dishes` field. The photo has
none yet, so the response is `"status":"updated"` and the row's `dishes` column
is filled:

```bash
curl -sS https://pxrqwhjlqkthqculjewm.supabase.co/functions/v1/ingest-food-photo \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "x-food-ingest-secret: $FOOD_INGEST_SECRET" \
  -F "file=@/path/to/dish.jpg" \
  --form-string 'dishes={"items":[{"name":"Pan-seared salmon","recipes":[
        {"title":"Crispy Pan-Seared Salmon","url":"https://example.com/1"},
        {"title":"Miso-Glazed Salmon","url":"https://example.com/2"},
        {"title":"Lemon Butter Salmon","url":"https://example.com/3"}]}]}'
```

To remove a test photo, delete its row in `food_photos` (today's pick goes with
it) and delete the file in **Storage → food-photos**.

## 5) Backfill the existing album

Export the Food album from Photos to a folder on the Mac (File → Export →
Export Unmodified Originals keeps the capture dates), then:

```bash
pip install pillow pillow-heif
export FOOD_INGEST_SECRET="paste-the-secret"

python3 scripts/backfill_food_photos.py ~/Desktop/food-export --dry-run
python3 scripts/backfill_food_photos.py ~/Desktop/food-export
```

The dry run lists each photo with the capture date it found and sends nothing.
The script reads the date from EXIF (falling back to the file's modified date,
which it flags as `file date`), converts HEIC to JPEG, shrinks the long edge to
2048 px and removes EXIF/GPS before anything leaves the Mac. The URL and anon
key default to the values in `weather-config.js`.

Backfilled photos have no caption and no dishes. Muse adds both (section 6), or
type a caption in the Table Editor.

## 6) Muse weekly routine

1. Connect Muse to the Photos library, scoped to the Food album if the
   permission picker allows album-level access.
2. Approve outbound requests to `pxrqwhjlqkthqculjewm.supabase.co` so the
   routine can run unattended, and allow it to search the web for recipes.
3. Create a routine that runs once a week with these instructions, replacing
   `<ANON KEY>` and `<FOOD INGEST SECRET>` with the real values:

```text
Sync my Food album to my website.

1. In my Photos library, find the photos in the album named "Food" that were
   taken or added in the last 14 days.
2. For each photo:
   a. Compute the SHA-256 hex digest of the original photo file exactly as it
      is stored, before changing it in any way. This is photo_hash.
   b. Read the photo's capture time and format it as ISO-8601 with its UTC
      offset, for example 2026-11-20T18:30:12-05:00. This is taken_at.
   c. Look at the photo and list the distinct dishes you can see in it, at
      most 3, the most prominent first. Do not invent dishes to reach 3.
      Give each dish one casual name of 2 to 5 words, your best guess at what
      it is, for example "Pan-seared salmon". No emoji, hashtags or trailing
      period. Mark exactly one dish, the most prominent, as the main dish.
   d. Search the web and choose exactly 3 recipes in total:
      - 3 dishes: 1 recipe for each dish.
      - 2 dishes: 2 recipes for the main dish, one for each of your top two
        guesses at what it is, and 1 recipe for the other dish.
      - 1 dish: 3 recipes, one for each of your top three guesses at what
        it is.
      A dish keeps the single name from step c however many recipes it has.
      Each recipe is a page you opened and confirmed is a recipe for that
      dish, on an established cooking site. No search result pages, videos,
      shops or social media posts. Record the page's title (at most 120
      characters) and its full https URL. The 3 URLs must be different.
   e. Build dishes, a JSON object in exactly this shape. This example is a
      photo with 2 dishes:
      {"items":[
        {"name":"Pan-seared salmon","main":true,"recipes":[
          {"title":"Crispy Pan-Seared Salmon","url":"https://example.com/a"},
          {"title":"Miso-Glazed Salmon","url":"https://example.com/b"}]},
        {"name":"Garlic fried rice","main":false,"recipes":[
          {"title":"Easy Garlic Fried Rice","url":"https://example.com/c"}]}
      ]}
   f. Make an upload copy: JPEG, rotated upright, long edge at most 2048 px,
      quality 85, with all EXIF and GPS metadata removed.
   g. Send a multipart/form-data POST to
      https://pxrqwhjlqkthqculjewm.supabase.co/functions/v1/ingest-food-photo
      with the headers
        Authorization: Bearer <ANON KEY>
        x-food-ingest-secret: <FOOD INGEST SECRET>
      and the form fields
        file = the upload copy
        taken_at = the capture time from step b
        photo_hash = the digest from step a
        dishes = the JSON from step e, as text
3. A response with "status": "inserted", "status": "updated" or
   "status": "duplicate" is a success. If the response has an "error" that
   starts with "dishes:", fix the JSON as it says and send that photo once
   more. For any other response, note the photo and the "error" text, then
   continue with the next photo.
4. Finish with one line: how many were inserted, updated, duplicate and failed.

Do not send the photos anywhere else.
```

The 14-day window means a missed week is caught by the next run. Photos that
are already synced with dishes come back as `duplicate`; photos synced without
dishes come back as `updated` the first time.

After the first run, check a few rows in **Table Editor → food_photos**: the
`dishes` column is filled and the recipe links open real recipes.

### Adding dishes to the photos that are already synced

The routine only looks at the last 14 days, so older backfilled photos keep
showing without recipes. To fill them in, run the same instructions once by
hand with step 1 changed to cover the whole album.

Try it on a single photo first and read the response:

- `updated`: Muse's `photo_hash` matches the backfill's. Run it on the whole
  album.
- `inserted`: the phone and the Mac export hold different files for the same
  photo, so Muse created a second copy instead of updating the first. Running
  the whole album is still fine, but it leaves every old photo twice. Remove
  the old copies afterwards, which are the ones without dishes:

  ```sql
  delete from food_photos old_copy
  using food_photos new_copy
  where old_copy.dishes is null
    and new_copy.dishes is not null
    and new_copy.taken_at = old_copy.taken_at;
  ```

  Their files stay in **Storage → food-photos** and can be deleted there.

## 7) Tuning the rotation

Edit the single row of `food_rotation_config` in the Table Editor. Changes
apply from the next daily pick, with no deploy.

| Column | Default | Effect |
| --- | --- | --- |
| `half_life_days` | `21` | A photo's weight halves every this many days since it was taken. Smaller means a stronger bias toward recent dishes. |
| `floor_weight` | `0.05` | Minimum weight, so old dishes still come up now and then. `0` to `1`. |
| `cooldown_days` | `5` | Days before a shown dish can be picked again. If every photo is on cooldown, any photo except the previous pick is used. |
| `timezone` | `America/Toronto` | The dish changes at midnight in this timezone. |

`weight = max(floor_weight, 0.5 ^ (age_days / half_life_days))`, and each
eligible photo is picked with probability proportional to its weight.

## 8) Hiding, removing or fixing a photo

- **Hide:** set `is_active` to `false` on its row. It is never picked again,
  and if it is today's dish the next page load picks a different one. The file
  stays in the bucket, reachable only by someone who already has its URL.
- **Remove:** delete the row, then delete `{photo_hash}.webp` in
  **Storage → food-photos**.
- **Fix a wrong dish or recipe:** edit the row's `dishes` JSON (and `caption`,
  which is the heading) in the Table Editor. The site shows whatever is there
  and skips anything it cannot read.
- **Have Muse redo the dishes:** set the row's `dishes` to `NULL`. The next
  run that includes the photo fills it again. `caption` is only replaced if it
  is empty, so clear it too for a new heading.
