-- Food photos: a catalog of synced dishes plus one recency-weighted pick per day.
-- Run this once in the Supabase SQL Editor. It is safe to run again.

-- 1) Catalog of all synced dishes. The only writer is the ingest-food-photo
--    Edge Function (service role key, bypasses RLS).
create table if not exists public.food_photos (
  id uuid primary key default gen_random_uuid(),
  photo_hash text unique not null,               -- SHA-256 of the original file, for deduplication
  storage_path text not null,                    -- e.g. "a3f9c2...webp"
  public_url text not null,                      -- full Supabase Storage URL
  caption text,                                  -- optional short dish description
  taken_at timestamptz not null,                 -- original capture time (drives recency)
  created_at timestamptz not null default now(), -- when it was synced
  last_shown_at date,                            -- used for cooldown filtering
  times_shown int not null default 0,
  is_active boolean not null default true,       -- set false to hide a photo without deleting it
  dishes jsonb                                   -- identified dishes with recipe links, see below
);

-- Added after the first release, so an existing table gets the column here.
-- Shape, written by the Edge Function (1 to 3 dishes, 3 recipes in total):
--   {"items": [{"name": "...", "main": true,
--               "recipes": [{"title": "...", "url": "https://..."}]}]}
-- NULL means the dishes have not been identified yet.
alter table public.food_photos add column if not exists dishes jsonb;

-- Keeps a hand edit in the Table Editor from storing something the site and
-- the Edge Function cannot read.
alter table public.food_photos drop constraint if exists food_photos_dishes_shape;
alter table public.food_photos add constraint food_photos_dishes_shape
  check (dishes is null or coalesce(jsonb_typeof(dishes -> 'items') = 'array', false));

alter table public.food_photos enable row level security;

-- Public read of visible photos only. No insert/update/delete policy on purpose.
drop policy if exists "Public read active food photos" on public.food_photos;
create policy "Public read active food photos"
  on public.food_photos
  for select
  to anon, authenticated
  using (is_active = true);

-- 2) One locked pick per calendar day (local date in the configured timezone).
create table if not exists public.daily_food_picks (
  pick_date date primary key,
  photo_id uuid not null references public.food_photos (id) on delete cascade,
  picked_at timestamptz not null default now()
);

alter table public.daily_food_picks enable row level security;

drop policy if exists "Public read daily food picks" on public.daily_food_picks;
create policy "Public read daily food picks"
  on public.daily_food_picks
  for select
  to anon, authenticated
  using (true);

-- 3) Single-row tuning knobs. Edit these in the Table Editor at any time; the
--    next daily pick uses the new values. The checks reject values that would
--    break the pick (including a misspelled timezone).
create table if not exists public.food_rotation_config (
  id int primary key check (id = 1),
  half_life_days numeric not null default 21 check (half_life_days > 0),
  floor_weight numeric not null default 0.05 check (floor_weight >= 0 and floor_weight <= 1),
  cooldown_days int not null default 5 check (cooldown_days >= 0),
  timezone text not null default 'America/Toronto'
    check ((timestamptz '2000-01-01 00:00:00+00' at time zone timezone) is not null)
);

insert into public.food_rotation_config (id) values (1)
on conflict (id) do nothing;

-- RLS on with no policies: only the service role and the function below
-- (security definer) can read or change the config.
alter table public.food_rotation_config enable row level security;

-- 4) Public storage bucket for the processed WebP files. A public bucket serves
--    objects by URL without any policy. There is deliberately no select policy
--    on storage.objects, so the bucket cannot be listed with the anon key and a
--    hidden photo stays undiscoverable.
insert into storage.buckets (id, name, public)
values ('food-photos', 'food-photos', true)
on conflict (id) do update set public = true;

-- 5) Today's dish. The first call of each local day picks a photo and locks it;
--    every later call that day returns the same row. Returns no rows when there
--    are no active photos.
--    Dropped first because Postgres cannot change the returned columns of an
--    existing function in place (dishes was added to them).
drop function if exists public.get_or_create_daily_food_pick();
create function public.get_or_create_daily_food_pick()
returns table (
  public_url text,
  caption text,
  taken_at timestamptz,
  dishes jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg public.food_rotation_config%rowtype;
  v_half_life double precision;
  v_floor double precision;
  v_cooldown integer;
  v_today date;
  v_previous uuid;
  v_winner uuid;
  v_inserted integer;
begin
  select c.* into cfg from public.food_rotation_config c where c.id = 1;
  v_half_life := greatest(coalesce(cfg.half_life_days, 21), 0.01);
  v_floor := greatest(coalesce(cfg.floor_weight, 0.05), 0);
  v_cooldown := greatest(coalesce(cfg.cooldown_days, 5), 0);
  v_today := (now() at time zone coalesce(cfg.timezone, 'America/Toronto'))::date;

  -- If today's photo was hidden after it was picked, release the lock so that
  -- hiding takes effect immediately.
  delete from public.daily_food_picks d
  using public.food_photos p
  where d.pick_date = v_today
    and p.id = d.photo_id
    and not p.is_active;

  -- Fast path: today's pick is already locked.
  return query
    select p.public_url, p.caption, p.taken_at, p.dishes
    from public.daily_food_picks d
    join public.food_photos p on p.id = d.photo_id
    where d.pick_date = v_today;
  if found then
    return;
  end if;

  -- The most recent earlier pick, so a small album does not repeat it.
  select d.photo_id into v_previous
  from public.daily_food_picks d
  where d.pick_date < v_today
  order by d.pick_date desc
  limit 1;

  -- Weighted pick. weight = max(floor_weight, 0.5 ^ (age_days / half_life_days)).
  -- Tier 0: off cooldown. Tier 1 (everything is on cooldown): any active photo
  -- except the previous pick. Tier 2 (only the previous pick is left): that one.
  -- Sorting by -ln(u) / weight picks each photo in the best non-empty tier with
  -- probability proportional to its weight.
  select e.id into v_winner
  from (
    select
      p.id,
      greatest(
        v_floor,
        -- The exponent is capped so a very old or bogus taken_at cannot underflow.
        power(
          0.5::double precision,
          least(
            greatest(extract(epoch from (now() - p.taken_at)) / 86400.0, 0) / v_half_life,
            500
          )
        )
      ) as weight,
      case
        when p.last_shown_at is null or v_today - p.last_shown_at >= v_cooldown then 0
        when p.id is distinct from v_previous then 1
        else 2
      end as tier
    from public.food_photos p
    where p.is_active
  ) e
  order by e.tier, -ln(1 - random()) / e.weight
  limit 1;

  if v_winner is null then
    return;
  end if;

  -- Atomic lock: if two visitors race just after midnight, one insert wins and
  -- only that caller records the showing.
  insert into public.daily_food_picks (pick_date, photo_id)
  values (v_today, v_winner)
  on conflict (pick_date) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted > 0 then
    update public.food_photos p
    set last_shown_at = v_today,
        times_shown = p.times_shown + 1
    where p.id = v_winner;
  end if;

  return query
    select p.public_url, p.caption, p.taken_at, p.dishes
    from public.daily_food_picks d
    join public.food_photos p on p.id = d.photo_id
    where d.pick_date = v_today;
end;
$$;

-- The website calls this with the anon key: POST /rest/v1/rpc/get_or_create_daily_food_pick
revoke all on function public.get_or_create_daily_food_pick() from public;
grant execute on function public.get_or_create_daily_food_pick() to anon, authenticated, service_role;

-- Make the new function visible to the REST API right away.
notify pgrst, 'reload schema';
