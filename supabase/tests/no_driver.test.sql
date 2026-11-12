-- SPEC 24 "갈 사람이 없을 때" (v0.4.2): 못 갈 때 안내, "못 간다고 알리기" and "알겠어" (24.3 #20-#22), 못 가는 날, the 24.4
-- notices and their dedupe keys, the 24.6 feed fields and family isolation. Scenarios S-57 to S-69.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

create function pg_temp.fixture(n int) returns uuid language sql immutable
as $$ select ('80000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid $$;
-- A fixed-offset zone where the local hour is now p_hour (the conformance driver's trick).
create function pg_temp.zone_at(p_hour int) returns text language sql stable as $$
  select case when o = 0 then 'Etc/GMT' else 'Etc/GMT' || case when o > 0 then '-' else '+' end || abs(o) end
  from (select (((p_hour - extract(hour from now() at time zone 'UTC')::int) + 36) % 24) - 12 as o) x
$$;
create function pg_temp.today() returns date language sql stable as $$ select (now() at time zone 'Asia/Seoul')::date $$;
create function pg_temp.outbox(p_pickup uuid, p_template text, p_status text default null) returns bigint language sql stable as $$
  select count(*) from public.notifications_outbox
  where pickup_id = p_pickup and template = p_template and (p_status is null or status::text = p_status)
$$;
create temp table r(key text primary key, value jsonb);
grant select, insert, update on r to authenticated, service_role;
grant execute on function pg_temp.today() to authenticated;

-- Family A: 엄마 (owner) and 아빠 drive and take SMS, 이모 cannot drive; 민준's device; 아빠's car. Family B: 옆집.
insert into auth.users(id,is_anonymous) values
  (pg_temp.fixture(1),false),(pg_temp.fixture(2),false),(pg_temp.fixture(3),false),(pg_temp.fixture(4),true),
  (pg_temp.fixture(5),true),(pg_temp.fixture(6),false),(pg_temp.fixture(7),true),(pg_temp.fixture(8),true),
  (pg_temp.fixture(90),false),(pg_temp.fixture(91),false);
insert into public.families(id,name) values (pg_temp.fixture(10),'못 가는 가족'),(pg_temp.fixture(20),'옆집 가족');
insert into public.family_members(id,family_id,auth_user_id,display_name,role,can_drive,can_request,location_consented_at,
  phone_e164,sms_opt_in) values
  (pg_temp.fixture(11),pg_temp.fixture(10),pg_temp.fixture(1),'엄마','owner',true,true,now(),'+821000000011',true),
  (pg_temp.fixture(12),pg_temp.fixture(10),pg_temp.fixture(2),'아빠','guardian',true,true,now(),'+821000000012',true),
  (pg_temp.fixture(13),pg_temp.fixture(10),pg_temp.fixture(3),'이모','guardian',false,true,now(),null,false),
  (pg_temp.fixture(21),pg_temp.fixture(20),pg_temp.fixture(6),'옆집 엄마','owner',true,true,now(),null,false);
insert into public.riders(id,family_id,display_name,kind,consent_basis,location_consented_at) values
  (pg_temp.fixture(31),pg_temp.fixture(10),'민준','child','guardian',now()),
  (pg_temp.fixture(32),pg_temp.fixture(20),'옆집 아이','child','guardian',now());
insert into public.rider_devices(family_id,rider_id,auth_user_id) values
  (pg_temp.fixture(10),pg_temp.fixture(31),pg_temp.fixture(4)),(pg_temp.fixture(20),pg_temp.fixture(32),pg_temp.fixture(7));
insert into public.vehicles(id,family_id,auth_user_id,nickname,current_driver_member_id) values
  (pg_temp.fixture(41),pg_temp.fixture(10),pg_temp.fixture(5),'아빠 차',pg_temp.fixture(12)),
  (pg_temp.fixture(42),pg_temp.fixture(20),pg_temp.fixture(8),'옆집 차',pg_temp.fixture(21));
insert into public.vehicle_states(vehicle_id,gear,collected_at) values (pg_temp.fixture(41),'P',now()),(pg_temp.fixture(42),'P',now());

-- ---- Schema (24.2) ----------------------------------------------------------------------------------------------------
select has_function('public','declare_no_driver',array['uuid','integer','text'],'declare_no_driver(pickup_id, expected_version, note)');
select has_function('public','ack_fallback',array['uuid'],'ack_fallback(pickup_id)');
select has_function('public','set_unavailable_day',array['date','boolean'],'set_unavailable_day(day, unavailable)');
select throws_ok($$ insert into public.member_unavailable_days(family_id,member_id,day)
    values (pg_temp.fixture(10),pg_temp.fixture(21),pg_temp.today()) $$,
  '23503',null,'a 못 가는 날 cannot name another family''s member (cross-family foreign key)');
select throws_ok($$ insert into public.pickups(family_id,rider_id,source,status,location_source,location_confirmed,dest_lat,dest_lng,
    dest_label,wanted_at,cancel_reason,cancelled_at) values (pg_temp.fixture(10),pg_temp.fixture(31),'request','cancelled','map_pin',true,
    37.5,127,'정문',now(),'no_driver',now()) $$,
  '23514',null,'a no_driver cancellation must carry the line to do instead and who said it');
select ok(not has_table_privilege('authenticated','public.member_unavailable_days','INSERT,UPDATE,DELETE'),
  '못 가는 날 are written only through set_unavailable_day');

-- ---- P-13: a place's 못 갈 때 안내 (24.2, 24.6) --------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000001';
insert into r values ('academy',public.upsert_place('수학학원','academy',37.5001,127.0371,150,null,'  학원 안에서 기다리기 '));
select is(value#>>'{data,place,fallback_note}','학원 안에서 기다리기','P-13: a place saves its 못 갈 때 안내, trimmed')
  from r where key='academy';
select is(public.upsert_place('수학학원','academy',37.5001,127.0371,150,(value#>>'{data,place,id}')::uuid)#>>'{data,place,fallback_note}',
  '학원 안에서 기다리기','saving a place without the argument keeps its 안내') from r where key='academy';
select is(public.upsert_place('수학학원','academy',37.5001,127.0371,150,(value#>>'{data,place,id}')::uuid,'')#>'{data,place,fallback_note}',
  'null'::jsonb,'an empty 안내 is stored as null (24.6)') from r where key='academy';
select is(public.upsert_place('수학학원','academy',37.5001,127.0371,150,(value#>>'{data,place,id}')::uuid,repeat('가',41))#>>'{error,code}',
  'VALIDATION','an 안내 over 40 characters is refused') from r where key='academy';
select is(public.upsert_place('수학학원','academy',37.5001,127.0371,150,(value#>>'{data,place,id}')::uuid,'학원 안에서 기다리기')
  #>>'{data,place,fallback_note}','학원 안에서 기다리기','the 안내 is set again') from r where key='academy';
select is(public.get_family_overview()#>>'{data,places,0,fallback_note}','학원 안에서 기다리기','the family overview lists the 안내');

-- ---- set_unavailable_day (24.3 못 가는 날) ---------------------------------------------------------------------------------
select is(public.set_unavailable_day(pg_temp.today(),true)#>'{data,days}',
  jsonb_build_array(jsonb_build_object('member_id',pg_temp.fixture(11),'day',pg_temp.today())),
  '엄마 marks today; the reply lists the family''s days');
select is(public.set_unavailable_day(pg_temp.today(),true)#>'{data,days}',
  jsonb_build_array(jsonb_build_object('member_id',pg_temp.fixture(11),'day',pg_temp.today())),'marking twice keeps one day');
select is(public.set_unavailable_day(pg_temp.today()+61,true)#>>'{error,code}','VALIDATION','61 days ahead is refused');
select is(public.set_unavailable_day(pg_temp.today()-1,true)#>>'{error,code}','VALIDATION','a past day is refused');
select is(public.set_unavailable_day(pg_temp.today()+60,true)->>'ok','true','60 days ahead is accepted');
select is(public.set_unavailable_day(pg_temp.today()+60,false)#>'{data,days}',
  jsonb_build_array(jsonb_build_object('member_id',pg_temp.fixture(11),'day',pg_temp.today())),'clearing removes the day');
select is(public.set_unavailable_day(null,true)#>>'{error,code}','VALIDATION','a day is required');
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000003';
select is(public.set_unavailable_day(pg_temp.today(),true)#>>'{error,code}','FORBIDDEN','a guardian who cannot drive has no 못 가는 날');
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000004';
select is(public.set_unavailable_day(pg_temp.today(),true)#>>'{error,code}','NOT_GUARDIAN','a rider device cannot mark days');
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000005';
select is(public.set_unavailable_day(pg_temp.today(),true)#>>'{error,code}','NOT_GUARDIAN','a car cannot mark days');
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000002';
select is(jsonb_array_length(public.set_unavailable_day(pg_temp.today(),true)#>'{data,days}'),2,'아빠 marks today too');

-- ---- S-57: every driver is unavailable today, 민준 asks anyway ------------------------------------------------------------
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000004';
insert into r select 'r1',public.rider_create_request(0,(value#>>'{data,place,id}')::uuid) from r where key='academy';
select is(value#>>'{data,pickup,status}','open','S-57: the request is made although nobody can drive today') from r where key='r1';
insert into r values ('rider_nobody',public.rider_get_state());
select is(value#>>'{data,actives,0,nobody_available}','true','S-57: the rider feed says nobody is available (open_nobody)')
  from r where key='rider_nobody';
select is(value#>>'{data,actives,0,wait_note}','학원 안에서 기다리기','S-57: with the place''s 안내 as wait_note')
  from r where key='rider_nobody';
select is(value#>>'{data,actives,0,escalation_stage}','0','without waiting five minutes') from r where key='rider_nobody';
reset role;
select is(pg_temp.outbox((value#>>'{data,pickup,id}')::uuid,'nobody_available'),3::bigint,
  'S-57: every guardian gets nobody_available once at creation') from r where key='r1';
select ok(not exists(select 1 from public.notifications_outbox where template='nobody_available' and dedupe_key not like 'na:%'),
  'nobody_available uses the na: dedupe key');
set local role authenticated;
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000001';
insert into r values ('today_nobody',public.get_today(2));
select is((select a->>'no_available_driver' from r t,jsonb_array_elements(t.value#>'{data,active}') a,r q
    where t.key='today_nobody' and q.key='r1' and a->>'id'=q.value#>>'{data,pickup,id}'),'true',
  'S-57: P-04 marks the request as having nobody available');
select is((select a->'unavailable_member_ids' from r t,jsonb_array_elements(t.value#>'{data,active}') a,r q
    where t.key='today_nobody' and q.key='r1' and a->>'id'=q.value#>>'{data,pickup,id}'),
  jsonb_build_array(pg_temp.fixture(11),pg_temp.fixture(12)),'P-06: the pickup row names who cannot drive that day');
select is((select a->>'place_fallback_note' from r t,jsonb_array_elements(t.value#>'{data,active}') a,r q
    where t.key='today_nobody' and q.key='r1' and a->>'id'=q.value#>>'{data,pickup,id}'),'학원 안에서 기다리기',
  'P-18: the pickup row carries its place''s 안내');
select is(jsonb_array_length(value#>'{data,unavailable_days}'),2,'get_today lists the family''s 못 가는 날') from r where key='today_nobody';
-- An unavailable driver's decline changes nothing: the notice was sent once.
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000002';
select is(public.respond_offer(o.id,'decline',p.version)->>'ok','true','아빠 declines the request card')
  from public.pickup_offers o join public.pickups p on p.id=o.pickup_id join r on r.key='r1' and p.id=(r.value#>>'{data,pickup,id}')::uuid;
reset role;
select is(pg_temp.outbox((value#>>'{data,pickup,id}')::uuid,'nobody_available'),3::bigint,'a later decline does not repeat it')
  from r where key='r1';

-- ---- S-59: 엄마 says nobody can go ------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000001';
insert into r select 'declared',public.declare_no_driver(p.id,p.version,'  학원 안에서 기다리기 ')
  from r join public.pickups p on p.id=(r.value#>>'{data,pickup,id}')::uuid where r.key='r1';
select is(value#>>'{data,pickup,status}','cancelled','S-59: the pickup ends') from r where key='declared';
select is(value#>>'{data,pickup,cancel_reason}','no_driver','with cancel_reason no_driver') from r where key='declared';
select is(value#>>'{data,pickup,fallback_note}','학원 안에서 기다리기','and the trimmed line to do instead') from r where key='declared';
select is(value#>>'{data,pickup,fallback_by_member_id}',pg_temp.fixture(11)::text,'and who said it') from r where key='declared';
select is(value#>>'{data,pickup,cancelled_by_kind}','guardian','cancelled by a guardian') from r where key='declared';
reset role;
select is((select status::text from public.pickup_offers o join r on r.key='r1' and o.pickup_id=(r.value#>>'{data,pickup,id}')::uuid),
  'cancelled','S-59: the family-wide offer is cancelled');
select is((select array_agg(recipient_member_id order by recipient_member_id) from public.notifications_outbox x join r on r.key='r1'
    and x.pickup_id=(r.value#>>'{data,pickup,id}')::uuid where x.template='no_driver'),
  array[pg_temp.fixture(12),pg_temp.fixture(13)],'S-59: the other guardians get the no_driver notice, not 엄마');
select is(pg_temp.outbox((value#>>'{data,pickup,id}')::uuid,'nobody_available','skipped'),3::bigint,
  'the pending nobody_available notices are skipped once the pickup ends') from r where key='r1';
select is((select count(*) from public.pickup_events e join r on r.key='r1' and e.pickup_id=(r.value#>>'{data,pickup,id}')::uuid
    where e.event_type='no_driver' and e.actor_kind='guardian'),1::bigint,'one no_driver event');
set local role authenticated;
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000004';
insert into r values ('rider_no_driver',public.rider_get_state());
select is((select jsonb_build_object('status',a->>'status','reason',a->>'cancel_reason','note',a->>'fallback_note',
      'by',a->>'fallback_by_name','acked',a->'fallback_ack_at')
    from r t,jsonb_array_elements(t.value#>'{data,actives}') a,r q
    where t.key='rider_no_driver' and q.key='r1' and a->>'id'=q.value#>>'{data,pickup,id}'),
  jsonb_build_object('status','cancelled','reason','no_driver','note','학원 안에서 기다리기','by','엄마','acked',null),
  'S-59: the rider feed keeps the no_driver pickup with what to do and who said it');
reset role;
update public.vehicle_states set collected_at=now() where vehicle_id=pg_temp.fixture(41);
set local role authenticated;
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000005';
insert into r values ('car_feed',public.vehicle_get_feed());
select ok(value->>'ok'='true' and not jsonb_path_exists(value,'$.**.fallback_note') and not jsonb_path_exists(value,'$.**.fallback_ack_at'),
  '24.5: the vehicle feed does not change') from r where key='car_feed';
select ok(not jsonb_path_exists(f.value,'$.data.cards[*] ? (@.pickup_id == $id)',jsonb_build_object('id',q.value#>>'{data,pickup,id}')),
  'the car shows no card for a trip nobody started') from r f, r q where f.key='car_feed' and q.key='r1';

-- ---- S-60: 민준 says "알겠어" -------------------------------------------------------------------------------------------------
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000004';
insert into r select 'acked',public.ack_fallback((value#>>'{data,pickup,id}')::uuid) from r where key='r1';
select ok(value#>>'{data,pickup,fallback_ack_at}' is not null,'S-60: the acknowledgement is recorded') from r where key='acked';
select is(public.ack_fallback((value#>>'{data,pickup,id}')::uuid)#>>'{data,pickup,fallback_ack_at}',
  (select value#>>'{data,pickup,fallback_ack_at}' from r where key='acked'),'S-60: pressing again keeps the first time')
  from r where key='r1';
select is(public.ack_fallback((value#>>'{data,pickup,id}')::uuid)#>>'{data,pickup,version}',
  (select value#>>'{data,pickup,version}' from r where key='declared'),'acknowledging is not a version change') from r where key='r1';
reset role;
select is((select count(*) from public.pickup_events e join r on r.key='r1' and e.pickup_id=(r.value#>>'{data,pickup,id}')::uuid
    where e.event_type='fallback_acknowledged'),1::bigint,'S-60: one fallback_acknowledged event');
select is(pg_temp.outbox((value#>>'{data,pickup,id}')::uuid,'fallback_acknowledged'),3::bigint,
  'S-60: every guardian hears that 민준 has seen it') from r where key='r1';
set local role authenticated;
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000001';
select is((select a->>'fallback_ack_at' is not null from jsonb_array_elements(public.get_today(2)#>'{data,timeline}') a,r q
    where q.key='r1' and a->>'id'=q.value#>>'{data,pickup,id}'),true,'S-60: P-04 sees "민준이 확인했어요"');
insert into r select 'detail',public.get_pickup((value#>>'{data,pickup,id}')::uuid) from r where key='r1';
select ok(jsonb_path_exists(value,'$.data.events[*] ? (@.event_type == "no_driver")')
    and jsonb_path_exists(value,'$.data.events[*] ? (@.event_type == "fallback_acknowledged")'),
  'P-05: the history shows "못 간다고 알림" and "민준이 확인"') from r where key='detail';
select is(value#>>'{data,pickup,fallback_by_name}','엄마','P-05: the detail names who said it') from r where key='detail';
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000003';
select is(public.ack_fallback((value#>>'{data,pickup,id}')::uuid)#>>'{error,code}','FORBIDDEN','only the requester acknowledges')
  from r where key='r1';

-- ---- S-69 and S-58: 민준 asks again; 아빠 is free now, 엄마 is not ---------------------------------------------------------------
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000002';
select is(jsonb_array_length(public.set_unavailable_day(pg_temp.today(),false)#>'{data,days}'),1,'아빠 clears today');
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000004';
insert into r select 'r2',public.rider_create_request(0,(value#>>'{data,place,id}')::uuid) from r where key='academy';
select is(value#>>'{data,pickup,status}','open','S-69: after "못 간다고 알리기" the requester can ask again') from r where key='r2';
reset role;
select is(pg_temp.outbox((value#>>'{data,pickup,id}')::uuid,'nobody_available'),0::bigint,'아빠 can go, so no nobody_available yet')
  from r where key='r2';
-- Cars and rider devices read no tables, so their calls take the version from here.
insert into r select 'r2v',jsonb_build_object('id',p.id,'version',p.version)
  from r join public.pickups p on p.id=(r.value#>>'{data,pickup,id}')::uuid where r.key='r2';
set local role authenticated;
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000005';
select is(public.vehicle_decline((value->>'id')::uuid,(value->>'version')::int)->>'ok','true','S-58: 아빠''s car says "못 가요"')
  from r where key='r2v';
reset role;
select is(pg_temp.outbox((value#>>'{data,pickup,id}')::uuid,'nobody_available'),3::bigint,
  'S-58: the last available driver''s decline tells every guardian once') from r where key='r2';
select is(deriro_private.available_drivers(p),'{}'::uuid[],'S-58: nobody is available')
  from r join public.pickups p on p.id=(r.value#>>'{data,pickup,id}')::uuid where r.key='r2';
set local role authenticated;
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000004';
select is((select a->>'nobody_available' from jsonb_array_elements(public.rider_get_state()#>'{data,actives}') a,r q
    where q.key='r2' and a->>'id'=q.value#>>'{data,pickup,id}'),'true','S-58: 민준 sees open_nobody');
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000001';
insert into r values ('get_today_nobody_available',public.get_today(2));
select is(public.accept_pickup((value#>>'{data,pickup,id}')::uuid)#>>'{data,pickup,assignee_member_id}',pg_temp.fixture(11)::text,
  'S-58: 엄마 can still say "내가 갈게" on her 못 가는 날') from r where key='r2';

-- ---- S-62, S-63, S-64 and the other refusals -----------------------------------------------------------------------------
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000002';
select is(public.declare_no_driver(p.id,p.version,'셔틀 타기')#>>'{error,code}','NOT_ASSIGNEE','S-62: only the assignee ends a held trip')
  from r join public.pickups p on p.id=(r.value#>>'{data,pickup,id}')::uuid where r.key='r2';
select is((select assignee_member_id from public.pickups p join r on r.key='r2' and p.id=(r.value#>>'{data,pickup,id}')::uuid),
  pg_temp.fixture(11),'S-62: 엄마 still holds it');
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000005';
select is(public.declare_no_driver((value->>'id')::uuid,(value->>'version')::int + 1,'셔틀 타기')#>>'{error,code}','FORBIDDEN',
  'S-64: a car cannot declare it') from r where key='r2v';
select is(public.declare_no_driver(pg_temp.fixture(999),1,'셔틀 타기')#>>'{error,code}','FORBIDDEN',
  'S-64: for any pickup ID, known or not');
select is(public.ack_fallback((value#>>'{data,pickup,id}')::uuid)#>>'{error,code}','FORBIDDEN','a car cannot acknowledge')
  from r where key='r1';
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000004';
select is(public.declare_no_driver((value->>'id')::uuid,(value->>'version')::int + 1,'셔틀 타기')#>>'{error,code}','FORBIDDEN',
  'the rider cannot declare it') from r where key='r2v';
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000001';
select is(public.declare_no_driver(p.id,p.version-1,'셔틀 타기')#>>'{error,code}','STALE_VERSION','a stale version is refused')
  from r join public.pickups p on p.id=(r.value#>>'{data,pickup,id}')::uuid where r.key='r2';
select is(public.declare_no_driver(p.id,p.version,E' \t ')#>>'{error,code}','VALIDATION','a blank line is refused')
  from r join public.pickups p on p.id=(r.value#>>'{data,pickup,id}')::uuid where r.key='r2';
select is(public.declare_no_driver(p.id,p.version,repeat('가',41))#>>'{error,code}','VALIDATION','more than 40 characters is refused')
  from r join public.pickups p on p.id=(r.value#>>'{data,pickup,id}')::uuid where r.key='r2';
select is(public.ack_fallback((value#>>'{data,pickup,id}')::uuid)#>>'{error,code}','FORBIDDEN','a guardian cannot acknowledge a rider''s')
  from r where key='r2';
select is(public.mark_en_route(p.id,p.version)#>>'{data,pickup,status}','en_route','엄마 departs')
  from r join public.pickups p on p.id=(r.value#>>'{data,pickup,id}')::uuid where r.key='r2';
select is(public.declare_no_driver(p.id,p.version,'셔틀 타기')#>>'{error,code}','INVALID_STATE','S-63: not once the trip has started')
  from r join public.pickups p on p.id=(r.value#>>'{data,pickup,id}')::uuid where r.key='r2';
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000004';
select is(public.ack_fallback((value#>>'{data,pickup,id}')::uuid)#>>'{error,code}','INVALID_STATE',
  'only a no_driver cancellation can be acknowledged') from r where key='r2';
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000001';
select is(public.cancel_pickup(p.id,p.version,'resolved_by_phone')#>>'{data,pickup,cancel_reason}','resolved_by_phone',
  'an ordinary cancellation keeps its reason') from r join public.pickups p on p.id=(r.value#>>'{data,pickup,id}')::uuid where r.key='r2';

-- ---- S-61: nobody acknowledges -------------------------------------------------------------------------------------------
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000004';
insert into r select 'r3',public.rider_create_request(0,(value#>>'{data,place,id}')::uuid) from r where key='academy';
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000002';
select is(public.declare_no_driver(p.id,p.version,'전화 기다리기')#>>'{data,pickup,fallback_note}','전화 기다리기','아빠 says nobody can go')
  from r join public.pickups p on p.id=(r.value#>>'{data,pickup,id}')::uuid where r.key='r3';
reset role;
select ok(deriro_private.run_escalations()>=0,'scheduler runs right after');
select is(pg_temp.outbox((value#>>'{data,pickup,id}')::uuid,'fallback_unacked'),0::bigint,'no reminder before five minutes')
  from r where key='r3';
update public.pickups set cancelled_at=now()-interval '5 min 30 sec' where id=(select (value#>>'{data,pickup,id}')::uuid from r where key='r3');
select ok(deriro_private.run_escalations()>=1,'five-minute reminder processed');
select is(pg_temp.outbox((value#>>'{data,pickup,id}')::uuid,'fallback_unacked'),3::bigint,
  'S-61: after five minutes every guardian gets an urgent push') from r where key='r3';
select is(pg_temp.outbox((value#>>'{data,pickup,id}')::uuid,'fallback_unacked_sms'),0::bigint,'no SMS before ten minutes')
  from r where key='r3';
select ok(deriro_private.run_escalations()>=1,'scheduler runs again');
select is(pg_temp.outbox((value#>>'{data,pickup,id}')::uuid,'fallback_unacked'),3::bigint,'S-61: the push goes once (fb5: key)')
  from r where key='r3';
select ok(not exists(select 1 from public.notifications_outbox x join r on r.key='r3' and x.pickup_id=(r.value#>>'{data,pickup,id}')::uuid
    where x.template='fallback_unacked' and x.dedupe_key not like 'fb5:' || (r.value#>>'{data,pickup,id}') || ':%'),
  'the five-minute reminder is keyed fb5:<pickup>');
set local role authenticated;
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000004';
select is((select a->>'escalation_stage' from jsonb_array_elements(public.rider_get_state()#>'{data,actives}') a,r q
    where q.key='r3' and a->>'id'=q.value#>>'{data,pickup,id}'),'1','after five minutes the rider''s call buttons grow');
reset role;
set local role service_role;
insert into r values ('jobs',public.svc_claim_outbox(100,60));
reset role;
update public.pickups set cancelled_at=now()-interval '10 min 30 sec' where id=(select (value#>>'{data,pickup,id}')::uuid from r where key='r3');
select ok(deriro_private.run_escalations()>=1,'ten-minute reminder processed');
select is((select array_agg(recipient_member_id order by recipient_member_id) from public.notifications_outbox x join r on r.key='r3'
    and x.pickup_id=(r.value#>>'{data,pickup,id}')::uuid where x.template='fallback_unacked_sms'),
  array[pg_temp.fixture(11),pg_temp.fixture(12)],'S-61: after ten minutes an SMS to each guardian who opted in');
select ok(not exists(select 1 from public.notifications_outbox x join r on r.key='r3' and x.pickup_id=(r.value#>>'{data,pickup,id}')::uuid
    where x.template='fallback_unacked_sms' and x.dedupe_key not like 'fb10:' || (r.value#>>'{data,pickup,id}') || ':%'),
  'the ten-minute reminder is keyed fb10:<pickup>');
set local role authenticated;
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000004';
select is(public.ack_fallback((value#>>'{data,pickup,id}')::uuid)->>'ok','true','민준 acknowledges late') from r where key='r3';
reset role;
select is(pg_temp.outbox((value#>>'{data,pickup,id}')::uuid,'fallback_unacked_sms','skipped'),2::bigint,
  'S-61: the step still waiting is skipped once acknowledged') from r where key='r3';
select is(pg_temp.outbox((value#>>'{data,pickup,id}')::uuid,'fallback_unacked','sending'),3::bigint,
  'a reminder a worker already holds is not touched here') from r where key='r3';
set local role service_role;
select is(public.svc_outbox_still_valid((j->>'id')::bigint,(j->>'claim_token')::uuid)#>>'{data,valid}','false',
  'S-61: the worker drops a held reminder after the acknowledgement')
  from r cross join lateral jsonb_array_elements(r.value#>'{data,jobs}') j
  where r.key='jobs' and j->>'template'='fallback_unacked' limit 1;
reset role;
select ok(deriro_private.run_escalations()>=0,'scheduler runs after the acknowledgement');
select is((select count(*) from public.notifications_outbox x join r on r.key='r3' and x.pickup_id=(r.value#>>'{data,pickup,id}')::uuid
    where x.template like 'fallback_unacked%'),5::bigint,'no reminder after the acknowledgement');
-- A no_driver pickup the requester no longer sees (max(wanted_at, cancelled_at) + 3 hours) gets no reminder.
insert into public.pickups(id,family_id,rider_id,source,status,location_source,location_confirmed,dest_lat,dest_lng,dest_label,
  wanted_at,created_at,cancelled_at,cancel_reason,cancelled_by_kind,is_customized,fallback_note,fallback_by_member_id)
values (pg_temp.fixture(301),pg_temp.fixture(10),pg_temp.fixture(31),'request','cancelled','map_pin',true,37.5,127,'정문',
  now()-interval '4 hours',now()-interval '4 hours',now()-interval '3 hours 1 minute','no_driver','guardian',true,'셔틀 타기',pg_temp.fixture(11));
select ok(deriro_private.run_escalations()>=0,'scheduler runs over an old one');
select is(pg_temp.outbox(pg_temp.fixture(301),'fallback_unacked'),0::bigint,'an old unacknowledged pickup gets no reminder');
set local role authenticated;
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000004';
select is((select count(*) from jsonb_array_elements(public.rider_get_state()#>'{data,actives}') a where a->>'id'=pg_temp.fixture(301)::text),
  0::bigint,'and the rider screen no longer shows it');
reset role;
-- One transaction has one now(): move the pickup's times back as the clock would.
update public.pickups set cancelled_at=now()-interval '15 minutes',fallback_ack_at=now()-interval '11 minutes'
  where id=(select (value#>>'{data,pickup,id}')::uuid from r where key='r1');
set local role authenticated;
select is((select count(*) from jsonb_array_elements(public.rider_get_state()#>'{data,actives}') a,r q
    where q.key='r1' and a->>'id'=q.value#>>'{data,pickup,id}'),0::bigint,'an acknowledged one shows for 10 minutes only');

-- ---- S-65, S-66: 못 가는 날 and routine occurrences ---------------------------------------------------------------------------
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000002';
select is(public.set_unavailable_day(pg_temp.today()+1,true)->>'ok','true','아빠 marks tomorrow');
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000001';
insert into r select 'rt1',public.upsert_routine(pg_temp.fixture(31),null,(value#>>'{data,place,id}')::uuid,127,'17:30',
  p_default_assignee_member_id=>pg_temp.fixture(12),p_default_vehicle_id=>pg_temp.fixture(41),p_start_date=>pg_temp.today()+1)
  from r where key='academy';
reset role;
create temp table occ as select p.id,p.routine_id from public.pickups p join r on r.key='rt1'
  and p.routine_id=(r.value#>>'{data,routine,id}')::uuid;
grant select on occ to authenticated;
select is((select status::text || ':' || coalesce(assignee_member_id::text,'none') || ':' || coalesce(vehicle_id::text,'none')
    from public.pickups where id=(select id from occ)),'open:none:none',
  'S-65: an occurrence on its default driver''s 못 가는 날 is created open, given to nobody');
set local role authenticated;
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000002';
select is(public.set_unavailable_day(pg_temp.today()+1,false)->>'ok','true','아빠 clears tomorrow');
reset role;
select is((select status::text || ':' || assignee_member_id::text || ':' || vehicle_id::text from public.pickups where id=(select id from occ)),
  'assigned:' || pg_temp.fixture(12) || ':' || pg_temp.fixture(41),'S-66: clearing gives the untouched open occurrence back to 아빠');
select is((select payload->>'cause' from public.pickup_events where pickup_id=(select id from occ) and event_type='routine_reassigned'
    order by id desc limit 1),'unavailable_day_cleared','recorded as routine_reassigned');
set local role authenticated;
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000001';
insert into r select 'rt2',public.upsert_routine(pg_temp.fixture(31),null,(value#>>'{data,place,id}')::uuid,127,'18:30',
  p_default_assignee_member_id=>pg_temp.fixture(12),p_default_vehicle_id=>pg_temp.fixture(41),p_start_date=>pg_temp.today()+1)
  from r where key='academy';
reset role;
insert into occ select p.id,p.routine_id from public.pickups p join r on r.key='rt2' and p.routine_id=(r.value#>>'{data,routine,id}')::uuid;
set local role authenticated;
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000002';
select is(public.accept_pickup(o.id)#>>'{data,pickup,is_customized}','true','아빠 accepts the 18:30 occurrence')
  from occ o join r on r.key='rt2' and o.routine_id=(r.value#>>'{data,routine,id}')::uuid;
insert into r values ('marked',public.set_unavailable_day(pg_temp.today()+1,true));
select is(value#>'{data,held_pickup_ids}',(select jsonb_agg(o.id) from occ o join r x on x.key='rt2' and o.routine_id=(x.value#>>'{data,routine,id}')::uuid),
  'the reply names the trip 아빠 still holds that day ("이날 맡은 픽업 1건은 그대로예요")') from r where key='marked';
reset role;
select is((select p.status::text || ':' || coalesce(p.assignee_member_id::text,'none') from public.pickups p join occ o on o.id=p.id
    join r on r.key='rt1' and o.routine_id=(r.value#>>'{data,routine,id}')::uuid),'open:none',
  'S-65: marking reopens the untouched default assignment');
select is((select p.status::text || ':' || p.assignee_member_id::text from public.pickups p join occ o on o.id=p.id
    join r on r.key='rt2' and o.routine_id=(r.value#>>'{data,routine,id}')::uuid),'assigned:' || pg_temp.fixture(12),
  'S-65: the occurrence 아빠 accepted stays his');
select is((select count(*) from public.pickup_events e join occ o on o.id=e.pickup_id join r on r.key='rt1'
    and o.routine_id=(r.value#>>'{data,routine,id}')::uuid where e.event_type='routine_reassigned'),2::bigint,
  'each change records routine_reassigned');
select is((select count(*) from public.notifications_outbox x join occ o on o.id=x.pickup_id join r on r.key='rt1'
    and o.routine_id=(r.value#>>'{data,routine,id}')::uuid),0::bigint,'routine_reassigned sends no notice (4.4 #12)');
-- An occurrence already offered to everyone stays open when the day is cleared (24.3).
update public.pickups set routine_offer_created_at=now() where id in (select o.id from occ o join r on r.key='rt1'
  and o.routine_id=(r.value#>>'{data,routine,id}')::uuid);
set local role authenticated;
select is(public.set_unavailable_day(pg_temp.today()+1,false)->>'ok','true','아빠 clears tomorrow again');
reset role;
select is((select p.status::text from public.pickups p join occ o on o.id=p.id join r on r.key='rt1'
    and o.routine_id=(r.value#>>'{data,routine,id}')::uuid),'open','S-66: an announced open occurrence is left open');

-- ---- S-67: 내일 담당 없음 at 20:00 in the family's time zone -----------------------------------------------------------------
-- Family E: it is now 21:xx there. 은서 cannot drive tomorrow, so 은지's own routine has nobody to drive it and 하늘's has
-- 은지. Family G: it is 18:xx there, too early for the notice.
insert into public.families(id,name,timezone) values (pg_temp.fixture(500),'저녁 가족',pg_temp.zone_at(21)),
  (pg_temp.fixture(600),'오후 가족',pg_temp.zone_at(18));
insert into public.family_members(id,family_id,auth_user_id,display_name,role,can_drive,can_request,location_consented_at) values
  (pg_temp.fixture(501),pg_temp.fixture(500),pg_temp.fixture(90),'은서','owner',true,true,now()),
  (pg_temp.fixture(502),pg_temp.fixture(500),pg_temp.fixture(91),'은지','guardian',true,true,now()),
  (pg_temp.fixture(601),pg_temp.fixture(600),null,'오후 엄마','owner',true,true,now());
insert into public.riders(id,family_id,display_name,kind,consent_basis) values
  (pg_temp.fixture(503),pg_temp.fixture(500),'하늘','child','guardian'),(pg_temp.fixture(603),pg_temp.fixture(600),'오후 아이','child','guardian');
insert into public.places(id,family_id,label,lat,lng) values (pg_temp.fixture(504),pg_temp.fixture(500),'학원',37.5,127),
  (pg_temp.fixture(604),pg_temp.fixture(600),'학원',37.5,127);
insert into public.routines(id,family_id,rider_id,rider_member_id,place_id,weekdays,time_local,start_date) values
  (pg_temp.fixture(505),pg_temp.fixture(500),pg_temp.fixture(503),null,pg_temp.fixture(504),127,'17:30',pg_temp.today()-7),
  (pg_temp.fixture(506),pg_temp.fixture(500),null,pg_temp.fixture(502),pg_temp.fixture(504),127,'17:30',pg_temp.today()-7),
  (pg_temp.fixture(507),pg_temp.fixture(500),pg_temp.fixture(503),null,pg_temp.fixture(504),127,'19:00',pg_temp.today()-7),
  (pg_temp.fixture(605),pg_temp.fixture(600),pg_temp.fixture(603),null,pg_temp.fixture(604),127,'17:30',pg_temp.today()-7);
insert into public.member_unavailable_days(family_id,member_id,day) values
  (pg_temp.fixture(500),pg_temp.fixture(501),(now() at time zone pg_temp.zone_at(21))::date+1);
insert into public.pickups(id,family_id,rider_id,rider_member_id,source,routine_id,occurrence_date,status,assignee_member_id,
  assignment_round,place_id,location_source,location_confirmed,dest_lat,dest_lng,dest_label,wanted_at)
select x.id,x.family,x.rider,x.rider_member,'routine',x.routine,x.day,x.status::public.pickup_status,x.assignee,
  case when x.assignee is null then 0 else 1 end,x.place,'saved_place',true,37.5,127,'학원',(x.day + x.at) at time zone x.zone
from (values
  (pg_temp.fixture(511),pg_temp.fixture(500),pg_temp.fixture(503),null::uuid,pg_temp.fixture(505),1,'open',null::uuid,pg_temp.fixture(504),time '17:30',pg_temp.zone_at(21)),
  (pg_temp.fixture(512),pg_temp.fixture(500),null,pg_temp.fixture(502),pg_temp.fixture(506),1,'open',null,pg_temp.fixture(504),time '17:30',pg_temp.zone_at(21)),
  (pg_temp.fixture(513),pg_temp.fixture(500),pg_temp.fixture(503),null,pg_temp.fixture(507),1,'assigned',pg_temp.fixture(501),pg_temp.fixture(504),time '19:00',pg_temp.zone_at(21)),
  (pg_temp.fixture(514),pg_temp.fixture(500),pg_temp.fixture(503),null,pg_temp.fixture(505),0,'open',null,pg_temp.fixture(504),time '23:59',pg_temp.zone_at(21)),
  (pg_temp.fixture(611),pg_temp.fixture(600),pg_temp.fixture(603),null,pg_temp.fixture(605),1,'open',null,pg_temp.fixture(604),time '17:30',pg_temp.zone_at(18))
) as v(id,family,rider,rider_member,routine,offset_days,status,assignee,place,at,zone)
cross join lateral (select v.id,v.family,v.rider,v.rider_member,v.routine,v.status,v.assignee,v.place,v.at,v.zone,
  (now() at time zone v.zone)::date + v.offset_days as day) x;
select ok(deriro_private.run_escalations(pg_temp.fixture(500))>=2,'the evening run processes tomorrow''s open occurrences');
select is((select array_agg(recipient_member_id order by recipient_member_id) from public.notifications_outbox
    where pickup_id=pg_temp.fixture(511) and template='tomorrow_open'),array[pg_temp.fixture(501),pg_temp.fixture(502)],
  'S-67: every guardian hears "내일 담당 없음 / 누가 갈지 미리 정해 주세요"');
select is((select array_agg(recipient_member_id order by recipient_member_id) from public.notifications_outbox
    where pickup_id=pg_temp.fixture(512) and template='tomorrow_nobody'),array[pg_temp.fixture(501)],
  'S-67: "갈 수 있는 사람이 없어요" when nobody can drive tomorrow; the requesting guardian is not told');
select ok(not exists(select 1 from public.notifications_outbox where template like 'tomorrow%' and dedupe_key not like 'tmr:%'),
  'the notice is keyed tmr:<pickup>');
select is((select count(*) from public.notifications_outbox where pickup_id in (pg_temp.fixture(513),pg_temp.fixture(514))
    and template like 'tomorrow%'),0::bigint,'an assigned occurrence and today''s open one get no "내일" notice');
select ok(deriro_private.run_escalations()>=0,'every family''s run');
select is((select count(*) from public.notifications_outbox where template like 'tomorrow%'
    and family_id in (pg_temp.fixture(500),pg_temp.fixture(600))),3::bigint,
  'S-67: once per occurrence, and not before 20:00 in another family''s zone');
update public.pickups set status='open',assignee_member_id=null,assignment_round=2 where id=pg_temp.fixture(513);
select ok(deriro_private.run_escalations(pg_temp.fixture(500))>=1,'the next run');
select is((select count(*) from public.notifications_outbox where pickup_id=pg_temp.fixture(513) and template like 'tomorrow%'),2::bigint,
  'S-67: an occurrence that becomes open after 20:00 is announced by the next run');
set local role authenticated;
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000090';
select is((select jsonb_object_agg(a->>'id',a->'no_available_driver') from jsonb_array_elements(public.get_today(2)#>'{data,timeline}') a
    where a->>'id' in (pg_temp.fixture(511)::text,pg_temp.fixture(512)::text)),
  jsonb_build_object(pg_temp.fixture(511),false,pg_temp.fixture(512),true),'S-67: P-04 "내일" rows say whether anyone can go');

-- ---- S-68: family isolation ----------------------------------------------------------------------------------------------
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000006';
select is(public.declare_no_driver((value#>>'{data,pickup,id}')::uuid,1,'셔틀 타기')#>>'{error,code}','NOT_FOUND',
  'S-68: another family cannot declare no driver on A''s pickup') from r where key='r3';
select is(public.declare_no_driver(pg_temp.fixture(998),1,'셔틀 타기')#>>'{error,code}','NOT_FOUND','as for an unknown ID');
select is(public.ack_fallback((value#>>'{data,pickup,id}')::uuid)#>>'{error,code}','NOT_FOUND','nor acknowledge it') from r where key='r1';
select is(public.set_unavailable_day(pg_temp.today(),true)#>'{data,days}',
  jsonb_build_array(jsonb_build_object('member_id',pg_temp.fixture(21),'day',pg_temp.today())),
  'S-68: another family''s guardian marks only their own day and sees only their family''s days');
select is((select count(*) from public.member_unavailable_days),1::bigint,'S-68: and reads only their family''s rows');
select is(public.get_today(2)#>'{data,unavailable_days}',
  jsonb_build_array(jsonb_build_object('member_id',pg_temp.fixture(21),'day',pg_temp.today())),'S-68: get_today shows only their days');
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000007';
select is(public.ack_fallback((value#>>'{data,pickup,id}')::uuid)#>>'{error,code}','NOT_FOUND','S-68: another family''s rider device cannot')
  from r where key='r1';
select is(jsonb_array_length(public.rider_get_state()#>'{data,actives}'),0,'S-68: and its feed shows nothing of family A');
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000008';
select is(public.declare_no_driver((value#>>'{data,pickup,id}')::uuid,1,'셔틀 타기')#>>'{error,code}','FORBIDDEN',
  'S-68: another family''s car is refused as every car is') from r where key='r3';
set local request.jwt.claim.sub='80000000-0000-4000-8000-000000000001';
select is((select count(*) from public.member_unavailable_days where member_id=pg_temp.fixture(21)),0::bigint,
  'S-68: family A cannot read family B''s days');
select ok(not (public.get_today(2)::text like '%' || pg_temp.fixture(21) || '%'),'S-68: family A''s feed names no family B member');
reset role;
select is((select fallback_ack_at is not null from public.pickups p join r on r.key='r3' and p.id=(r.value#>>'{data,pickup,id}')::uuid),
  true,'family A''s pickup is as A left it');

-- ---- 7.3 retention: past 못 가는 날 go away -----------------------------------------------------------------------------------
insert into public.member_unavailable_days(family_id,member_id,day) values (pg_temp.fixture(10),pg_temp.fixture(12),pg_temp.today()-1);
select ok(deriro_private.retention_cleanup() is not null,'daily retention runs');
select is((select count(*) from public.member_unavailable_days where day<pg_temp.today() and family_id=pg_temp.fixture(10)),0::bigint,
  'a 못 가는 날 that has passed is removed');
select ok(exists(select 1 from public.member_unavailable_days where day=pg_temp.today() and member_id=pg_temp.fixture(11)),
  'today''s is kept');

-- Example feeds for the web (written with --write-fixtures).
select 'get_today_nobody_available' as fixture_name,value as payload from r where key='get_today_nobody_available';
select 'rider_get_state_no_driver' as fixture_name,value as payload from r where key='rider_no_driver';

select * from finish();
rollback;
