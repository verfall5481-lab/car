alter table public.families add column is_demo boolean not null default false,
  add column demo_time_scale int not null default 1 check (demo_time_scale between 1 and 60);

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
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from public, anon, authenticated, service_role;

create type public.outbox_status as enum ('pending','sending','sent','skipped','failed');
create table public.notifications_outbox (
  id bigint generated always as identity primary key,
  family_id uuid not null references public.families on delete cascade,
  pickup_id uuid,
  offer_id uuid,
  vehicle_alert_id uuid references public.vehicle_alerts on delete cascade,
  recipient_member_id uuid,
  recipient_rider_id uuid,
  channel text not null check (channel in ('push','sms')),
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
  check (num_nonnulls(recipient_member_id,recipient_rider_id) = 1),
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
alter table public.notifications_outbox enable row level security;
revoke all on public.notifications_outbox from public, anon, authenticated, service_role;

create function deriro_private.queue_pickup(p_pickup public.pickups,p_template text,p_key text,p_audience text,
  p_member_id uuid default null,p_channel text default 'push',p_status public.pickup_status default null,
  p_check_round boolean default false,p_offer public.pickup_offers default null,
  p_offer_status public.offer_status default null,p_exclude_member uuid default null)
returns void language sql set search_path = '' as $$
  insert into public.notifications_outbox(family_id,pickup_id,offer_id,recipient_member_id,recipient_rider_id,
    channel,template,payload,expected_status,expected_assignment_round,expected_offer_status,driver_only,dedupe_key)
  select p_pickup.family_id,p_pickup.id,p_offer.id,t.member_id,t.rider_id,p_channel,p_template,
    jsonb_build_object('rider_name',deriro_private.rider_name(p_pickup),'place',p_pickup.dest_label,
      'time',to_char(p_pickup.wanted_at at time zone 'Asia/Seoul','HH24:MI'),
      'who',deriro_private.member_name(p_pickup.assignee_member_id),
      'from',deriro_private.member_name(p_offer.from_member_id),'to',deriro_private.member_name(p_offer.to_member_id),
      'note',p_offer.note),
    p_status,case when p_check_round then p_pickup.assignment_round end,p_offer_status,
    p_audience='drivers',p_key || ':' || coalesce(t.member_id,t.rider_id)::text
  from (
    select m.id as member_id,null::uuid as rider_id from public.family_members m where m.family_id=p_pickup.family_id
      and m.left_at is null and m.id is distinct from p_exclude_member
      and (p_channel<>'sms' or (m.sms_opt_in and m.phone_e164 is not null))
      and ((p_audience='drivers' and m.can_drive and m.id is distinct from p_pickup.rider_member_id
        and (p_member_id is null or m.id=p_member_id)) or p_audience='family'
        or (p_audience='one' and m.id=p_member_id)
        or (p_audience='rider' and m.id=p_pickup.rider_member_id))
    union all
    select null,r.id from public.riders r where p_audience='rider' and r.id=p_pickup.rider_id and r.archived_at is null
  ) t
  on conflict (dedupe_key) do nothing
$$;

create function deriro_private.on_pickup_event()
returns trigger language plpgsql set search_path = '' as $$
declare
  p public.pickups;
  offer public.pickup_offers;
  key text := new.event_type || ':' || new.id;
  prior_id uuid;
begin
  select * into p from public.pickups where id=new.pickup_id;
  if new.payload ? 'offer_id' then
    select * into offer from public.pickup_offers where id=(new.payload->>'offer_id')::uuid and pickup_id=p.id;
  end if;
  case new.event_type
    when 'created' then
      if p.source='request' then perform deriro_private.queue_pickup(p,'child_request_new',key,'drivers',p_status=>'open'); end if;
    when 'offered' then
      perform deriro_private.queue_pickup(p,case when offer.to_member_id is null then 'offer_to_all' else 'offer_to_you' end,key,
        'drivers',offer.to_member_id,p_status=>'assigned',p_offer=>offer,p_offer_status=>'pending',p_exclude_member=>offer.from_member_id);
    when 'offer_declined' then
      if offer.from_member_id is not null and (offer.to_member_id is not null or offer.status='declined') then
        perform deriro_private.queue_pickup(p,case when offer.to_member_id is null then 'offer_all_declined' else 'offer_declined' end,key,
          'one',offer.from_member_id,p_status=>'assigned',p_offer=>offer,p_offer_status=>'declined');
      end if;
    when 'offer_expired' then
      if offer.from_member_id is not null then
        perform deriro_private.queue_pickup(p,'offer_expired',key,'one',offer.from_member_id,p_status=>'assigned',p_offer=>offer,p_offer_status=>'expired');
      end if;
    when 'accepted','offer_accepted' then
      perform deriro_private.queue_pickup(p,'pickup_accepted',key,'family',p_check_round=>true,p_exclude_member=>p.assignee_member_id);
      perform deriro_private.queue_pickup(p,'child_assigned',key||':rider','rider',p_check_round=>true);
      if new.event_type='offer_accepted' and offer.from_member_id is not null then
        perform deriro_private.queue_pickup(p,'offer_accepted',key||':sender','one',offer.from_member_id,p_check_round=>true,p_offer=>offer,p_offer_status=>'accepted');
      end if;
    when 'took_over','member_reassigned' then
      prior_id := (new.payload->>'previous_assignee_id')::uuid;
      if prior_id is not null then perform deriro_private.queue_pickup(p,'taken_over',key,'one',prior_id,p_check_round=>true); end if;
      perform deriro_private.queue_pickup(p,'pickup_accepted',key||':assignee','one',p.assignee_member_id,p_check_round=>true);
    when 'en_route' then
      if p.source='request' then perform deriro_private.queue_pickup(p,'pickup_en_route',key,'family',p_status=>'en_route',
        p_exclude_member=>p.assignee_member_id); end if;
      perform deriro_private.queue_pickup(p,'child_en_route',key||':rider','rider',p_status=>'en_route');
    when 'en_route_undone' then
      perform deriro_private.queue_pickup(p,'en_route_undone',key,'family',p_status=>'assigned',p_exclude_member=>p.assignee_member_id);
    when 'arrived' then
      perform deriro_private.queue_pickup(p,'child_arrived',key,'rider',p_status=>'arrived');
    when 'completed' then
      if p.source='request' then perform deriro_private.queue_pickup(p,'pickup_completed',key,'family',p_status=>'completed'); end if;
    when 'cancelled' then
      perform deriro_private.queue_pickup(p,case when p.en_route_at is not null then 'pickup_cancelled_urgent'
        when new.actor_kind='rider' then 'pickup_cancelled_by_child' else 'pickup_cancelled' end,key,'family',p_status=>'cancelled');
    when 'expired' then
      perform deriro_private.queue_pickup(p,'pickup_expired',key,'drivers',p_status=>'expired');
    when 'rider_ready' then
      if p.assignee_member_id is null then perform deriro_private.queue_pickup(p,'child_ready_early',key,'drivers',p_status=>'open');
      else perform deriro_private.queue_pickup(p,'child_ready_early',key,'one',p.assignee_member_id,p_status=>'assigned',p_check_round=>true); end if;
    when 'not_met_reported' then
      perform deriro_private.queue_pickup(p,'child_not_met',key,'one',p.assignee_member_id,p_status=>'arrived',p_check_round=>true);
      perform deriro_private.queue_pickup(p,'child_not_met_family',key||':family','family',p_status=>'arrived',p_exclude_member=>p.assignee_member_id);
    when 'closed_unconfirmed' then
      perform deriro_private.queue_pickup(p,case when p.not_met_reported_at is null then 'closed_unconfirmed' else 'closed_unconfirmed_not_met' end,
        key,'family',p_status=>'closed_unconfirmed');
    else null;
  end case;
  return new;
end
$$;
create trigger outbox_from_pickup_event after insert on public.pickup_events for each row execute function deriro_private.on_pickup_event();

create function deriro_private.on_offer_resolved()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status='pending' and new.status<>'pending' then
    update public.notifications_outbox set status='skipped',finished_at=now()
      where offer_id=new.id and status='pending' and expected_offer_status='pending';
  end if;
  return new;
end
$$;
create trigger skip_resolved_offer_notifications after update of status on public.pickup_offers
  for each row execute function deriro_private.on_offer_resolved();

create function deriro_private.skip_stale_pickup_notifications()
returns trigger language plpgsql set search_path = '' as $$
begin
  if row(old.status,old.assignment_round) is not distinct from row(new.status,new.assignment_round) then return new; end if;
  update public.notifications_outbox set status='skipped',finished_at=now()
    where pickup_id=new.id and status='pending' and (
      (expected_status is not null and expected_status<>new.status)
      or (expected_assignment_round is not null and
        (expected_assignment_round<>new.assignment_round or not deriro_private.active_status(new.status))));
  return new;
end
$$;
create trigger skip_stale_pickup_notifications after update of status,assignee_member_id on public.pickups
  for each row execute function deriro_private.skip_stale_pickup_notifications();

create function deriro_private.routine_created_event()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.source='routine' then perform deriro_private.add_event(new,null,'created'); end if;
  return new;
end
$$;
create trigger audit_routine_occurrence after insert on public.pickups for each row execute function deriro_private.routine_created_event();

create function deriro_private.on_range_alert()
returns trigger language plpgsql set search_path = '' as $$
declare
  vehicle public.vehicles;
begin
  if new.resolved_at is not null or new.acknowledged_at is not null then return new; end if;
  if tg_op='UPDATE' and new.pickup_ids is not distinct from old.pickup_ids then return new; end if;
  select * into vehicle from public.vehicles where id=new.vehicle_id and revoked_at is null;
  if vehicle.current_driver_member_id is null then return new; end if;
  insert into public.notifications_outbox(family_id,vehicle_alert_id,recipient_member_id,channel,template,payload,dedupe_key)
    values(new.family_id,new.id,vehicle.current_driver_member_id,'push','low_range',
      jsonb_build_object('vehicle',vehicle.nickname,'vehicle_id',vehicle.id,'required_km',new.required_km,'range_km',new.range_km,
        'alert_revision',new.alert_revision),
      'low_range:'||new.id||':'||new.alert_revision)
    on conflict (dedupe_key) do nothing;
  return new;
end
$$;
create trigger outbox_from_range_alert after insert or update of pickup_ids on public.vehicle_alerts
  for each row execute function deriro_private.on_range_alert();

create function deriro_private.push_endpoint_allowed(p_endpoint text)
returns boolean language sql immutable set search_path = '' as $$
  select char_length(p_endpoint) between 20 and 2048 and p_endpoint ~
    '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/[A-Za-z0-9_~:/?&=%+.,!-]+$'
$$;

create function deriro_private.manage_push(p_action text,p_endpoint text,p_p256dh text,p_auth text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor deriro_private.actor := deriro_private.current_actor();
  uid uuid := auth.uid();
  retry_after int;
begin
  if uid is null then return deriro_private.err('NOT_AUTHENTICATED'); end if;
  if actor.kind is null or actor.kind not in ('member','rider') then return deriro_private.err('FORBIDDEN'); end if;
  if p_action='register' then
    if not coalesce(deriro_private.push_endpoint_allowed(p_endpoint),false)
      or not coalesce(p_p256dh ~ '^[A-Za-z0-9_-]{87}={0,2}$',false)
      or not coalesce(p_auth ~ '^[A-Za-z0-9_-]{22}={0,2}$',false)
    then return deriro_private.err('VALIDATION'); end if;
    insert into public.push_subscriptions as s(family_id,auth_user_id,endpoint,p256dh,auth)
      values(actor.family_id,uid,p_endpoint,p_p256dh,p_auth)
      on conflict(endpoint) do update set p256dh=excluded.p256dh,auth=excluded.auth,family_id=excluded.family_id
      where s.auth_user_id=uid;
    if not found then return deriro_private.err('FORBIDDEN'); end if;
  elsif p_action='unregister' then
    delete from public.push_subscriptions where auth_user_id=uid and endpoint=p_endpoint;
  elsif p_action='test' and actor.kind='member' then
    retry_after := deriro_private.rate_retry(uid,'test_push',3,interval '10 minutes');
    if retry_after>0 then return deriro_private.err('RATE_LIMITED',jsonb_build_object('retry_after_sec',retry_after)); end if;
    insert into public.notifications_outbox(family_id,recipient_member_id,channel,template,dedupe_key)
      values(actor.family_id,actor.member_id,'push','test_push','test_push:'||gen_random_uuid());
  else return deriro_private.err('FORBIDDEN');
  end if;
  return deriro_private.ok('{}');
end
$$;

create function deriro_private.prune_revoked_push()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_table_name='rider_devices' then
    if old.revoked_at is null and new.revoked_at is not null then
      delete from public.push_subscriptions where auth_user_id=new.auth_user_id;
    end if;
  elsif old.left_at is null and new.left_at is not null then
    delete from public.push_subscriptions where auth_user_id=new.auth_user_id;
  end if;
  return new;
end
$$;
create trigger prune_rider_push after update of revoked_at on public.rider_devices for each row execute function deriro_private.prune_revoked_push();
create trigger prune_member_push after update of left_at on public.family_members for each row execute function deriro_private.prune_revoked_push();

create function deriro_private.outbox_worker(p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job public.notifications_outbox;
  p public.pickups;
  o public.pickup_offers;
  a public.vehicle_alerts;
  m public.family_members;
  token uuid := (p_data->>'token')::uuid;
  job_id bigint := (p_data->>'id')::bigint;
  target_state public.outbox_status := (p_data->>'status')::public.outbox_status;
  batch int := least(greatest(coalesce((p_data->>'limit')::int,50),1),100);
  lease int := least(greatest(coalesce((p_data->>'lease')::int,60),30),300);
  jobs jsonb;
  subscriptions jsonb;
  geo_label text;
  demo boolean;
begin
  case p_action
    when 'claim' then
      -- A fourth attempt abandoned by a dead worker must still reach a terminal state.
      with abandoned as (
        select x.id from public.notifications_outbox x where x.status='sending' and x.lease_until<=now() and x.attempts>=4
          order by x.lease_until,x.id limit batch for update skip locked
      ) update public.notifications_outbox x set status='failed',claim_token=null,lease_until=null,
        last_error='lease_exhausted',finished_at=now() from abandoned where x.id=abandoned.id;
      with claimable as (
        select x.id from public.notifications_outbox x where x.attempts<4 and
          ((x.status='pending' and x.scheduled_at<=now()) or (x.status='sending' and x.lease_until<=now()))
        order by x.scheduled_at,x.id limit batch for update skip locked
      ), claimed as (
        update public.notifications_outbox x set status='sending',claim_token=gen_random_uuid(),
          lease_until=now()+make_interval(secs=>lease),attempts=x.attempts+1
        from claimable c where x.id=c.id returning x.*
      ) select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'claim_token',c.claim_token,'attempts',c.attempts,
        'lease_until',c.lease_until,'channel',c.channel,'template',c.template) order by c.scheduled_at,c.id),'[]') into jobs from claimed c;
      return deriro_private.ok(jsonb_build_object('jobs',jobs));

    when 'finish' then
      if target_state is null or target_state='sending' then return deriro_private.err('VALIDATION'); end if;
      update public.notifications_outbox x set
        status=case when target_state='pending' and x.attempts>=4 then 'failed'::public.outbox_status else target_state end,
        scheduled_at=case when target_state='pending' and x.attempts<4 then
          now() + (array[interval '30 seconds',interval '2 minutes',interval '5 minutes'])[greatest(1,least(x.attempts,3))] else x.scheduled_at end,
        finished_at=case when target_state<>'pending' or x.attempts>=4 then now() end,
        sent_at=case when target_state='sent' then now() else x.sent_at end,
        last_error=case when p_data->>'error' ~ '^[a-zA-Z0-9_-]{1,64}$' then p_data->>'error' end,
        claim_token=null,lease_until=null
      where x.id=job_id and x.claim_token=token and x.status='sending' and x.lease_until>now();
      return deriro_private.ok(jsonb_build_object('updated',found));

    when 'release' then
      update public.notifications_outbox x set status='pending',attempts=greatest(x.attempts-1,0),claim_token=null,lease_until=null
        where x.id=job_id and x.claim_token=token and x.status='sending' and x.lease_until>now();
      return deriro_private.ok(jsonb_build_object('updated',found));

    when 'prune_push' then
      delete from public.push_subscriptions where id=(p_data->>'subscription_id')::uuid and endpoint=p_data->>'endpoint';
      return deriro_private.ok(jsonb_build_object('updated',found));

    when 'validate' then
      select * into job from public.notifications_outbox x where x.id=job_id and x.claim_token=token
        and x.status='sending' and x.lease_until>now();
      if not found then return deriro_private.ok('{"valid":false}'); end if;
      select f.is_demo into demo from public.families f where f.id=job.family_id;
      if job.pickup_id is not null then
        select * into p from public.pickups where id=job.pickup_id;
        if not found or (job.expected_status is not null and p.status<>job.expected_status)
          or (job.expected_assignment_round is not null and
            (p.assignment_round<>job.expected_assignment_round or not deriro_private.active_status(p.status)))
          or (job.driver_only and job.recipient_member_id=p.rider_member_id)
          or (p.status='open' and now()>=p.wanted_at+interval '60 minutes')
        then return deriro_private.ok('{"valid":false}'); end if;
      end if;
      if job.offer_id is not null and job.expected_offer_status is not null then
        select * into o from public.pickup_offers where id=job.offer_id;
        if not found or o.status<>job.expected_offer_status or (o.status='pending' and o.expires_at<=now())
          then return deriro_private.ok('{"valid":false}'); end if;
      end if;
      if job.vehicle_alert_id is not null then
        select * into a from public.vehicle_alerts where id=job.vehicle_alert_id;
        if not found or a.acknowledged_at is not null or a.resolved_at is not null
          or a.alert_revision is distinct from (job.payload->>'alert_revision')::int
          or not exists(select 1 from public.vehicles v join public.vehicle_states s on s.vehicle_id=v.id
            where v.id=a.vehicle_id and v.revoked_at is null and v.current_driver_member_id=job.recipient_member_id
              and s.collected_at>=now()-interval '24 hours')
        then return deriro_private.ok('{"valid":false}'); end if;
      end if;
      if job.recipient_member_id is not null then
        select * into m from public.family_members where id=job.recipient_member_id and left_at is null and auth_user_id is not null;
        if not found or (job.driver_only and not m.can_drive) then return deriro_private.ok('{"valid":false}'); end if;
      end if;
      if job.channel='geo' then
        if p.id is null or p.location_source<>'gps' or p.location_confirmed or not deriro_private.active_status(p.status)
          or p.destination_revision<>(job.payload->>'destination_revision')::int
        then return deriro_private.ok('{"valid":false}'); end if;
        return deriro_private.ok(jsonb_build_object('valid',true,'demo',demo,'pickup_id',p.id,'destination_revision',p.destination_revision,
          'lat',p.dest_lat,'lng',p.dest_lng));
      end if;
      if job.channel='sms' then
        if not coalesce(m.sms_opt_in,false) or m.phone_e164 is null then return deriro_private.ok('{"valid":false}'); end if;
        if not deriro_private.reserve_sms_budget(job.family_id,'outbox:'||job.id) then
          return deriro_private.ok('{"valid":false}');
        end if;
        return deriro_private.ok(jsonb_build_object('valid',true,'demo',demo,'phone_e164',m.phone_e164,'pickup_id',job.pickup_id,'payload',job.payload));
      end if;
      select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'endpoint',s.endpoint,'keys',jsonb_build_object('p256dh',s.p256dh,'auth',s.auth))),'[]')
      into subscriptions from public.push_subscriptions s
      where s.family_id=job.family_id and deriro_private.push_endpoint_allowed(s.endpoint) and (
        s.auth_user_id=m.auth_user_id or exists(select 1 from public.rider_devices d join public.riders r on r.id=d.rider_id
          where d.auth_user_id=s.auth_user_id and d.rider_id=job.recipient_rider_id and d.revoked_at is null and r.archived_at is null)
      );
      return deriro_private.ok(jsonb_build_object('valid',jsonb_array_length(subscriptions)>0,'subscriptions',subscriptions,
        'demo',demo or coalesce(a.is_demo_value,false),'pickup_id',job.pickup_id,'payload',job.payload));

    when 'geo_label' then
      geo_label := btrim(p_data->>'label');
      if geo_label is null or char_length(geo_label) not between 1 and 24 or geo_label !~ '^[가-힣0-9· -]+(동|읍|면|리|가) 근처$'
        then return deriro_private.err('VALIDATION'); end if;
      select * into job from public.notifications_outbox x where x.id=job_id and x.claim_token=token
        and x.status='sending' and x.lease_until>now() and x.channel='geo';
      if not found then return deriro_private.ok('{"updated":false}'); end if;
      update public.pickups x set dest_label=geo_label where x.id=job.pickup_id and x.location_source='gps'
        and not x.location_confirmed and deriro_private.active_status(x.status)
        and x.destination_revision=(job.payload->>'destination_revision')::int;
      return deriro_private.ok(jsonb_build_object('updated',found));

    else return deriro_private.err('VALIDATION');
  end case;
end
$$;

alter table public.notifications_outbox drop constraint notifications_outbox_channel_check;
alter table public.notifications_outbox add check (channel in ('push','sms','geo'));
alter table public.notifications_outbox drop constraint notifications_outbox_check;
alter table public.notifications_outbox add check (
  num_nonnulls(recipient_member_id,recipient_rider_id) = case when channel='geo' then 0 else 1 end
);

create function deriro_private.queue_geo_label()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.source='request' and new.location_source='gps' and not new.location_confirmed then
    insert into public.notifications_outbox(family_id,pickup_id,channel,template,payload,dedupe_key)
      values(new.family_id,new.id,'geo','geo_label',jsonb_build_object('destination_revision',new.destination_revision),'geo:'||new.id);
  end if;
  return new;
end
$$;
create trigger outbox_from_unconfirmed_gps after insert on public.pickups for each row execute function deriro_private.queue_geo_label();

create table deriro_private.escalation_checks (
  pickup_id uuid primary key references public.pickups on delete cascade,
  checked_at timestamptz not null
);
alter table deriro_private.escalation_checks enable row level security;

create function deriro_private.run_escalations(p_family_id uuid default null)
returns int language plpgsql set search_path = '' as $$
declare
  p public.pickups;
  offer public.pickup_offers;
  key text;
  round_key text;
  r_minutes int;
  scale int;
  processed int := 0;
begin
  for p in select x.* from public.pickups x join public.families f on f.id=x.family_id
    left join deriro_private.escalation_checks checked on checked.pickup_id=x.id
    where (p_family_id is null or x.family_id=p_family_id) and x.status in ('open','assigned','arrived')
    and (x.status='arrived' or x.source='request' or
      x.wanted_at<=now()+interval '2 hours' or exists(select 1 from public.pickup_offers o
        where o.pickup_id=x.id and o.status='pending' and o.expires_at<=now()))
    order by checked.checked_at nulls first,x.wanted_at,x.id limit 500 for update of x skip locked
  loop
    select f.demo_time_scale into scale from public.families f where f.id=p.family_id;
    insert into deriro_private.escalation_checks(pickup_id,checked_at) values(p.id,now())
      on conflict(pickup_id) do update set checked_at=excluded.checked_at;
    key := p.id::text;
    round_key := key||':'||p.assignment_round;
    processed := processed+1;
    if p.status='open' and now()>=p.wanted_at+interval '60 minutes'/scale then
      p := deriro_private.expire_pickup(p);
      continue;
    end if;
    select * into offer from public.pickup_offers o where o.pickup_id=p.id and o.status='pending' for update;
    if found and offer.created_at+(offer.expires_at-offer.created_at)/scale<=now() then
      perform deriro_private.resolve_offer(offer.id,'expired');
      perform deriro_private.add_event(p,null,'offer_expired',jsonb_build_object('offer_id',offer.id));
    end if;

    if p.status='open' and p.source='request' then
      if p.created_at<=now()-interval '2 minutes'/scale then
        perform deriro_private.queue_pickup(p,'child_request_repeat','req2:'||key,'drivers',p_status=>'open');
      end if;
      if p.created_at<=now()-interval '3 minutes'/scale then
        perform deriro_private.queue_pickup(p,'esc_sms_open','req3:'||key,'drivers',p_channel=>'sms',p_status=>'open');
      end if;
      if p.created_at<=now()-interval '10 minutes'/scale then
        perform deriro_private.queue_pickup(p,'esc_sms_open_urgent','req10:'||key,'drivers',p_channel=>'sms',p_status=>'open');
      end if;
    elsif p.status='assigned' and p.source='request' then
      if greatest(p.wanted_at,p.accepted_at)<=now()-interval '10 minutes'/scale then
        perform deriro_private.queue_pickup(p,'not_departed_assignee','nd10:'||round_key,'one',p.assignee_member_id,p_status=>'assigned',p_check_round=>true);
      end if;
      if greatest(p.wanted_at,p.accepted_at)<=now()-interval '20 minutes'/scale then
        perform deriro_private.queue_pickup(p,'not_departed_family','nd20:'||round_key,'family',p_status=>'assigned',p_check_round=>true);
      end if;
    elsif p.status in ('open','assigned') and p.source='routine' then
      select notify_before_min into r_minutes from public.routines where id=p.routine_id;
      if now()>=p.wanted_at-make_interval(mins=>coalesce(r_minutes,20)) then
        if p.status='assigned' then
          perform deriro_private.queue_pickup(p,'routine_reminder','rr:'||round_key,'one',p.assignee_member_id,p_status=>'assigned',p_check_round=>true);
        elsif p.routine_offer_created_at is null then
          insert into public.pickup_offers(family_id,pickup_id,origin,expires_at)
            values(p.family_id,p.id,'routine',greatest(p.wanted_at,now()+interval '10 minutes')) on conflict do nothing;
          update public.pickups set routine_offer_created_at=now() where id=p.id;
          perform deriro_private.queue_pickup(p,'routine_open','ro:'||key,'drivers',p_status=>'open');
        end if;
      end if;
      if now()>=p.wanted_at-interval '5 minutes' then
        if p.status='assigned' then
          perform deriro_private.queue_pickup(p,'routine_not_departed','rn5:'||round_key,'one',p.assignee_member_id,p_status=>'assigned',p_check_round=>true);
        else
          perform deriro_private.queue_pickup(p,'routine_open_sms','ros:'||key,'drivers',p_channel=>'sms',p_status=>'open');
        end if;
      end if;
      if p.status='assigned' and now()>=p.wanted_at+interval '5 minutes'/scale then
        perform deriro_private.queue_pickup(p,'routine_not_departed','rn+5:'||round_key,'family',p_status=>'assigned',p_check_round=>true);
      end if;
      if p.status='assigned' and p.rider_ready_at<=now()-interval '10 minutes'/scale then
        perform deriro_private.queue_pickup(p,'not_departed_family','rd10:'||round_key,'family',p_status=>'assigned',p_check_round=>true);
      end if;
    elsif p.status='arrived' then
      if p.arrived_at<=now()-interval '3 hours'/scale then
        update public.pickups set status='closed_unconfirmed',closed_unconfirmed_at=now() where id=p.id returning * into p;
        update public.vehicles set active_pickup_id=null,active_nav_session_id=null,active_destination_revision=null
          where id=p.vehicle_id and active_pickup_id=p.id;
        perform deriro_private.add_event(p,null,'closed_unconfirmed');
      else
        if p.arrived_at<=now()-interval '30 minutes'/scale then
          perform deriro_private.queue_pickup(p,'boarding_check','bc30:'||key,'one',p.assignee_member_id,p_status=>'arrived');
        end if;
        if p.arrived_at<=now()-interval '60 minutes'/scale then
          perform deriro_private.queue_pickup(p,'boarding_check_family','bc60:'||key,'family',p_status=>'arrived');
        end if;
      end if;
    end if;
  end loop;
  return processed;
end
$$;

create function deriro_private.retention_cleanup()
returns jsonb language plpgsql set search_path = '' as $$
declare
  erased_pickups int;
  erased_jobs int;
begin
  update public.pickups p set raw_lat=null,raw_lng=null,raw_accuracy_m=null,
    dest_lat=case when p.place_id is null then round(p.dest_lat::numeric,3)::double precision else p.dest_lat end,
    dest_lng=case when p.place_id is null then round(p.dest_lng::numeric,3)::double precision else p.dest_lng end
  where coalesce(p.completed_at,p.cancelled_at,p.expired_at,p.closed_unconfirmed_at)<=now()-interval '30 days'
    and (num_nonnulls(p.raw_lat,p.raw_lng,p.raw_accuracy_m)>0 or
      (p.place_id is null and (p.dest_lat<>round(p.dest_lat::numeric,3)::double precision or p.dest_lng<>round(p.dest_lng::numeric,3)::double precision)));
  delete from public.pickups p where not deriro_private.active_status(p.status)
    and coalesce(p.completed_at,p.cancelled_at,p.expired_at,p.closed_unconfirmed_at,p.created_at)<=now()-interval '1 year';
  get diagnostics erased_pickups=row_count;
  delete from public.pickup_events e where e.created_at<=now()-interval '1 year';
  delete from public.notifications_outbox o where o.finished_at<=now()-interval '30 days' and o.status in ('sent','skipped','failed');
  get diagnostics erased_jobs=row_count;
  delete from deriro_private.link_codes c where c.expires_at<=now()-interval '7 days';
  delete from deriro_private.rate_limits r where r.resets_at<=now()-interval '1 day';
  delete from deriro_private.sms_reservations r where r.local_day < (now() at time zone 'Asia/Seoul')::date-7;
  update public.vehicle_states set lat=null,lng=null,location_at=null where location_at<=now()-interval '24 hours';
  return jsonb_build_object('pickups_deleted',erased_pickups,'jobs_deleted',erased_jobs);
end
$$;

create table public.family_feed_changes (
  id bigint generated always as identity primary key,
  family_id uuid not null references public.families on delete cascade,
  created_at timestamptz not null default now()
);
create index family_feed_changes_family on public.family_feed_changes(family_id,created_at);
alter table public.family_feed_changes enable row level security;
revoke all on public.family_feed_changes from public, anon, authenticated, service_role;
grant select on public.family_feed_changes to authenticated;
create policy family_feed_change_select on public.family_feed_changes for select to authenticated
  using (family_id=(select deriro_private.member_family()));

create function deriro_private.dirty_family_feed()
returns trigger language plpgsql set search_path = '' as $$
declare
  family uuid := case when tg_op='DELETE' then old.family_id else new.family_id end;
begin
  if exists(select 1 from public.families where id=family) then
    insert into public.family_feed_changes(family_id) values(family);
  end if;
  return null;
end
$$;
do $$
declare relation text;
begin
  foreach relation in array array['pickups','pickup_offers','vehicle_alerts','family_members','riders','places','pickup_points','routines','vehicles'] loop
    execute format('create trigger dirty_family_feed after insert or update or delete on public.%I
      for each row execute function deriro_private.dirty_family_feed()',relation);
  end loop;
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.family_feed_changes, public.pickup_offers;
  end if;
end
$$;

create function deriro_private.recompute_all_ranges()
returns int language plpgsql set search_path = '' as $$
declare
  vehicle_id uuid;
  processed int := 0;
begin
  for vehicle_id in select v.id from public.vehicles v where v.revoked_at is null order by v.id
  loop
    perform deriro_private.recompute_low_range(vehicle_id);
    processed := processed+1;
  end loop;
  return processed;
end
$$;

create function deriro_private.pickup_range_changed()
returns trigger language plpgsql set search_path = '' as $$
declare id_arg uuid;
begin
  if tg_op='UPDATE' and row(old.vehicle_id,old.status,old.wanted_at,old.destination_revision)
    is not distinct from row(new.vehicle_id,new.status,new.wanted_at,new.destination_revision) then return new; end if;
  for id_arg in select distinct x.id from unnest(array[new.vehicle_id,case when tg_op='UPDATE' then old.vehicle_id end]) as x(id)
    where x.id is not null order by x.id
  loop
    perform deriro_private.recompute_low_range(id_arg);
  end loop;
  return new;
end
$$;
create trigger recalculate_pickup_range after insert or update on public.pickups
  for each row execute function deriro_private.pickup_range_changed();

create function deriro_private.kick_dispatch()
returns void language plpgsql set search_path = '' as $$
declare
  dispatch_url text;
  dispatch_secret text;
begin
  if to_regclass('vault.decrypted_secrets') is null or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then return; end if;
  if current_setting('deriro.dispatch_scheduled',true)='1' then return; end if;
  execute 'select max(decrypted_secret) filter(where name=$1),max(decrypted_secret) filter(where name=$2)
    from vault.decrypted_secrets where name in ($1,$2)'
    into dispatch_url,dispatch_secret using 'deriro_dispatch_url','deriro_dispatch_secret';
  if dispatch_url is null or dispatch_secret is null or length(dispatch_secret)<24
    or dispatch_url !~ '^https?://' then return; end if;
  perform set_config('deriro.dispatch_scheduled','1',true);
  execute 'select net.http_post(url:=$1,body:=$2,headers:=$3,timeout_milliseconds:=30000)'
    using dispatch_url,'{}'::jsonb,jsonb_build_object('content-type','application/json','x-dispatch-secret',dispatch_secret);
end
$$;

create function deriro_private.after_outbox_insert()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform deriro_private.kick_dispatch();
  return null;
end
$$;
create trigger kick_dispatch_after_enqueue after insert on public.notifications_outbox
  for each statement execute function deriro_private.after_outbox_insert();

create function deriro_private.maintenance(p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  case p_action
    when 'escalations' then result := jsonb_build_object('processed',deriro_private.run_escalations());
    when 'occurrences' then result := jsonb_build_object('created',deriro_private.ensure_occurrences(null,2));
    when 'range' then result := jsonb_build_object('processed',deriro_private.recompute_all_ranges());
    when 'retention' then
      result := deriro_private.retention_cleanup();
      delete from public.family_feed_changes where created_at < now()-interval '1 day';
    when 'dispatch' then perform deriro_private.kick_dispatch(); result := '{}';
    else return deriro_private.err('VALIDATION');
  end case;
  return deriro_private.ok(result);
end
$$;

create function deriro_private.manage_demo(p_action text,p_scale int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor deriro_private.actor := deriro_private.current_actor();
begin
  if auth.uid() is null then return deriro_private.err('NOT_AUTHENTICATED'); end if;
  if actor.kind is distinct from 'member' or not exists(select 1 from public.family_members m join public.families f on f.id=m.family_id
    where m.id=actor.member_id and m.role='owner' and m.left_at is null and f.is_demo)
  then return deriro_private.err('FORBIDDEN'); end if;
  case p_action
    when 'run' then
      return deriro_private.ok(jsonb_build_object('processed',deriro_private.run_escalations(actor.family_id)));
    when 'scale' then
      if p_scale is null or p_scale not between 1 and 60 then return deriro_private.err('VALIDATION'); end if;
      update public.families set demo_time_scale=p_scale where id=actor.family_id;
    when 'reset' then
      perform 1 from public.pickups p where p.family_id=actor.family_id order by p.id for update;
      update public.vehicles set active_pickup_id=null,active_nav_session_id=null,active_destination_revision=null where family_id=actor.family_id;
      delete from public.notifications_outbox where family_id=actor.family_id;
      delete from public.vehicle_alerts where family_id=actor.family_id;
      delete from public.pickups where family_id=actor.family_id;
      update public.families set demo_time_scale=1 where id=actor.family_id;
      perform deriro_private.ensure_occurrences(actor.family_id,2);
    else return deriro_private.err('VALIDATION');
  end case;
  return deriro_private.ok('{}');
end
$$;

grant usage on schema deriro_private to service_role;
revoke execute on function deriro_private.queue_pickup(public.pickups,text,text,text,uuid,text,public.pickup_status,boolean,public.pickup_offers,public.offer_status,uuid),
  deriro_private.on_pickup_event(),deriro_private.on_offer_resolved(),deriro_private.routine_created_event(),
  deriro_private.skip_stale_pickup_notifications(),
  deriro_private.on_range_alert(),deriro_private.push_endpoint_allowed(text),deriro_private.prune_revoked_push(),
  deriro_private.queue_geo_label(),deriro_private.run_escalations(uuid),deriro_private.retention_cleanup(),
  deriro_private.dirty_family_feed(),deriro_private.recompute_all_ranges(),deriro_private.pickup_range_changed(),
  deriro_private.kick_dispatch(),deriro_private.after_outbox_insert()
  from public, anon, authenticated, service_role;

create function public.register_push_subscription(p_endpoint text,p_p256dh text,p_auth text)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_push('register',p_endpoint,p_p256dh,p_auth) $$;

create function public.unregister_push_subscription(p_endpoint text)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_push('unregister',p_endpoint,null,null) $$;

create function public.enqueue_test_push()
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_push('test',null,null,null) $$;

create function public.demo_reset()
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_demo('reset',null) $$;

create function public.demo_run_now()
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_demo('run',null) $$;

create function public.demo_set_time_scale(p_scale int)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_demo('scale',p_scale) $$;

revoke execute on function
  deriro_private.manage_push(text,text,text,text),
  deriro_private.manage_demo(text,int),
  public.register_push_subscription(text,text,text),
  public.unregister_push_subscription(text),
  public.enqueue_test_push(),
  public.demo_reset(),
  public.demo_run_now(),
  public.demo_set_time_scale(int)
  from public, anon, authenticated, service_role;
grant execute on function
  deriro_private.manage_push(text,text,text,text),
  deriro_private.manage_demo(text,int),
  public.register_push_subscription(text,text,text),
  public.unregister_push_subscription(text),
  public.enqueue_test_push(),
  public.demo_reset(),
  public.demo_run_now(),
  public.demo_set_time_scale(int)
  to authenticated;

create function public.svc_claim_outbox(p_limit int default 50,p_lease_sec int default 60)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.outbox_worker('claim',jsonb_build_object('limit',p_limit,'lease',p_lease_sec)) $$;

create function public.svc_finish_outbox(p_id bigint,p_token uuid,p_status public.outbox_status,p_error text default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.outbox_worker('finish',jsonb_build_object('id',p_id,'token',p_token,'status',p_status,'error',p_error)) $$;

create function public.svc_release_outbox(p_id bigint,p_token uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.outbox_worker('release',jsonb_build_object('id',p_id,'token',p_token)) $$;

create function public.svc_outbox_still_valid(p_id bigint,p_token uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.outbox_worker('validate',jsonb_build_object('id',p_id,'token',p_token)) $$;

create function public.svc_prune_push_subscription(p_subscription_id uuid,p_endpoint text)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.outbox_worker('prune_push',jsonb_build_object('subscription_id',p_subscription_id,'endpoint',p_endpoint)) $$;

create function public.svc_apply_geo_label(p_id bigint,p_token uuid,p_label text)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.outbox_worker('geo_label',jsonb_build_object('id',p_id,'token',p_token,'label',p_label)) $$;

create function public.svc_maintenance(p_action text)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.maintenance(p_action) $$;

revoke execute on function
  deriro_private.outbox_worker(text,jsonb),
  deriro_private.maintenance(text),
  public.svc_claim_outbox(int,int),
  public.svc_finish_outbox(bigint,uuid,public.outbox_status,text),
  public.svc_release_outbox(bigint,uuid),
  public.svc_outbox_still_valid(bigint,uuid),
  public.svc_prune_push_subscription(uuid,text),
  public.svc_apply_geo_label(bigint,uuid,text),
  public.svc_maintenance(text)
  from public, anon, authenticated, service_role;
grant execute on function
  deriro_private.outbox_worker(text,jsonb),
  deriro_private.maintenance(text),
  public.svc_claim_outbox(int,int),
  public.svc_finish_outbox(bigint,uuid,public.outbox_status,text),
  public.svc_release_outbox(bigint,uuid),
  public.svc_outbox_still_valid(bigint,uuid),
  public.svc_prune_push_subscription(uuid,text),
  public.svc_apply_geo_label(bigint,uuid,text),
  public.svc_maintenance(text)
  to service_role;

-- Supabase ships these extensions; isolated Postgres tests run the same maintenance functions directly.
do $$
begin
  if exists(select 1 from pg_available_extensions where name='pg_net') then
    create extension if not exists pg_net;
  end if;
  if exists(select 1 from pg_available_extensions where name='pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('deriro_escalations','* * * * *','select deriro_private.maintenance(''escalations'')');
    perform cron.schedule('deriro_dispatch','* * * * *','select deriro_private.maintenance(''dispatch'')');
    perform cron.schedule('deriro_occurrences','5 * * * *','select deriro_private.maintenance(''occurrences'')');
    perform cron.schedule('deriro_low_range','10 * * * *','select deriro_private.maintenance(''range'')');
    perform cron.schedule('deriro_retention','0 19 * * *','select deriro_private.maintenance(''retention'')');
  end if;
end
$$;
