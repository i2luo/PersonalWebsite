# Daily Tech TL;DR Setup

A zero-cost feature on the home page: each weekday it grabs the top Hacker News
story, summarizes it in a random celebrity persona (Gemini 2.5 Flash), narrates
it (ElevenLabs), stores the MP3 in Supabase Storage, and the site plays it back.

The whole pipeline stays inside free tiers. Processing one story per weekday
(~23/month) at ≤ 350 characters keeps you well under the ElevenLabs 10,000
char/month limit (~8k max).

```
Hacker News API ─▶ GitHub Actions (Mon–Fri) ─▶ Gemini 2.5 Flash (persona summary)
                                                        │
              Supabase table  ◀── upload MP3 ◀── ElevenLabs TTS
                    │
              Home page frontend (HTML5 audio)
```

## 1) Supabase: table + storage bucket

Run `supabase/tech-tldr-setup.sql` once in the Supabase SQL Editor. It creates:

- `public.portfolio_tech_tldr` (public read; one row per story date)
- a **public** Storage bucket `tech-tldr-audio` (holds the MP3s)

The website reads the latest row with your existing anon key (already in
`weather-config.js`). No frontend changes are needed beyond what is committed.

## 2) Get the free API keys

- **Gemini** — create a key at <https://aistudio.google.com/app/apikey> (free
  tier: ~15 requests/min).
- **ElevenLabs** — copy your key from Profile → API Keys (free: 10,000 chars/mo).
- **Supabase service role key** — Project Settings → API → `service_role` (secret;
  used only by the automation to write the row and upload the audio).

## 3) Add GitHub Actions secrets

In the repo: **Settings → Secrets and variables → Actions → New repository secret**.
Add:

| Secret | Value |
| --- | --- |
| `SUPABASE_URL` | `https://pxrqwhjlqkthqculjewm.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | your service role key |
| `GEMINI_API_KEY` | your Gemini key |
| `ELEVENLABS_API_KEY` | your ElevenLabs key |
| `TECH_TLDR_PERSONAS` | *(optional)* JSON override, see below |

The workflow lives in `.github/workflows/tech-tldr.yml` and runs at **13:00 UTC,
Mon–Fri**. You can also trigger it manually from the Actions tab (with an optional
"force" toggle to run on a weekend).

## 4) Personas and celebrity voices

`scripts/generate_tech_tldr.py` picks a random persona. The **persona name** drives
the Gemini writing style; the mapped **`voice_id`** is the ElevenLabs voice used for
narration.

The built-in list ships with real ElevenLabs *default* voice IDs so it runs out of
the box. For genuine celebrity-sounding narration, find matching voices in the
ElevenLabs **Voice Library**, copy their voice IDs, and either:

- edit `DEFAULT_PERSONAS` in `scripts/generate_tech_tldr.py`, or
- set the `TECH_TLDR_PERSONAS` secret to a JSON array, e.g.:

```json
[
  { "name": "Gordon Ramsay", "voice_id": "your_community_voice_id" },
  { "name": "David Attenborough", "voice_id": "another_voice_id" }
]
```

## 5) Test it locally (optional)

```bash
export SUPABASE_URL="https://pxrqwhjlqkthqculjewm.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="..."
export GEMINI_API_KEY="..."
export ELEVENLABS_API_KEY="..."
python3 scripts/generate_tech_tldr.py --force   # --force ignores the weekend skip
```

Then open the home page; the "Today's Tech TL;DR" card loads the latest row and
plays the audio. On weekends with no fresh story it shows the most recent weekday
entry.

## Cost summary (2026 free tiers)

| Component | Service | Cost |
| --- | --- | --- |
| Automation runner | GitHub Actions | $0 |
| News ingestion | Hacker News API | $0 |
| Summary engine | Gemini 2.5 Flash | $0 |
| Voice synthesis | ElevenLabs (≤10k chars/mo) | $0 |
| Audio + data storage | Supabase | $0 |
