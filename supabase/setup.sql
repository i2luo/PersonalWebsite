create table if not exists public.portfolio_weather_current (
  id integer primary key default 1 check (id = 1),
  city text not null,
  region text,
  country text,
  temperature_c double precision not null,
  feels_like_c double precision not null,
  wind_kmh double precision not null,
  weather_code integer,
  weather_summary text,
  weather_timezone text,
  updated_at timestamptz not null default now()
);

alter table public.portfolio_weather_current
  add column if not exists weather_timezone text;

alter table public.portfolio_weather_current enable row level security;

drop policy if exists "Public read weather" on public.portfolio_weather_current;
create policy "Public read weather"
  on public.portfolio_weather_current
  for select
  to anon, authenticated
  using (true);

insert into public.portfolio_weather_current (
  id,
  city,
  region,
  country,
  temperature_c,
  feels_like_c,
  wind_kmh,
  weather_code,
  weather_summary,
  weather_timezone,
  updated_at
)
values (
  1,
  'Waterloo',
  'Ontario',
  'Canada',
  0,
  0,
  0,
  0,
  'Clear sky',
  'America/Toronto',
  now()
)
on conflict (id) do nothing;

-- Last-known coordinates for hourly cloud refresh (no public access).
create table if not exists public.portfolio_weather_private_config (
  id integer primary key default 1 check (id = 1),
  latitude double precision not null,
  longitude double precision not null,
  updated_at timestamptz not null default now()
);

alter table public.portfolio_weather_private_config enable row level security;

insert into public.portfolio_weather_private_config (id, latitude, longitude)
values (1, 43.47, -80.54)
on conflict (id) do nothing;

create table if not exists public.portfolio_gallery_notes (
  id bigint generated always as identity primary key,
  author text not null default 'Anonymous',
  content text not null check (char_length(content) <= 220),
  color text not null default 'yellow' check (color in ('yellow', 'blue', 'pink', 'mint')),
  pattern text not null default 'plain' check (pattern in ('plain', 'flowers', 'stars', 'dots', 'stripes', 'hearts')),
  created_at timestamptz not null default now()
);

alter table public.portfolio_gallery_notes enable row level security;

drop policy if exists "Public read sticky notes" on public.portfolio_gallery_notes;
create policy "Public read sticky notes"
  on public.portfolio_gallery_notes
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Public insert sticky notes" on public.portfolio_gallery_notes;
create policy "Public insert sticky notes"
  on public.portfolio_gallery_notes
  for insert
  to anon, authenticated
  with check (
    char_length(trim(content)) > 0
    and char_length(content) <= 220
    and char_length(author) <= 32
    and color in ('yellow', 'blue', 'pink', 'mint')
    and pattern in ('plain', 'flowers', 'stars', 'dots', 'stripes', 'hearts')
  );

-- Migration for existing installs
alter table public.portfolio_gallery_notes drop constraint if exists portfolio_gallery_notes_color_check;
alter table public.portfolio_gallery_notes
  add constraint portfolio_gallery_notes_color_check
  check (color in ('yellow', 'blue', 'pink', 'mint'));

alter table public.portfolio_gallery_notes
  add column if not exists pattern text not null default 'plain';

alter table public.portfolio_gallery_notes drop constraint if exists portfolio_gallery_notes_pattern_check;
alter table public.portfolio_gallery_notes
  add constraint portfolio_gallery_notes_pattern_check
  check (pattern in ('plain', 'flowers', 'stars', 'dots', 'stripes', 'hearts'));
