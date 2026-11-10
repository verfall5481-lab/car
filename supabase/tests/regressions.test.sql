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

select * from finish();
rollback;
