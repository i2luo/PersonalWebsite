-- Run once in Supabase SQL Editor (Dashboard → SQL → New query).
-- Required for cloud hourly refresh and Mac coordinate sync.

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
