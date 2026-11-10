begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

create function pg_temp.fixture(n int) returns uuid language sql immutable
  as $$ select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create temp table responses (name text primary key, value jsonb);
grant select, insert on responses to authenticated;

insert into auth.users(id, is_anonymous) values
  (pg_temp.fixture(11), false), (pg_temp.fixture(12), false), (pg_temp.fixture(13), false),
  (pg_temp.fixture(14), false), (pg_temp.fixture(15), true), (pg_temp.fixture(16), true), (pg_temp.fixture(17), true);
insert into public.families(id, name) values (pg_temp.fixture(1), '가족 A'), (pg_temp.fixture(2), '가족 B');
insert into public.family_members(id, family_id, auth_user_id, display_name, can_drive, can_request, location_consented_at)
values (pg_temp.fixture(21), pg_temp.fixture(1), pg_temp.fixture(11), '엄마', true, true, now()),
  (pg_temp.fixture(22), pg_temp.fixture(1), pg_temp.fixture(12), '아빠', true, true, now()),
  (pg_temp.fixture(23), pg_temp.fixture(1), pg_temp.fixture(13), '보호자', false, false, now()),
  (pg_temp.fixture(24), pg_temp.fixture(2), pg_temp.fixture(14), '다른 가족', true, true, now());
insert into public.places(id, family_id, label, lat, lng)
values (pg_temp.fixture(31), pg_temp.fixture(1), '병원', 37.5001, 127), (pg_temp.fixture(32), pg_temp.fixture(2), '다른 가족 장소', 37.5, 127);
insert into public.pickup_points(id, family_id, place_id, label, lat, lng, note)
values (pg_temp.fixture(33), pg_temp.fixture(1), pg_temp.fixture(31), '후문', 37.5002, 127.0002, '후문 벤치');
insert into public.vehicles(id, family_id, auth_user_id, nickname, current_driver_member_id)
values (pg_temp.fixture(41), pg_temp.fixture(1), pg_temp.fixture(16), '우리 차', pg_temp.fixture(22));
insert into public.vehicle_states(vehicle_id, gear, collected_at) values (pg_temp.fixture(41), 'P', now());
insert into public.riders(id, family_id, display_name, kind, consent_basis, location_consented_at)
values (pg_temp.fixture(51), pg_temp.fixture(1), '할머니', 'adult', 'self', now()),
  (pg_temp.fixture(52), pg_temp.fixture(1), '아이', 'child', 'guardian', now());
insert into public.rider_devices(id, family_id, rider_id, auth_user_id, revoked_at)
values (pg_temp.fixture(61), pg_temp.fixture(1), pg_temp.fixture(51), pg_temp.fixture(15), null),
  (pg_temp.fixture(62), pg_temp.fixture(1), pg_temp.fixture(52), pg_temp.fixture(17), now());

select ok(not has_function_privilege('anon', 'public.accept_pickup(uuid,uuid)', 'EXECUTE'), 'anon cannot run pickup mutations');
select ok(not has_function_privilege('authenticated', 'deriro_private.expire_pickup(public.pickups)', 'EXECUTE'),
  'only authorized entry points can call privileged helpers');
select ok(not has_table_privilege('authenticated', 'public.pickups', 'UPDATE'), 'direct pickup writes denied');
select ok(not has_table_privilege('authenticated', 'public.rider_devices', 'SELECT'), 'device bindings are private');
select ok(not has_column_privilege('authenticated', 'public.family_members', 'auth_user_id', 'SELECT'),
  'auth user IDs are private');
select throws_ok(
  $$ insert into public.pickup_points(family_id, place_id, label, lat, lng)
     values (pg_temp.fixture(1), pg_temp.fixture(32), '다른 가족', 37.5, 127) $$,
  '23503', null, 'cross-family foreign key rejects another family’s place'
);

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000015';
select is((select count(*) from public.families), 0::bigint, 'rider cannot read family tables');
insert into responses values ('initial', public.rider_create_request(p_pin => '{"lat":37.5,"lng":127,"note":"후문 벤치"}'));
select is(value#>>'{data,pickup,location_source}', 'map_pin', 'rider request preserves source') from responses where name = 'initial';
select is(value#>>'{data,pickup,location_confirmed}', 'true', 'map pin is confirmed') from responses where name = 'initial';
select is(value#>>'{data,pickup,pin_note}', '후문 벤치', 'map pin note is stored') from responses where name = 'initial';
select is(public.rider_create_request(p_place_id => pg_temp.fixture(31))#>>'{error,code}', 'ACTIVE_REQUEST_EXISTS', 'one active request per rider');
select is(public.member_create_request(p_place_id => pg_temp.fixture(31))#>>'{error,code}', 'FORBIDDEN', 'rider cannot assume member role');

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000017';
select is(public.rider_create_request(p_place_id => pg_temp.fixture(31))#>>'{error,code}', 'DEVICE_REVOKED', 'revoked device cannot request');
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000014';
select is((select count(*) from public.pickups), 0::bigint, 'another family cannot read pickup');
select is(public.accept_pickup((value#>>'{data,pickup,id}')::uuid)#>>'{error,code}', 'NOT_FOUND', 'another family cannot accept pickup')
  from responses where name = 'initial';

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000013';
select is((select count(*) from public.pickup_offers), 0::bigint, 'member without drive permission has no incoming offers');
select is(public.member_create_request(p_place_id => pg_temp.fixture(31))#>>'{error,code}', 'FORBIDDEN', 'request permission required');
select is(public.accept_pickup((value#>>'{data,pickup,id}')::uuid)#>>'{error,code}', 'FORBIDDEN', 'drive permission required')
  from responses where name = 'initial';

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000011';
select is((select count(*) from public.families), 1::bigint, 'member reads own family');
select is((select count(*) from public.family_members), 3::bigint, 'member reads own family membership');
select is((select count(*) from public.pickup_offers), 1::bigint, 'eligible driver reads own family offer');
select is(public.accept_pickup((value#>>'{data,pickup,id}')::uuid)#>>'{data,pickup,status}', 'assigned', 'first acceptance assigns')
  from responses where name = 'initial';
select is(public.accept_pickup((value#>>'{data,pickup,id}')::uuid)#>>'{data,pickup,version}', '2', 'same accepter can retry')
  from responses where name = 'initial';

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000012';
select is(public.accept_pickup((value#>>'{data,pickup,id}')::uuid)#>>'{error,code}', 'ALREADY_TAKEN', 'second contender loses')
  from responses where name = 'initial';
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000016';
select is(public.accept_pickup((value#>>'{data,pickup,id}')::uuid)#>>'{error,detail,by}', '엄마',
  'a car whose driver lost the race hears who took it (F-10)') from responses where name = 'initial';
select is(public.vehicle_start_now((value#>>'{data,pickup,id}')::uuid, 2, pg_temp.fixture(73))#>>'{error,code}', 'NO_VALID_OFFER',
  'starting another driver''s trip without an offer is NO_VALID_OFFER (8.3.1)') from responses where name = 'initial';
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000011';
insert into responses
select 'offer', public.offer_pickup((value#>>'{data,pickup,id}')::uuid, 2, pg_temp.fixture(22)) from responses where name = 'initial';
select is((select assignee_member_id from public.pickups where source = 'request'), pg_temp.fixture(21), 'handoff offer keeps current assignee');
select is(value#>>'{data,offer,status}', 'pending', 'handoff starts pending') from responses where name = 'offer';

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000012';
select is(public.respond_offer((value#>>'{data,offer,id}')::uuid, 'accept', 2)#>>'{data,pickup,assignee_member_id}', pg_temp.fixture(22)::text,
  'accepting a handoff changes assignee') from responses where name = 'offer';
select is(public.respond_offer((value#>>'{data,offer,id}')::uuid, 'accept', 2)#>>'{data,pickup,version}', '3', 'handoff retry succeeds')
  from responses where name = 'offer';
insert into responses
select 'counteroffer', public.offer_pickup((value#>>'{data,pickup,id}')::uuid, 3, pg_temp.fixture(21)) from responses where name = 'initial';
select is(public.mark_en_route((value#>>'{data,pickup,id}')::uuid, 2)#>>'{error,code}', 'STALE_VERSION', 'stale departure rejected')
  from responses where name = 'initial';
select is(public.mark_en_route((value#>>'{data,pickup,id}')::uuid, 3)#>>'{data,pickup,status}', 'en_route', 'assignee can depart')
  from responses where name = 'initial';
select is((select status::text from public.pickup_offers where id = (value#>>'{data,offer,id}')::uuid), 'cancelled', 'depart cancels pending offer')
  from responses where name = 'counteroffer';
select is(public.mark_completed((value#>>'{data,pickup,id}')::uuid, 4)#>>'{error,code}', 'INVALID_STATE', 'cannot board before arrival')
  from responses where name = 'initial';
select is(public.mark_arrived((value#>>'{data,pickup,id}')::uuid, 'manual', p_expected_version => 4)#>>'{data,pickup,status}',
  'arrived', 'arrival leaves the pickup awaiting boarding') from responses where name = 'initial';

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000015';
select is(public.mark_completed((value#>>'{data,pickup,id}')::uuid, 5)#>>'{data,pickup,status}', 'completed', 'rider explicitly confirms boarding')
  from responses where name = 'initial';
insert into responses values ('gps', public.rider_create_request(p_gps => '{"lat":37.5,"lng":127,"accuracy_m":900}'));
select is(value#>>'{data,pickup,location_confirmed}', 'false', 'poor GPS accuracy never snaps') from responses where name = 'gps';

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000016';
select is(public.vehicle_start_now((value#>>'{data,pickup,id}')::uuid, 1, pg_temp.fixture(71))#>>'{error,code}',
  'LOCATION_UNCONFIRMED', 'vehicle cannot depart before location confirmation') from responses where name = 'gps';
select is(public.confirm_location((value#>>'{data,pickup,id}')::uuid, 1, 37.5, 127, '장소', pg_temp.fixture(31))#>>'{data,pickup,location_confirmed}',
  'true', 'parked vehicle can confirm location') from responses where name = 'gps';
insert into responses select 'start', public.vehicle_start_now((value#>>'{data,pickup,id}')::uuid, 2, pg_temp.fixture(71))
  from responses where name = 'gps';
select is(value#>>'{data,pickup,status}', 'en_route', 'vehicle atomically accepts and departs') from responses where name = 'start';
select is(public.vehicle_start_now((value#>>'{data,pickup,id}')::uuid, 2, pg_temp.fixture(71))#>>'{data,nav_session_id}',
  value#>>'{data,nav_session_id}', 'same start action returns same session') from responses where name = 'start';
select is(public.report_nav_result((value#>>'{data,pickup,id}')::uuid, (value#>>'{data,nav_session_id}')::uuid, 'failed')->>'ok',
  'true', 'navigation failure is recorded separately') from responses where name = 'start';

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000011';
select is((select status::text from public.pickups where id = (value#>>'{data,pickup,id}')::uuid), 'en_route',
  'navigation failure keeps departure') from responses where name = 'start';
insert into responses values ('member', public.member_create_request(p_pickup_point_id => pg_temp.fixture(33)));
select is(value#>>'{data,pickup,location_source}', 'saved_point', 'member may choose a saved pickup point') from responses where name = 'member';
select is(public.accept_pickup((value#>>'{data,pickup,id}')::uuid)#>>'{error,code}', 'FORBIDDEN', 'member cannot accept their own request')
  from responses where name = 'member';

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000016';
insert into responses select 'switch', public.vehicle_start_now((value#>>'{data,pickup,id}')::uuid, 1, pg_temp.fixture(72))
  from responses where name = 'member';
select is(value#>>'{data,pickup,status}', 'en_route', 'parked vehicle can switch to a new trip') from responses where name = 'switch';
select is(public.mark_arrived((value#>>'{data,pickup,id}')::uuid, 'nav_callback',
  (value#>>'{data,nav_session_id}')::uuid, (value#>>'{data,destination_revision}')::int)#>>'{data,ignored}',
  'true', 'callback from previous vehicle trip is ignored') from responses where name = 'start';
select is(public.mark_arrived((value#>>'{data,pickup,id}')::uuid, 'nav_callback',
  (value#>>'{data,nav_session_id}')::uuid, (value#>>'{data,destination_revision}')::int)#>>'{data,pickup,status}',
  'arrived', 'callback with current session and revision records arrival') from responses where name = 'switch';

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000011';
select is(public.mark_completed((value#>>'{data,pickup,id}')::uuid, 3)#>>'{data,pickup,status}', 'completed',
  'member requester can board') from responses where name = 'switch';
select is(public.cancel_pickup((value#>>'{data,pickup,id}')::uuid, 3)#>>'{data,pickup,status}', 'cancelled', 'previous trip remains active after switch')
  from responses where name = 'start';

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000015';
insert into responses values ('snap', public.rider_create_request(p_gps => '{"lat":37.5,"lng":127}'));
select is(value#>>'{data,pickup,place_id}', pg_temp.fixture(31)::text,
  'GPS with missing accuracy defaults to 50m and cannot snap to other family') from responses where name = 'snap';

reset role;
select is((select count(*) from public.pickup_events where pickup_id = (value#>>'{data,pickup,id}')::uuid and event_type = 'accepted'),
  1::bigint, 'acceptance retry creates a single event') from responses where name = 'initial';
select is((select active_pickup_id from public.vehicles where id = pg_temp.fixture(41)), null::uuid, 'completion clears active guidance');

update public.pickups set wanted_at = now() - interval '61 minutes' where id = (
  select (value#>>'{data,pickup,id}')::uuid from responses where name = 'snap'
);
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000011';
select is(public.accept_pickup((value#>>'{data,pickup,id}')::uuid)#>>'{error,code}', 'PICKUP_EXPIRED',
  'late acceptance returns business error') from responses where name = 'snap';
select is((select status::text from public.pickups where id = (value#>>'{data,pickup,id}')::uuid), 'expired',
  'late acceptance commits expiry') from responses where name = 'snap';

reset role;
select * from finish();
rollback;
