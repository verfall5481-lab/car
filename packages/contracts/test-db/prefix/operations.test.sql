-- Runs with the first four migrations applied: everything except notifications.
-- Every call here would fail if one of those files referenced the notifications migration.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

create temp table step(name text primary key,value jsonb);
grant select,insert on step to authenticated;
insert into auth.users(id,is_anonymous) values
  ('60000000-0000-4000-8000-000000000001',false),('60000000-0000-4000-8000-000000000003',true);

set local role authenticated;
set local request.jwt.claim.sub='60000000-0000-4000-8000-000000000001';
insert into step values ('owner',public.create_family('엄마','prefix-v1',p_location_consent=>true));
insert into step values ('home',public.upsert_place('집','home',37.5,127));
insert into step values ('rider',public.add_rider('민준','child',2018,'prefix-v1'));
select is(public.upsert_routine((r.value#>>'{data,rider,id}')::uuid,null,(p.value#>>'{data,place,id}')::uuid,127,'17:30',
  p_start_date=>(now() at time zone 'Asia/Seoul')::date+1)->>'ok','true','operations: save a routine')
  from step r,step p where r.name='rider' and p.name='home';
select is(public.get_today(2)->>'ok','true','operations: read today');
select is(public.get_family_overview()->>'ok','true','operations: read the family overview');
insert into step select 'paused',public.upsert_routine((r.value#>>'{data,rider,id}')::uuid,null,(p.value#>>'{data,place,id}')::uuid,127,'18:30',
  p_start_date=>(now() at time zone 'Asia/Seoul')::date+1) from step r,step p where r.name='rider' and p.name='home';
select is(public.upsert_routine((r.value#>>'{data,rider,id}')::uuid,null,(p.value#>>'{data,place,id}')::uuid,127,'18:30',
  p_start_date=>(now() at time zone 'Asia/Seoul')::date+1,p_routine_id=>(s.value#>>'{data,routine,id}')::uuid,p_active=>false,
  p_cancel_future=>true)->>'ok','true','operations: pause a routine and cancel its occurrences')
  from step r,step p,step s where r.name='rider' and p.name='home' and s.name='paused';
select is(public.archive_routine((select r.id from public.routines r where r.time_local='17:30'))->>'ok','true',
  'operations: archive a routine and cancel its occurrences');
reset role;
select is((select string_agg(e.actor_kind||':'||(e.payload->>'cause'),',' order by e.actor_kind) from public.pickup_events e
  where e.event_type='cancelled'),'guardian:routine_paused,system:routine_archived','operations: both cancellations are recorded');
set local role authenticated;

set local request.jwt.claim.sub='60000000-0000-4000-8000-000000000003';
insert into step values ('pair',public.vehicle_pair_start());
set local request.jwt.claim.sub='60000000-0000-4000-8000-000000000001';
select is(public.vehicle_pair_confirm(p.value#>>'{data,code}','우리 차',(o.value#>>'{data,member,id}')::uuid)->>'ok','true',
  'account_linking: pair a vehicle') from step p,step o where p.name='pair' and o.name='owner';
set local request.jwt.claim.sub='60000000-0000-4000-8000-000000000003';
select is(public.upsert_vehicle_state('P',now(),100,p_lat=>37.5,p_lng=>127,p_location_at=>now())->>'ok','true',
  'operations: store telemetry and recompute range');
select is(public.vehicle_get_feed()->>'ok','true','operations: read the vehicle feed');

reset role;
select * from finish();
rollback;
