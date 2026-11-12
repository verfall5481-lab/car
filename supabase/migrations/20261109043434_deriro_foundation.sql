-- Schema foundation: every table, column, constraint, index, RLS policy and table grant.
-- Later migrations add functions and triggers only, so each file is valid when applied in order.
create schema deriro_private;
revoke all on schema deriro_private from public, anon, authenticated, service_role;
grant usage on schema deriro_private to authenticated, service_role;
-- Per-schema default privileges cannot remove PostgreSQL's built-in PUBLIC execute grant.
-- Every function therefore revokes execute explicitly where it is created.
alter default privileges in schema deriro_private revoke execute on functions from public, anon, authenticated, service_role;

create type public.pickup_status as enum (
  'open', 'assigned', 'en_route', 'arrived', 'completed', 'cancelled', 'expired', 'closed_unconfirmed'
);
create type public.offer_status as enum ('pending', 'accepted', 'declined', 'expired', 'cancelled', 'superseded');
create type public.location_source as enum ('saved_point', 'saved_place', 'map_pin', 'gps');
create type public.outbox_status as enum ('pending', 'sending', 'sent', 'skipped', 'failed');

create table public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 40),
  created_at timestamptz not null default now(),
  timezone text not null default 'Asia/Seoul',
  is_demo boolean not null default false,
  demo_time_scale int not null default 1 check (demo_time_scale between 1 and 60)
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
  phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  sms_opt_in boolean not null default false,
  unique (family_id, id)
);
create unique index family_members_active_user on public.family_members(auth_user_id) where left_at is null;
create unique index family_members_active_owner on public.family_members(family_id) where role = 'owner' and left_at is null;
create unique index family_members_active_name on public.family_members(family_id, display_name) where left_at is null;

create table public.riders (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 20),
  kind text not null check (kind in ('child', 'adult')),
  birth_year int,
  consent_basis text not null check (consent_basis in ('guardian', 'self')),
  location_consented_at timestamptz,
  archived_at timestamptz,
  phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  check (kind <> 'adult' or consent_basis = 'self'),
  unique (family_id, id)
);
create unique index riders_active_name on public.riders(family_id, display_name) where archived_at is null;

create table public.rider_devices (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  rider_id uuid not null,
  auth_user_id uuid not null references auth.users on delete cascade,
  revoked_at timestamptz,
  user_agent text,
  last_seen_at timestamptz not null default now(),
  foreign key (family_id, rider_id) references public.riders(family_id, id)
);
create unique index rider_devices_active_auth on public.rider_devices(auth_user_id) where revoked_at is null;
create index rider_devices_rider_active on public.rider_devices(rider_id) where revoked_at is null;

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
create unique index vehicles_active_name on public.vehicles(family_id, nickname) where revoked_at is null;

-- Deliberately service-owned. Unknown or stale gear never authorizes a parked-only operation.
-- Constraint names are part of the RPC contract: vehicle_operation maps exactly these to VALIDATION.
create table public.vehicle_states (
  vehicle_id uuid primary key references public.vehicles on delete cascade,
  gear text not null constraint vehicle_states_gear_check check (gear in ('P', 'R', 'N', 'D', 'unknown')),
  collected_at timestamptz not null,
  range_km double precision constraint vehicle_states_range_km_check check (range_km between 0 and 3000),
  fuel_pct double precision constraint vehicle_states_fuel_pct_check check (fuel_pct between 0 and 100),
  soc_pct double precision constraint vehicle_states_soc_pct_check check (soc_pct between 0 and 100),
  energy_type text constraint vehicle_states_energy_type_check check (energy_type in
    ('ice','hev','phev','bev','fcev','gasoline','diesel','hybrid','electric','hydrogen','unknown')),
  ignition text constraint vehicle_states_ignition_check check (ignition in ('off','acc','on','unknown')),
  lat double precision constraint vehicle_states_lat_check check (lat between -90 and 90),
  lng double precision constraint vehicle_states_lng_check check (lng between -180 and 180),
  location_at timestamptz,
  is_demo_value boolean not null default false,
  constraint vehicle_states_location_check check (num_nonnulls(lat, lng, location_at) in (0, 3))
);

create table public.places (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 40),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  radius_m int not null default 150 check (radius_m between 50 and 500),
  archived_at timestamptz,
  kind text not null default 'other' check (kind in ('home','school','academy','other')),
  -- 24.2 "못 갈 때 안내": shown to the requester when nobody can go. Saved trimmed; an empty input is stored as null.
  fallback_note text check (fallback_note is null or char_length(btrim(fallback_note)) between 1 and 40),
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
  active boolean not null default true,
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
  cancel_reason text check (cancel_reason in (
    'cancelled','skipped','not_met','resolved_by_phone','mistake','other_way_home','other','routine_archived','child_cancelled',
    'no_driver'
  )),
  expired_at timestamptz,
  rider_ready_at timestamptz,
  not_met_reported_at timestamptz,
  version int not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  routine_offer_created_at timestamptz,
  closed_unconfirmed_at timestamptz,
  arrived_source text check (arrived_source in ('nav_callback','manual')),
  completed_by_kind text check (completed_by_kind in ('guardian','rider','vehicle')),
  cancelled_by_kind text check (cancelled_by_kind in ('guardian','rider','vehicle','system')),
  raw_lat double precision check (raw_lat between -90 and 90),
  raw_lng double precision check (raw_lng between -180 and 180),
  raw_accuracy_m double precision check (raw_accuracy_m >= 0),
  -- 24.2 "못 간다고 알리기": the line the requester should do instead, who said so, and the requester's "알겠어".
  fallback_note text check (fallback_note is null or char_length(btrim(fallback_note)) between 1 and 40),
  fallback_by_member_id uuid,
  fallback_ack_at timestamptz,
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
  -- A no_driver cancellation always says what to do instead and who said it; only it can be acknowledged.
  check (cancel_reason is distinct from 'no_driver'
    or (status = 'cancelled' and fallback_note is not null and fallback_by_member_id is not null)),
  check (num_nonnulls(fallback_note, fallback_by_member_id, fallback_ack_at) = 0 or cancel_reason = 'no_driver'),
  foreign key (family_id, rider_id) references public.riders(family_id, id),
  foreign key (family_id, rider_member_id) references public.family_members(family_id, id),
  foreign key (family_id, routine_id) references public.routines(family_id, id),
  foreign key (family_id, assignee_member_id) references public.family_members(family_id, id),
  foreign key (family_id, vehicle_id) references public.vehicles(family_id, id),
  foreign key (family_id, place_id) references public.places(family_id, id),
  foreign key (family_id, place_id, pickup_point_id) references public.pickup_points(family_id, place_id, id),
  foreign key (family_id, fallback_by_member_id) references public.family_members(family_id, id)
);
alter table public.vehicles add foreign key (family_id, active_pickup_id) references public.pickups(family_id, id);
create unique index pickups_one_active_rider_request on public.pickups(rider_id)
  where source = 'request' and rider_id is not null and status in ('open', 'assigned', 'en_route', 'arrived');
create unique index pickups_one_active_member_request on public.pickups(rider_member_id)
  where source = 'request' and rider_member_id is not null and status in ('open', 'assigned', 'en_route', 'arrived');
create index pickups_family_wanted on public.pickups(family_id, wanted_at);
create index pickups_vehicle_active on public.pickups(vehicle_id)
  where status in ('assigned', 'en_route', 'arrived');
create index pickups_rider_feed on public.pickups(rider_id, wanted_at) where rider_id is not null;
create index pickups_escalations on public.pickups(status, wanted_at) where status in ('open','assigned','arrived');

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
create index offers_expiry on public.pickup_offers(expires_at) where status = 'pending';

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

-- 24.2 "못 가는 날": a date (family time zone) a guardian cannot drive. Written only by set_unavailable_day; family
-- members read it. Rows of past dates are removed by the daily retention pass (7.3).
create table public.member_unavailable_days (
  family_id uuid not null references public.families on delete cascade,
  member_id uuid not null,
  day date not null,
  created_at timestamptz not null default now(),
  primary key (member_id, day),
  foreign key (family_id, member_id) references public.family_members(family_id, id) on delete cascade
);
create index member_unavailable_days_family on public.member_unavailable_days(family_id, day);

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  member_id uuid,
  rider_id uuid,
  granted_by_member_id uuid,
  granted_by_rider_id uuid,
  purpose text not null check (purpose in ('privacy','member_location','rider_location')),
  version text not null check (char_length(version) between 1 and 40),
  granted_at timestamptz not null default now(),
  check (num_nonnulls(member_id, rider_id) = 1),
  check (num_nonnulls(granted_by_member_id, granted_by_rider_id) = 1),
  foreign key (family_id, member_id) references public.family_members(family_id, id) on delete cascade,
  foreign key (family_id, rider_id) references public.riders(family_id, id) on delete cascade,
  foreign key (family_id, granted_by_member_id) references public.family_members(family_id, id) on delete cascade,
  foreign key (family_id, granted_by_rider_id) references public.riders(family_id, id) on delete cascade
);

create table public.vehicle_alerts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  vehicle_id uuid not null,
  type text not null default 'low_range' check (type = 'low_range'),
  range_km double precision not null,
  required_km double precision not null,
  pickup_count int not null,
  pickup_ids uuid[] not null,
  alert_revision int not null default 1,
  is_demo_value boolean not null,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (family_id, vehicle_id) references public.vehicles(family_id, id) on delete cascade
);
create unique index vehicle_alert_open on public.vehicle_alerts(vehicle_id) where resolved_at is null;
create index vehicle_alert_family on public.vehicle_alerts(family_id) where resolved_at is null;

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  auth_user_id uuid not null references auth.users on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index push_subscriptions_principal on public.push_subscriptions(auth_user_id);

create table public.notifications_outbox (
  id bigint generated always as identity primary key,
  family_id uuid not null references public.families on delete cascade,
  pickup_id uuid,
  offer_id uuid,
  vehicle_alert_id uuid references public.vehicle_alerts on delete cascade,
  recipient_member_id uuid,
  recipient_rider_id uuid,
  channel text not null check (channel in ('push','sms','geo')),
  template text not null,
  payload jsonb not null default '{}',
  expected_status public.pickup_status,
  expected_assignment_round int,
  expected_offer_status public.offer_status,
  driver_only boolean not null default false,
  dedupe_key text not null unique,
  status public.outbox_status not null default 'pending',
  attempts int not null default 0 check (attempts between 0 and 4),
  scheduled_at timestamptz not null default now(),
  claim_token uuid,
  lease_until timestamptz,
  last_error text,
  sent_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  -- Web Push subscriptions that already accepted this job. A retry sends only to the others.
  delivered_subscription_ids uuid[] not null default '{}',
  check (num_nonnulls(recipient_member_id,recipient_rider_id) = case when channel='geo' then 0 else 1 end),
  check ((status='sending') = (claim_token is not null and lease_until is not null)),
  foreign key (family_id,pickup_id) references public.pickups(family_id,id) on delete cascade,
  foreign key (family_id,offer_id) references public.pickup_offers(family_id,id) on delete cascade,
  foreign key (family_id,recipient_member_id) references public.family_members(family_id,id) on delete cascade,
  foreign key (family_id,recipient_rider_id) references public.riders(family_id,id) on delete cascade
);
create index notifications_outbox_due on public.notifications_outbox(scheduled_at,id) where status='pending';
create index notifications_outbox_leases on public.notifications_outbox(lease_until,id) where status='sending';
create index notifications_outbox_offer on public.notifications_outbox(offer_id) where status='pending';
create index notifications_outbox_pickup_pending on public.notifications_outbox(pickup_id) where status='pending';
create index notifications_outbox_retention on public.notifications_outbox(finished_at) where finished_at is not null;

create table public.family_feed_changes (
  id bigint generated always as identity primary key,
  family_id uuid not null references public.families on delete cascade,
  created_at timestamptz not null default now()
);
create index family_feed_changes_family on public.family_feed_changes(family_id,created_at);

create table deriro_private.code_secret (
  singleton boolean primary key default true check (singleton),
  pepper text not null
);
insert into deriro_private.code_secret(pepper) values (gen_random_uuid()::text || gen_random_uuid()::text);

create table deriro_private.link_codes (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('family','rider','vehicle')),
  code_hash bytea not null unique,
  family_id uuid references public.families on delete cascade,
  member_id uuid,
  rider_id uuid,
  vehicle_auth_user_id uuid references auth.users on delete cascade,
  channel text check (channel in ('qr','sms')),
  used_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (family_id, member_id) references public.family_members(family_id, id) on delete cascade,
  foreign key (family_id, rider_id) references public.riders(family_id, id) on delete cascade
);
create index link_codes_rider on deriro_private.link_codes(rider_id, created_at) where rider_id is not null;
create index link_codes_vehicle on deriro_private.link_codes(vehicle_auth_user_id) where kind = 'vehicle';

create table deriro_private.rate_limits (
  principal uuid not null,
  action text not null,
  hits int not null default 1,
  resets_at timestamptz not null,
  primary key (principal, action)
);

create table deriro_private.sms_reservations (
  family_id uuid not null references public.families on delete cascade,
  local_day date not null,
  reference_key text not null,
  primary key (family_id,local_day,reference_key)
);

create table deriro_private.pickup_declines (
  pickup_id uuid references public.pickups on delete cascade,
  member_id uuid references public.family_members on delete cascade,
  primary key (pickup_id, member_id)
);

create table deriro_private.escalation_checks (
  pickup_id uuid primary key references public.pickups on delete cascade,
  checked_at timestamptz not null
);

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
    'places', 'pickup_points', 'routines', 'pickups', 'pickup_offers', 'offer_responses', 'pickup_events',
    'member_unavailable_days', 'consents', 'vehicle_alerts', 'push_subscriptions', 'notifications_outbox', 'family_feed_changes'
  ] loop
    execute format('alter table public.%I enable row level security', tab);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', tab);
  end loop;
  foreach tab in array array['code_secret', 'link_codes', 'rate_limits', 'sms_reservations', 'pickup_declines', 'escalation_checks'] loop
    execute format('alter table deriro_private.%I enable row level security', tab);
  end loop;
  foreach tab in array array['family_members', 'riders', 'vehicles', 'places', 'pickup_points', 'routines', 'pickups',
    'member_unavailable_days'] loop
    execute format(
      'create policy family_select on public.%I for select to authenticated using (family_id = (select deriro_private.member_family()))',
      tab
    );
  end loop;
end
$$;
-- Supabase's default privileges grant every new public sequence to the API roles. Identity values are drawn only by
-- the privileged RPC implementations that own the inserts, so neither a client role nor the service role keeps them.
revoke all on all sequences in schema public from public, anon, authenticated, service_role;

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
create policy family_feed_change_select on public.family_feed_changes for select to authenticated
  using (family_id = (select deriro_private.member_family()));

grant select on public.families, public.places, public.pickup_points, public.routines,
  public.pickup_offers, public.family_feed_changes, public.member_unavailable_days to authenticated;
grant select (id, family_id, display_name, role, can_request, can_drive, left_at)
  on public.family_members to authenticated;
grant select (id, family_id, display_name, kind, consent_basis, archived_at)
  on public.riders to authenticated;
grant select (id, family_id, nickname, current_driver_member_id, revoked_at)
  on public.vehicles to authenticated;
-- Keep raw fixes and navigation internals off the direct API. Feed RPCs also strip the raw fields.
grant select (id, family_id, rider_id, rider_member_id, source, routine_id, occurrence_date, is_customized, assignment_round,
  status, assignee_member_id, vehicle_id, place_id, pickup_point_id, location_source, location_confirmed, dest_lat,
  dest_lng, dest_label, pin_note, destination_revision, nav_status, wanted_at, accepted_at, en_route_at, arrived_at,
  completed_at, cancelled_at, cancel_reason, expired_at, rider_ready_at, not_met_reported_at, version, created_at, updated_at,
  closed_unconfirmed_at, arrived_source, completed_by_kind, cancelled_by_kind, fallback_note, fallback_by_member_id,
  fallback_ack_at) on public.pickups to authenticated;

do $$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.family_feed_changes, public.pickup_offers;
  end if;
end
$$;

-- deriro.label_refresh names the one pickup whose approximate area label the geo worker is writing.
-- That label is display text for an unconfirmed fix, so it must not invalidate versions or navigation.
create function deriro_private.version_pickup()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  label_refresh boolean := coalesce(current_setting('deriro.label_refresh', true), '') = new.id::text;
begin
  new.updated_at := now();
  if row(new.dest_lat, new.dest_lng, new.location_source, new.place_id, new.pickup_point_id, new.pin_note)
    is distinct from row(old.dest_lat, old.dest_lng, old.location_source, old.place_id, old.pickup_point_id, old.pin_note)
    or (new.dest_label is distinct from old.dest_label and not label_refresh)
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
