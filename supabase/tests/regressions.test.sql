-- Regression tests for the backend review fixes: member departure, geo labels, per-subscription push,
-- constraint-scoped error mapping, range verdicts and a read-only get_today.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

create function pg_temp.fixture(n int) returns uuid language sql immutable
as $$ select ('40000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid $$;
create temp table saved(name text primary key,value jsonb);
grant select,insert,update on saved to authenticated,service_role;

insert into auth.users(id,is_anonymous) values
  (pg_temp.fixture(1),false),(pg_temp.fixture(2),false),(pg_temp.fixture(3),false),
  (pg_temp.fixture(4),true),(pg_temp.fixture(5),true),(pg_temp.fixture(6),false),(pg_temp.fixture(7),false);
insert into public.families(id,name) values(pg_temp.fixture(10),'회귀 가족'),(pg_temp.fixture(90),'후임 없는 가족');
insert into public.family_members(id,family_id,auth_user_id,display_name,role,can_drive,can_request,location_consented_at,phone_e164,sms_opt_in) values
  (pg_temp.fixture(11),pg_temp.fixture(10),pg_temp.fixture(1),'엄마','owner',true,true,now(),null,false),
  (pg_temp.fixture(12),pg_temp.fixture(10),pg_temp.fixture(2),'아빠','guardian',true,true,now(),'+821000000012',true),
  (pg_temp.fixture(13),pg_temp.fixture(10),pg_temp.fixture(3),'삼촌','guardian',true,true,now(),null,false),
  (pg_temp.fixture(91),pg_temp.fixture(90),pg_temp.fixture(6),'할아버지','owner',false,true,now(),null,false),
  (pg_temp.fixture(92),pg_temp.fixture(90),pg_temp.fixture(7),'이모','guardian',true,true,now(),null,false);
insert into public.riders(id,family_id,display_name,kind,consent_basis,location_consented_at) values
  (pg_temp.fixture(21),pg_temp.fixture(10),'민준','child','guardian',now()),
  (pg_temp.fixture(22),pg_temp.fixture(10),'서연','child','guardian',now()),
  (pg_temp.fixture(23),pg_temp.fixture(10),'할머니','adult','self',now()),
  (pg_temp.fixture(24),pg_temp.fixture(10),'지우','child','guardian',now()),
  (pg_temp.fixture(93),pg_temp.fixture(90),'하늘','child','guardian',now());
insert into public.rider_devices(family_id,rider_id,auth_user_id) values(pg_temp.fixture(10),pg_temp.fixture(23),pg_temp.fixture(5));
insert into public.places(id,family_id,label,kind,lat,lng) values(pg_temp.fixture(31),pg_temp.fixture(10),'집','home',37.5,127);
insert into public.vehicles(id,family_id,auth_user_id,nickname,current_driver_member_id) values
  (pg_temp.fixture(41),pg_temp.fixture(10),pg_temp.fixture(4),'아빠 차',pg_temp.fixture(12)),
  (pg_temp.fixture(42),pg_temp.fixture(10),null,'엄마 차',pg_temp.fixture(11));
insert into public.vehicle_states(vehicle_id,gear,collected_at,range_km) values(pg_temp.fixture(41),'P',now(),500);

-- Departure (8.3 remove_member, leave_family): a departed requester's pickups close.
set local role authenticated;
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000000003';
insert into saved values ('own_request',public.member_create_request(p_place_id=>pg_temp.fixture(31)));
reset role;
update public.pickups set created_at=now()-interval '4 minutes' where id=(select (value#>>'{data,pickup,id}')::uuid from saved where name='own_request');
set local role authenticated;
select is(public.leave_family()->>'ok','true','a requester can leave with an open request');
reset role;
select is((select status::text||':'||cancelled_by_kind||':'||cancel_reason from public.pickups
  where id=(select (value#>>'{data,pickup,id}')::uuid from saved where name='own_request')),
  'cancelled:system:cancelled','a departed requester''s open request closes as a system cancellation');
select ok(exists(select 1 from public.pickup_events e join saved s on s.name='own_request' and e.pickup_id=(s.value#>>'{data,pickup,id}')::uuid
  where e.event_type='cancelled' and e.actor_kind='system' and e.payload->>'cause'='requester_left'),'requester departure is recorded on the pickup');
select is((select count(*) from public.notifications_outbox x join saved s on s.name='own_request' and x.pickup_id=(s.value#>>'{data,pickup,id}')::uuid
  where x.template='child_request_new' and x.status='pending'),0::bigint,'pending request alerts for the departed requester are skipped');
select ok(deriro_private.run_escalations()>=0,'scheduler runs after the departure');
select is((select count(*) from public.notifications_outbox x join saved s on s.name='own_request' and x.pickup_id=(s.value#>>'{data,pickup,id}')::uuid
  where x.template in ('esc_sms_open','child_request_repeat')),0::bigint,'a departed requester''s request no longer escalates or sends SMS');

-- Departure: an en_route or arrived pickup goes back to assigned under the owner.
insert into public.pickups(id,family_id,rider_id,source,status,assignee_member_id,vehicle_id,location_source,location_confirmed,
  dest_lat,dest_lng,dest_label,wanted_at,accepted_at,en_route_at,nav_session_id,nav_destination_revision,nav_status,last_start_action_id)
values(pg_temp.fixture(51),pg_temp.fixture(10),pg_temp.fixture(21),'request','en_route',pg_temp.fixture(12),pg_temp.fixture(41),'map_pin',true,
  37.51,127.01,'정문',now(),now(),now(),pg_temp.fixture(61),1,'requested',pg_temp.fixture(62));
update public.vehicles set active_pickup_id=pg_temp.fixture(51),active_nav_session_id=pg_temp.fixture(61),active_destination_revision=1
  where id=pg_temp.fixture(41);
insert into public.pickups(id,family_id,rider_id,source,status,assignee_member_id,location_source,location_confirmed,
  dest_lat,dest_lng,dest_label,wanted_at,accepted_at,en_route_at,arrived_at,arrived_source)
values(pg_temp.fixture(52),pg_temp.fixture(10),pg_temp.fixture(22),'request','arrived',pg_temp.fixture(12),'map_pin',true,
  37.51,127.01,'후문',now(),now(),now(),now(),'manual');
set local role authenticated;
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000000002';
select is(public.leave_family()->>'ok','true','an assignee can leave during a trip');
reset role;
select is((select string_agg(status::text||':'||(assignee_member_id=pg_temp.fixture(11))::text,',' order by id) from public.pickups
  where id in (pg_temp.fixture(51),pg_temp.fixture(52))),'assigned:true,assigned:true',
  'en_route and arrived pickups return to assigned under the owner');
select ok((select bool_and(en_route_at is null and arrived_at is null and arrived_source is null and nav_session_id is null
  and nav_destination_revision is null and nav_status='none' and last_start_action_id is null and vehicle_id is null and accepted_at is not null)
  from public.pickups where id in (pg_temp.fixture(51),pg_temp.fixture(52))),'the successor starts without the previous trip''s departure or navigation');
select ok((select active_pickup_id is null and active_nav_session_id is null and current_driver_member_id is null
  from public.vehicles where id=pg_temp.fixture(41)),'the departed driver''s vehicle guidance ends');
select is((select string_agg(e.payload->>'previous_status',',' order by e.pickup_id) from public.pickup_events e
  where e.pickup_id in (pg_temp.fixture(51),pg_temp.fixture(52)) and e.event_type='member_reassigned'
    and e.payload->>'previous_assignee_id'=pg_temp.fixture(12)::text),'en_route,arrived','reassignment events record the interrupted state');
select is((select count(*) from public.notifications_outbox where pickup_id in (pg_temp.fixture(51),pg_temp.fixture(52))
  and template='pickup_accepted' and recipient_member_id=pg_temp.fixture(11)),2::bigint,'the owner is told about each inherited pickup');
select is((select count(*) from public.notifications_outbox where pickup_id in (pg_temp.fixture(51),pg_temp.fixture(52))
  and template='child_assigned' and recipient_rider_id in (pg_temp.fixture(21),pg_temp.fixture(22))),2::bigint,'each rider learns who is coming now');
set local role authenticated;
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000000001';
select is(public.mark_en_route(pg_temp.fixture(51),(select version from public.pickups where id=pg_temp.fixture(51)))#>>'{data,pickup,status}',
  'en_route','the new assignee departs normally');
reset role;

-- Departure without an eligible successor cancels the trip.
insert into public.pickups(id,family_id,rider_id,source,status,assignee_member_id,location_source,location_confirmed,
  dest_lat,dest_lng,dest_label,wanted_at,accepted_at,en_route_at)
values(pg_temp.fixture(53),pg_temp.fixture(90),pg_temp.fixture(93),'request','en_route',pg_temp.fixture(92),'map_pin',true,
  37.51,127.01,'정문',now(),now(),now());
set local role authenticated;
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000000007';
select is(public.leave_family()->>'ok','true','the only driver can leave');
reset role;
select is((select status::text||':'||cancelled_by_kind from public.pickups where id=pg_temp.fixture(53)),'cancelled:system',
  'without an eligible successor the trip is cancelled');
select ok(exists(select 1 from public.notifications_outbox where pickup_id=pg_temp.fixture(53) and template='pickup_cancelled_urgent'
  and recipient_member_id=pg_temp.fixture(91)),'the family gets the urgent cancellation notice');

-- Geo label (8.8): the area label is display text and never makes a client's version stale.
set local role authenticated;
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000000005';
insert into saved values ('gps',public.rider_create_request(p_gps=>'{"lat":37.5012,"lng":127.0396,"accuracy_m":900}'));
reset role;
select is((select location_confirmed::text from public.pickups where id=(select (value#>>'{data,pickup,id}')::uuid from saved where name='gps')),
  'false','an inaccurate fix stays unconfirmed');
set local role service_role;
insert into saved values ('claim_geo',public.svc_claim_outbox(100,60));
insert into saved select 'geo_label',public.svc_apply_geo_label((j->>'id')::bigint,(j->>'claim_token')::uuid,'역삼1동 근처')
  from saved s cross join lateral jsonb_array_elements(s.value#>'{data,jobs}') j where s.name='claim_geo' and j->>'channel'='geo';
reset role;
select is((select value#>>'{data,updated}' from saved where name='geo_label'),'true','the worker writes the area label');
select is((select dest_label||':'||version||':'||destination_revision from public.pickups
  where id=(select (value#>>'{data,pickup,id}')::uuid from saved where name='gps')),
  '역삼1동 근처:'||(select (value#>>'{data,pickup,version}')||':'||(value#>>'{data,pickup,destination_revision}') from saved where name='gps'),
  'the label is visible without changing version or destination revision');
select is(coalesce(current_setting('deriro.label_refresh',true),''),'','the label marker does not leak past the write');
set local role authenticated;
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000000005';
select is(public.rider_get_state()#>>'{data,actives,0,dest_label}','역삼1동 근처','the rider feed shows the area label');
select is(public.rider_cancel_request((value#>>'{data,pickup,id}')::uuid,(value#>>'{data,pickup,version}')::int)#>>'{data,pickup,status}',
  'cancelled','the version read before the label write still cancels') from saved where name='gps';
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000000001';
insert into saved values ('owner_request',public.member_create_request(p_gps=>'{"lat":37.52,"lng":127.05,"accuracy_m":900}'));
select is(public.confirm_location((value#>>'{data,pickup,id}')::uuid,(value#>>'{data,pickup,version}')::int,37.52,127.05,'정문 앞')#>>'{data,pickup,destination_revision}',
  '2','a guardian''s location edit still revises the destination') from saved where name='owner_request';
reset role;

-- Web Push: a retry goes only to subscriptions that have not accepted the job.
insert into public.push_subscriptions(id,family_id,auth_user_id,endpoint,p256dh,auth) values
  (pg_temp.fixture(81),pg_temp.fixture(10),pg_temp.fixture(1),'https://fcm.googleapis.com/fcm/send/regression-a','k','a'),
  (pg_temp.fixture(82),pg_temp.fixture(10),pg_temp.fixture(1),'https://fcm.googleapis.com/fcm/send/regression-b','k','a');
with job as (insert into public.notifications_outbox(family_id,recipient_member_id,channel,template,dedupe_key)
  values(pg_temp.fixture(10),pg_temp.fixture(11),'push','test_push','regression:partial') returning id)
insert into saved select 'push_job',to_jsonb(id) from job;
with job as (insert into public.notifications_outbox(family_id,recipient_member_id,channel,template,dedupe_key)
  values(pg_temp.fixture(10),pg_temp.fixture(11),'push','test_push','regression:failed') returning id)
insert into saved select 'failed_job',to_jsonb(id) from job;
create temp view claims as select s.name as claim,(j->>'id')::bigint as id,(j->>'claim_token')::uuid as token
  from saved s cross join lateral jsonb_array_elements(s.value#>'{data,jobs}') j where s.name like 'claim_push%';
grant select on claims to service_role;
create temp view jobs_under_test as select name,value::bigint as id from saved where name in ('push_job','failed_job');
grant select on jobs_under_test to service_role;
set local role service_role;
insert into saved values ('claim_push_1',public.svc_claim_outbox(100,60));
select is(jsonb_array_length(public.svc_outbox_still_valid(c.id,c.token)#>'{data,subscriptions}'),2,'the first attempt targets every subscription')
  from claims c join jobs_under_test j on j.id=c.id and j.name='push_job' where c.claim='claim_push_1';
select is(public.svc_finish_outbox(c.id,pg_temp.fixture(999),'pending','partial_push',array[pg_temp.fixture(81)])#>>'{data,updated}','false',
  'a stale claim cannot record deliveries') from claims c join jobs_under_test j on j.id=c.id and j.name='push_job' where c.claim='claim_push_1';
select is(public.svc_finish_outbox(c.id,c.token,'pending','partial_push',array[pg_temp.fixture(81)])#>>'{data,updated}','true',
  'a partial delivery is recorded') from claims c join jobs_under_test j on j.id=c.id and j.name='push_job' where c.claim='claim_push_1';
reset role;
select is((select status::text||':'||delivered_subscription_ids::text from public.notifications_outbox
  where id=(select id from jobs_under_test where name='push_job')),
  'pending:{'||pg_temp.fixture(81)||'}','the job waits for a retry and remembers the accepted subscription');
update public.notifications_outbox set scheduled_at=now()-interval '1 second' where id=(select id from jobs_under_test where name='push_job');
set local role service_role;
insert into saved values ('claim_push_2',public.svc_claim_outbox(100,60));
select is(public.svc_outbox_still_valid(c.id,c.token)#>'{data,subscriptions}'->0->>'id',pg_temp.fixture(82)::text,
  'the retry targets only the remaining subscription')
  from claims c join jobs_under_test j on j.id=c.id and j.name='push_job' where c.claim='claim_push_2';
select is(jsonb_array_length(public.svc_outbox_still_valid(c.id,c.token)#>'{data,subscriptions}')||':'||
  (public.svc_outbox_still_valid(c.id,c.token)#>>'{data,delivered_count}'),'1:1','the retry reports earlier deliveries')
  from claims c join jobs_under_test j on j.id=c.id and j.name='push_job' where c.claim='claim_push_2';
reset role;
update public.notifications_outbox set attempts=4 where id in (select id from jobs_under_test);
set local role service_role;
select is(public.svc_finish_outbox(c.id,c.token,'pending','push_retry')#>>'{data,updated}','true','the last attempt of a partial push finishes')
  from claims c join jobs_under_test j on j.id=c.id and j.name='push_job' where c.claim='claim_push_2';
select is(public.svc_finish_outbox(c.id,c.token,'pending','push_retry')#>>'{data,updated}','true','the last attempt of an undelivered push finishes')
  from claims c join jobs_under_test j on j.id=c.id and j.name='failed_job' where c.claim='claim_push_1';
reset role;
select is((select string_agg(j.name||':'||x.status,',' order by j.name) from public.notifications_outbox x join jobs_under_test j on j.id=x.id),
  'failed_job:failed,push_job:sent','attempts running out mark a partial push sent and an undelivered push failed');

-- Error mapping: only the named conflicts become business errors.
set local role authenticated;
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000000001';
select is(public.add_rider('민준','child',2019,'test-policy-v1')#>>'{error,code}','NAME_TAKEN','a duplicate active rider name is NAME_TAKEN');
insert into saved values ('point',public.upsert_pickup_point(pg_temp.fixture(31),'대문',37.5,127));
select is(public.upsert_pickup_point(pg_temp.fixture(31),'대문',37.5001,127)#>>'{error,code}','NAME_TAKEN','a duplicate pickup point label is NAME_TAKEN');
reset role;
create unique index regression_unexpected_unique on public.riders(birth_year) where birth_year = 1950;
alter table public.vehicle_states add constraint regression_unexpected_check check (fuel_pct is distinct from 42);
set local role authenticated;
select ok(public.add_rider('첫째','adult',1950)->>'ok' = 'true','the first rider passes the extra index');
select throws_ok($$ select public.add_rider('둘째','adult',1950) $$,'23505',null,'an unexpected unique violation is raised, not reported as NAME_TAKEN');
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000000004';
select is(public.upsert_vehicle_state('P',now()+interval '1 second',5000)#>>'{error,code}','VALIDATION','telemetry outside a value check is VALIDATION');
select throws_ok($$ select public.upsert_vehicle_state('P',now()+interval '1 second',100,42) $$,'23514',null,'an unexpected check violation is raised');
reset role;

-- Range (F-16, A.2, A.3): stale or incomplete telemetry never reads as sufficient.
insert into public.pickups(id,family_id,rider_id,source,status,assignee_member_id,vehicle_id,location_source,location_confirmed,
  dest_lat,dest_lng,dest_label,wanted_at)
values(pg_temp.fixture(54),pg_temp.fixture(10),pg_temp.fixture(24),'request','assigned',pg_temp.fixture(11),pg_temp.fixture(42),'map_pin',true,
  37.51,127.01,'학원',now()+interval '1 hour');
insert into public.vehicle_states(vehicle_id,gear,collected_at,range_km) values(pg_temp.fixture(42),'P',now()-interval '8 hours',500);
select is((select deriro_private.range_summary(v)->>'verdict' from public.vehicles v where v.id=pg_temp.fixture(42)),'check_required',
  'an eight-hour-old range is not called sufficient');
update public.vehicle_states set collected_at=now() where vehicle_id=pg_temp.fixture(42);
select is((select deriro_private.range_summary(v)->>'verdict' from public.vehicles v where v.id=pg_temp.fixture(42)),'sufficient',
  'a fresh range with every pickup computed is sufficient');
update public.places set archived_at=now() where id=pg_temp.fixture(31);
select is((select deriro_private.range_summary(v)->>'verdict' from public.vehicles v where v.id=pg_temp.fixture(42)),'check_required',
  'without an origin the required distance is unknown');
update public.places set archived_at=null where id=pg_temp.fixture(31);
update public.vehicle_states set range_km=1,collected_at=now()-interval '8 hours' where vehicle_id=pg_temp.fixture(42);
select is((select deriro_private.range_summary(v)->>'verdict' from public.vehicles v where v.id=pg_temp.fixture(42)),'low',
  'a shortage is still reported from a reading under 24 hours old');
select ok(deriro_private.recompute_low_range(pg_temp.fixture(42)) is not null,'the shortage opens a warning');
update public.vehicle_states set range_km=500 where vehicle_id=pg_temp.fixture(42);
select ok(deriro_private.recompute_low_range(pg_temp.fixture(42)) is null,'stale sufficient data reports nothing');
select is((select count(*) from public.vehicle_alerts where vehicle_id=pg_temp.fixture(42) and resolved_at is null),1::bigint,
  'stale data does not close the warning');
update public.vehicle_states set collected_at=now()-interval '25 hours' where vehicle_id=pg_temp.fixture(42);
update public.pickups set status='cancelled',cancelled_at=now() where id=pg_temp.fixture(54);
select is((select count(*) from public.vehicle_alerts where vehicle_id=pg_temp.fixture(42) and resolved_at is null),1::bigint,
  'day-old telemetry neither creates nor closes a warning');
update public.vehicle_states set collected_at=now() where vehicle_id=pg_temp.fixture(42);
select ok(deriro_private.recompute_low_range(pg_temp.fixture(42)) is null,'fresh telemetry is evaluated');
select is((select count(*) from public.vehicle_alerts where vehicle_id=pg_temp.fixture(42) and resolved_at is null),0::bigint,
  'with fresh telemetry and no assignment the warning closes');

-- get_today is read only. Occurrences come from routine saves and the scheduler (section 9).
insert into public.routines(id,family_id,rider_id,place_id,weekdays,time_local,start_date)
  values(pg_temp.fixture(71),pg_temp.fixture(10),pg_temp.fixture(21),pg_temp.fixture(31),127,'12:00',(now() at time zone 'Asia/Seoul')::date);
set local role authenticated;
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000000001';
select is(public.get_today(2)->>'ok','true','guardian reads today');
reset role;
select is((select count(*) from public.pickups where routine_id=pg_temp.fixture(71)),0::bigint,'reading today creates no occurrences');
select is(deriro_private.maintenance('occurrences')->>'ok','true','the scheduler job runs');
select ok((select count(*) from public.pickups where routine_id=pg_temp.fixture(71))>=1,'the scheduler creates the occurrences');

-- A family of three drivers for the offer-resolution and cancellation-notice regressions below.
insert into auth.users(id,is_anonymous) values
  (pg_temp.fixture(1001),false),(pg_temp.fixture(1002),false),(pg_temp.fixture(1003),false),(pg_temp.fixture(1004),true);
insert into public.families(id,name) values(pg_temp.fixture(1010),'인계 가족');
insert into public.family_members(id,family_id,auth_user_id,display_name,role,can_drive,can_request,location_consented_at) values
  (pg_temp.fixture(1011),pg_temp.fixture(1010),pg_temp.fixture(1001),'엄마','owner',true,true,now()),
  (pg_temp.fixture(1012),pg_temp.fixture(1010),pg_temp.fixture(1002),'아빠','guardian',true,true,now()),
  (pg_temp.fixture(1013),pg_temp.fixture(1010),pg_temp.fixture(1003),'이모','guardian',true,true,now());
insert into public.riders(id,family_id,display_name,kind,consent_basis,location_consented_at) values
  (pg_temp.fixture(1021),pg_temp.fixture(1010),'서연','child','guardian',now()),
  (pg_temp.fixture(1022),pg_temp.fixture(1010),'민준','child','guardian',now()),
  (pg_temp.fixture(1023),pg_temp.fixture(1010),'지우','child','guardian',now());
insert into public.places(id,family_id,label,kind,lat,lng) values(pg_temp.fixture(1031),pg_temp.fixture(1010),'수학학원','academy',37.55,127.1);
insert into public.vehicles(id,family_id,auth_user_id,nickname,current_driver_member_id) values
  (pg_temp.fixture(1041),pg_temp.fixture(1010),pg_temp.fixture(1004),'아빠 차',pg_temp.fixture(1012));
insert into public.vehicle_states(vehicle_id,gear,collected_at,range_km) values(pg_temp.fixture(1041),'P',now(),500);
insert into public.routines(id,family_id,rider_id,place_id,weekdays,time_local,default_assignee_member_id,start_date) values
  (pg_temp.fixture(1071),pg_temp.fixture(1010),pg_temp.fixture(1021),pg_temp.fixture(1031),127,'17:30',pg_temp.fixture(1011),(now() at time zone 'Asia/Seoul')::date),
  (pg_temp.fixture(1072),pg_temp.fixture(1010),pg_temp.fixture(1022),pg_temp.fixture(1031),127,'17:30',pg_temp.fixture(1013),(now() at time zone 'Asia/Seoul')::date),
  (pg_temp.fixture(1073),pg_temp.fixture(1010),pg_temp.fixture(1023),pg_temp.fixture(1031),127,'17:30',pg_temp.fixture(1013),(now() at time zone 'Asia/Seoul')::date),
  (pg_temp.fixture(1074),pg_temp.fixture(1010),pg_temp.fixture(1021),pg_temp.fixture(1031),127,'08:00',pg_temp.fixture(1012),(now() at time zone 'Asia/Seoul')::date);
-- Future routine occurrences. Default assignments have no accepted_at; 1056 and 1057 were explicitly accepted.
insert into public.pickups(id,family_id,rider_id,source,routine_id,occurrence_date,status,assignee_member_id,vehicle_id,place_id,
  location_source,location_confirmed,dest_lat,dest_lng,dest_label,wanted_at,accepted_at,is_customized,assignment_round)
select pg_temp.fixture(x.n),pg_temp.fixture(1010),pg_temp.fixture(x.rider),'routine',pg_temp.fixture(x.routine),
  (now() at time zone 'Asia/Seoul')::date+x.days,'assigned',pg_temp.fixture(x.assignee),case when x.car then pg_temp.fixture(1041) end,
  pg_temp.fixture(1031),'saved_place',true,37.55,127.1,'수학학원',now()+make_interval(days=>x.days),
  case when x.accepted then now()-interval '1 hour' end,x.accepted,1
from (values (1051,1021,1071,1,1011,false,false),(1052,1021,1071,2,1012,true,false),(1058,1021,1071,3,1011,false,false),
  (1054,1022,1072,1,1013,false,true),(1055,1023,1073,1,1013,false,false),(1056,1023,1073,2,1012,false,true),
  (1057,1021,1074,1,1012,false,true)) x(n,rider,routine,days,assignee,car,accepted);

-- Offer resolution on acceptance (4.4 #5, #9; F-11). The default assignee 엄마 hands off to 아빠 and then
-- confirms the trip herself. A sender never accepts her own offer, so confirming withdraws it.
set local role authenticated;
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000001001';
insert into saved values ('own_handoff',public.offer_pickup(pg_temp.fixture(1051),
  (select version from public.pickups where id=pg_temp.fixture(1051)),pg_temp.fixture(1012),'부탁해'));
select is(value#>>'{data,offer,status}','pending','the default assignee hands the occurrence to 아빠') from saved where name='own_handoff';
insert into saved values ('own_confirm',public.accept_pickup(pg_temp.fixture(1051)));
select is(value#>>'{data,pickup,assignee_member_id}',pg_temp.fixture(1011)::text,'confirming keeps 엄마 as the assignee') from saved where name='own_confirm';
reset role;
select is((select status::text||':'||resolved_by_member_id from public.pickup_offers
  where id=(select (value#>>'{data,offer,id}')::uuid from saved where name='own_handoff')),
  'cancelled:'||pg_temp.fixture(1011),'confirming her own trip withdraws 엄마''s pending handoff instead of accepting it');
select is((select count(*) from public.pickup_offers where pickup_id=pg_temp.fixture(1051) and status='accepted'),0::bigint,
  'no offer on the trip is recorded as accepted by its sender');
select ok((select accepted_at is not null from public.pickups where id=pg_temp.fixture(1051)),'the first explicit acceptance is recorded');
select is((select string_agg(template||':'||status,',' order by id) from public.notifications_outbox
  where pickup_id=pg_temp.fixture(1051) and recipient_member_id=pg_temp.fixture(1012)),'offer_to_you:skipped,pickup_accepted:pending',
  '아빠''s handoff card is withdrawn and he is only told that 엄마 has the trip');
select is((select payload->>'who' from public.notifications_outbox where pickup_id=pg_temp.fixture(1051)
  and recipient_member_id=pg_temp.fixture(1012) and template='pickup_accepted'),'엄마','the notice names 엄마, who is still going');
select is((select count(*) from public.notifications_outbox where pickup_id=pg_temp.fixture(1051) and template='offer_accepted'),0::bigint,
  'nobody is told the handoff was accepted');
set local role authenticated;
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000001002';
select is(public.respond_offer((value#>>'{data,offer,id}')::uuid,'accept',(select version from public.pickups where id=pg_temp.fixture(1051)))#>>'{error,code}',
  'OFFER_NOT_PENDING','the recipient can no longer accept the withdrawn handoff') from saved where name='own_handoff';
reset role;

-- The same for a vehicle-origin offer: 아빠's car says "못 가요" on his default occurrence, then 아빠 confirms by phone.
insert into saved values ('version_1052',to_jsonb((select version from public.pickups where id=pg_temp.fixture(1052))));
set local role authenticated;
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000001004';
select is(public.vehicle_decline(pg_temp.fixture(1052),(select value::int from saved where name='version_1052'))#>>'{data,offer,origin}','vehicle',
  'the assigned car hands the occurrence to everyone');
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000001002';
select is(public.accept_pickup(pg_temp.fixture(1052))#>>'{data,pickup,vehicle_id}',pg_temp.fixture(1041)::text,'아빠 confirms his own trip');
reset role;
select is((select string_agg(origin||':'||status||':'||resolved_by_member_id,',') from public.pickup_offers where pickup_id=pg_temp.fixture(1052)),
  'vehicle:cancelled:'||pg_temp.fixture(1012),'the car''s "못 가요" offer is withdrawn, not accepted by 아빠');
select is((select string_agg(template||':'||status,',' order by recipient_member_id,id) from public.notifications_outbox
  where pickup_id=pg_temp.fixture(1052) and recipient_member_id in (pg_temp.fixture(1011),pg_temp.fixture(1013))),
  'offer_to_all:skipped,pickup_accepted:pending,offer_to_all:skipped,pickup_accepted:pending',
  'the other drivers lose the request card and learn that 아빠 has the trip');

-- A family-wide offer the default assignee did not send is still a legitimate acceptance (4.4 #5), and an open request
-- offer is accepted by whoever takes the trip (4.3 #3).
insert into public.pickup_offers(family_id,pickup_id,origin,expires_at)
  values(pg_temp.fixture(1010),pg_temp.fixture(1058),'routine',now()+interval '10 minutes');
set local role authenticated;
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000001001';
select is(public.accept_pickup(pg_temp.fixture(1058))->>'ok','true','the default assignee confirms with a family-wide offer pending');
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000001003';
insert into saved values ('aunt_request',public.member_create_request(p_place_id=>pg_temp.fixture(1031)));
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000001002';
select is(public.accept_pickup((value#>>'{data,pickup,id}')::uuid)#>>'{data,pickup,status}','assigned','아빠 accepts 이모''s request')
  from saved where name='aunt_request';
reset role;
select is((select string_agg(o.pickup_id::text||':'||o.status||':'||o.resolved_by_member_id,',' order by o.pickup_id::text) from public.pickup_offers o
  where o.pickup_id in (pg_temp.fixture(1058),(select (value#>>'{data,pickup,id}')::uuid from saved where name='aunt_request'))),
  (select string_agg(x,',' order by x) from unnest(array[pg_temp.fixture(1058)||':accepted:'||pg_temp.fixture(1011),
    (select value#>>'{data,pickup,id}' from saved where name='aunt_request')||':accepted:'||pg_temp.fixture(1012)]) x),
  'offers addressed to the acceptor are accepted by the acceptor');

-- Archiving a rider (8.3 archive_child) is the archiving guardian's cancellation of every unfinished trip. Whoever
-- had accepted or departed is told (16.1 보호자 취소), urgently when already driving.
insert into public.pickups(id,family_id,rider_id,source,status,assignee_member_id,vehicle_id,location_source,location_confirmed,
  dest_lat,dest_lng,dest_label,wanted_at,accepted_at,en_route_at,nav_session_id,nav_destination_revision,nav_status,last_start_action_id,assignment_round)
values(pg_temp.fixture(1053),pg_temp.fixture(1010),pg_temp.fixture(1022),'request','en_route',pg_temp.fixture(1012),pg_temp.fixture(1041),'map_pin',true,
  37.56,127.11,'학원 후문',now(),now()-interval '5 minutes',now()-interval '2 minutes',pg_temp.fixture(1061),1,'requested',pg_temp.fixture(1062),1);
update public.vehicles set active_pickup_id=pg_temp.fixture(1053),active_nav_session_id=pg_temp.fixture(1061),active_destination_revision=1
  where id=pg_temp.fixture(1041);
set local role authenticated;
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000001001';
select is(public.archive_rider(pg_temp.fixture(1022))->>'ok','true','엄마 archives 민준 while 아빠 is driving to him');
reset role;
select is((select string_agg(status::text||':'||cancelled_by_kind||':'||is_customized,',' order by id) from public.pickups
  where id in (pg_temp.fixture(1053),pg_temp.fixture(1054))),'cancelled:guardian:true,cancelled:guardian:true',
  'the rider''s live trips close as the guardian''s cancellation');
select is((select string_agg(e.actor_kind||':'||e.actor_id||':'||(e.payload->>'cause'),',' order by e.pickup_id) from public.pickup_events e
  where e.pickup_id in (pg_temp.fixture(1053),pg_temp.fixture(1054)) and e.event_type='cancelled'),
  'guardian:'||pg_temp.fixture(1011)||':rider_archived,guardian:'||pg_temp.fixture(1011)||':rider_archived',
  'each cancelled trip records a cancelled event by the archiving guardian');
select is((select template||':'||status from public.notifications_outbox where pickup_id=pg_temp.fixture(1053)
  and recipient_member_id=pg_temp.fixture(1012) and expected_status='cancelled'),'pickup_cancelled_urgent:pending',
  'the driver already on the way gets the urgent cancellation notice');
select is((select template||':'||status from public.notifications_outbox where pickup_id=pg_temp.fixture(1054)
  and recipient_member_id=pg_temp.fixture(1013) and expected_status='cancelled'),'pickup_cancelled:pending',
  'the guardian who accepted the occurrence is told it is cancelled');
select ok((select active_pickup_id is null and active_nav_session_id is null from public.vehicles where id=pg_temp.fixture(1041)),
  'the car''s guidance for the cancelled trip ends');
set local role authenticated;
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000001004';
select ok(jsonb_path_exists(public.vehicle_get_feed(),'$.data.cards[*] ? (@.kind == "cancelled_urgent" && @.pickup_id == $id)',
  jsonb_build_object('id',pg_temp.fixture(1053))),'the assigned car shows the urgent cancellation card');
reset role;

-- Archiving a routine (F-14 시스템: 루틴 보관) cancels its unconfirmed future occurrences as a recorded system transition.
-- An explicitly accepted occurrence is kept (F-10).
set local role authenticated;
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000001001';
select is(public.archive_routine(pg_temp.fixture(1073))->>'ok','true','엄마 archives 지우''s routine');
reset role;
select is((select string_agg(status::text||':'||coalesce(cancel_reason,'-')||':'||coalesce(cancelled_by_kind,'-'),',' order by id) from public.pickups
  where id in (pg_temp.fixture(1055),pg_temp.fixture(1056))),'cancelled:routine_archived:system,assigned:-:-',
  'the default occurrence closes as a system cancellation and the accepted one is kept');
select is((select e.actor_kind||':'||(e.payload->>'cause') from public.pickup_events e where e.pickup_id=pg_temp.fixture(1055) and e.event_type='cancelled'),
  'system:routine_archived','the routine cancellation is recorded as an event');
select is((select template||':'||status from public.notifications_outbox where pickup_id=pg_temp.fixture(1055)
  and recipient_member_id=pg_temp.fixture(1013) and expected_status='cancelled'),'pickup_cancelled:pending',
  'the default assignee is told the occurrence is off');

-- Pausing a routine with "cancel future" (upsert_routine) cancels even accepted occurrences, so it notifies like a skip.
set local role authenticated;
set local request.jwt.claim.sub='40000000-0000-4000-8000-000000001001';
select is(public.upsert_routine(pg_temp.fixture(1021),null,pg_temp.fixture(1031),127,'08:00',20,pg_temp.fixture(1012),
  p_routine_id=>pg_temp.fixture(1074),p_active=>false,p_cancel_future=>true)->>'ok','true','엄마 pauses the routine and cancels its future trips');
reset role;
select is((select status::text||':'||cancel_reason||':'||cancelled_by_kind from public.pickups where id=pg_temp.fixture(1057)),
  'cancelled:skipped:guardian','아빠''s accepted occurrence is skipped by 엄마');
select is((select e.actor_kind||':'||e.actor_id||':'||(e.payload->>'cause') from public.pickup_events e
  where e.pickup_id=pg_temp.fixture(1057) and e.event_type='cancelled'),'guardian:'||pg_temp.fixture(1011)||':routine_paused',
  'the skipped occurrence records who cancelled it');
select is((select template||':'||status from public.notifications_outbox where pickup_id=pg_temp.fixture(1057)
  and recipient_member_id=pg_temp.fixture(1012) and expected_status='cancelled'),'pickup_cancelled:pending',
  'the guardian who accepted it is told');

select * from finish();
rollback;
