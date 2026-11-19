-- Latest Hevy workout: a single row the home page reads.
-- Run this once in the Supabase SQL Editor.

create table if not exists public.portfolio_latest_workout (
  id integer primary key default 1 check (id = 1),
  title text not null,
  started_at timestamptz,
  ended_at timestamptz,
  duration_min integer check (duration_min is null or duration_min >= 0),
  exercise_count integer not null default 0 check (exercise_count >= 0),
  -- [{ "name": "...", "sets": [{ "type", "reps", "weight_kg", "weight_lbs",
  --    "rpe", "duration_seconds", "distance_km" }] }]
  exercises jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.portfolio_latest_workout enable row level security;

-- Public read access for the website (anon + authenticated). There is no
-- insert/update policy on purpose: the only writer is the
-- publish-latest-workout Edge Function, which uses the service role key
-- (bypasses RLS) after checking the x-publish-secret header.
drop policy if exists "Public read latest workout" on public.portfolio_latest_workout;
create policy "Public read latest workout"
  on public.portfolio_latest_workout
  for select
  to anon, authenticated
  using (true);
