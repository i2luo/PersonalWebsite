-- Daily Tech TL;DR: one celebrity-narrated top story per weekday.
-- Run this once in the Supabase SQL Editor.

-- 1) Data table: one row per story date, frontend reads the latest row.
create table if not exists public.portfolio_tech_tldr (
  story_date date primary key,
  headline text not null,
  persona text not null,
  summary text not null check (char_length(summary) <= 600),
  audio_url text,
  source_url text,
  created_at timestamptz not null default now()
);

alter table public.portfolio_tech_tldr enable row level security;

-- Public read access for the website (anon + authenticated). Writes happen
-- only from the automation using the service role key, which bypasses RLS.
drop policy if exists "Public read tech tldr" on public.portfolio_tech_tldr;
create policy "Public read tech tldr"
  on public.portfolio_tech_tldr
  for select
  to anon, authenticated
  using (true);

-- 2) Public storage bucket for the generated MP3 files.
insert into storage.buckets (id, name, public)
values ('tech-tldr-audio', 'tech-tldr-audio', true)
on conflict (id) do update set public = true;

-- Public read of the audio objects (the bucket being public already serves
-- objects, this policy keeps the REST/object API readable for anon too).
drop policy if exists "Public read tech tldr audio" on storage.objects;
create policy "Public read tech tldr audio"
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'tech-tldr-audio');
