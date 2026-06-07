-- Run in Supabase SQL Editor AFTER deploying the refresh-portfolio-weather Edge Function.
-- Dashboard: Database → Extensions → enable pg_cron and pg_net if needed.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Store last-known coordinates for cloud refresh (service role only; no public policies).
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

-- Replace YOUR_PROJECT_REF with your Supabase project ref (from the dashboard URL).
-- Replace YOUR_SERVICE_ROLE_KEY with Project Settings → API → service_role key.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'portfolio-weather-hourly') then
    perform cron.unschedule('portfolio-weather-hourly');
  end if;
end $$;

select cron.schedule(
  'portfolio-weather-hourly',
  '0 * * * *',
  $$
  select net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/refresh-portfolio-weather',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY'
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);
