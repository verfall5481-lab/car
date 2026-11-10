-- Runs with only the foundation, pickup_rpc and account_linking migrations applied.
-- Every call here would fail if one of those files referenced a later migration.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

create temp table step(name text primary key,value jsonb);
grant select,insert on step to authenticated;
insert into auth.users(id,is_anonymous) values
  ('50000000-0000-4000-8000-000000000001',false),('50000000-0000-4000-8000-000000000002',false),
  ('50000000-0000-4000-8000-000000000003',true);

set local role authenticated;
set local request.jwt.claim.sub='50000000-0000-4000-8000-000000000001';
insert into step values ('owner',public.create_family('엄마','prefix-v1','+821000000001',true,'접두 가족',true));
select is(value->>'ok','true','account_linking: create a family') from step where name='owner';
insert into step values ('invite',public.create_family_invite());
insert into step values ('rider',public.add_rider('민준','child',2018,'prefix-v1','+821000000009'));
select ok((public.create_rider_invite((value#>>'{data,rider,id}')::uuid,'sms')#>'{data}') ? 'is_demo',
  'account_linking: an SMS rider invite reads the family demo flag') from step where name='rider';
insert into step select 'rider_code',public.create_rider_invite((value#>>'{data,rider,id}')::uuid) from step where name='rider';

set local request.jwt.claim.sub='50000000-0000-4000-8000-000000000002';
select is(public.join_family(value#>>'{data,code}','아빠','prefix-v1',p_location_consent=>true)->>'ok','true',
  'account_linking: join a family') from step where name='invite';
insert into step values ('request',public.member_create_request(p_gps=>'{"lat":37.5,"lng":127,"accuracy_m":900}'));
select is(value#>>'{data,pickup,status}','open','pickup_rpc: a member request stores the raw fix') from step where name='request';

set local request.jwt.claim.sub='50000000-0000-4000-8000-000000000001';
select is(public.accept_pickup((value#>>'{data,pickup,id}')::uuid)#>>'{data,pickup,status}','assigned','pickup_rpc: accept')
  from step where name='request';

set local request.jwt.claim.sub='50000000-0000-4000-8000-000000000002';
select is(public.leave_family()->>'ok','true','account_linking: leave with an active request');
reset role;
select is((select status::text||':'||cancelled_by_kind from public.pickups),'cancelled:system',
  'account_linking: the departed requester''s pickup closes');

set local role authenticated;
set local request.jwt.claim.sub='50000000-0000-4000-8000-000000000003';
select is(public.claim_rider_invite(value#>>'{data,code}')->>'ok','true','account_linking: link a rider device') from step where name='rider_code';
insert into step values ('rider_request',public.rider_create_request(p_gps=>'{"lat":37.5,"lng":127}'));
select is(public.cancel_pickup((value#>>'{data,pickup,id}')::uuid,(value#>>'{data,pickup,version}')::int)#>>'{data,pickup,cancel_reason}',
  'child_cancelled','pickup_rpc: a rider cancellation stores its reason') from step where name='rider_request';
insert into step values ('second_request',public.rider_create_request(p_gps=>'{"lat":37.5,"lng":127}'));

set local request.jwt.claim.sub='50000000-0000-4000-8000-000000000001';
select is(public.archive_rider((value#>>'{data,rider,id}')::uuid)->>'ok','true','account_linking: archive a rider with a live request')
  from step where name='rider';
reset role;
select is((select e.actor_kind||':'||(e.payload->>'cause') from public.pickup_events e join step s on s.name='second_request'
  and e.pickup_id=(s.value#>>'{data,pickup,id}')::uuid where e.event_type='cancelled'),'guardian:rider_archived',
  'account_linking: archiving records the guardian''s cancellation');

reset role;
select * from finish();
rollback;
