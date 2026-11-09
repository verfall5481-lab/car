create schema deriro_private;
revoke all on schema deriro_private from public, anon, authenticated, service_role;
grant usage on schema deriro_private to authenticated;
alter default privileges in schema deriro_private revoke execute on functions from public, anon, authenticated, service_role;

create type public.pickup_status as enum (
  'open', 'assigned', 'en_route', 'arrived', 'completed', 'cancelled', 'expired', 'closed_unconfirmed'
);
create type public.offer_status as enum ('pending', 'accepted', 'declined', 'expired', 'cancelled', 'superseded');
create type public.location_source as enum ('saved_point', 'saved_place', 'map_pin', 'gps');

create table public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 40),
  created_at timestamptz not null default now()
);

create table public.family_members (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  auth_user_id uuid references auth.users on delete set null,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 20),
  role text not null default 'guardian' check (role in ('owner', 'guardian')),
  can_request boolean not null default true,
  can_drive boolean not null default true,
  location_consented_at timestamptz,
  left_at timestamptz,
  unique (family_id, id)
);
create unique index family_members_active_user on public.family_members(auth_user_id) where left_at is null;
create unique index family_members_active_owner on public.family_members(family_id) where role = 'owner' and left_at is null;

create table public.riders (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 20),
  kind text not null check (kind in ('child', 'adult')),
  birth_year int,
  consent_basis text not null check (consent_basis in ('guardian', 'self')),
  location_consented_at timestamptz,
  archived_at timestamptz,
  check (kind <> 'adult' or consent_basis = 'self'),
  unique (family_id, id)
);

create table public.rider_devices (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  rider_id uuid not null,
  auth_user_id uuid not null unique references auth.users on delete cascade,
  revoked_at timestamptz,
  foreign key (family_id, rider_id) references public.riders(family_id, id)
);

create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  auth_user_id uuid unique references auth.users on delete set null,
  nickname text not null check (char_length(btrim(nickname)) between 1 and 20),
  current_driver_member_id uuid,
  revoked_at timestamptz,
  active_pickup_id uuid,
  active_nav_session_id uuid,
  active_destination_revision int,
  unique (family_id, id),
  foreign key (family_id, current_driver_member_id) references public.family_members(family_id, id),
  check (num_nonnulls(active_pickup_id, active_nav_session_id, active_destination_revision) in (0, 3))
);

-- Deliberately service-owned. Unknown or stale gear never authorizes a parked-only operation.
create table public.vehicle_states (
  vehicle_id uuid primary key references public.vehicles on delete cascade,
  gear text not null check (gear in ('P', 'R', 'N', 'D', 'unknown')),
  collected_at timestamptz not null
);

create table public.places (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 40),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  radius_m int not null default 150 check (radius_m between 50 and 500),
  archived_at timestamptz,
  unique (family_id, id)
);

create table public.pickup_points (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  place_id uuid not null,
  label text not null check (char_length(btrim(label)) between 1 and 20),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  note text check (char_length(note) <= 40),
  archived_at timestamptz,
  unique (family_id, id),
  unique (family_id, place_id, id),
  foreign key (family_id, place_id) references public.places(family_id, id)
);
create unique index pickup_points_active_label on public.pickup_points(place_id, label) where archived_at is null;

create table public.routines (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  rider_id uuid,
  rider_member_id uuid,
  place_id uuid not null,
  pickup_point_id uuid,
  weekdays smallint not null check (weekdays between 1 and 127),
  time_local time not null,
  notify_before_min int not null default 20 check (notify_before_min between 5 and 120),
  default_assignee_member_id uuid,
  default_vehicle_id uuid,
  start_date date not null default (now() at time zone 'Asia/Seoul')::date,
  end_date date,
  archived_at timestamptz,
  unique (family_id, id),
  check (num_nonnulls(rider_id, rider_member_id) = 1),
  check (end_date is null or end_date >= start_date),
  foreign key (family_id, rider_id) references public.riders(family_id, id),
  foreign key (family_id, rider_member_id) references public.family_members(family_id, id),
  foreign key (family_id, place_id) references public.places(family_id, id),
  foreign key (family_id, place_id, pickup_point_id) references public.pickup_points(family_id, place_id, id),
  foreign key (family_id, default_assignee_member_id) references public.family_members(family_id, id),
  foreign key (family_id, default_vehicle_id) references public.vehicles(family_id, id)
);

create table public.pickups (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  rider_id uuid,
  rider_member_id uuid,
  source text not null check (source in ('request', 'routine')),
  routine_id uuid,
  occurrence_date date,
  is_customized boolean not null default false,
  assignment_round int not null default 0 check (assignment_round >= 0),
  status public.pickup_status not null default 'open',
  assignee_member_id uuid,
  vehicle_id uuid,
  place_id uuid,
  pickup_point_id uuid,
  location_source public.location_source not null,
  location_confirmed boolean not null,
  dest_lat double precision not null check (dest_lat between -90 and 90),
  dest_lng double precision not null check (dest_lng between -180 and 180),
  dest_label text not null check (char_length(btrim(dest_label)) between 1 and 40),
  pin_note text check (char_length(pin_note) <= 40),
  destination_revision int not null default 1 check (destination_revision > 0),
  nav_session_id uuid,
  nav_destination_revision int,
  nav_status text not null default 'none' check (nav_status in ('none', 'requested', 'ok', 'failed')),
  last_start_action_id uuid,
  wanted_at timestamptz not null,
  accepted_at timestamptz,
  en_route_at timestamptz,
  arrived_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason in ('cancelled', 'skipped', 'not_met')),
  expired_at timestamptz,
  rider_ready_at timestamptz,
  not_met_reported_at timestamptz,
  version int not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (family_id, id),
  unique (routine_id, occurrence_date),
  check (num_nonnulls(rider_id, rider_member_id) = 1),
  check (rider_member_id is null or rider_member_id is distinct from assignee_member_id),
  check ((source = 'routine' and num_nonnulls(routine_id, occurrence_date) = 2)
      or (source = 'request' and num_nonnulls(routine_id, occurrence_date) = 0)),
  check (status = 'cancelled' or (status in ('open', 'expired')) = (assignee_member_id is null)),
  check (location_source = 'gps' or location_confirmed),
  check (location_source <> 'saved_place' or place_id is not null),
  check (pickup_point_id is null or place_id is not null),
  check ((location_source = 'saved_point') = (pickup_point_id is not null)),
  check (vehicle_id is null or assignee_member_id is not null),
  foreign key (family_id, rider_id) references public.riders(family_id, id),
  foreign key (family_id, rider_member_id) references public.family_members(family_id, id),
  foreign key (family_id, routine_id) references public.routines(family_id, id),
  foreign key (family_id, assignee_member_id) references public.family_members(family_id, id),
  foreign key (family_id, vehicle_id) references public.vehicles(family_id, id),
  foreign key (family_id, place_id) references public.places(family_id, id),
  foreign key (family_id, place_id, pickup_point_id) references public.pickup_points(family_id, place_id, id)
);
alter table public.vehicles add foreign key (family_id, active_pickup_id) references public.pickups(family_id, id);
create unique index pickups_one_active_rider_request on public.pickups(rider_id)
  where source = 'request' and rider_id is not null and status in ('open', 'assigned', 'en_route', 'arrived');
create unique index pickups_one_active_member_request on public.pickups(rider_member_id)
  where source = 'request' and rider_member_id is not null and status in ('open', 'assigned', 'en_route', 'arrived');
create index pickups_family_wanted on public.pickups(family_id, wanted_at);
create index pickups_vehicle_active on public.pickups(vehicle_id)
  where status in ('assigned', 'en_route', 'arrived');

create table public.pickup_offers (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  pickup_id uuid not null,
  origin text not null check (origin in ('request', 'routine', 'guardian', 'vehicle')),
  from_member_id uuid,
  to_member_id uuid,
  note text check (char_length(note) <= 40),
  status public.offer_status not null default 'pending',
  expires_at timestamptz not null,
  resolved_at timestamptz,
  resolved_by_member_id uuid,
  created_at timestamptz not null default now(),
  unique (family_id, id),
  check (from_member_id is null or from_member_id is distinct from to_member_id),
  foreign key (family_id, pickup_id) references public.pickups(family_id, id) on delete cascade,
  foreign key (family_id, from_member_id) references public.family_members(family_id, id),
  foreign key (family_id, to_member_id) references public.family_members(family_id, id),
  foreign key (family_id, resolved_by_member_id) references public.family_members(family_id, id)
);
create unique index pickup_offers_one_pending on public.pickup_offers(pickup_id) where status = 'pending';
create index pickup_offers_pickup on public.pickup_offers(pickup_id);

create table public.offer_responses (
  family_id uuid not null,
  offer_id uuid not null,
  member_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (offer_id, member_id),
  foreign key (family_id, offer_id) references public.pickup_offers(family_id, id) on delete cascade,
  foreign key (family_id, member_id) references public.family_members(family_id, id)
);

create table public.pickup_events (
  id bigint generated always as identity primary key,
  family_id uuid not null,
  pickup_id uuid not null,
  actor_kind text not null check (actor_kind in ('guardian', 'rider', 'vehicle', 'system')),
  actor_id uuid,
  event_type text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (family_id, pickup_id) references public.pickups(family_id, id) on delete cascade
);
create index pickup_events_pickup on public.pickup_events(pickup_id, id);

create function deriro_private.member_family()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select m.family_id from public.family_members m join auth.users u on u.id = m.auth_user_id
    where m.auth_user_id = (select auth.uid()) and m.left_at is null and not u.is_anonymous
$$;
revoke execute on function deriro_private.member_family() from public, anon, authenticated, service_role;
grant execute on function deriro_private.member_family() to authenticated;

create function deriro_private.member_id(p_drive_only boolean)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select m.id from public.family_members m join auth.users u on u.id = m.auth_user_id
    where m.auth_user_id = (select auth.uid()) and m.left_at is null and not u.is_anonymous
      and (not p_drive_only or m.can_drive)
$$;
revoke execute on function deriro_private.member_id(boolean) from public, anon, authenticated, service_role;
grant execute on function deriro_private.member_id(boolean) to authenticated;

do $$
declare
  tab text;
begin
  foreach tab in array array[
    'families', 'family_members', 'riders', 'rider_devices', 'vehicles', 'vehicle_states',
    'places', 'pickup_points', 'routines', 'pickups', 'pickup_offers', 'offer_responses', 'pickup_events'
  ] loop
    execute format('alter table public.%I enable row level security', tab);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', tab);
  end loop;
  foreach tab in array array['family_members', 'riders', 'vehicles', 'places', 'pickup_points', 'routines', 'pickups'] loop
    execute format(
      'create policy family_select on public.%I for select to authenticated using (family_id = (select deriro_private.member_family()))',
      tab
    );
  end loop;
end
$$;

create policy family_select on public.families for select to authenticated
  using (id = (select deriro_private.member_family()));
create policy offer_select on public.pickup_offers for select to authenticated
  using (family_id = (select deriro_private.member_family())
    and (from_member_id = (select deriro_private.member_id(false)) or (
      (select deriro_private.member_id(true)) is not null
      and (to_member_id is null or to_member_id = (select deriro_private.member_id(true)))
      and exists (select 1 from public.pickups p where p.id = pickup_id
        and p.rider_member_id is distinct from (select deriro_private.member_id(true)))
    )));

grant select on public.families, public.places, public.pickup_points, public.routines,
  public.pickups, public.pickup_offers to authenticated;
grant select (id, family_id, display_name, role, can_request, can_drive, left_at)
  on public.family_members to authenticated;
grant select (id, family_id, display_name, kind, consent_basis, archived_at)
  on public.riders to authenticated;
grant select (id, family_id, nickname, current_driver_member_id, revoked_at)
  on public.vehicles to authenticated;

create function deriro_private.version_pickup()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  if row(new.dest_lat, new.dest_lng, new.dest_label, new.location_source, new.place_id, new.pickup_point_id, new.pin_note)
    is distinct from row(old.dest_lat, old.dest_lng, old.dest_label, old.location_source, old.place_id, old.pickup_point_id, old.pin_note)
  then
    new.destination_revision := old.destination_revision + 1;
  end if;
  if new.assignee_member_id is distinct from old.assignee_member_id then
    new.assignment_round := old.assignment_round + 1;
  end if;
  if row(new.status, new.assignee_member_id, new.vehicle_id, new.destination_revision,
         new.wanted_at, new.location_confirmed, new.rider_ready_at, new.accepted_at)
    is distinct from row(old.status, old.assignee_member_id, old.vehicle_id, old.destination_revision,
         old.wanted_at, old.location_confirmed, old.rider_ready_at, old.accepted_at)
  then
    new.version := old.version + 1;
  end if;
  return new;
end
$$;
create trigger version_pickup before update on public.pickups
  for each row execute function deriro_private.version_pickup();
revoke execute on function deriro_private.version_pickup() from public, anon, authenticated, service_role;
