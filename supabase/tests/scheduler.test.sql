begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

create function pg_temp.fixture(n int) returns uuid language sql immutable
as $$ select ('20000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid $$;
insert into auth.users(id,is_anonymous) values(pg_temp.fixture(1),false),(pg_temp.fixture(2),false),(pg_temp.fixture(3),true);
insert into public.families(id,name) values(pg_temp.fixture(10),'알림 검증 가족');
insert into public.family_members(id,family_id,auth_user_id,display_name,phone_e164,sms_opt_in) values
  (pg_temp.fixture(11),pg_temp.fixture(10),pg_temp.fixture(1),'엄마','+821000000001',true),
  (pg_temp.fixture(12),pg_temp.fixture(10),pg_temp.fixture(2),'아빠','+821000000002',false);
insert into public.riders(id,family_id,display_name,kind,consent_basis,location_consented_at) values
  (pg_temp.fixture(21),pg_temp.fixture(10),'민준','child','guardian',now()),
  (pg_temp.fixture(22),pg_temp.fixture(10),'서연','child','guardian',now()),
  (pg_temp.fixture(23),pg_temp.fixture(10),'할머니','adult','self',now());
insert into public.rider_devices(family_id,rider_id,auth_user_id) values(pg_temp.fixture(10),pg_temp.fixture(21),pg_temp.fixture(3));
insert into public.vehicles(id,family_id,nickname,current_driver_member_id)
  values(pg_temp.fixture(31),pg_temp.fixture(10),'우리 차',pg_temp.fixture(12));
insert into public.vehicle_states(vehicle_id,gear,collected_at,range_km)
  values(pg_temp.fixture(31),'P',now(),8);
insert into public.places(family_id,label,kind,lat,lng) values(pg_temp.fixture(10),'집','home',37.5,127);
insert into public.pickups(id,family_id,rider_id,source,location_source,location_confirmed,dest_lat,dest_lng,dest_label,wanted_at,created_at)
  values(pg_temp.fixture(41),pg_temp.fixture(10),pg_temp.fixture(21),'request','map_pin',true,37.55,127.1,'정문',now(),now()-interval '2 min 30 sec');

select ok(deriro_private.run_escalations()>=1,'open request enters escalation processing');
select is((select count(*) from public.notifications_outbox where template='child_request_repeat'),2::bigint,'at two minutes eligible drivers get repeat push');
select is((select count(*) from public.notifications_outbox where channel='sms'),0::bigint,'no SMS before three minutes');

update public.pickups set created_at=now()-interval '3 min 30 sec' where id=pg_temp.fixture(41);
select ok(deriro_private.run_escalations()>=1,'three-minute timer processed');
select is((select count(*) from public.notifications_outbox where template='esc_sms_open'),1::bigint,'three-minute SMS goes to opted-in guardian only');

update public.pickups set created_at=now()-interval '5 min 30 sec' where id=pg_temp.fixture(41);
set local role authenticated;
set local request.jwt.claim.sub='20000000-0000-4000-8000-000000000003';
select is(public.rider_get_state()#>>'{data,actives,0,escalation_stage}','1','five minutes highlights the rider call option');
reset role;

update public.pickups set created_at=now()-interval '10 min 30 sec' where id=pg_temp.fixture(41);
select ok(deriro_private.run_escalations()>=1,'ten-minute timer processed');
select is((select count(*) from public.notifications_outbox where template='esc_sms_open_urgent'),1::bigint,'ten-minute SMS adds one urgent job');
select is((select count(*) from public.notifications_outbox where template='child_request_repeat'),2::bigint,'scheduler dedupes repeat push across ticks');

create temp table jobs(payload jsonb);
grant select,insert on jobs to service_role;
set local role service_role;
insert into jobs values (public.svc_claim_outbox(20,60));
reset role;
set local role authenticated;
set local request.jwt.claim.sub='20000000-0000-4000-8000-000000000002';
select is(public.accept_pickup(pg_temp.fixture(41))#>>'{data,pickup,status}','assigned','request can be accepted before queued SMS is sent');
reset role;
set local role service_role;
select is(public.svc_outbox_still_valid((j->>'id')::bigint,(j->>'claim_token')::uuid)#>>'{data,valid}',
  'false','worker revalidation skips queued open-request SMS after acceptance')
from jobs cross join lateral jsonb_array_elements(payload#>'{data,jobs}') x(j) where j->>'template'='esc_sms_open';
reset role;

update public.pickups set accepted_at=now()-interval '11 minutes',wanted_at=now()-interval '11 minutes' where id=pg_temp.fixture(41);
select ok(deriro_private.run_escalations()>=1,'assigned timer processed');
select is((select count(*) from public.notifications_outbox where template='not_departed_assignee'),1::bigint,'ten-minute assigned reminder targets assignee');
select is((select count(*) from public.notifications_outbox where template='not_departed_family'),0::bigint,'no family reminder before twenty minutes');
update public.pickups set dest_lng=127.2 where id=pg_temp.fixture(41);
select ok(deriro_private.run_escalations()>=1,'scheduler rechecks revised destination');
select is((select count(*) from public.notifications_outbox where template='not_departed_assignee'),1::bigint,'destination revision does not reset assignment dedupe');

update public.pickups set accepted_at=now()-interval '21 minutes',wanted_at=now()-interval '21 minutes' where id=pg_temp.fixture(41);
select ok(deriro_private.run_escalations()>=1,'twenty-minute timer processed');
select is((select count(*) from public.notifications_outbox where template='not_departed_family'),2::bigint,'twenty-minute assigned reminder reaches family');

update public.pickups set status='arrived',arrived_at=now()-interval '31 minutes' where id=pg_temp.fixture(41);
select is((select count(*) from public.notifications_outbox where template='not_departed_family' and status='skipped'),
  2::bigint,'status change skips pending reminders for the previous stage');
select ok(deriro_private.run_escalations()>=1,'arrival timer processed');
select is((select count(*) from public.notifications_outbox where template='boarding_check'),1::bigint,'thirty-minute boarding reminder reaches assignee');
select is((select count(*) from public.notifications_outbox where template='boarding_check_family'),0::bigint,'no family reminder before sixty minutes');
update public.pickups set arrived_at=now()-interval '61 minutes' where id=pg_temp.fixture(41);
select ok(deriro_private.run_escalations()>=1,'sixty-minute arrival timer processed');
select is((select count(*) from public.notifications_outbox where template='boarding_check_family'),2::bigint,'sixty-minute boarding reminder reaches family');
select is((select status::text from public.pickups where id=pg_temp.fixture(41)),'arrived','reminders never mark pickup completed');

insert into public.pickups(id,family_id,rider_id,source,status,assignee_member_id,vehicle_id,location_source,location_confirmed,dest_lat,dest_lng,dest_label,wanted_at)
  values(pg_temp.fixture(42),pg_temp.fixture(10),pg_temp.fixture(22),'request','assigned',pg_temp.fixture(12),pg_temp.fixture(31),
    'map_pin',true,37.55,127.1,'학교',now()+interval '20 minutes');
select is((select count(*) from public.notifications_outbox where template='low_range'),1::bigint,'low range queues a first warning');
create temp table first_alert as select id from public.vehicle_alerts where vehicle_id=pg_temp.fixture(31) and resolved_at is null;
grant select on first_alert to authenticated;
set local role authenticated;
set local request.jwt.claim.sub='20000000-0000-4000-8000-000000000002';
select is(public.ack_vehicle_alert((select id from first_alert))->>'ok','true','guardian acknowledges range warning');
reset role;
select ok(deriro_private.recompute_low_range(pg_temp.fixture(31)) is not null,'same vehicle inputs still describe shortage');
select is((select count(*) from public.notifications_outbox where template='low_range'),1::bigint,'same inputs do not send another warning');
select ok((select acknowledged_at is not null from public.vehicle_alerts where id=(select id from first_alert)),
  'same inputs preserve acknowledgment');
insert into public.pickups(id,family_id,rider_id,source,status,assignee_member_id,vehicle_id,location_source,location_confirmed,dest_lat,dest_lng,dest_label,wanted_at)
  values(pg_temp.fixture(43),pg_temp.fixture(10),pg_temp.fixture(23),'request','assigned',pg_temp.fixture(12),pg_temp.fixture(31),
    'map_pin',true,37.57,127.1,'학원',now()+interval '25 minutes');
select is((select count(*) from public.vehicle_alerts where resolved_at is null),1::bigint,'new pickup updates the existing warning');
select is((select pickup_count from public.vehicle_alerts where id=(select id from first_alert)),2,'existing warning tracks both assignments');
select ok((select acknowledged_at is null from public.vehicle_alerts where id=(select id from first_alert)),
  'new pickup clears the warning acknowledgment');
select is((select count(*) from public.notifications_outbox where template='low_range'),2::bigint,'new assignment queues one renewed warning');

select * from finish();
rollback;
