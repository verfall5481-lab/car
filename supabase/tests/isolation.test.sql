-- Tenant isolation and role permissions: SPEC 2.1-2.2, 7.4-7.6, 8.1-8.2 and 23 (v0.4 riders, can_request, can_drive).
--
-- Family A is the family under test, family B the other tenant and family D a demo family. Every client call goes
-- through pg_temp.script, which impersonates a principal (role plus JWT subject), records the response or the raised
-- SQLSTATE, fingerprints every row of every table per family before and after, and rolls the call back unless asked
-- to keep it. A rejected call must therefore leave every fingerprint unchanged, and an accepted one may change only
-- its own family's rows.
--
-- Sections: catalog privileges, direct table access, the role matrix (every public RPC against every family A
-- principal), cross-family calls (every id-taking RPC called by family B with family A's ids, compared with an
-- unknown id), code capabilities and feeds, state-dependent scenarios, and finally scenarios that keep their changes.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

create function pg_temp.fixture(n int) returns uuid language sql immutable
  as $$ select ('70000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;

-- Principals. side A: the matrix columns (family A principals plus unbound, anon and service roles).
-- family: the family whose rows the principal may read directly. Only active guardians read tables.
create temp table principal(name text primary key, role text not null, uid uuid, family uuid, side text not null, ord int not null);
insert into principal values
  ('a_owner',           'authenticated', pg_temp.fixture(101), pg_temp.fixture(1), 'A', 1),
  ('a_guardian',        'authenticated', pg_temp.fixture(102), pg_temp.fixture(1), 'A', 2),
  ('a_limited',         'authenticated', pg_temp.fixture(103), pg_temp.fixture(1), 'A', 3),
  ('a_left',            'authenticated', pg_temp.fixture(104), null,               'A', 4),
  ('a_rider',           'authenticated', pg_temp.fixture(105), null,               'A', 5),
  ('a_rider2',          'authenticated', pg_temp.fixture(106), null,               'A', 6),
  ('a_revoked_rider',   'authenticated', pg_temp.fixture(107), null,               'A', 7),
  ('a_vehicle',         'authenticated', pg_temp.fixture(108), null,               'A', 8),
  ('a_revoked_vehicle', 'authenticated', pg_temp.fixture(109), null,               'A', 9),
  ('stray',             'authenticated', pg_temp.fixture(110), null,               'A', 10),
  ('fresh',             'authenticated', pg_temp.fixture(111), null,               'A', 11),
  ('anon',              'anon',          null,                 null,               'A', 12),
  ('service',           'service_role',  null,                 null,               'A', 13),
  ('b_owner',           'authenticated', pg_temp.fixture(121), pg_temp.fixture(2), 'B', 14),
  ('b_rider',           'authenticated', pg_temp.fixture(122), null,               'B', 15),
  ('b_vehicle',         'authenticated', pg_temp.fixture(123), null,               'B', 16),
  ('d_owner',           'authenticated', pg_temp.fixture(131), pg_temp.fixture(3), 'D', 17),
  ('d_guardian',        'authenticated', pg_temp.fixture(132), pg_temp.fixture(3), 'D', 18);

-- Named fixture rows. Templates refer to them as {a:name} (family A, replaced by an unknown id for the
-- nonexistence comparison), {b:name} (family B), {v:name} (the pickup's current version) and {s:name} (saved text).
create temp table fx(name text primary key, id uuid not null, family text not null);
insert into fx values
  ('fam_a', pg_temp.fixture(1), 'A'), ('fam_b', pg_temp.fixture(2), 'B'), ('fam_d', pg_temp.fixture(3), 'D'),
  ('m_owner', pg_temp.fixture(201), 'A'), ('m_guardian', pg_temp.fixture(202), 'A'), ('m_limited', pg_temp.fixture(203), 'A'),
  ('m_left', pg_temp.fixture(204), 'A'), ('m_b_owner', pg_temp.fixture(221), 'B'), ('m_b_guardian', pg_temp.fixture(222), 'B'),
  ('m_d_owner', pg_temp.fixture(231), 'D'), ('m_d_guardian', pg_temp.fixture(232), 'D'),
  ('r_child', pg_temp.fixture(301), 'A'), ('r_adult', pg_temp.fixture(302), 'A'), ('r_revoked', pg_temp.fixture(303), 'A'),
  ('r_spare', pg_temp.fixture(304), 'A'), ('r_b', pg_temp.fixture(321), 'B'), ('r_b2', pg_temp.fixture(322), 'B'), ('r_b3', pg_temp.fixture(323), 'B'),
  ('dev_child', pg_temp.fixture(401), 'A'), ('dev_adult', pg_temp.fixture(402), 'A'), ('dev_revoked', pg_temp.fixture(403), 'A'),
  ('dev_b', pg_temp.fixture(421), 'B'),
  ('place_home', pg_temp.fixture(501), 'A'), ('place_school', pg_temp.fixture(502), 'A'), ('point_gate', pg_temp.fixture(511), 'A'),
  ('place_b', pg_temp.fixture(521), 'B'), ('point_b', pg_temp.fixture(531), 'B'),
  ('car', pg_temp.fixture(601), 'A'), ('car_revoked', pg_temp.fixture(602), 'A'), ('car_b', pg_temp.fixture(621), 'B'),
  ('routine', pg_temp.fixture(701), 'A'),
  ('k_open', pg_temp.fixture(801), 'A'), ('k_assigned', pg_temp.fixture(802), 'A'), ('k_arrived_member', pg_temp.fixture(803), 'A'),
  ('k_routine_open', pg_temp.fixture(804), 'A'), ('k_en_route', pg_temp.fixture(805), 'A'),
  ('k_routine_arrived', pg_temp.fixture(806), 'A'), ('k_no_driver', pg_temp.fixture(807), 'A'), ('k_b_open', pg_temp.fixture(821), 'B'), ('k_b_assigned', pg_temp.fixture(822), 'B'), ('k_b_taken', pg_temp.fixture(823), 'B'),
  ('k_d_open', pg_temp.fixture(831), 'D'),
  ('offer_open', pg_temp.fixture(901), 'A'), ('offer_handoff', pg_temp.fixture(902), 'A'), ('offer_b', pg_temp.fixture(921), 'B'),
  ('alert', pg_temp.fixture(951), 'A'), ('push_owner', pg_temp.fixture(961), 'A'), ('push_b', pg_temp.fixture(962), 'B'),
  ('nav_session', pg_temp.fixture(991), 'A'), ('nav_action', pg_temp.fixture(992), 'A');

-- Saved text: codes issued below, push endpoints. marker: text that identifies a family in a response.
create temp table saved(name text primary key, value text not null);
insert into saved values
  ('owner_endpoint', 'https://fcm.googleapis.com/fcm/send/isolation-owner'),
  ('b_endpoint', 'https://fcm.googleapis.com/fcm/send/isolation-b-owner');
create temp table marker(family text not null, value text not null);
insert into marker values ('A', '격리 가족 A'), ('A', '+821000000201'), ('A', '+821000000202'), ('A', '+821000000301'),
  ('A', 'isolation-owner'), ('B', '격리 가족 B'), ('B', '+821000000221'), ('B', 'isolation-b-owner'), ('D', '격리 데모 가족');

-- Fixture data, written directly as the migration owner.
insert into auth.users(id, is_anonymous) values
  (pg_temp.fixture(101), false), (pg_temp.fixture(102), false), (pg_temp.fixture(103), false), (pg_temp.fixture(104), false),
  (pg_temp.fixture(105), true), (pg_temp.fixture(106), true), (pg_temp.fixture(107), true), (pg_temp.fixture(108), true),
  (pg_temp.fixture(109), true), (pg_temp.fixture(110), true), (pg_temp.fixture(111), false),
  (pg_temp.fixture(121), false), (pg_temp.fixture(122), true), (pg_temp.fixture(123), true),
  (pg_temp.fixture(131), false), (pg_temp.fixture(132), false);
insert into public.families(id, name, is_demo) values
  (pg_temp.fixture(1), '격리 가족 A', false), (pg_temp.fixture(2), '격리 가족 B', false), (pg_temp.fixture(3), '격리 데모 가족', true);
insert into public.family_members(id, family_id, auth_user_id, display_name, role, can_drive, can_request,
  location_consented_at, left_at, phone_e164, sms_opt_in) values
  (pg_temp.fixture(201), pg_temp.fixture(1), pg_temp.fixture(101), '엄마', 'owner', true, true, now(), null, '+821000000201', true),
  (pg_temp.fixture(202), pg_temp.fixture(1), pg_temp.fixture(102), '아빠', 'guardian', true, true, now(), null, '+821000000202', false),
  (pg_temp.fixture(203), pg_temp.fixture(1), pg_temp.fixture(103), '할아버지', 'guardian', false, false, now(), null, null, false),
  (pg_temp.fixture(204), pg_temp.fixture(1), pg_temp.fixture(104), '떠난 이모', 'guardian', true, true, null, now() - interval '1 day', null, false),
  (pg_temp.fixture(221), pg_temp.fixture(2), pg_temp.fixture(121), '옆집 엄마', 'owner', true, true, now(), null, '+821000000221', true),
  (pg_temp.fixture(222), pg_temp.fixture(2), null, '옆집 아빠', 'guardian', true, true, now(), null, null, false),
  (pg_temp.fixture(231), pg_temp.fixture(3), pg_temp.fixture(131), '데모 엄마', 'owner', true, true, now(), null, null, false),
  (pg_temp.fixture(232), pg_temp.fixture(3), pg_temp.fixture(132), '데모 아빠', 'guardian', true, true, now(), null, null, false);
insert into public.riders(id, family_id, display_name, kind, consent_basis, location_consented_at, birth_year, phone_e164) values
  (pg_temp.fixture(301), pg_temp.fixture(1), '민준', 'child', 'guardian', now(), 2017, '+821000000301'),
  (pg_temp.fixture(302), pg_temp.fixture(1), '할머니', 'adult', 'self', now(), 1950, null),
  (pg_temp.fixture(303), pg_temp.fixture(1), '서연', 'child', 'guardian', now(), 2016, null),
  (pg_temp.fixture(304), pg_temp.fixture(1), '지우', 'child', 'guardian', now(), 2018, null),
  (pg_temp.fixture(321), pg_temp.fixture(2), '옆집 아이', 'child', 'guardian', now(), 2017, null),
  (pg_temp.fixture(322), pg_temp.fixture(2), '옆집 할머니', 'adult', 'self', now(), 1948, null),
  (pg_temp.fixture(323), pg_temp.fixture(2), '옆집 막내', 'child', 'guardian', now(), 2019, null);
insert into public.rider_devices(id, family_id, rider_id, auth_user_id, revoked_at) values
  (pg_temp.fixture(401), pg_temp.fixture(1), pg_temp.fixture(301), pg_temp.fixture(105), null),
  (pg_temp.fixture(402), pg_temp.fixture(1), pg_temp.fixture(302), pg_temp.fixture(106), null),
  (pg_temp.fixture(403), pg_temp.fixture(1), pg_temp.fixture(303), pg_temp.fixture(107), now() - interval '1 day'),
  (pg_temp.fixture(421), pg_temp.fixture(2), pg_temp.fixture(321), pg_temp.fixture(122), null);
insert into public.places(id, family_id, label, kind, lat, lng) values
  (pg_temp.fixture(501), pg_temp.fixture(1), '집', 'home', 37.5, 127.0),
  (pg_temp.fixture(502), pg_temp.fixture(1), '학교', 'school', 37.55, 127.05),
  (pg_temp.fixture(521), pg_temp.fixture(2), '옆집', 'home', 37.5001, 127.0001);
insert into public.pickup_points(id, family_id, place_id, label, lat, lng, note) values
  (pg_temp.fixture(511), pg_temp.fixture(1), pg_temp.fixture(502), '정문', 37.5502, 127.0502, '정문 벤치'),
  (pg_temp.fixture(531), pg_temp.fixture(2), pg_temp.fixture(521), '대문', 37.5002, 127.0002, null);
insert into public.vehicles(id, family_id, auth_user_id, nickname, current_driver_member_id, revoked_at) values
  (pg_temp.fixture(601), pg_temp.fixture(1), pg_temp.fixture(108), '우리 차', pg_temp.fixture(202), null),
  (pg_temp.fixture(602), pg_temp.fixture(1), pg_temp.fixture(109), '예전 차', null, now() - interval '1 day'),
  (pg_temp.fixture(621), pg_temp.fixture(2), pg_temp.fixture(123), '옆집 차', pg_temp.fixture(221), null);
insert into public.vehicle_states(vehicle_id, gear, collected_at) values
  (pg_temp.fixture(601), 'P', now()), (pg_temp.fixture(621), 'P', now());
insert into public.routines(id, family_id, rider_id, place_id, weekdays, time_local, default_assignee_member_id,
  default_vehicle_id, start_date)
values (pg_temp.fixture(701), pg_temp.fixture(1), pg_temp.fixture(301), pg_temp.fixture(502), 127, '23:59', pg_temp.fixture(201),
  pg_temp.fixture(601), (now() at time zone 'Asia/Seoul')::date);
insert into public.pickups(id, family_id, rider_id, rider_member_id, source, routine_id, occurrence_date, status,
  assignee_member_id, vehicle_id, place_id, location_source, location_confirmed, dest_lat, dest_lng, dest_label, wanted_at,
  accepted_at, en_route_at, arrived_at, arrived_source, nav_session_id, nav_destination_revision, nav_status, last_start_action_id)
values
  -- A rider request waiting for a driver.
  (pg_temp.fixture(801), pg_temp.fixture(1), pg_temp.fixture(301), null, 'request', null, null, 'open', null, null, null,
    'map_pin', true, 37.501, 127.001, '정문 앞', now() + interval '5 minutes', null, null, null, null, null, null, 'none', null),
  -- Accepted by 아빠 with the family car; 아빠 has offered it to everyone (pending handoff).
  (pg_temp.fixture(802), pg_temp.fixture(1), pg_temp.fixture(303), null, 'request', null, null, 'assigned', pg_temp.fixture(202),
    pg_temp.fixture(601), null, 'map_pin', true, 37.502, 127.002, '후문 앞', now() + interval '20 minutes',
    now() - interval '1 minute', null, null, null, null, null, 'none', null),
  -- 엄마's own request, 아빠 arrived without the car.
  (pg_temp.fixture(803), pg_temp.fixture(1), null, pg_temp.fixture(201), 'request', null, null, 'arrived', pg_temp.fixture(202), null,
    null, 'map_pin', true, 37.503, 127.003, '병원 앞', now() - interval '10 minutes', now() - interval '15 minutes',
    now() - interval '12 minutes', now() - interval '1 minute', 'manual', null, null, 'none', null),
  -- Tomorrow's routine occurrence, still open. Tomorrow keeps it in the future for routine revisions at any hour.
  (pg_temp.fixture(804), pg_temp.fixture(1), pg_temp.fixture(301), null, 'routine', pg_temp.fixture(701),
    (now() at time zone 'Asia/Seoul')::date + 1, 'open', null, null, pg_temp.fixture(502), 'saved_place', true, 37.55, 127.05, '학교',
    now() + interval '3 hours', null, null, null, null, null, null, 'none', null),
  -- The car is guiding 아빠 to this request (current navigation session 991, revision 1).
  (pg_temp.fixture(805), pg_temp.fixture(1), pg_temp.fixture(304), null, 'request', null, null, 'en_route', pg_temp.fixture(202),
    pg_temp.fixture(601), null, 'map_pin', true, 37.504, 127.004, '학원 앞', now(), now() - interval '3 minutes',
    now() - interval '1 minute', null, null, pg_temp.fixture(991), 1, 'requested', pg_temp.fixture(992)),
  -- Yesterday's routine occurrence: 아빠 arrived in the car, the rider has not boarded.
  (pg_temp.fixture(806), pg_temp.fixture(1), pg_temp.fixture(301), null, 'routine', pg_temp.fixture(701),
    (now() at time zone 'Asia/Seoul')::date - 1, 'arrived', pg_temp.fixture(202), pg_temp.fixture(601), pg_temp.fixture(502),
    'saved_place', true, 37.55, 127.05, '학교', now() - interval '15 minutes', now() - interval '40 minutes',
    now() - interval '30 minutes', now() - interval '2 minutes', 'manual', null, null, 'none', null),
  (pg_temp.fixture(821), pg_temp.fixture(2), pg_temp.fixture(321), null, 'request', null, null, 'open', null, null, null,
    'map_pin', true, 37.5003, 127.0003, '옆집 앞', now() + interval '5 minutes', null, null, null, null, null, null, 'none', null),
  (pg_temp.fixture(822), pg_temp.fixture(2), pg_temp.fixture(322), null, 'request', null, null, 'assigned', pg_temp.fixture(221),
    pg_temp.fixture(621), null, 'map_pin', true, 37.5004, 127.0004, '옆집 뒤', now() + interval '20 minutes',
    now() - interval '1 minute', null, null, null, null, null, 'none', null),
  -- A request in the demo family, so demo resets and timers have something to act on.
  (pg_temp.fixture(831), pg_temp.fixture(3), null, pg_temp.fixture(232), 'request', null, null, 'open', null, null, null,
    'map_pin', true, 37.5006, 127.0006, '데모 정문', now() - interval '20 minutes', null, null, null, null, null, null, 'none', null),
  -- Held by the other guardian of family B, so family B's owner could take it over.
  (pg_temp.fixture(823), pg_temp.fixture(2), pg_temp.fixture(323), null, 'request', null, null, 'assigned', pg_temp.fixture(222),
    null, null, 'map_pin', true, 37.5005, 127.0005, '옆집 옆', now() + interval '30 minutes',
    now() - interval '1 minute', null, null, null, null, null, 'none', null);
-- 24.3 #20: 엄마 said nobody can go to 민준's earlier request; 민준 has not pressed "알겠어" yet.
insert into public.pickups(id, family_id, rider_id, source, status, location_source, location_confirmed, dest_lat, dest_lng,
  dest_label, wanted_at, cancelled_at, cancel_reason, cancelled_by_kind, is_customized, fallback_note, fallback_by_member_id)
values (pg_temp.fixture(807), pg_temp.fixture(1), pg_temp.fixture(301), 'request', 'cancelled', 'map_pin', true, 37.506, 127.006,
  '학원 앞', now() - interval '30 minutes', now() - interval '2 minutes', 'no_driver', 'guardian', true, '학원 안에서 기다리기',
  pg_temp.fixture(201));
-- 24.2 못 가는 날: 아빠 tomorrow in family A, the owner of family B tomorrow.
insert into public.member_unavailable_days(family_id, member_id, day) values
  (pg_temp.fixture(1), pg_temp.fixture(202), (now() at time zone 'Asia/Seoul')::date + 1),
  (pg_temp.fixture(2), pg_temp.fixture(221), (now() at time zone 'Asia/Seoul')::date + 1);
update public.vehicles set active_pickup_id = pg_temp.fixture(805), active_nav_session_id = pg_temp.fixture(991),
  active_destination_revision = 1 where id = pg_temp.fixture(601);
insert into public.pickup_offers(id, family_id, pickup_id, origin, from_member_id, to_member_id, status, expires_at) values
  (pg_temp.fixture(901), pg_temp.fixture(1), pg_temp.fixture(801), 'request', null, null, 'pending', now() + interval '65 minutes'),
  (pg_temp.fixture(902), pg_temp.fixture(1), pg_temp.fixture(802), 'guardian', pg_temp.fixture(202), null, 'pending', now() + interval '10 minutes'),
  (pg_temp.fixture(921), pg_temp.fixture(2), pg_temp.fixture(821), 'request', null, null, 'pending', now() + interval '65 minutes');
insert into public.offer_responses(family_id, offer_id, member_id) values (pg_temp.fixture(1), pg_temp.fixture(902), pg_temp.fixture(203));
insert into public.pickup_events(family_id, pickup_id, actor_kind, event_type) values
  (pg_temp.fixture(1), pg_temp.fixture(801), 'rider', 'created'), (pg_temp.fixture(2), pg_temp.fixture(821), 'rider', 'created');
insert into public.vehicle_alerts(id, family_id, vehicle_id, range_km, required_km, pickup_count, pickup_ids, is_demo_value)
values (pg_temp.fixture(951), pg_temp.fixture(1), pg_temp.fixture(601), 5, 30, 1, array[pg_temp.fixture(802)], false);
insert into public.push_subscriptions(id, family_id, auth_user_id, endpoint, p256dh, auth) values
  (pg_temp.fixture(961), pg_temp.fixture(1), pg_temp.fixture(101), 'https://fcm.googleapis.com/fcm/send/isolation-owner', repeat('A', 87), repeat('A', 22)),
  (pg_temp.fixture(962), pg_temp.fixture(2), pg_temp.fixture(121), 'https://fcm.googleapis.com/fcm/send/isolation-b-owner', repeat('B', 87), repeat('B', 22));
insert into public.consents(family_id, member_id, granted_by_member_id, purpose, version) values
  (pg_temp.fixture(1), pg_temp.fixture(201), pg_temp.fixture(201), 'privacy', 'iso-v1'),
  (pg_temp.fixture(2), pg_temp.fixture(221), pg_temp.fixture(221), 'privacy', 'iso-v1');
insert into public.consents(family_id, rider_id, granted_by_member_id, purpose, version) values
  (pg_temp.fixture(1), pg_temp.fixture(301), pg_temp.fixture(201), 'rider_location', 'iso-v1');

-- Row fingerprints per table and family. rate_limits is excluded: a rejected attempt may legitimately be counted.
create temp table digest_sql as
select 'select coalesce(jsonb_object_agg(k, h), ''{}''::jsonb) from (' || string_agg(format(
    'select %L || ''@'' || coalesce(fam, ''none'') as k, md5(string_agg(line, ''|'' order by line)) as h'
    ' from (select %s as fam, t::text as line from %I.%I t) s group by fam', n.nspname || '.' || c.relname, fam.expr,
    n.nspname, c.relname), ' union all ') || ') x' as sql
from pg_class c join pg_namespace n on n.oid = c.relnamespace
cross join lateral (select case
  when exists(select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'family_id' and not a.attisdropped) then 't.family_id::text'
  when c.oid = 'public.families'::regclass then 't.id::text'
  when exists(select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'vehicle_id' and not a.attisdropped)
    then '(select v.family_id::text from public.vehicles v where v.id = t.vehicle_id)'
  when exists(select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'pickup_id' and not a.attisdropped)
    then '(select p.family_id::text from public.pickups p where p.id = t.pickup_id)'
  else 'null' end as expr) fam
where c.relkind in ('r', 'p') and (n.nspname in ('public', 'deriro_private') or c.oid = 'auth.users'::regclass)
  and c.oid <> 'deriro_private.rate_limits'::regclass;

create function pg_temp.digest() returns jsonb language plpgsql as $$
declare result jsonb;
begin
  execute (select sql from pg_temp.digest_sql) into result;
  return result;
end $$;

create function pg_temp.family_of(p_key text, p_before jsonb) returns text language sql stable as $$
  select case when split_part(p_key, '@', 2) = 'none' then 'none'
    else coalesce((select f.family from pg_temp.fx f where f.name like 'fam\_%' and f.id::text = split_part(p_key, '@', 2)),
      case when exists(select 1 from jsonb_object_keys(p_before) k where split_part(k, '@', 2) = split_part(p_key, '@', 2))
        then 'other' else 'new' end) end
$$;

create function pg_temp.render(p_template text, p_ghost boolean default false) returns text language plpgsql as $$
declare
  token text[];
  rendered text;
  statement text := p_template;
begin
  for token in select regexp_matches(p_template, '\{(a|b|v|s):([a-z0-9_]+)\}', 'g') loop
    rendered := case token[1]
      when 'a' then case when p_ghost then quote_literal(md5('ghost:' || token[2])::uuid) || '::uuid'
        else (select quote_literal(f.id) || '::uuid' from pg_temp.fx f where f.name = token[2]) end
      when 'b' then (select quote_literal(f.id) || '::uuid' from pg_temp.fx f where f.name = token[2])
      when 'v' then (select p.version::text from public.pickups p join pg_temp.fx f on f.id = p.id where f.name = token[2])
      when 's' then (select quote_literal(s.value) from pg_temp.saved s where s.name = token[2]) end;
    if rendered is null then raise exception 'unknown fixture token %', token; end if;
    statement := replace(statement, '{' || token[1] || ':' || token[2] || '}', rendered);
  end loop;
  return 'select ' || statement;
end $$;

-- Runs steps [{who, tpl | sql, ghost?}] in order, each as its principal, inside one subtransaction.
create function pg_temp.script(p_steps jsonb, p_keep boolean default false, p_probe text default null, p_digest boolean default true)
returns jsonb language plpgsql as $$
declare
  step jsonb;
  who record;
  statement text;
  results jsonb := '[]';
  result jsonb;
  before jsonb;
  after jsonb;
  probe jsonb;
  changed jsonb;
  err_state text;
  err_text text;
begin
  if p_digest then before := pg_temp.digest(); end if;
  begin
    for step in select value from jsonb_array_elements(p_steps) loop
      select * into strict who from pg_temp.principal where name = step->>'who';
      statement := coalesce(step->>'sql', pg_temp.render(step->>'tpl', coalesce((step->>'ghost')::boolean, false)));
      result := null;
      perform set_config('request.jwt.claim.sub', coalesce(who.uid::text, ''), true);
      execute format('set local role %I', who.role);
      begin
        execute statement into result;
      exception when others then
        get stacked diagnostics err_state = returned_sqlstate, err_text = message_text;
        result := jsonb_build_object('raised', err_state, 'message', err_text);
      end;
      reset role;
      perform set_config('request.jwt.claim.sub', '', true);
      results := results || jsonb_build_array(coalesce(result, 'null'::jsonb));
    end loop;
    if p_probe is not null then execute p_probe into probe; end if;
    if p_digest then after := pg_temp.digest(); end if;
    if not p_keep then raise exception using errcode = 'XU001', message = 'undo'; end if;
  exception when sqlstate 'XU001' then null;
  end;
  if p_digest then
    select coalesce(jsonb_agg(k order by k), '[]') into changed
      from (select jsonb_object_keys(before) union select jsonb_object_keys(after)) keys(k) where before->k is distinct from after->k;
  end if;
  return jsonb_build_object('result', results->-1, 'results', results, 'probe', probe, 'changed', changed,
    'families', (select coalesce(jsonb_agg(distinct pg_temp.family_of(k, before)), '[]') from jsonb_array_elements_text(changed) k));
end $$;

create function pg_temp.call(p_who text, p_template text, p_ghost boolean default false) returns jsonb language sql immutable as $$
  select jsonb_build_object('who', p_who, 'tpl', p_template, 'ghost', p_ghost)
$$;
create function pg_temp.attempt(p_who text, p_template text, p_keep boolean default false, p_probe text default null) returns jsonb
language sql as $$ select pg_temp.script(jsonb_build_array(pg_temp.call(p_who, p_template)), p_keep, p_probe) $$;
create function pg_temp.outcome(r jsonb) returns text language sql immutable as $$
  select coalesce(r#>>'{error,code}', 'raised ' || (r->>'raised'), case when r->>'ok' = 'true' then 'ok' end, 'no response')
$$;
create function pg_temp.code_of(p_who text, p_template text) returns text language sql as $$
  select pg_temp.outcome(pg_temp.attempt(p_who, p_template)->'result')
$$;
create function pg_temp.rejected(r jsonb) returns boolean language sql immutable as $$
  select coalesce(r->>'ok' = 'false' or r ? 'raised', false)
$$;
create function pg_temp.confined(s jsonb, p_families text[]) returns boolean language sql immutable as $$
  select coalesce(bool_and(f = any(p_families || array['none', 'new'])), true) from jsonb_array_elements_text(s->'families') f
$$;
-- Identifiers and markers of the given families that appear in a response but were not part of the call itself.
create function pg_temp.leaks(p_response jsonb, p_call text, p_families text[]) returns text[] language sql stable as $$
  select coalesce(array_agg(x order by x), '{}') from (
    select f.name as x from pg_temp.fx f where f.family = any(p_families)
      and strpos(p_response::text, f.id::text) > 0 and strpos(p_call, f.id::text) = 0
    union all
    select m.value from pg_temp.marker m where m.family = any(p_families) and strpos(p_response::text, m.value) > 0) l
$$;
create function pg_temp.count_family(p_table text, p_column text, p_family uuid) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute format('select count(*) from public.%I where %s = %L::uuid', p_table, p_column, p_family) into n;
  return n;
end $$;

-- Codes are capabilities, issued here through the real RPCs and kept: a family invite, an invite for the rider 지우,
-- and a pairing code shown by an unbound anonymous car.
insert into saved values
  ('family_code', pg_temp.attempt('a_owner', 'public.create_family_invite()', true)#>>'{result,data,code}'),
  ('rider_code', pg_temp.attempt('a_owner', 'public.create_rider_invite({a:r_spare})', true)#>>'{result,data,code}'),
  ('pair_code', pg_temp.attempt('stray', 'public.vehicle_pair_start()', true)#>>'{result,data,code}');
select ok((select count(*) from saved where name like '%\_code' and value ~ '^[0-9A-Z-]{6,9}$') = 3, 'fixture codes were issued');

-- ============================================================================================================
-- 1. Catalog: function and table privileges, RLS and Realtime. Catalog-driven, so new objects are covered.
-- ============================================================================================================

select is(array(select p.oid::regprocedure::text from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosecdef order by 1), '{}'::text[],
  'public RPC entry points are SECURITY INVOKER; privileged work lives in deriro_private (8.1)');
select is(array(select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema', 'extensions') and n.nspname not like 'pg\_%'
      and not exists(select 1 from unnest(p.proconfig) c where c like 'search\_path=%') order by 1), '{}'::text[],
  'every SECURITY DEFINER function pins search_path');
select is(array(select p.oid::regprocedure::text from pg_proc p
    where p.pronamespace in ('public'::regnamespace, 'deriro_private'::regnamespace)
      and not coalesce('search_path=""' = any(p.proconfig), false) order by 1), '{}'::text[],
  'every function in public and deriro_private sets search_path to empty (8.1)');
select is(array(select p.oid::regprocedure::text from pg_proc p
    where p.pronamespace in ('public'::regnamespace, 'deriro_private'::regnamespace)
      and exists(select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE') order by 1), '{}'::text[],
  'PUBLIC holds EXECUTE on no function in public or deriro_private');
-- 8.1 revokes anon outright. Rider devices and cars sign in anonymously but run as authenticated with
-- is_anonymous=true, so no public RPC is meant for the anon role: the allowlist is empty.
select is(array(select p.oid::regprocedure::text from pg_proc p
    where p.pronamespace in ('public'::regnamespace, 'deriro_private'::regnamespace)
      and has_function_privilege('anon', p.oid, 'EXECUTE') order by 1), '{}'::text[],
  'anon executes no function in public or deriro_private');
select is(array(select p.proname::text from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'svc\_%'
      and (not has_function_privilege('service_role', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    order by 1), '{}'::text[],
  'svc_* functions are executable by service_role and not by authenticated (8.8)');
select ok((select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'svc\_%') >= 7,
  'the service-only functions exist');
select is(array(select p.proname::text from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not like 'svc\_%'
      and has_function_privilege('service_role', p.oid, 'EXECUTE') order by 1), '{}'::text[],
  'service_role executes no client RPC');
select is(array(select p.proname::text from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not like 'svc\_%'
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE') order by 1), '{}'::text[],
  'authenticated executes every client RPC (authorization happens inside, per principal)');
-- 8.1: public wrappers are invokers, so authenticated must execute the definer each one delegates to.
-- Everything else in deriro_private stays closed, except the helpers that RLS policies call.
select is(array(select p.proname::text from pg_proc p where p.pronamespace = 'deriro_private'::regnamespace
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not (p.prosecdef and p.provolatile = 's' and exists(select 1 from pg_policy pol
        where strpos(coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), ''),
          'deriro_private.' || p.proname || '(') > 0))
      and not (p.prosecdef and exists(select 1 from pg_proc w where w.pronamespace = 'public'::regnamespace and w.proname not like 'svc\_%'
        and strpos(w.prosrc, 'deriro_private.' || p.proname || '(') > 0))
    order by 1), '{}'::text[],
  'authenticated executes only RLS helpers and the definers that client RPCs delegate to in deriro_private');
select is(array(select p.proname::text from pg_proc p where p.pronamespace = 'deriro_private'::regnamespace
      and has_function_privilege('authenticated', p.oid, 'EXECUTE') and not p.prosecdef order by 1), '{}'::text[],
  'every deriro_private function open to authenticated is a SECURITY DEFINER boundary');
select is(array(select distinct p.proname::text from pg_proc p join pg_policy pol
      on strpos(coalesce(pg_get_expr(pol.polqual, pol.polrelid), ''), 'deriro_private.' || p.proname || '(') > 0
    where p.pronamespace = 'deriro_private'::regnamespace order by 1), array['member_family', 'member_id'],
  'RLS policies call exactly the member_family and member_id helpers');
select is(array(select distinct p.proname::text from pg_proc p join pg_policy pol
      on strpos(coalesce(pg_get_expr(pol.polqual, pol.polrelid), ''), 'deriro_private.' || p.proname || '(') > 0
    where p.pronamespace = 'deriro_private'::regnamespace and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
    order by 1), '{}'::text[],
  'authenticated can execute every helper its policies call');
select is(array(select p.proname::text from pg_proc p where p.pronamespace = 'deriro_private'::regnamespace
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
      and not (p.prosecdef and exists(select 1 from pg_proc w where w.pronamespace = 'public'::regnamespace and w.proname like 'svc\_%'
        and strpos(w.prosrc, 'deriro_private.' || p.proname || '(') > 0))
    order by 1), '{}'::text[],
  'service_role executes only the definers behind svc_* in deriro_private');
select is(array(select x from (values
      ('anon USAGE deriro_private', has_schema_privilege('anon', 'deriro_private', 'USAGE')),
      ('anon CREATE deriro_private', has_schema_privilege('anon', 'deriro_private', 'CREATE')),
      ('authenticated CREATE deriro_private', has_schema_privilege('authenticated', 'deriro_private', 'CREATE')),
      ('anon CREATE public', has_schema_privilege('anon', 'public', 'CREATE')),
      ('authenticated CREATE public', has_schema_privilege('authenticated', 'public', 'CREATE'))) v(x, held)
    where held), '{}'::text[],
  'client roles cannot create objects, and anon cannot enter deriro_private');
select is(array(select c.oid::regclass::text from pg_class c
    where c.relnamespace in ('public'::regnamespace, 'deriro_private'::regnamespace) and c.relkind in ('r', 'p')
      and not c.relrowsecurity order by 1), '{}'::text[],
  'row level security is enabled on every table in public and deriro_private');
select is(array(select c.relname::text from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm', 'f')
    order by 1), '{}'::text[],
  'public exposes no views, materialized views or foreign tables that could bypass RLS');
select is(array(select format('%s.%s (%s to %s)', pol.polrelid::regclass, pol.polname, pol.polcmd, pol.polroles::regrole[])
    from pg_policy pol join pg_class c on c.oid = pol.polrelid
    where c.relnamespace in ('public'::regnamespace, 'deriro_private'::regnamespace)
      and (pol.polcmd <> 'r' or not pol.polpermissive or pol.polroles <> array['authenticated'::regrole]::oid[]) order by 1), '{}'::text[],
  'every policy is a permissive SELECT policy for authenticated: writes happen only in RPCs');
select is(array(select c.relname::text from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and has_any_column_privilege('authenticated', c.oid, 'SELECT')
      and not exists(select 1 from pg_policy pol where pol.polrelid = c.oid and pol.polcmd = 'r'
        and strpos(pg_get_expr(pol.polqual, pol.polrelid), 'deriro_private.member_family()') > 0) order by 1), '{}'::text[],
  'every table authenticated can read is filtered by the caller''s family');
select is(array(select c.oid::regclass::text from pg_class c
    where c.relnamespace in ('public'::regnamespace, 'deriro_private'::regnamespace) and c.relkind in ('r', 'p')
      and (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')) order by 1), '{}'::text[],
  'anon holds no privilege on any table or column');
select is(array(select c.oid::regclass::text from pg_class c
    where c.relnamespace in ('public'::regnamespace, 'deriro_private'::regnamespace) and c.relkind in ('r', 'p')
      and (has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege('authenticated', c.oid, 'INSERT,UPDATE,REFERENCES')
        or (c.relnamespace = 'deriro_private'::regnamespace and has_any_column_privilege('authenticated', c.oid, 'SELECT'))) order by 1),
  '{}'::text[],
  'authenticated may only SELECT, and only in public');
select is(array(select c.oid::regclass::text from pg_class c
    where c.relnamespace in ('public'::regnamespace, 'deriro_private'::regnamespace) and c.relkind in ('r', 'p')
      and (has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')) order by 1), '{}'::text[],
  'service_role reaches data only through svc_* functions');
-- Regression: Supabase's default privileges grant every public sequence to anon and authenticated
-- (reproduced by the test shim). The foundation migration revokes them.
select is(array(select format('%s %s', c.oid::regclass, r.rolname) from pg_class c cross join pg_roles r
    where c.relnamespace in ('public'::regnamespace, 'deriro_private'::regnamespace) and c.relkind = 'S'
      and r.rolname in ('anon', 'authenticated', 'service_role') and has_sequence_privilege(r.rolname, c.oid, 'USAGE,SELECT,UPDATE')
    order by 1), '{}'::text[],
  'no API role can read or advance an identity sequence');

-- Exact column grants. A column added to a granted table must be classified here before it becomes readable.
create temp table column_grant(tab text primary key, cols text[] not null);
insert into column_grant values
  ('families', array['created_at', 'demo_time_scale', 'id', 'is_demo', 'name', 'timezone']),
  ('family_members', array['can_drive', 'can_request', 'display_name', 'family_id', 'id', 'left_at', 'role']),
  ('riders', array['archived_at', 'consent_basis', 'display_name', 'family_id', 'id', 'kind']),
  ('vehicles', array['current_driver_member_id', 'family_id', 'id', 'nickname', 'revoked_at']),
  ('places', array['archived_at', 'fallback_note', 'family_id', 'id', 'kind', 'label', 'lat', 'lng', 'radius_m']),
  ('member_unavailable_days', array['created_at', 'day', 'family_id', 'member_id']),
  ('pickup_points', array['archived_at', 'family_id', 'id', 'label', 'lat', 'lng', 'note', 'place_id']),
  ('routines', array['active', 'archived_at', 'default_assignee_member_id', 'default_vehicle_id', 'end_date', 'family_id', 'id',
    'notify_before_min', 'pickup_point_id', 'place_id', 'rider_id', 'rider_member_id', 'start_date', 'time_local', 'weekdays']),
  ('pickups', array['accepted_at', 'arrived_at', 'arrived_source', 'assignee_member_id', 'assignment_round', 'cancel_reason',
    'cancelled_at', 'cancelled_by_kind', 'closed_unconfirmed_at', 'completed_at', 'completed_by_kind', 'created_at',
    'dest_label', 'dest_lat', 'dest_lng', 'destination_revision', 'en_route_at', 'expired_at', 'fallback_ack_at',
    'fallback_by_member_id', 'fallback_note', 'family_id', 'id',
    'is_customized', 'location_confirmed', 'location_source', 'nav_status', 'not_met_reported_at', 'occurrence_date',
    'pickup_point_id', 'pin_note', 'place_id', 'rider_id', 'rider_member_id', 'rider_ready_at', 'routine_id', 'source',
    'status', 'updated_at', 'vehicle_id', 'version', 'wanted_at']),
  ('pickup_offers', array['created_at', 'expires_at', 'family_id', 'from_member_id', 'id', 'note', 'origin', 'pickup_id',
    'resolved_at', 'resolved_by_member_id', 'status', 'to_member_id']),
  ('family_feed_changes', array['created_at', 'family_id', 'id']);
select is(array(select a.attname::text from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('authenticated', c.oid, a.attnum, 'SELECT') order by 1),
    coalesce((select array(select unnest(g.cols) order by 1) from column_grant g where g.tab = c.relname), '{}'::text[]),
    format('authenticated can select exactly the published columns of %s', c.relname))
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by c.relname;

-- Realtime (7.6). Subscribers receive only rows their SELECT policy admits, so a published table needs the same
-- family filter as a direct read.
select is(array(select t.tablename::text from pg_publication_tables t where t.pubname = 'supabase_realtime' order by 1),
  array['family_feed_changes', 'pickup_offers'], 'Realtime publishes only the family change signal and the offers');
select is(array(select t.schemaname || '.' || t.tablename from pg_publication_tables t join pg_class c
      on c.oid = format('%I.%I', t.schemaname, t.tablename)::regclass
    where t.pubname = 'supabase_realtime' and (not c.relrowsecurity or has_any_column_privilege('anon', c.oid, 'SELECT')
      or not exists(select 1 from pg_policy pol where pol.polrelid = c.oid and pol.polcmd = 'r'
        and strpos(pg_get_expr(pol.polqual, pol.polrelid), 'deriro_private.member_family()') > 0)) order by 1), '{}'::text[],
  'every published table has RLS, a family SELECT policy and no anon access');

-- ============================================================================================================
-- 2. Direct table access, for every public table and every principal.
-- ============================================================================================================

create temp table table_run as
select c.relname::text as tab, p.name as who, p.ord as pord, p.family,
  has_any_column_privilege(p.role, c.oid, 'SELECT') as readable,
  case when fam.col = 'null::uuid' or p.family is null then 0 else pg_temp.count_family(c.relname, fam.col, p.family) end as own,
  pg_temp.script(jsonb_build_array(jsonb_build_object('who', p.name, 'sql', format(
    'select jsonb_build_object(''total'', count(*), ''foreign'', count(*) filter (where %s is distinct from %L::uuid)) from public.%I',
    fam.col, p.family, c.relname))), false, null, false) as sel,
  pg_temp.script(jsonb_build_array(
    jsonb_build_object('who', p.name, 'sql', format(
      'with w as (insert into public.%I default values returning 1) select jsonb_build_object(''rows'', count(*)) from w', c.relname)),
    jsonb_build_object('who', p.name, 'sql', format(
      'with w as (update public.%I set %I = %I returning 1) select jsonb_build_object(''rows'', count(*)) from w',
      c.relname, first_col.name, first_col.name)),
    jsonb_build_object('who', p.name, 'sql', format(
      'with w as (delete from public.%I returning 1) select jsonb_build_object(''rows'', count(*)) from w', c.relname))),
    false, null, false) as dml
from pg_class c
cross join principal p
cross join lateral (select case
  when exists(select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'family_id') then 'family_id'
  when c.oid = 'public.families'::regclass then 'id' else 'null::uuid' end as col) fam
-- An identity column refuses updates before privileges are checked, so the probe updates the first ordinary column.
cross join lateral (select a.attname::text as name from pg_attribute a where a.attrelid = c.oid and a.attnum > 0
  and not a.attisdropped and a.attidentity = '' and a.attgenerated = '' order by a.attnum limit 1) first_col
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r';

-- Readable tables return only the caller's family; a guardian sees all of it (offers are further narrowed per
-- member by offer_select); every other principal reads nothing. Unreadable tables refuse with 42501.
select ok(case when not readable then sel#>>'{result,raised}' = '42501'
    else sel->'result' ? 'total' and (sel#>>'{result,foreign}')::bigint = 0
      and (family is not null or (sel#>>'{result,total}')::bigint = 0)
      and (family is null or tab = 'pickup_offers' or (sel#>>'{result,total}')::bigint = own) end,
  format('SELECT %s as %s -> %s', tab, who, case when sel->'result' ? 'raised' then 'raised ' || (sel#>>'{result,raised}')
    else (sel#>>'{result,total}') || ' rows, ' || (sel#>>'{result,foreign}') || ' outside the caller''s family' end))
from table_run order by tab, pord;
select ok((select bool_and(r->>'raised' = '42501') from jsonb_array_elements(dml->'results') r),
  format('INSERT, UPDATE, DELETE on %s as %s -> %s', tab, who,
    (select string_agg(pg_temp.outcome(r.value), ' / ' order by r.ordinality) from jsonb_array_elements(dml->'results') with ordinality r)))
from table_run order by tab, pord;
select is(array(select tab from table_run where who = 'a_owner' and readable and (sel#>>'{result,total}')::bigint = 0 order by 1),
  '{}'::text[], 'the owner''s reads are not vacuous: every readable table holds family A rows');

-- Columns outside the grant cannot be selected, even by a guardian whose policy admits the row.
select is(pg_temp.script(jsonb_build_array(jsonb_build_object('who', 'a_owner', 'sql',
    format('select jsonb_build_object(''n'', count(%I)) from public.%I', a.attname, c.relname))), false, null, false)#>>'{result,raised}',
  '42501', format('a guardian cannot select %s.%s', c.relname, a.attname))
from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and has_any_column_privilege('authenticated', c.oid, 'SELECT')
  and not has_column_privilege('authenticated', c.oid, a.attnum, 'SELECT')
order by c.relname, a.attname;

-- ============================================================================================================
-- 3. Role matrix (2.2, 23). Each row is one call in the fixture state; allowed lists the family A principals
-- for whom it succeeds (O). Every other principal (X) must get an error envelope or an exception and change
-- nothing. Allowed calls may change only family A rows (or unscoped pairing codes, or a family they create).
-- cross_who: the family B principals that also run the row with family A's ids (section 4).
-- ============================================================================================================

create temp table matrix(ord int primary key, label text not null, rpc text not null, template text not null,
  allowed text[] not null, cross_who text[] not null default array['b_owner', 'b_rider', 'b_vehicle']);
create function pg_temp.members() returns text[] language sql immutable as $$ select array['a_owner', 'a_guardian', 'a_limited'] $$;
create function pg_temp.unbound() returns text[] language sql immutable as $$ select array['a_left', 'fresh'] $$;
insert into matrix(ord, label, rpc, template, allowed, cross_who) values
  -- Family and guardians (2.2: 가족 정보 보기, 보호자 초대, 다른 보호자 내보내기; 8.3).
  (1, 'create_family', 'create_family', 'public.create_family(''새 보호자'', ''iso-v1'')', pg_temp.unbound(), '{}'),
  (2, 'join_family(A code)', 'join_family', 'public.join_family({s:family_code}, ''새 보호자'', ''iso-v1'')', pg_temp.unbound(), '{}'),
  (3, 'preview_family_invite(A code)', 'preview_family_invite', 'public.preview_family_invite({s:family_code})',
    pg_temp.members() || pg_temp.unbound(), '{}'),
  (4, 'create_family_invite', 'create_family_invite', 'public.create_family_invite()', pg_temp.members(), '{}'),
  (5, 'update_me', 'update_me', 'public.update_me(''바뀐 이름'')', pg_temp.members(), '{}'),
  (6, 'update_family', 'update_family', 'public.update_family(''바뀐 가족'')', array['a_owner'], '{}'),
  (7, 'set_member_roles(another guardian)', 'set_member_roles', 'public.set_member_roles({a:m_guardian}, true, true)',
    array['a_owner', 'a_guardian'], default),
  (8, 'set_member_roles(self, limited)', 'set_member_roles', 'public.set_member_roles({a:m_limited}, true, true)',
    array['a_owner', 'a_limited'], default),
  (9, 'transfer_owner(guardian)', 'transfer_owner', 'public.transfer_owner({a:m_guardian})', array['a_owner'], default),
  (10, 'remove_member(guardian)', 'remove_member', 'public.remove_member({a:m_guardian})', array['a_owner'], default),
  (11, 'remove_member(owner)', 'remove_member', 'public.remove_member({a:m_owner})', '{}', default),
  (12, 'leave_family', 'leave_family', 'public.leave_family()', array['a_guardian', 'a_limited'], '{}'),
  (13, 'prepare_delete_account', 'prepare_delete_account', 'public.prepare_delete_account()',
    array['a_guardian', 'a_limited'] || pg_temp.unbound(), '{}'),
  -- Riders and devices (2.2: 아이 추가·삭제, 아이 기기 연결 해제; 23.4 add_rider).
  (20, 'add_rider', 'add_rider', 'public.add_rider(''새 가족원'', ''adult'')', pg_temp.members(), '{}'),
  (21, 'update_rider', 'update_rider', 'public.update_rider({a:r_child}, ''민준이'')', pg_temp.members(), default),
  (22, 'archive_rider', 'archive_rider', 'public.archive_rider({a:r_child})', pg_temp.members(), default),
  (23, 'create_rider_invite', 'create_rider_invite', 'public.create_rider_invite({a:r_child})', pg_temp.members(), default),
  (24, 'claim_rider_invite(A code)', 'claim_rider_invite', 'public.claim_rider_invite({s:rider_code}, ''iso agent'', false, ''iso-v1'')',
    array['a_rider', 'a_rider2', 'a_revoked_rider', 'a_revoked_vehicle', 'stray'], '{}'),
  (25, 'revoke_rider_device', 'revoke_rider_device', 'public.revoke_rider_device({a:dev_child})', pg_temp.members(), default),
  -- Vehicles (2.2: 차량 페어링 확인 — 차량은 페어링 시작만, 현재 운전자 변경, 차량 상태 업로드).
  (30, 'vehicle_pair_start', 'vehicle_pair_start', 'public.vehicle_pair_start()', array['a_revoked_rider', 'a_revoked_vehicle', 'stray'], '{}'),
  (31, 'vehicle_pair_status', 'vehicle_pair_status', 'public.vehicle_pair_status()',
    array['a_rider', 'a_rider2', 'a_revoked_rider', 'a_vehicle', 'stray'], '{}'),
  (32, 'vehicle_pair_confirm(pairing code, A driver)', 'vehicle_pair_confirm',
    'public.vehicle_pair_confirm({s:pair_code}, ''새 차'', {a:m_guardian})', pg_temp.members(), default),
  (33, 'update_vehicle', 'update_vehicle', 'public.update_vehicle({a:car}, ''바꾼 차'')', pg_temp.members(), default),
  (34, 'vehicle_set_driver', 'vehicle_set_driver', 'public.vehicle_set_driver({a:m_owner})', array['a_vehicle'], default),
  (35, 'revoke_vehicle', 'revoke_vehicle', 'public.revoke_vehicle({a:car})', pg_temp.members(), default),
  (36, 'vehicle_unpair_self', 'vehicle_unpair_self', 'public.vehicle_unpair_self()', array['a_vehicle', 'a_revoked_vehicle'], '{}'),
  (37, 'upsert_vehicle_state', 'upsert_vehicle_state', 'public.upsert_vehicle_state(''P'', now())', array['a_vehicle'], '{}'),
  (38, 'vehicle_get_feed', 'vehicle_get_feed', 'public.vehicle_get_feed()', array['a_vehicle'], '{}'),
  (39, 'ack_vehicle_alert', 'ack_vehicle_alert', 'public.ack_vehicle_alert({a:alert})', pg_temp.members() || array['a_vehicle'], default),
  (40, 'vehicle_decline(open request)', 'vehicle_decline', 'public.vehicle_decline({a:k_open}, {v:k_open})', array['a_vehicle'], default),
  (41, 'vehicle_decline(own assignment)', 'vehicle_decline', 'public.vehicle_decline({a:k_assigned}, {v:k_assigned})',
    array['a_vehicle'], default),
  -- Places and routines (2.2: 장소·루틴 관리).
  (50, 'upsert_place(new)', 'upsert_place', 'public.upsert_place(''새 장소'', ''other'', 37.6, 127.1)', pg_temp.members(), '{}'),
  (51, 'upsert_place(edit)', 'upsert_place', 'public.upsert_place(''바꾼 집'', ''home'', 37.5, 127, 150, {a:place_home})',
    pg_temp.members(), default),
  (52, 'archive_place', 'archive_place', 'public.archive_place({a:place_home})', pg_temp.members(), default),
  (53, 'upsert_pickup_point(new)', 'upsert_pickup_point', 'public.upsert_pickup_point({a:place_school}, ''후문'', 37.551, 127.051)',
    pg_temp.members(), default),
  (54, 'upsert_pickup_point(edit)', 'upsert_pickup_point',
    'public.upsert_pickup_point({a:place_school}, ''정문'', 37.551, 127.051, null, {a:point_gate})', pg_temp.members(), default),
  (55, 'archive_pickup_point', 'archive_pickup_point', 'public.archive_pickup_point({a:point_gate})', pg_temp.members(), default),
  (56, 'upsert_routine(new)', 'upsert_routine', 'public.upsert_routine({a:r_adult}, null, {a:place_school}, 31, ''08:00'')',
    pg_temp.members(), default),
  (57, 'upsert_routine(edit)', 'upsert_routine',
    'public.upsert_routine({a:r_child}, null, {a:place_school}, 31, ''08:00'', p_routine_id => {a:routine})', pg_temp.members(), default),
  (58, 'archive_routine', 'archive_routine', 'public.archive_routine({a:routine})', pg_temp.members(), default),
  (59, 'ensure_occurrences', 'ensure_occurrences', 'public.ensure_occurrences(2)', pg_temp.members(), '{}'),
  -- 24.3 못 가는 날: a guardian marks their own day; one who cannot drive has nothing to mark.
  (64, 'set_unavailable_day', 'set_unavailable_day',
    'public.set_unavailable_day((now() at time zone ''Asia/Seoul'')::date + 2, true)', array['a_owner', 'a_guardian'], '{}'),
  -- Feeds (2.2: 가족 정보 보기 — 아이 기기·차량은 자기 피드만).
  (60, 'get_family_overview', 'get_family_overview', 'public.get_family_overview()', pg_temp.members(), '{}'),
  (61, 'get_today', 'get_today', 'public.get_today(2)', pg_temp.members(), '{}'),
  (62, 'get_pickup', 'get_pickup', 'public.get_pickup({a:k_open})', pg_temp.members(), default),
  (63, 'rider_get_state', 'rider_get_state', 'public.rider_get_state()', array['a_rider', 'a_rider2'], '{}'),
  -- Requests (2.2: 픽업 요청 생성; 23.4 member_create_request needs can_request, rider_create_request is the device's own).
  (70, 'member_create_request(place)', 'member_create_request', 'public.member_create_request(10, {a:place_school})',
    array['a_guardian'], default),
  (71, 'member_create_request(pickup point)', 'member_create_request',
    'public.member_create_request(10, p_pickup_point_id => {a:point_gate})', array['a_guardian'], default),
  (72, 'rider_create_request(place)', 'rider_create_request', 'public.rider_create_request(10, {a:place_school})',
    array['a_rider2'], default),
  (73, 'rider_create_request(pickup point)', 'rider_create_request',
    'public.rider_create_request(10, p_pickup_point_id => {a:point_gate})', array['a_rider2'], default),
  -- Accepting and handing off (2.2: 픽업 수락, 넘기기).
  (80, 'accept_pickup(open request)', 'accept_pickup', 'public.accept_pickup({a:k_open})', array['a_owner', 'a_guardian', 'a_vehicle'], default),
  (81, 'accept_pickup(open request, car)', 'accept_pickup', 'public.accept_pickup({a:k_open}, {a:car})',
    array['a_guardian', 'a_vehicle'], default),
  (82, 'offer_pickup(to a chosen guardian)', 'offer_pickup',
    'public.offer_pickup({a:k_assigned}, {v:k_assigned}, {a:m_owner}, ''부탁해요'')', array['a_guardian'], default),
  (83, 'offer_pickup(to everyone)', 'offer_pickup', 'public.offer_pickup({a:k_assigned}, {v:k_assigned})',
    array['a_guardian', 'a_vehicle'], default),
  (84, 'respond_offer(accept handoff)', 'respond_offer', 'public.respond_offer({a:offer_handoff}, ''accept'', {v:k_assigned})',
    array['a_owner'], default),
  (85, 'respond_offer(decline handoff)', 'respond_offer', 'public.respond_offer({a:offer_handoff}, ''decline'', {v:k_assigned})',
    array['a_owner'], default),
  (86, 'respond_offer(accept request card)', 'respond_offer', 'public.respond_offer({a:offer_open}, ''accept'', {v:k_open})',
    array['a_owner', 'a_guardian', 'a_vehicle'], default),
  (87, 'cancel_offer', 'cancel_offer', 'public.cancel_offer({a:offer_handoff}, {v:k_assigned})', array['a_guardian'], default),
  (88, 'take_over', 'take_over', 'public.take_over({a:k_assigned}, {v:k_assigned})', array['a_owner', 'a_guardian'], default),
  -- Departure, arrival, boarding (2.2: 출발 보고·도착·탑승 확인; 차량은 자기 차 배정일 때, 탑승 확인은 주차 중).
  (90, 'mark_en_route', 'mark_en_route', 'public.mark_en_route({a:k_assigned}, {v:k_assigned})', array['a_guardian'], default),
  (91, 'vehicle_start_now(open request)', 'vehicle_start_now', 'public.vehicle_start_now({a:k_open}, {v:k_open}, gen_random_uuid())',
    array['a_vehicle'], default),
  (92, 'vehicle_start_now(own assignment)', 'vehicle_start_now',
    'public.vehicle_start_now({a:k_assigned}, {v:k_assigned}, gen_random_uuid())', array['a_vehicle'], default),
  (93, 'mark_arrived(manual)', 'mark_arrived', 'public.mark_arrived({a:k_en_route}, ''manual'', p_expected_version => {v:k_en_route})',
    array['a_guardian', 'a_vehicle'], default),
  (94, 'mark_arrived(navigation callback)', 'mark_arrived',
    'public.mark_arrived({a:k_en_route}, ''nav_callback'', {a:nav_session}, 1)', array['a_vehicle'], default),
  (95, 'report_nav_result', 'report_nav_result', 'public.report_nav_result({a:k_en_route}, {a:nav_session}, ''ok'')',
    array['a_vehicle'], default),
  (96, 'undo_en_route', 'undo_en_route', 'public.undo_en_route({a:k_en_route}, {v:k_en_route})', array['a_guardian', 'a_vehicle'], default),
  (97, 'mark_completed(rider trip in the car)', 'mark_completed',
    'public.mark_completed({a:k_routine_arrived}, {v:k_routine_arrived})', array['a_guardian', 'a_rider', 'a_vehicle'], default),
  (98, 'mark_completed(guardian''s own trip, no car)', 'mark_completed',
    'public.mark_completed({a:k_arrived_member}, {v:k_arrived_member})', array['a_owner', 'a_guardian'], default),
  (99, 'rider_mark_boarded', 'rider_mark_boarded', 'public.rider_mark_boarded({a:k_routine_arrived}, {v:k_routine_arrived})',
    array['a_rider'], default),
  (100, 'rider_ready_early', 'rider_ready_early', 'public.rider_ready_early({a:k_routine_open}, {v:k_routine_open})',
    array['a_rider'], default),
  -- 24.3 #20-#22: any guardian but the requester on an open request, only the assignee on an assigned one; the requester
  -- acknowledges. Cars and rider devices never declare (S-64).
  (102, 'declare_no_driver(open request)', 'declare_no_driver',
    'public.declare_no_driver({a:k_open}, {v:k_open}, ''학원 안에서 기다리기'')', pg_temp.members(), default),
  (103, 'declare_no_driver(own assignment)', 'declare_no_driver',
    'public.declare_no_driver({a:k_assigned}, {v:k_assigned}, ''셔틀 타기'')', array['a_guardian'], default),
  (104, 'ack_fallback', 'ack_fallback', 'public.ack_fallback({a:k_no_driver})', array['a_rider'], default),
  (101, 'rider_report_not_met', 'rider_report_not_met',
    'public.rider_report_not_met({a:k_routine_arrived}, {v:k_routine_arrived})', array['a_rider'], default),
  -- Cancelling and location (2.2: 취소 — 아이는 자기 요청만, 차량 X; 위치 확정 — 차량은 주차 중).
  (110, 'cancel_pickup(open request)', 'cancel_pickup', 'public.cancel_pickup({a:k_open}, {v:k_open})',
    pg_temp.members() || array['a_rider'], default),
  (111, 'cancel_pickup(arrived, not met)', 'cancel_pickup',
    'public.cancel_pickup({a:k_routine_arrived}, {v:k_routine_arrived}, ''not_met'')', pg_temp.members(), default),
  (112, 'rider_cancel_request', 'rider_cancel_request', 'public.rider_cancel_request({a:k_open}, {v:k_open})', array['a_rider'], default),
  (113, 'skip_occurrence', 'skip_occurrence', 'public.skip_occurrence({a:k_routine_open}, {v:k_routine_open})', pg_temp.members(), default),
  (114, 'confirm_location', 'confirm_location',
    'public.confirm_location({a:k_open}, {v:k_open}, 37.55, 127.05, ''학교'', {a:place_school})', pg_temp.members() || array['a_vehicle'], default),
  -- Push, demo and service functions.
  (120, 'register_push_subscription', 'register_push_subscription',
    'public.register_push_subscription(''https://fcm.googleapis.com/fcm/send/isolation-new'', repeat(''A'', 87), repeat(''A'', 22))',
    pg_temp.members() || array['a_rider', 'a_rider2'], '{}'),
  (121, 'unregister_push_subscription(unknown endpoint)', 'unregister_push_subscription',
    'public.unregister_push_subscription(''https://fcm.googleapis.com/fcm/send/isolation-missing'')',
    pg_temp.members() || array['a_rider', 'a_rider2'], '{}'),
  (122, 'enqueue_test_push', 'enqueue_test_push', 'public.enqueue_test_push()', pg_temp.members(), '{}'),
  (123, 'demo_reset', 'demo_reset', 'public.demo_reset()', '{}', '{}'),
  (124, 'demo_run_now', 'demo_run_now', 'public.demo_run_now()', '{}', '{}'),
  (125, 'demo_set_time_scale', 'demo_set_time_scale', 'public.demo_set_time_scale(5)', '{}', '{}'),
  (130, 'svc_claim_outbox', 'svc_claim_outbox', 'public.svc_claim_outbox(10, 60)', array['service'], '{}'),
  (131, 'svc_finish_outbox', 'svc_finish_outbox', 'public.svc_finish_outbox(0, {a:nav_action}, ''sent'')', array['service'], default),
  (132, 'svc_release_outbox', 'svc_release_outbox', 'public.svc_release_outbox(0, {a:nav_action})', array['service'], default),
  (133, 'svc_outbox_still_valid', 'svc_outbox_still_valid', 'public.svc_outbox_still_valid(0, {a:nav_action})', array['service'], default),
  (134, 'svc_prune_push_subscription', 'svc_prune_push_subscription',
    'public.svc_prune_push_subscription({a:push_owner}, {s:owner_endpoint})', array['service'], default),
  (135, 'svc_apply_geo_label', 'svc_apply_geo_label', 'public.svc_apply_geo_label(0, {a:nav_action}, ''역삼1동 근처'')',
    array['service'], default),
  (136, 'svc_maintenance', 'svc_maintenance', 'public.svc_maintenance(''escalations'')', array['service'], '{}'),
  -- Family B's own ids mixed with one family A id. Only B's guardian can get past the first check.
  (140, 'upsert_routine(B rider, A place)', 'upsert_routine', 'public.upsert_routine({b:r_b}, null, {a:place_school}, 31, ''08:00'')',
    '{}', array['b_owner']),
  (141, 'upsert_routine(B rider, A driver)', 'upsert_routine',
    'public.upsert_routine({b:r_b}, null, {b:place_b}, 31, ''08:00'', p_default_assignee_member_id => {a:m_guardian})', '{}', array['b_owner']),
  (142, 'upsert_routine(B place, A pickup point)', 'upsert_routine',
    'public.upsert_routine({b:r_b}, null, {b:place_b}, 31, ''08:00'', p_pickup_point_id => {a:point_gate})', '{}', array['b_owner']),
  (143, 'upsert_routine(A member as rider)', 'upsert_routine',
    'public.upsert_routine(null, {a:m_owner}, {b:place_b}, 31, ''08:00'')', '{}', array['b_owner']),
  (144, 'upsert_routine(B driver, A car)', 'upsert_routine',
    'public.upsert_routine({b:r_b}, null, {b:place_b}, 31, ''08:00'', p_default_assignee_member_id => {b:m_b_owner}, p_default_vehicle_id => {a:car})',
    '{}', array['b_owner']),
  (145, 'upsert_routine(B ids, A routine)', 'upsert_routine',
    'public.upsert_routine({b:r_b}, null, {b:place_b}, 31, ''08:00'', p_routine_id => {a:routine})', '{}', array['b_owner']),
  (146, 'upsert_pickup_point(B place, A point)', 'upsert_pickup_point',
    'public.upsert_pickup_point({b:place_b}, ''후문'', 37.5, 127, null, {a:point_gate})', '{}', array['b_owner']),
  (147, 'update_vehicle(B car, A driver)', 'update_vehicle', 'public.update_vehicle({b:car_b}, null, {a:m_guardian})', '{}', array['b_owner']),
  (148, 'confirm_location(B pickup, A place)', 'confirm_location',
    'public.confirm_location({b:k_b_open}, {v:k_b_open}, 37.5, 127, ''정문'', {a:place_school})', '{}', array['b_owner']),
  (149, 'accept_pickup(B pickup, A car)', 'accept_pickup', 'public.accept_pickup({b:k_b_open}, {a:car})', '{}', array['b_owner']),
  (150, 'offer_pickup(B pickup, to A guardian)', 'offer_pickup',
    'public.offer_pickup({b:k_b_assigned}, {v:k_b_assigned}, {a:m_guardian})', '{}', array['b_owner']),
  (151, 'take_over(B pickup, A car)', 'take_over', 'public.take_over({b:k_b_taken}, {v:k_b_taken}, {a:car})', '{}', array['b_owner']),
  (152, 'respond_offer(B request card, A car)', 'respond_offer',
    'public.respond_offer({b:offer_b}, ''accept'', {v:k_b_open}, {a:car})', '{}', array['b_owner']);

select is(array(select p.proname::text from pg_proc p where p.pronamespace = 'public'::regnamespace
    except select rpc from matrix order by 1), '{}'::text[], 'every public function is classified in the role matrix');
select is(array(select rpc from matrix except select p.proname::text from pg_proc p where p.pronamespace = 'public'::regnamespace
    order by 1), '{}'::text[], 'the role matrix names no function that does not exist');
select is(array(select label from matrix where template !~ ('^public\.' || rpc || '\(') order by 1), '{}'::text[],
  'every matrix row calls the RPC it classifies');
select is(array(select p.proname::text from pg_proc p where p.pronamespace = 'public'::regnamespace
      and 'uuid'::regtype::oid = any(p.proargtypes::oid[])
    except select rpc from matrix where cardinality(cross_who) > 0 order by 1), '{}'::text[],
  'every public RPC that takes an id is called with another family''s ids');
select is(array(select x from (select unnest(allowed) x from matrix union select unnest(cross_who) from matrix) a
    except select name from principal order by 1), '{}'::text[], 'the matrix names only known principals');
select is(array(select label from matrix where cardinality(cross_who) > 0 and strpos(template, '{a:') = 0 order by 1), '{}'::text[],
  'every cross-family row passes at least one family A id');
select is(array(select f.name from fx f where f.name not in ('nav_session', 'nav_action') and not exists(
    select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and case when exists(select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'id' and a.atttypid = 'uuid'::regtype)
        then pg_temp.count_family(c.relname, 'id', f.id) > 0 else false end) order by 1), '{}'::text[],
  'every named fixture id exists, so a refusal is never just an unknown id');

create temp table matrix_run as
select m.ord, m.label, p.name as who, p.ord as pord, p.name = any(m.allowed) as allowed,
  pg_temp.script(jsonb_build_array(pg_temp.call(p.name, m.template))) as s
from matrix m cross join principal p where p.side = 'A';

select ok(case when allowed then s#>>'{result,ok}' = 'true' and (who = 'service' or pg_temp.confined(s, array['A']))
    else pg_temp.rejected(s->'result') and s->'changed' = '[]' end,
  format('%s %s: %s -> %s', case when allowed then 'O' else 'X' end, who, label, pg_temp.outcome(s->'result'))
    || case when s->'changed' <> '[]' and not allowed then ' but changed ' || (s->'changed')::text
       when allowed and not pg_temp.confined(s, array['A']) and who <> 'service' then ' but changed ' || (s->'families')::text else '' end)
from matrix_run order by ord, pord;

-- The anon role is refused by the database before any RPC body runs.
select is(array(select label from matrix_run where who = 'anon' and s#>>'{result,raised}' is distinct from '42501' order by 1),
  '{}'::text[], 'the anon role gets 42501 from every RPC');

-- ============================================================================================================
-- 4. Cross-family: family B's principals call every id-taking RPC with family A's ids. Each call must be refused
-- with no change anywhere, answer exactly as for an unknown id (no existence oracle), and leak no A identifier.
-- ============================================================================================================

create temp table cross_run as
select m.ord, m.label, p.name as who, p.ord as pord, pg_temp.render(m.template) as statement,
  pg_temp.script(jsonb_build_array(pg_temp.call(p.name, m.template))) as s,
  pg_temp.script(jsonb_build_array(pg_temp.call(p.name, m.template, true)), false, null, false) as ghost
from matrix m join principal p on p.name = any(m.cross_who);

select ok(pg_temp.rejected(s->'result') and s->'changed' = '[]'
    and pg_temp.outcome(s->'result') = pg_temp.outcome(ghost->'result')
    and cardinality(pg_temp.leaks(s->'result', statement, array['A'])) = 0,
  format('%s cannot reach family A through %s -> %s (unknown id -> %s)', who, label, pg_temp.outcome(s->'result'),
    pg_temp.outcome(ghost->'result'))
    || case when s->'changed' <> '[]' then ' but changed ' || (s->'changed')::text else '' end
    || case when cardinality(pg_temp.leaks(s->'result', statement, array['A'])) > 0
       then ' but leaked ' || array_to_string(pg_temp.leaks(s->'result', statement, array['A']), ',') else '' end)
from cross_run order by ord, pord;

-- ============================================================================================================
-- 5. Codes, push endpoints and feeds across families.
-- ============================================================================================================

-- An invite or pairing code is the capability itself: whoever holds it gets what it grants, never more.
-- Each expectation is "outcome changed-families" for one call.
select is(pg_temp.outcome(s->'result') || ' ' || (s->'families')::text, expected, description)
from (values
  ('b_owner', 'public.join_family({s:family_code}, ''옆집 엄마2'', ''iso-v1'')', 'ALREADY_IN_FAMILY []',
    'a guardian of family B cannot also join family A with A''s invite'),
  ('b_rider', 'public.claim_rider_invite({s:rider_code})', 'ok []',
    'a rider device of family B holding an A rider code is only asked to confirm the switch'),
  ('b_vehicle', 'public.claim_rider_invite({s:rider_code}, null, true)', 'FORBIDDEN []',
    'a car of family B cannot become a rider device of family A'),
  ('b_owner', 'public.vehicle_pair_confirm({s:pair_code}, ''옆집 새 차'', {b:m_b_owner})', 'ok ["B", "none"]',
    'an unbound car''s pairing code pairs it with the confirming guardian''s family only'),
  -- Push endpoints are globally unique: another family can neither take one over nor remove it.
  ('b_owner', 'public.register_push_subscription({s:owner_endpoint}, repeat(''B'', 87), repeat(''B'', 22))', 'FORBIDDEN []',
    'family B cannot take over family A''s push endpoint'),
  ('b_rider', 'public.register_push_subscription({s:owner_endpoint}, repeat(''B'', 87), repeat(''B'', 22))', 'FORBIDDEN []',
    'a rider device of family B cannot take it over either'),
  ('b_owner', 'public.unregister_push_subscription({s:owner_endpoint})', 'ok []',
    'unregistering another family''s endpoint removes nothing (the call is idempotent)'),
  ('a_guardian', 'public.unregister_push_subscription({s:owner_endpoint})', 'ok []',
    'a guardian cannot remove another guardian''s endpoint'),
  ('a_owner', 'public.unregister_push_subscription({s:owner_endpoint})', 'ok ["A"]',
    'the owner of an endpoint can remove it')) v(who, tpl, expected, description)
cross join lateral (select pg_temp.attempt(v.who, v.tpl) as s) r;
select is(array(select k from jsonb_object_keys(pg_temp.attempt('b_owner', 'public.preview_family_invite({s:family_code})')#>'{result,data}') k
    order by 1), array['family_name', 'inviter_name'], 'a code preview from another family shows only the family and inviter names');
select ok(pg_temp.attempt('b_rider', 'public.claim_rider_invite({s:rider_code})')#>'{result,data}' ? 'needs_switch_confirm',
  'the switch prompt is a confirmation, not a binding');

-- Feeds mention no other family's ids or names.
select ok(s#>>'{result,ok}' = 'true' and cardinality(pg_temp.leaks(s->'result', '', others)) = 0,
  format('%s via %s mentions no other family', who, tpl) || coalesce(' but leaked ' || array_to_string(nullif(pg_temp.leaks(s->'result', '', others), '{}'), ','), ''))
from (values ('a_owner', 'public.get_family_overview()', array['B', 'D']), ('a_owner', 'public.get_today(2)', array['B', 'D']),
  ('a_owner', 'public.get_pickup({a:k_assigned})', array['B', 'D']), ('a_rider', 'public.rider_get_state()', array['B', 'D']),
  ('a_vehicle', 'public.vehicle_get_feed()', array['B', 'D']), ('b_owner', 'public.get_family_overview()', array['A', 'D']),
  ('b_owner', 'public.get_today(2)', array['A', 'D']), ('b_rider', 'public.rider_get_state()', array['A', 'D']),
  ('b_vehicle', 'public.vehicle_get_feed()', array['A', 'D']), ('d_owner', 'public.get_family_overview()', array['A', 'B'])) v(who, tpl, others)
cross join lateral (select pg_temp.attempt(v.who, v.tpl) as s) r;

-- ============================================================================================================
-- 6. State-dependent cells, each rolled back.
-- ============================================================================================================

-- A car accepts in its current driver's name (2.2 픽업 수락: 현재 운전자 명의).
select is((select jsonb_build_object('assignee', p->>'assignee_member_id', 'vehicle', p->>'vehicle_id')
    from (select pg_temp.attempt('a_vehicle', 'public.accept_pickup({a:k_open})')#>'{result,data,pickup}' as p) x),
  jsonb_build_object('assignee', pg_temp.fixture(202), 'vehicle', pg_temp.fixture(601)),
  'a car accepts in its current driver''s name and is assigned to the trip');

-- A rider device acts only on its own requests: a second device in the same family cannot touch them.
insert into fx select 'k_rider2', (pg_temp.attempt('a_rider2', 'public.rider_create_request(0, p_pin => ''{"lat":37.52,"lng":127.02}'')', true)
  #>>'{result,data,pickup,id}')::uuid, 'A';
select is(pg_temp.code_of('a_rider', 'public.rider_cancel_request({a:k_rider2}, {v:k_rider2})'), 'NOT_FOUND',
  'a rider device cannot cancel another rider''s request');
select is(pg_temp.code_of('a_rider', 'public.cancel_pickup({a:k_rider2}, {v:k_rider2})'), 'NOT_FOUND',
  'nor through the shared cancel RPC');
select is(pg_temp.code_of('a_rider', 'public.rider_mark_boarded({a:k_rider2}, {v:k_rider2})'), 'NOT_FOUND',
  'a rider device cannot board another rider''s request');
select is(pg_temp.code_of('a_rider2', 'public.rider_cancel_request({a:k_rider2}, {v:k_rider2})'), 'ok',
  'the requesting device can cancel its own request');
select is(pg_temp.code_of('a_vehicle', 'public.rider_cancel_request({a:k_rider2}, {v:k_rider2})'), 'FORBIDDEN',
  'a car cannot cancel a request (2.2 취소: 차량 X)');

-- Boarding, location and driver changes need a fresh parked reading where the RPC models parking.
update public.vehicle_states set gear = 'D' where vehicle_id = pg_temp.fixture(601);
select is(pg_temp.code_of('a_vehicle', 'public.mark_completed({a:k_routine_arrived}, {v:k_routine_arrived})'), 'FORBIDDEN',
  'a moving car cannot confirm boarding');
select is(pg_temp.code_of('a_vehicle', 'public.confirm_location({a:k_open}, {v:k_open}, 37.55, 127.05, ''학교'', {a:place_school})'),
  'FORBIDDEN', 'a moving car cannot confirm a location');
select is(pg_temp.code_of('a_vehicle', 'public.vehicle_set_driver({a:m_owner})'), 'FORBIDDEN', 'a moving car cannot change its driver');
select is(pg_temp.code_of('a_vehicle', 'public.vehicle_start_now({a:k_assigned}, {v:k_assigned}, gen_random_uuid())'), 'FORBIDDEN',
  'a moving car cannot switch guidance to another trip');
select is(pg_temp.code_of('a_guardian', 'public.mark_completed({a:k_routine_arrived}, {v:k_routine_arrived})'), 'ok',
  'the assignee''s phone can still confirm boarding while the car moves');
update public.vehicle_states set gear = 'P', collected_at = now() - interval '31 seconds' where vehicle_id = pg_temp.fixture(601);
select is(pg_temp.code_of('a_vehicle', 'public.mark_completed({a:k_routine_arrived}, {v:k_routine_arrived})'), 'FORBIDDEN',
  'a stale parked reading does not count as parked');
update public.vehicle_states set collected_at = now() where vehicle_id = pg_temp.fixture(601);
select is(pg_temp.code_of('a_vehicle', 'public.mark_completed({a:k_routine_arrived}, {v:k_routine_arrived})'), 'ok',
  'a fresh parked reading lets the car confirm boarding');

-- A car acts on a trip only while it is the trip's car.
update public.vehicles set active_pickup_id = null, active_nav_session_id = null, active_destination_revision = null
  where id = pg_temp.fixture(601);
update public.pickups set vehicle_id = null where id = pg_temp.fixture(805);
select is(pg_temp.code_of('a_vehicle', 'public.mark_arrived({a:k_en_route}, ''manual'', p_expected_version => {v:k_en_route})'),
  'NOT_FOUND', 'a car cannot mark arrival for a trip it is not assigned to');
select is(pg_temp.code_of('a_vehicle', 'public.mark_arrived({a:k_en_route}, ''nav_callback'', {a:nav_session}, 1)'), 'NOT_FOUND',
  'nor send a navigation callback for it');
select is(pg_temp.code_of('a_vehicle', 'public.undo_en_route({a:k_en_route}, {v:k_en_route})'), 'NOT_FOUND',
  'nor undo its departure');
select is(pg_temp.code_of('a_vehicle', 'public.report_nav_result({a:k_en_route}, {a:nav_session}, ''failed'')'), 'NOT_FOUND',
  'nor report its navigation result');
select is(pg_temp.code_of('a_guardian', 'public.mark_arrived({a:k_en_route}, ''manual'', p_expected_version => {v:k_en_route})'), 'ok',
  'the assignee can still mark arrival by phone');
update public.pickups set vehicle_id = pg_temp.fixture(601) where id = pg_temp.fixture(805);
update public.vehicles set active_pickup_id = pg_temp.fixture(805), active_nav_session_id = pg_temp.fixture(991),
  active_destination_revision = 1 where id = pg_temp.fixture(601);

-- can_drive = false (23.1): no offers, no accepting, no driving, also through a car whose driver cannot drive.
select is(pg_temp.script(jsonb_build_array(jsonb_build_object('who', 'a_limited', 'sql',
    'select jsonb_build_object(''n'', count(*)) from public.pickup_offers')), false, null, false)#>>'{result,n}', '0',
  'a guardian who cannot drive receives no offers');
select is(pg_temp.script(jsonb_build_array(jsonb_build_object('who', 'a_owner', 'sql',
    'select jsonb_build_object(''n'', count(*)) from public.pickup_offers')), false, null, false)#>>'{result,n}',
  (select count(*)::text from public.pickup_offers where family_id = pg_temp.fixture(1)),
  'a guardian who can drive sees every request card and the open handoff');
update public.vehicles set current_driver_member_id = pg_temp.fixture(203) where id = pg_temp.fixture(601);
select is(pg_temp.code_of('a_vehicle', 'public.accept_pickup({a:k_open})'), 'NOT_FOUND', 'a car whose driver cannot drive cannot accept');
select is(pg_temp.code_of('a_vehicle', 'public.vehicle_start_now({a:k_open}, {v:k_open}, gen_random_uuid())'), 'NOT_FOUND',
  'nor start a request');
select is(pg_temp.code_of('a_vehicle', 'public.vehicle_start_now({a:k_assigned}, {v:k_assigned}, gen_random_uuid())'), 'FORBIDDEN',
  'nor start the trip it is assigned to');
select is(pg_temp.code_of('a_vehicle', 'public.vehicle_decline({a:k_open}, {v:k_open})'), 'FORBIDDEN', 'nor decline for the family');
select is(pg_temp.attempt('a_vehicle', 'public.vehicle_get_feed()')#>'{result,data,cards}', '[]'::jsonb,
  'and its feed shows no request cards');
update public.vehicles set current_driver_member_id = pg_temp.fixture(202) where id = pg_temp.fixture(601);
-- Regression: a guardian whose can_drive is turned off after accepting keeps the trip until it is handed off,
-- but cannot start driving it. Before the fix mark_en_route succeeded.
select is((select jsonb_agg(pg_temp.outcome(r.value) order by r.ordinality) from jsonb_array_elements(pg_temp.script(jsonb_build_array(
    pg_temp.call('a_owner', 'public.set_member_roles({a:m_guardian}, false, true)'),
    pg_temp.call('a_guardian', 'public.mark_en_route({a:k_assigned}, {v:k_assigned})'),
    pg_temp.call('a_guardian', 'public.accept_pickup({a:k_open})'),
    pg_temp.call('a_guardian', 'public.offer_pickup({a:k_assigned}, {v:k_assigned}, {a:m_owner})')))->'results') with ordinality r),
  '["ok", "FORBIDDEN", "FORBIDDEN", "ok"]'::jsonb,
  'after losing can_drive an assignee cannot depart or accept, but can still hand the trip off');
-- Regression: a routine revision gives the trip to the default driver only while that driver can still drive.
select is(pg_temp.script(jsonb_build_array(
    pg_temp.call('a_owner', 'public.set_member_roles({a:m_owner}, false, true)'),
    pg_temp.call('a_guardian', 'public.revoke_vehicle({a:car})')), false,
    format('select to_jsonb(p.status::text || '':'' || coalesce(p.assignee_member_id::text, ''none'')) from public.pickups p where p.id = %L',
      pg_temp.fixture(804)))->>'probe',
  'open:none', 'a routine revision does not assign an occurrence to a default driver who cannot drive');
select is(pg_temp.code_of('a_owner', format('public.upsert_routine({a:r_child}, null, {a:place_school}, 31, ''08:00'', p_default_assignee_member_id => %L::uuid)',
    pg_temp.fixture(203))), 'NOT_FOUND', 'a guardian who cannot drive cannot be made a routine''s default driver');

-- Regression: a car hands off only by declining to everyone (2.2 넘기기). Before the fix it could pick a recipient.
select is(pg_temp.code_of('a_vehicle', 'public.offer_pickup({a:k_assigned}, {v:k_assigned}, {a:m_owner})'), 'FORBIDDEN',
  'a car cannot choose who receives a handoff');
select is(pg_temp.code_of('a_vehicle', 'public.offer_pickup({a:k_assigned}, {v:k_assigned}, null, ''메모'')'), 'FORBIDDEN',
  'a car cannot attach a handoff note');
select is(pg_temp.attempt('a_vehicle', 'public.vehicle_decline({a:k_assigned}, {v:k_assigned})', false,
    format('select to_jsonb(count(*)) from public.pickup_offers where pickup_id = %L and status = ''pending'' and to_member_id is null and from_member_id = %L',
      pg_temp.fixture(802), pg_temp.fixture(202)))->>'probe', '1',
  'declining in the car offers the trip to every driver in the driver''s name');

-- Regression: one auth user is one principal (2.1). An anonymous rider device or car that converts to a permanent
-- account keeps its binding, so it cannot also join or create a family.
update auth.users set is_anonymous = false where id in (pg_temp.fixture(105), pg_temp.fixture(108));
select is(pg_temp.code_of('a_rider', 'public.create_family(''변환된 기기'', ''iso-v1'')'), 'ALREADY_IN_FAMILY',
  'a converted rider device cannot create a family');
select is(pg_temp.code_of('a_rider', 'public.join_family({s:family_code}, ''변환된 기기'', ''iso-v1'')'), 'ALREADY_IN_FAMILY',
  'a converted rider device cannot join a family');
select is(pg_temp.code_of('a_vehicle', 'public.create_family(''변환된 차'', ''iso-v1'')'), 'ALREADY_IN_FAMILY',
  'a converted car cannot create a family');
select is(pg_temp.code_of('a_vehicle', 'public.join_family({s:family_code}, ''변환된 차'', ''iso-v1'')'), 'ALREADY_IN_FAMILY',
  'a converted car cannot join a family');
select is(pg_temp.code_of('a_rider', 'public.rider_get_state()'), 'NOT_RIDER_DEVICE',
  'a converted device stops acting as a rider device');
select is(pg_temp.code_of('a_vehicle', 'public.vehicle_get_feed()'), 'NOT_VEHICLE', 'a converted car stops acting as a car');
update auth.users set is_anonymous = true where id in (pg_temp.fixture(105), pg_temp.fixture(108));
select is(pg_temp.code_of('a_revoked_rider', 'public.create_family(''익명'', ''iso-v1'')'), 'FORBIDDEN',
  'an anonymous session cannot become a guardian');

-- Demo RPCs (F-20) run only for the owner of a family marked as a demo, and touch only that family.
select is(pg_temp.outcome(s->'result') || ' ' || (s->'families')::text, 'ok ["D"]', description)
from (values ('public.demo_set_time_scale(5)', 'the demo owner speeds up only the demo family'),
  ('public.demo_reset()', 'the demo owner resets only the demo family'),
  ('public.demo_run_now()', 'the demo owner runs only the demo family''s timers')) v(tpl, description)
cross join lateral (select pg_temp.attempt('d_owner', v.tpl) as s) r;
select is(array(select pg_temp.code_of(w, 'public.' || p.proname || case when p.pronargs > 0 then '(5)' else '()' end)
    from pg_proc p cross join unnest(array['d_guardian', 'a_owner', 'b_owner']) w
    where p.pronamespace = 'public'::regnamespace and p.proname like 'demo\_%' order by p.proname, w),
  array_fill('FORBIDDEN'::text, array[3 * (select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'demo\_%')]),
  'every demo RPC refuses a demo guardian and the owners of families not marked as demos');

-- ============================================================================================================
-- 7. Changes that stay: ownership transfer, departure, revocation. Access ends in the same transaction.
-- ============================================================================================================

select is(pg_temp.code_of('a_owner', 'public.transfer_owner({a:m_guardian})'), 'ok', 'the owner can transfer ownership');
select is(pg_temp.attempt('a_owner', 'public.transfer_owner({a:m_guardian})', true)->'families', '["A"]'::jsonb,
  'ownership moves to 아빠');
select is(pg_temp.code_of('a_owner', 'public.remove_member({a:m_guardian})'), 'FORBIDDEN', 'the former owner can no longer remove a guardian');
select is(pg_temp.code_of('a_owner', 'public.update_family(''이전 소유자'')'), 'FORBIDDEN', 'nor rename the family');
select is(pg_temp.code_of('a_owner', 'public.transfer_owner({a:m_owner})'), 'FORBIDDEN', 'nor take ownership back');
select is(pg_temp.code_of('a_guardian', 'public.update_family(''새 소유자'')'), 'ok', 'the new owner can rename the family');
select is(pg_temp.code_of('a_guardian', 'public.remove_member({a:m_owner})'), 'ok', 'the new owner can remove the former owner');

select is(pg_temp.attempt('a_limited', 'public.leave_family()', true)#>>'{result,ok}', 'true', 'a guardian leaves the family');
select is(pg_temp.code_of('a_limited', 'public.get_today()'), 'NOT_GUARDIAN', 'the departed guardian''s session loses the feed');
select is(pg_temp.code_of('a_limited', 'public.create_family_invite()'), 'NOT_GUARDIAN', 'and cannot invite');
select is(pg_temp.code_of('a_limited', 'public.cancel_pickup({a:k_open}, {v:k_open})'), 'FORBIDDEN', 'and cannot cancel');
select is(pg_temp.script(jsonb_build_array(jsonb_build_object('who', 'a_limited', 'sql',
    'select jsonb_build_object(''n'', (select count(*) from public.pickups) + (select count(*) from public.families) + (select count(*) from public.family_members))')),
    false, null, false)#>>'{result,n}', '0', 'and reads no family rows');

select is(pg_temp.attempt('a_owner', 'public.revoke_rider_device({a:dev_adult})', true)#>>'{result,ok}', 'true', 'a guardian revokes a device');
select is(pg_temp.code_of('a_rider2', 'public.rider_get_state()'), 'DEVICE_REVOKED', 'the revoked device loses its feed');
select is(pg_temp.code_of('a_rider2', 'public.rider_create_request(0, {a:place_school})'), 'DEVICE_REVOKED', 'and cannot request');
select is(pg_temp.code_of('a_rider2', 'public.rider_cancel_request({a:k_rider2}, {v:k_rider2})'), 'DEVICE_REVOKED',
  'and cannot act on its earlier request');
select is(pg_temp.code_of('a_rider2', 'public.register_push_subscription(''https://fcm.googleapis.com/fcm/send/isolation-late'', repeat(''A'', 87), repeat(''A'', 22))'),
  'FORBIDDEN', 'and cannot register for notifications');

select is(pg_temp.attempt('a_guardian', 'public.revoke_vehicle({a:car})', true, format(
    'select to_jsonb(count(*)) from public.pickups where vehicle_id = %L and status in (''assigned'', ''en_route'', ''arrived'')',
    pg_temp.fixture(601)))->>'probe', '0', 'revoking a car detaches it from every unfinished trip');
select is(pg_temp.code_of('a_vehicle', 'public.vehicle_get_feed()'), 'VEHICLE_REVOKED', 'the revoked car loses its feed');
select is(pg_temp.code_of('a_vehicle', 'public.accept_pickup({a:k_open})'), 'VEHICLE_REVOKED', 'and cannot accept');
select is(pg_temp.code_of('a_vehicle', 'public.upsert_vehicle_state(''P'', now())'), 'VEHICLE_REVOKED', 'and cannot upload state');
select is(pg_temp.code_of('a_vehicle', 'public.vehicle_set_driver({a:m_guardian})'), 'VEHICLE_REVOKED', 'and cannot change driver');

-- Regression: a pairing code issued to an anonymous car session cannot pair once that session has converted to a
-- permanent account and become a guardian elsewhere (2.1). Before the fix the guardian's account became a car too.
update auth.users set is_anonymous = false where id = pg_temp.fixture(110);
select is(pg_temp.attempt('stray', 'public.create_family(''변환된 사용자'', ''iso-v1'')', true)#>>'{result,ok}', 'true',
  'an unbound session that converts may create its own family');
select is(pg_temp.code_of('a_guardian', 'public.vehicle_pair_confirm({s:pair_code}, ''새 차'', {a:m_guardian})'), 'PAIR_CODE_INVALID',
  'its earlier pairing code no longer pairs it as a car');

select * from finish();
rollback;
