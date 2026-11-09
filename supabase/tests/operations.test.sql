begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

create function pg_temp.fixture(n int) returns uuid language sql immutable
as $$ select ('10000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid $$;
create temp table result(key text primary key,value jsonb);
grant select,insert on result to authenticated,service_role;
insert into auth.users(id,is_anonymous) values
  (pg_temp.fixture(1),false),(pg_temp.fixture(2),false),(pg_temp.fixture(3),false),
  (pg_temp.fixture(4),true),(pg_temp.fixture(5),true),(pg_temp.fixture(6),true),
  (pg_temp.fixture(7),true),(pg_temp.fixture(8),true);

set local role authenticated;
set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000001';
insert into result values ('owner',public.create_family('엄마','test-policy-v1','+821000000001',true,'테스트 가족',true));
select is(value->>'ok','true','non-anonymous user creates a family with consent') from result where key='owner';
select is(public.create_family('중복','test-policy-v1')#>>'{error,code}','ALREADY_IN_FAMILY','one family per account');
insert into result values ('family_code',public.create_family_invite());
select ok((value#>>'{data,code}') ~ '^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$','family code excludes ambiguous characters') from result where key='family_code';
select is(public.add_rider('민준','child')#>>'{error,code}','CONSENT_REQUIRED','child registration needs guardian consent');
insert into result values ('child',public.add_rider('민준','child',2018,'test-policy-v1'));
insert into result values ('adult',public.add_rider('할머니','adult'));
insert into result select 'adult_code',public.create_rider_invite((value#>>'{data,rider,id}')::uuid) from result where key='adult';
insert into result select 'child_code',public.create_rider_invite((value#>>'{data,rider,id}')::uuid) from result where key='child';
insert into result values ('home',public.upsert_place('집','home',37.5,127));
insert into result values ('academy',public.upsert_place('수학학원','academy',37.55,127.1));
insert into result select 'gate',public.upsert_pickup_point((value#>>'{data,place,id}')::uuid,'후문',37.5501,127.1,'후문 벤치') from result where key='academy';

set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000002';
select is(public.preview_family_invite(value#>>'{data,code}')#>>'{data,family_name}','테스트 가족','authenticated invite preview returns family display name')
  from result where key='family_code';
insert into result select 'driver',public.join_family(value#>>'{data,code}','아빠','test-policy-v1',p_location_consent=>true) from result where key='family_code';
select is(value->>'ok','true','family invite joins the matching family') from result where key='driver';
set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000003';
select is(public.join_family(value#>>'{data,code}','이모','test-policy-v1')#>>'{error,code}','INVITE_USED','family invite single-use') from result where key='family_code';
insert into result values ('outside',public.create_family('이모','test-policy-v1'));
insert into result values ('outside_place',public.upsert_place('다른 집','home',37.5,127));

set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000004';
select is(public.create_family('익명','test-policy-v1')#>>'{error,code}','FORBIDDEN','anonymous actor cannot onboard as guardian');
select is(public.claim_rider_invite(value#>>'{data,code}')#>>'{error,code}','CONSENT_REQUIRED','adult rider explicitly consents') from result where key='adult_code';
insert into result select 'adult_device',public.claim_rider_invite(value#>>'{data,code}','fixture browser',false,'test-policy-v1') from result where key='adult_code';
select is(value#>>'{data,rider,consent_basis}','self','adult rider links as self-consent') from result where key='adult_device';
select is(public.vehicle_pair_start()#>>'{error,code}','FORBIDDEN','rider principal cannot start a vehicle pairing');

set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000005';
insert into result values ('pair',public.vehicle_pair_start());
select ok((value#>>'{data,code}') ~ '^[A-HJKMNP-Z2-9]{6}$','six-character vehicle pairing code') from result where key='pair';
select is(public.vehicle_pair_status()#>>'{data,paired}','false','vehicle can poll before confirmation');

set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000001';
insert into result select 'car',public.vehicle_pair_confirm(p.value#>>'{data,code}','우리 차',(d.value#>>'{data,member,id}')::uuid)
  from result p,result d where p.key='pair' and d.key='driver';
select is(value->>'ok','true','guardian confirms anonymous vehicle pairing') from result where key='car';
select is(public.vehicle_pair_confirm(p.value#>>'{data,code}','다른 차',(d.value#>>'{data,member,id}')::uuid)#>>'{error,code}',
  'PAIR_CODE_INVALID','pairing code single-use') from result p,result d where p.key='pair' and d.key='driver';
select is(public.archive_place((value#>>'{data,place,id}')::uuid)#>>'{error,code}','NOT_FOUND','cannot archive another family place')
  from result where key='outside_place';

set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000006';
insert into result select 'child_device',public.claim_rider_invite(value#>>'{data,code}') from result where key='child_code';
select is(value->>'ok','true','guardian-consented rider links without asking for self consent') from result where key='child_device';
select is(public.claim_rider_invite(value#>>'{data,code}')#>>'{error,code}','INVITE_USED','rider code single-use') from result where key='child_code';

set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000007';
select is(public.claim_rider_invite('00000000')#>>'{error,code}','INVITE_INVALID','invalid code attempt tracked');
select public.claim_rider_invite('00000000');
select public.claim_rider_invite('00000000');
select public.claim_rider_invite('00000000');
select public.claim_rider_invite('00000000');
select is(public.claim_rider_invite('00000000')#>>'{error,code}','RATE_LIMITED','sixth failed claim blocked without throwing');

set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000001';
insert into result select 'routine',public.upsert_routine((r.value#>>'{data,rider,id}')::uuid,null,
  (p.value#>>'{data,place,id}')::uuid,127,'17:30',p_default_assignee_member_id=>(d.value#>>'{data,member,id}')::uuid,
  p_default_vehicle_id=>(v.value#>>'{data,vehicle,id}')::uuid,p_start_date=>(now() at time zone 'Asia/Seoul')::date+1)
  from result r,result p,result d,result v where r.key='child' and p.key='academy' and d.key='driver' and v.key='car';
select is(value->>'ok','true','guardian saves a routine and generates future occurrences') from result where key='routine';
select is(public.ensure_occurrences(2)#>>'{data,created}','0','occurrences are idempotent');
select is(public.archive_place((value#>>'{data,place,id}')::uuid)#>>'{error,code}','FORBIDDEN','active routine blocks place archive') from result where key='academy';

set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000004';
insert into result select 'request',public.rider_create_request(10,p_pickup_point_id=>(value#>>'{data,pickup_point,id}')::uuid) from result where key='gate';
select is(value#>>'{data,pickup,dest_label}','후문','rider requests a named pickup point') from result where key='request';
select is(public.rider_get_state()#>>'{data,actives,0,dest_label}','후문','rider feed exposes progress at its pickup point');
select is(public.rider_get_state()#>>'{data,rider,display_name}','할머니','rider feed scoped to the current linked device');
select is(public.get_family_overview()#>>'{error,code}','NOT_GUARDIAN','rider cannot use guardian feed');

set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000005';
select is(public.vehicle_pair_status()#>>'{data,paired}','true','confirmed vehicle can poll and bind');
select is(public.upsert_vehicle_state('P',now(),5,p_energy_type=>'bev',p_ignition=>'on',p_is_demo_value=>true)#>>'{data,state,gear}','P',
  'bound vehicle reports state');
insert into result values ('vehicle_get_feed',public.vehicle_get_feed());
select is(value#>>'{data,cards,0,primary_action}','start_now','vehicle feed offers start for a confirmed near-time request') from result where key='vehicle_get_feed';
select is(value#>>'{data,cards,0,rider_name}','할머니','vehicle feed uses general family rider name') from result where key='vehicle_get_feed';
select is(value#>>'{data,vehicle,current_driver,display_name}','아빠','vehicle feed shows current driver') from result where key='vehicle_get_feed';

set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000002';
insert into result select 'accepted',public.accept_pickup((p.value#>>'{data,pickup,id}')::uuid,(v.value#>>'{data,vehicle,id}')::uuid)
  from result p,result v where p.key='request' and v.key='car';
select is(value#>>'{data,pickup,status}','assigned','guardian accepts request with vehicle') from result where key='accepted';
insert into result select 'handoff',public.offer_pickup((p.value#>>'{data,pickup,id}')::uuid,2,(m.value#>>'{data,member,id}')::uuid,'테스트 부탁')
  from result p,result m where p.key='request' and m.key='owner';
select is(value#>>'{data,offer,status}','pending','handoff saved') from result where key='handoff';
insert into result values ('get_today',public.get_today());
select ok(jsonb_path_exists(value,'$.data.active[*] ? (@.offer.note == "테스트 부탁")'),'sender feed embeds outgoing pending offer') from result where key='get_today';
insert into result select 'get_pickup',public.get_pickup((value#>>'{data,pickup,id}')::uuid) from result where key='request';
select is(value#>>'{data,offers,0,note}','테스트 부탁','guardian pickup detail retains handoff history') from result where key='get_pickup';
select ok(jsonb_path_exists(value,'$.data.events[*] ? (@.event_type == "accepted" && @.actor_kind == "guardian" && exists(@.payload.vehicle_id))'),
  'phone acceptance records guardian as actor and vehicle as payload') from result where key='get_pickup';
select ok((value#>'{data,range,required_km}') is not null,'required range available for a home origin') from result where key='get_pickup';
select is(public.rider_mark_boarded((value#>>'{data,pickup,id}')::uuid,2)#>>'{error,code}','FORBIDDEN','rider boarding alias does not accept guardian auth')
  from result where key='request';

set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000001';
insert into result values ('get_family_overview',public.get_family_overview());
select is(jsonb_array_length(value#>'{data,members}'),2,'overview includes both family guardians') from result where key='get_family_overview';
select is(jsonb_array_length(value#>'{data,rider_devices}'),2,'overview exposes connected devices without credentials') from result where key='get_family_overview';
select ok(not jsonb_path_exists(value,'$.data.rider_devices[*].auth_user_id'),'feed conceals device auth IDs') from result where key='get_family_overview';
select is(public.register_push_subscription('https://127.0.0.1/private',repeat('A',87),repeat('A',22))#>>'{error,code}',
  'VALIDATION','push endpoint restricted to known vendors');
select is(public.register_push_subscription('https://fcm.googleapis.com/fcm/send/test',repeat('A',87),repeat('A',22))->>'ok',
  'true','guardian can register a valid push subscription');
select is(public.enqueue_test_push()->>'ok','true','guardian can enqueue test notification');
select ok(not has_function_privilege('authenticated','public.svc_claim_outbox(integer,integer)','EXECUTE'),'client cannot claim outbox');
select is(public.prepare_delete_account()#>>'{error,code}','OWNER_TRANSFER_REQUIRED','owner with other members must transfer ownership before delete');

set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000004';
insert into result values ('rider_get_state',public.rider_get_state());
select key as fixture_name,value as payload from result where key in ('get_family_overview','get_today','get_pickup','rider_get_state','vehicle_get_feed') order by key;

reset role;
insert into public.pickups(family_id,rider_id,source,routine_id,occurrence_date,status,assignee_member_id,vehicle_id,location_source,
  location_confirmed,dest_lat,dest_lng,dest_label,wanted_at)
select (m.value#>>'{data,family,id}')::uuid,(r.value#>>'{data,rider,id}')::uuid,'routine',(s.value#>>'{data,routine,id}')::uuid,
  (now() at time zone 'Asia/Seoul')::date+x.offset_days,'assigned',(d.value#>>'{data,member,id}')::uuid,(v.value#>>'{data,vehicle,id}')::uuid,
  'map_pin',true,37.6,127.2,'범위 테스트',now()+x.delay
from result m,result r,result s,result d,result v, (values (-2,interval '-1 hour'),(3,interval '25 hours')) x(offset_days,delay)
where m.key='owner' and r.key='child' and s.key='routine' and d.key='driver' and v.key='car';
select ok(not exists(select 1 from public.vehicle_alerts a cross join lateral unnest(a.pickup_ids) item
  join public.pickups p on p.id=item where p.dest_label='범위 테스트'),
  'range estimate excludes past and more than 24-hour assignments');
select is((select count(*) from public.notifications_outbox x join result r on r.key='request' and x.pickup_id=(r.value#>>'{data,pickup,id}')::uuid
  where x.template='child_request_new'),2::bigint,'rider request queues each eligible guardian once');
select ok(not exists(select 1 from deriro_private.link_codes l join result r on r.key='child_code'
  where encode(l.code_hash,'escape')=r.value#>>'{data,code}'),'database stores hashed link codes');
select is((select count(*) from public.vehicle_alerts where resolved_at is null),1::bigint,'low range creates a warning for a near assignment');
select ok(deriro_private.reserve_sms_budget((value#>>'{data,family,id}')::uuid,'same-job'),'first SMS reserves daily budget') from result where key='owner';
select ok(deriro_private.reserve_sms_budget((value#>>'{data,family,id}')::uuid,'same-job'),'retry reuses SMS budget reservation') from result where key='owner';
select is((select count(*) from deriro_private.sms_reservations),1::bigint,'retry does not reserve a second SMS unit');
select is((select count(*) from result r cross join generate_series(1,30) x(n)
  where r.key='owner' and deriro_private.reserve_sms_budget((r.value#>>'{data,family,id}')::uuid,'job-'||x.n)),
  29::bigint,'family SMS cap allows 30 distinct sends per Korea calendar day');

set local role service_role;
insert into result values ('jobs',public.svc_claim_outbox(100,60));
select ok(jsonb_array_length(value#>'{data,jobs}')>0,'service can atomically claim notifications') from result where key='jobs';
select is(public.svc_finish_outbox((j.value->>'id')::bigint,pg_temp.fixture(900),'sent')#>>'{data,updated}','false','wrong lease token cannot finish')
  from result r cross join lateral jsonb_array_elements(r.value#>'{data,jobs}') j where r.key='jobs' and j.value->>'template'='test_push';
select is(public.svc_outbox_still_valid((j.value->>'id')::bigint,(j.value->>'claim_token')::uuid)#>>'{data,valid}','true','eligible test push revalidated with subscription')
  from result r cross join lateral jsonb_array_elements(r.value#>'{data,jobs}') j where r.key='jobs' and j.value->>'template'='test_push';
select is(public.svc_release_outbox((j.value->>'id')::bigint,(j.value->>'claim_token')::uuid)#>>'{data,updated}','true','worker can release unprocessed job')
  from result r cross join lateral jsonb_array_elements(r.value#>'{data,jobs}') j where r.key='jobs' and j.value->>'template'='test_push';

reset role;
select is((select attempts from public.notifications_outbox where template='test_push'),0,'releasing returns the attempt');
update public.pickups set status='arrived',arrived_at=now()-interval '3 hours 1 minute',not_met_reported_at=now()-interval '3 hours'
  where id=(select (value#>>'{data,pickup,id}')::uuid from result where key='request');
select ok(deriro_private.run_escalations()>=1,'scheduler processes due pickup');
select is((select p.status::text from public.pickups p join result r on r.key='request' and p.id=(r.value#>>'{data,pickup,id}')::uuid),
  'closed_unconfirmed','scheduler closes without boarding after three hours');
select ok(exists(select 1 from public.notifications_outbox where template='closed_unconfirmed_not_met'),'not-met closure queues urgent notification');
insert into public.pickups(family_id,rider_id,source,status,location_source,location_confirmed,dest_lat,dest_lng,dest_label,pin_note,cancelled_at,wanted_at)
select (m.value#>>'{data,family,id}')::uuid,(r.value#>>'{data,rider,id}')::uuid,'request','cancelled','map_pin',true,
  37.52363,127.12344,'테스트 지도 핀','후문 벤치',now()-interval '31 days',now()-interval '31 days'
from result m,result r where m.key='owner' and r.key='adult';
select deriro_private.retention_cleanup();
select is((select dest_lat from public.pickups where dest_label='테스트 지도 핀'),37.524::double precision,'map pin coordinates rounded after 30 days');
select is((select pin_note from public.pickups where dest_label='테스트 지도 핀'),'후문 벤치','map pin note survives retention rounding');

set local role authenticated;
set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000001';
select is(public.revoke_rider_device((value#>>'{data,device_id}')::uuid)->>'ok','true','guardian revokes rider device') from result where key='adult_device';
set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000004';
select is(public.rider_get_state()#>>'{error,code}','DEVICE_REVOKED','revoked device feed no longer available');

set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000001';
select is(public.set_member_roles((value#>>'{data,member,id}')::uuid,false,true)->>'ok','true','owner can remove another member drive permission')
  from result where key='driver';
insert into result select 'own_request',public.member_create_request(p_place_id=>(value#>>'{data,place,id}')::uuid) from result where key='home';
select is(value#>>'{data,pickup,rider_member_id}',(select value#>>'{data,member,id}' from result where key='owner'),
  'a guardian can make their own request') from result where key='own_request';
select is(public.accept_pickup((value#>>'{data,pickup,id}')::uuid)#>>'{error,code}','FORBIDDEN','guardian requester cannot accept own request')
  from result where key='own_request';
set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000002';
select is((select count(*) from jsonb_array_elements(public.get_today()#>'{data,active}') a,result r
  where r.key='own_request' and a->>'id'=r.value#>>'{data,pickup,id}'),0::bigint,
  'member without drive permission does not see the open incoming request card');
select is(public.leave_family()->>'ok','true','guardian can leave with existing pickup and consent history');
select is(public.get_family_overview()#>>'{error,code}','NOT_GUARDIAN','remaining guardian session loses family access');
reset role;
select is((select deriro_private.member_name(p.assignee_member_id) from public.pickups p join result r
  on r.key='request' and p.id=(r.value#>>'{data,pickup,id}')::uuid),'아빠','closed pickup keeps departed guardian display name');
set local role authenticated;
set local request.jwt.claim.sub='10000000-0000-4000-8000-000000000003';
select is(public.prepare_delete_account()#>>'{error,code}','CONFIRM_FAMILY_DELETE','sole owner must confirm family deletion');
select is(public.prepare_delete_account(true)->>'ok','true','confirmed sole-owner family deletion prepares Auth removal');
select is(public.prepare_delete_account(true)->>'ok','true','account removal can retry after family cleanup');

reset role;
select * from finish();
rollback;
