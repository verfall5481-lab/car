alter table public.families add column timezone text not null default 'Asia/Seoul';
alter table public.family_members
  add column phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  add column sms_opt_in boolean not null default false;
alter table public.riders add column phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$');
alter table public.rider_devices add column user_agent text, add column last_seen_at timestamptz not null default now();
alter table public.rider_devices drop constraint rider_devices_auth_user_id_key;
create unique index rider_devices_active_auth on public.rider_devices(auth_user_id) where revoked_at is null;
create index rider_devices_rider_active on public.rider_devices(rider_id) where revoked_at is null;
create unique index family_members_active_name on public.family_members(family_id, display_name) where left_at is null;
create unique index riders_active_name on public.riders(family_id, display_name) where archived_at is null;
create unique index vehicles_active_name on public.vehicles(family_id, nickname) where revoked_at is null;

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  member_id uuid,
  rider_id uuid,
  granted_by_member_id uuid,
  granted_by_rider_id uuid,
  purpose text not null check (purpose in ('privacy','member_location','rider_location')),
  version text not null check (char_length(version) between 1 and 40),
  granted_at timestamptz not null default now(),
  check (num_nonnulls(member_id, rider_id) = 1),
  check (num_nonnulls(granted_by_member_id, granted_by_rider_id) = 1),
  foreign key (family_id, member_id) references public.family_members(family_id, id) on delete cascade,
  foreign key (family_id, rider_id) references public.riders(family_id, id) on delete cascade,
  foreign key (family_id, granted_by_member_id) references public.family_members(family_id, id) on delete cascade,
  foreign key (family_id, granted_by_rider_id) references public.riders(family_id, id) on delete cascade
);
alter table public.consents enable row level security;
revoke all on public.consents from public, anon, authenticated, service_role;

create table deriro_private.code_secret (
  singleton boolean primary key default true check (singleton),
  pepper text not null
);
insert into deriro_private.code_secret(pepper) values (gen_random_uuid()::text || gen_random_uuid()::text);

create table deriro_private.link_codes (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('family','rider','vehicle')),
  code_hash bytea not null unique,
  family_id uuid references public.families on delete cascade,
  member_id uuid,
  rider_id uuid,
  vehicle_auth_user_id uuid references auth.users on delete cascade,
  channel text check (channel in ('qr','sms')),
  used_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (family_id, member_id) references public.family_members(family_id, id) on delete cascade,
  foreign key (family_id, rider_id) references public.riders(family_id, id) on delete cascade
);
create index link_codes_rider on deriro_private.link_codes(rider_id, created_at) where rider_id is not null;
create index link_codes_vehicle on deriro_private.link_codes(vehicle_auth_user_id) where kind = 'vehicle';

create table deriro_private.rate_limits (
  principal uuid not null,
  action text not null,
  hits int not null default 1,
  resets_at timestamptz not null,
  primary key (principal, action)
);
alter table deriro_private.code_secret enable row level security;
alter table deriro_private.link_codes enable row level security;
alter table deriro_private.rate_limits enable row level security;

create table deriro_private.sms_reservations (
  family_id uuid not null references public.families on delete cascade,
  local_day date not null,
  reference_key text not null,
  primary key (family_id,local_day,reference_key)
);
alter table deriro_private.sms_reservations enable row level security;

create function deriro_private.reserve_sms_budget(p_family_id uuid,p_reference_key text)
returns boolean language plpgsql set search_path = '' as $$
declare local_day_arg date := (now() at time zone 'Asia/Seoul')::date;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_family_id::text||':'||local_day_arg::text,7111));
  if exists(select 1 from deriro_private.sms_reservations r where r.family_id=p_family_id
    and r.local_day=local_day_arg and r.reference_key=p_reference_key) then return true; end if;
  if (select count(*) from deriro_private.sms_reservations r where r.family_id=p_family_id and r.local_day=local_day_arg)>=30
    then return false; end if;
  insert into deriro_private.sms_reservations(family_id,local_day,reference_key) values(p_family_id,local_day_arg,p_reference_key);
  return true;
end
$$;

create function deriro_private.rate_retry(p_principal uuid, p_action text, p_limit int, p_window interval)
returns int language plpgsql set search_path = '' as $$
declare bucket deriro_private.rate_limits;
begin
  insert into deriro_private.rate_limits as r(principal, action, resets_at)
    values (p_principal, p_action, now() + p_window)
  on conflict (principal, action) do update set
    hits = case when r.resets_at <= now() then 1 else least(r.hits + 1, p_limit + 1) end,
    resets_at = case when r.resets_at <= now() then now() + p_window else r.resets_at end
  returning * into bucket;
  if bucket.hits <= p_limit then return 0; end if;
  return greatest(1, ceil(extract(epoch from bucket.resets_at - now()))::int);
end
$$;

create function deriro_private.code_digest(p_kind text, p_code text)
returns bytea language sql stable set search_path = '' as $$
  select sha256(convert_to(pepper || ':' || p_kind || ':' || upper(regexp_replace(p_code, '[[:space:]-]', '', 'g')), 'UTF8'))
  from deriro_private.code_secret
$$;

create function deriro_private.new_link(p_kind text, p_family_id uuid, p_member_id uuid, p_rider_id uuid,
  p_vehicle_uid uuid, p_channel text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  secret_bytes bytea;
  raw_code text;
  display_code text;
  link_path text;
  expires timestamptz := now() + case when p_kind = 'family' then interval '24 hours' else interval '10 minutes' end;
  i int;
begin
  for retry in 1..10 loop
    secret_bytes := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
    if p_kind = 'rider' then
      raw_code := lpad((((get_byte(secret_bytes, 0)::bigint << 24) | (get_byte(secret_bytes, 1)::bigint << 16)
        | (get_byte(secret_bytes, 2)::bigint << 8) | get_byte(secret_bytes, 3)) % 100000000)::text, 8, '0');
    else
      raw_code := '';
      for i in 0..case when p_kind = 'family' then 7 else 5 end loop
        raw_code := raw_code || substr(alphabet, 1 + (get_byte(secret_bytes, case when i >= 6 then i + 3 else i end) % char_length(alphabet)), 1);
      end loop;
    end if;
    insert into deriro_private.link_codes(kind, code_hash, family_id, member_id, rider_id, vehicle_auth_user_id, channel, expires_at)
    values (p_kind, deriro_private.code_digest(p_kind, raw_code), p_family_id, p_member_id, p_rider_id, p_vehicle_uid, p_channel, expires)
    on conflict (code_hash) do nothing;
    if found then
      display_code := case when p_kind = 'family' then substr(raw_code,1,4) || '-' || substr(raw_code,5) else raw_code end;
      link_path := case p_kind when 'family' then '/p/join?code=' when 'rider' then '/c/start?code=' else '/p/vehicles/pair?code=' end;
      return jsonb_build_object('code', display_code, 'url', link_path || display_code, 'expires_at', expires);
    end if;
  end loop;
  raise exception 'code space exhausted';
end
$$;

create function deriro_private.public_member(p_member public.family_members)
returns jsonb language sql stable set search_path = '' as $$
  select to_jsonb(p_member) - array['auth_user_id','phone_e164','sms_opt_in','location_consented_at']
$$;

create function deriro_private.public_vehicle(p_vehicle public.vehicles)
returns jsonb language sql stable set search_path = '' as $$
  select case when p_vehicle.id is not null then to_jsonb(p_vehicle) - 'auth_user_id' end
$$;

create function deriro_private.leave_member(p_member public.family_members, p_successor uuid)
returns void language plpgsql set search_path = '' as $$
declare
  old_pickup public.pickups;
  successor_id uuid;
begin
  -- Lock every affected pickup before offers or vehicle references.
  perform 1 from public.pickups p where p.family_id = p_member.family_id
    and p.status in ('open','assigned','en_route','arrived') order by p.id for update;
  for old_pickup in select * from public.pickups p where p.family_id = p_member.family_id
    and p.assignee_member_id = p_member.id and p.status in ('assigned','en_route','arrived') order by p.id
  loop
    select m.id into successor_id from public.family_members m where m.family_id = p_member.family_id
      and m.id <> p_member.id and m.id is distinct from old_pickup.rider_member_id and m.left_at is null and m.can_drive
      order by (m.id = p_successor) desc, m.id limit 1;
    if successor_id is null then
      update public.pickups set status = 'cancelled', cancel_reason = 'cancelled', cancelled_at = now()
        where id = old_pickup.id returning * into old_pickup;
      perform deriro_private.add_event(old_pickup, null, 'cancelled');
    else
      update public.pickups set assignee_member_id = successor_id, vehicle_id = null, is_customized = true,
        accepted_at = now(), nav_session_id = null, nav_destination_revision = null, nav_status = 'none'
        where id = old_pickup.id returning * into old_pickup;
      perform deriro_private.add_event(old_pickup, null, 'member_reassigned', jsonb_build_object('previous_assignee_id', p_member.id));
    end if;
    update public.pickup_offers set status = 'cancelled', resolved_at = now() where pickup_id = old_pickup.id and status = 'pending';
  end loop;
  update public.pickup_offers set status = 'cancelled', resolved_at = now()
    where family_id = p_member.family_id and status = 'pending' and p_member.id in (from_member_id, to_member_id);
  update public.vehicles set current_driver_member_id = null, active_pickup_id = null,
    active_nav_session_id = null, active_destination_revision = null
    where family_id = p_member.family_id and current_driver_member_id = p_member.id;
  update public.routines set default_assignee_member_id = null, default_vehicle_id = null
    where family_id = p_member.family_id and default_assignee_member_id = p_member.id;
  update public.routines set archived_at = now() where family_id = p_member.family_id and rider_member_id = p_member.id;
  update deriro_private.link_codes set revoked_at = now() where member_id = p_member.id and used_at is null;
  update public.family_members set left_at = now(), phone_e164 = null, sms_opt_in = false, location_consented_at = null
    where id = p_member.id;
end
$$;

create function deriro_private.manage_account(p_action text, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  anonymous boolean;
  actor deriro_private.actor;
  me public.family_members;
  target public.family_members;
  fam public.families;
  rider public.riders;
  prior_rider public.riders;
  device public.rider_devices;
  vehicle public.vehicles;
  code_row deriro_private.link_codes;
  id_arg uuid := (p_data->>'id')::uuid;
  target_id uuid := (p_data->>'driver')::uuid;
  name_arg text := nullif(btrim(p_data->>'name'), '');
  phone text := nullif(btrim(p_data->>'phone'), '');
  privacy text := nullif(btrim(p_data->>'privacy'), '');
  consent text := nullif(btrim(p_data->>'consent'), '');
  birth int := (p_data->>'birth_year')::int;
  retry_after int;
  link jsonb;
  channel text := coalesce(p_data->>'channel', 'qr');
  kind_arg text := p_data->>'kind';
  basis text;
  limit_count int;
  result jsonb;
begin
  if uid is null then return deriro_private.err('NOT_AUTHENTICATED'); end if;
  select u.is_anonymous into anonymous from auth.users u where u.id = uid;
  if not found then return deriro_private.err('NOT_AUTHENTICATED'); end if;
  actor := deriro_private.current_actor();

  if p_action = 'preview_family_invite' then
    if anonymous then return deriro_private.err('FORBIDDEN'); end if;
    retry_after := deriro_private.rate_retry(uid,'preview_family_invite',10,interval '10 minutes');
    if retry_after > 0 then return deriro_private.err('RATE_LIMITED',jsonb_build_object('retry_after_sec',retry_after)); end if;
    select * into code_row from deriro_private.link_codes c where c.kind='family'
      and c.code_hash=deriro_private.code_digest('family',p_data->>'code');
    if not found or code_row.revoked_at is not null then return deriro_private.err('INVITE_INVALID'); end if;
    if code_row.used_at is not null then return deriro_private.err('INVITE_USED'); end if;
    if code_row.expires_at <= now() then return deriro_private.err('INVITE_EXPIRED'); end if;
    select * into fam from public.families where id=code_row.family_id;
    select * into target from public.family_members where id=code_row.member_id and left_at is null;
    if fam.id is null or target.id is null then return deriro_private.err('INVITE_INVALID'); end if;
    return deriro_private.ok(jsonb_build_object('family_name',fam.name,'inviter_name',target.display_name));
  end if;

  if p_action in ('create_family','join_family') then
    if anonymous then return deriro_private.err('FORBIDDEN'); end if;
    if name_arg is null or char_length(name_arg) > 20 or privacy is null or char_length(privacy) > 40
      or (phone is not null and phone !~ '^\+[1-9][0-9]{7,14}$')
      or char_length(coalesce(p_data->>'family_name','')) > 40
    then return deriro_private.err('VALIDATION'); end if;
    perform pg_advisory_xact_lock(hashtextextended(uid::text, 7110));
    if exists(select 1 from public.family_members m where m.auth_user_id = uid and m.left_at is null)
      then return deriro_private.err('ALREADY_IN_FAMILY'); end if;
    if p_action = 'join_family' then
      retry_after := deriro_private.rate_retry(uid, 'join_family', 10, interval '10 minutes');
      if retry_after > 0 then return deriro_private.err('RATE_LIMITED', jsonb_build_object('retry_after_sec',retry_after)); end if;
      select * into code_row from deriro_private.link_codes c where c.kind = 'family'
        and c.code_hash = deriro_private.code_digest('family', p_data->>'code');
      if not found then return deriro_private.err('INVITE_INVALID'); end if;
      select * into fam from public.families f where f.id = code_row.family_id for key share;
      if not found then return deriro_private.err('INVITE_INVALID'); end if;
      select * into code_row from deriro_private.link_codes c where c.id = code_row.id for update;
      if not found or code_row.revoked_at is not null then return deriro_private.err('INVITE_INVALID'); end if;
      if code_row.used_at is not null then return deriro_private.err('INVITE_USED'); end if;
      if code_row.expires_at <= now() then return deriro_private.err('INVITE_EXPIRED'); end if;
      if exists(select 1 from public.family_members m where m.family_id = fam.id and m.display_name = name_arg and m.left_at is null)
        then return deriro_private.err('NAME_TAKEN'); end if;
    else
      insert into public.families(name) values (coalesce(nullif(btrim(p_data->>'family_name'), ''), '우리 가족')) returning * into fam;
    end if;
    insert into public.family_members(family_id, auth_user_id, display_name, role, phone_e164, sms_opt_in, location_consented_at)
      values(fam.id, uid, name_arg, case when p_action = 'create_family' then 'owner' else 'guardian' end, phone,
        phone is not null and coalesce((p_data->>'sms')::boolean,false),
        case when coalesce((p_data->>'location_consent')::boolean,false) then now() end)
      returning * into me;
    insert into public.consents(family_id,member_id,granted_by_member_id,purpose,version)
      values (fam.id, me.id, me.id, 'privacy', privacy);
    if me.location_consented_at is not null then
      insert into public.consents(family_id,member_id,granted_by_member_id,purpose,version)
        values (fam.id, me.id, me.id, 'member_location', privacy);
    end if;
    if p_action = 'join_family' then update deriro_private.link_codes set used_at = now() where id = code_row.id; end if;
    return deriro_private.ok(jsonb_build_object('family',to_jsonb(fam),'member',to_jsonb(me)-'auth_user_id'));
  end if;

  if p_action in ('claim_rider_invite','vehicle_pair_start','vehicle_pair_status') then
    if not anonymous then return deriro_private.err('FORBIDDEN'); end if;
    if p_action = 'vehicle_pair_status' then
      select * into vehicle from public.vehicles v where v.auth_user_id = uid;
      if vehicle.revoked_at is not null then return deriro_private.err('VEHICLE_REVOKED'); end if;
      return deriro_private.ok(jsonb_strip_nulls(jsonb_build_object('paired',vehicle.id is not null,'vehicle',deriro_private.public_vehicle(vehicle))));
    end if;
    perform pg_advisory_xact_lock(hashtextextended(uid::text, 7110));
    if p_action = 'vehicle_pair_start' then
      if exists(select 1 from public.rider_devices d where d.auth_user_id = uid and d.revoked_at is null)
        then return deriro_private.err('FORBIDDEN'); end if;
      if exists(select 1 from public.vehicles v where v.auth_user_id = uid and v.revoked_at is null)
        then return deriro_private.err('INVALID_STATE'); end if;
      retry_after := deriro_private.rate_retry(uid, 'pair_start', 6, interval '10 minutes');
      if retry_after > 0 then return deriro_private.err('RATE_LIMITED', jsonb_build_object('retry_after_sec',retry_after)); end if;
      update public.vehicles set auth_user_id = null where auth_user_id = uid and revoked_at is not null;
      update deriro_private.link_codes set revoked_at = now()
        where kind = 'vehicle' and vehicle_auth_user_id = uid and used_at is null and revoked_at is null;
      return deriro_private.ok(deriro_private.new_link('vehicle',null,null,null,uid,null));
    end if;
    if exists(select 1 from public.vehicles v where v.auth_user_id = uid and v.revoked_at is null)
      then return deriro_private.err('FORBIDDEN'); end if;
    retry_after := deriro_private.rate_retry(uid, 'claim_rider', 5, interval '10 minutes');
    if retry_after > 0 then return deriro_private.err('RATE_LIMITED', jsonb_build_object('retry_after_sec',retry_after)); end if;
    -- Lock the rider before its invite, matching the issue and archive paths.
    select * into code_row from deriro_private.link_codes c where c.kind = 'rider'
      and c.code_hash = deriro_private.code_digest('rider', p_data->>'code');
    if not found then return deriro_private.err('INVITE_INVALID'); end if;
    select * into device from public.rider_devices d where d.auth_user_id = uid and d.revoked_at is null;
    perform 1 from public.riders r where r.id in (code_row.rider_id, device.rider_id) order by r.id for update;
    select * into rider from public.riders r where r.id = code_row.rider_id and r.archived_at is null;
    if not found then return deriro_private.err('INVITE_INVALID'); end if;
    select * into code_row from deriro_private.link_codes c where c.id = code_row.id for update;
    if not found or code_row.revoked_at is not null then return deriro_private.err('INVITE_INVALID'); end if;
    if code_row.used_at is not null then return deriro_private.err('INVITE_USED'); end if;
    if code_row.expires_at <= now() then return deriro_private.err('INVITE_EXPIRED'); end if;
    if device.id is not null and device.rider_id <> rider.id and not coalesce((p_data->>'confirm_switch')::boolean,false) then
      select * into prior_rider from public.riders where id = device.rider_id;
      return deriro_private.ok(jsonb_build_object('needs_switch_confirm',jsonb_build_object('from',prior_rider.display_name,'to',rider.display_name)));
    end if;
    if rider.location_consented_at is null and (rider.consent_basis <> 'self' or consent is null or char_length(consent) > 40) then
      return deriro_private.err('CONSENT_REQUIRED');
    end if;
    select count(*)::int into limit_count from public.rider_devices d where d.rider_id = rider.id and d.revoked_at is null and d.auth_user_id <> uid;
    if limit_count >= 2 then return deriro_private.err('DEVICE_LIMIT'); end if;
    if rider.location_consented_at is null then
      update public.riders set location_consented_at = now() where id = rider.id returning * into rider;
      insert into public.consents(family_id,rider_id,granted_by_rider_id,purpose,version)
        values(rider.family_id,rider.id,rider.id,'rider_location',consent);
    end if;
    if device.id is not null and device.rider_id <> rider.id then
      update public.rider_devices set revoked_at = now() where id = device.id;
      device := null;
    end if;
    if device.id is null then
      insert into public.rider_devices(family_id,rider_id,auth_user_id,user_agent)
        values(rider.family_id,rider.id,uid,left(p_data->>'user_agent',250)) returning * into device;
    end if;
    update deriro_private.link_codes set used_at = now() where id = code_row.id;
    update deriro_private.link_codes set revoked_at = now() where kind = 'vehicle' and vehicle_auth_user_id = uid and used_at is null;
    return deriro_private.ok(jsonb_build_object('rider',to_jsonb(rider)-'phone_e164','device_id',device.id,
      'family_guardians',coalesce((select jsonb_agg(deriro_private.public_member(m)) from public.family_members m
        where m.family_id = rider.family_id and m.left_at is null),'[]')));
  end if;

  if p_action = 'vehicle_set_driver' then
    select * into vehicle from public.vehicles v where v.auth_user_id = uid for update;
    if not found or not anonymous then return deriro_private.err('NOT_VEHICLE'); end if;
    if vehicle.revoked_at is not null then return deriro_private.err('VEHICLE_REVOKED'); end if;
    if not exists(select 1 from public.vehicle_states s where s.vehicle_id = vehicle.id and s.gear = 'P'
      and s.collected_at between now() - interval '30 seconds' and now()) then return deriro_private.err('FORBIDDEN'); end if;
    if not deriro_private.eligible_driver(vehicle.family_id,id_arg,null) then return deriro_private.err('NOT_FOUND'); end if;
    update public.vehicles set current_driver_member_id = id_arg where id = vehicle.id returning * into vehicle;
    return deriro_private.ok(jsonb_build_object('vehicle',deriro_private.public_vehicle(vehicle)));
  end if;

  if p_action = 'prepare_delete_account' and not anonymous and actor.kind is null then
    return deriro_private.ok('{}');
  end if;
  if actor.kind is distinct from 'member' then return deriro_private.err('NOT_GUARDIAN'); end if;
  select * into me from public.family_members where id = actor.member_id;

  case p_action
    when 'create_family_invite' then
      perform 1 from public.families where id=me.family_id for key share;
      if not found or not exists(select 1 from public.family_members m where m.id=me.id and m.left_at is null)
        then return deriro_private.err('NOT_GUARDIAN'); end if;
      retry_after := deriro_private.rate_retry(uid, 'create_family_invite', 10, interval '1 hour');
      if retry_after > 0 then return deriro_private.err('RATE_LIMITED',jsonb_build_object('retry_after_sec',retry_after)); end if;
      return deriro_private.ok(deriro_private.new_link('family',me.family_id,me.id,null,null,null));

    when 'update_me' then
      if char_length(name_arg) > 20 or (phone is not null and phone !~ '^\+[1-9][0-9]{7,14}$')
        or char_length(consent) > 40 then return deriro_private.err('VALIDATION'); end if;
      update public.family_members m set display_name = coalesce(name_arg,m.display_name),
        phone_e164 = case when p_data ? 'phone' and p_data->'phone' <> 'null'::jsonb then phone else m.phone_e164 end,
        sms_opt_in = coalesce((p_data->>'sms')::boolean,m.sms_opt_in),
        location_consented_at = case when consent is not null then now() else m.location_consented_at end
        where m.id = me.id returning * into me;
      if me.phone_e164 is null and me.sms_opt_in then
        update public.family_members m set sms_opt_in = false where m.id = me.id returning * into me;
      end if;
      if consent is not null then
        insert into public.consents(family_id,member_id,granted_by_member_id,purpose,version)
          values(me.family_id,me.id,me.id,'member_location',consent);
      end if;
      return deriro_private.ok(jsonb_build_object('member',to_jsonb(me)-'auth_user_id'));

    when 'update_family' then
      if me.role <> 'owner' then return deriro_private.err('FORBIDDEN'); end if;
      if name_arg is null or char_length(name_arg) > 40 then return deriro_private.err('VALIDATION'); end if;
      update public.families set name = name_arg where id = me.family_id returning * into fam;
      return deriro_private.ok(jsonb_build_object('family',to_jsonb(fam)));

    when 'set_member_roles' then
      if me.role <> 'owner' and id_arg <> me.id then return deriro_private.err('FORBIDDEN'); end if;
      if p_data->>'can_drive' is null or p_data->>'can_request' is null then return deriro_private.err('VALIDATION'); end if;
      update public.family_members m set can_drive = (p_data->>'can_drive')::boolean, can_request = (p_data->>'can_request')::boolean
        where m.id = id_arg and m.family_id = me.family_id and m.left_at is null returning * into target;
      if not found then return deriro_private.err('NOT_FOUND'); end if;
      return deriro_private.ok(jsonb_build_object('member',deriro_private.public_member(target)));

    when 'transfer_owner','remove_member','leave_family','prepare_delete_account' then
      perform 1 from public.families where id = me.family_id for update;
      select * into me from public.family_members where id = me.id and left_at is null;
      if not found then return deriro_private.err('NOT_GUARDIAN'); end if;
      if p_action in ('transfer_owner','remove_member') then
        if me.role <> 'owner' or id_arg = me.id then return deriro_private.err('FORBIDDEN'); end if;
        select * into target from public.family_members m where m.id = id_arg and m.family_id = me.family_id and m.left_at is null;
        if not found then return deriro_private.err('NOT_FOUND'); end if;
        if p_action = 'transfer_owner' then
          update public.family_members set role = 'guardian' where id = me.id;
          update public.family_members set role = 'owner' where id = target.id returning * into target;
          return deriro_private.ok(jsonb_build_object('member',deriro_private.public_member(target)));
        end if;
        perform deriro_private.leave_member(target, me.id);
      elsif me.role = 'owner' then
        if p_action = 'leave_family' or exists(select 1 from public.family_members m where m.family_id = me.family_id and m.id <> me.id and m.left_at is null)
          then return deriro_private.err('OWNER_TRANSFER_REQUIRED'); end if;
        if not coalesce((p_data->>'confirm')::boolean,false) then return deriro_private.err('CONFIRM_FAMILY_DELETE'); end if;
        update public.vehicles set active_pickup_id = null, active_nav_session_id = null, active_destination_revision = null where family_id = me.family_id;
        delete from public.pickup_offers where family_id = me.family_id;
        delete from public.pickups where family_id = me.family_id;
        delete from public.routines where family_id = me.family_id;
        delete from public.rider_devices where family_id = me.family_id;
        delete from public.pickup_points where family_id = me.family_id;
        delete from public.families where id = me.family_id;
      else
        select * into target from public.family_members m where m.family_id = me.family_id and m.role = 'owner' and m.left_at is null;
        perform deriro_private.leave_member(me,target.id);
      end if;
      return deriro_private.ok('{}');

    when 'add_rider' then
      if name_arg is null or char_length(name_arg) > 20 or kind_arg is null or kind_arg not in ('child','adult')
        or (phone is not null and phone !~ '^\+[1-9][0-9]{7,14}$') or char_length(consent) > 40
        or (birth is not null and birth not between 1900 and extract(year from now())::int)
        or (kind_arg = 'adult' and birth > extract(year from now())::int - 14)
      then return deriro_private.err('VALIDATION'); end if;
      basis := case when kind_arg = 'adult' or birth <= extract(year from now())::int - 15 then 'self' else 'guardian' end;
      if basis = 'guardian' and consent is null then return deriro_private.err('CONSENT_REQUIRED'); end if;
      insert into public.riders(family_id,display_name,kind,birth_year,consent_basis,location_consented_at,phone_e164)
        values(me.family_id,name_arg,kind_arg,birth,basis,case when basis='guardian' then now() end,phone) returning * into rider;
      if basis = 'guardian' then
        insert into public.consents(family_id,rider_id,granted_by_member_id,purpose,version)
          values(me.family_id,rider.id,me.id,'rider_location',consent);
      end if;
      return deriro_private.ok(jsonb_build_object('rider',to_jsonb(rider)));

    when 'update_rider','archive_rider','create_rider_invite' then
      perform 1 from public.families where id=me.family_id for key share;
      if not found then return deriro_private.err('NOT_FOUND'); end if;
      select * into rider from public.riders r where r.id = id_arg and r.family_id = me.family_id and r.archived_at is null for update;
      if not found then return deriro_private.err('NOT_FOUND'); end if;
      if p_action = 'update_rider' then
        if char_length(name_arg) > 20 or (phone is not null and phone !~ '^\+[1-9][0-9]{7,14}$')
          then return deriro_private.err('VALIDATION'); end if;
        update public.riders r set display_name = coalesce(name_arg,r.display_name),
          phone_e164 = case when p_data->'phone' <> 'null'::jsonb then phone else r.phone_e164 end
          where r.id = rider.id returning * into rider;
        return deriro_private.ok(jsonb_build_object('rider',to_jsonb(rider)));
      elsif p_action = 'archive_rider' then
        perform 1 from public.pickups p where p.rider_id = rider.id and p.status in ('open','assigned','en_route','arrived') order by p.id for update;
        update public.pickup_offers set status = 'cancelled',resolved_at = now() where status = 'pending'
          and pickup_id in (select id from public.pickups where rider_id = rider.id and status in ('open','assigned','en_route','arrived'));
        update public.vehicles set active_pickup_id = null, active_nav_session_id = null, active_destination_revision = null
          where active_pickup_id in (select id from public.pickups where rider_id = rider.id);
        update public.pickups set status = 'cancelled',cancel_reason = 'cancelled',cancelled_at = now()
          where rider_id = rider.id and status in ('open','assigned','en_route','arrived');
        update public.routines set archived_at = now() where rider_id = rider.id and archived_at is null;
        update public.riders set archived_at = now(), phone_e164 = null where id = rider.id;
        update public.rider_devices set revoked_at = now() where rider_id = rider.id and revoked_at is null;
        update deriro_private.link_codes set revoked_at = now() where rider_id = rider.id and used_at is null;
        return deriro_private.ok('{}');
      end if;
      if channel not in ('qr','sms') then return deriro_private.err('VALIDATION'); end if;
      if channel = 'sms' and rider.phone_e164 is null then return deriro_private.err('VALIDATION','{"field":"phone_e164"}'); end if;
      if channel = 'sms' then
        retry_after := deriro_private.rate_retry(rider.id, 'rider_invite_sms', 5, interval '1 day');
        if retry_after > 0 then return deriro_private.err('RATE_LIMITED',jsonb_build_object('retry_after_sec',retry_after)); end if;
        if not deriro_private.reserve_sms_budget(me.family_id,'invite:'||gen_random_uuid()) then
          return deriro_private.err('RATE_LIMITED',jsonb_build_object('scope','family_sms_daily'));
        end if;
      end if;
      update deriro_private.link_codes set revoked_at = now() where rider_id = rider.id and used_at is null and revoked_at is null;
      link := deriro_private.new_link('rider',me.family_id,me.id,rider.id,null,channel);
      return deriro_private.ok(link || jsonb_build_object('rider_name',rider.display_name) ||
        case when channel = 'sms' then jsonb_build_object('phone_e164',rider.phone_e164,
          'is_demo',(select f.is_demo from public.families f where f.id=me.family_id)) else '{}'::jsonb end);

    when 'revoke_rider_device' then
      update public.rider_devices set revoked_at = now() where id = id_arg and family_id = me.family_id and revoked_at is null;
      if not found then return deriro_private.err('NOT_FOUND'); end if;
      return deriro_private.ok('{}');

    when 'vehicle_pair_confirm' then
      if name_arg is null or char_length(name_arg)>20 then return deriro_private.err('VALIDATION'); end if;
      retry_after := deriro_private.rate_retry(uid,'pair_confirm',5,interval '10 minutes');
      if retry_after > 0 then return deriro_private.err('RATE_LIMITED',jsonb_build_object('retry_after_sec',retry_after)); end if;
      if not deriro_private.eligible_driver(me.family_id,target_id,null) then return deriro_private.err('NOT_FOUND'); end if;
      select * into code_row from deriro_private.link_codes c where c.kind = 'vehicle'
        and c.code_hash = deriro_private.code_digest('vehicle',p_data->>'code');
      if not found then return deriro_private.err('PAIR_CODE_INVALID'); end if;
      perform pg_advisory_xact_lock(hashtextextended(code_row.vehicle_auth_user_id::text,7110));
      select * into code_row from deriro_private.link_codes c where c.id = code_row.id for update;
      if not found or code_row.revoked_at is not null or code_row.used_at is not null
        or exists(select 1 from public.rider_devices d where d.auth_user_id = code_row.vehicle_auth_user_id and d.revoked_at is null)
        then return deriro_private.err('PAIR_CODE_INVALID'); end if;
      if code_row.expires_at <= now() then return deriro_private.err('PAIR_CODE_EXPIRED'); end if;
      if exists(select 1 from public.vehicles v where v.auth_user_id = code_row.vehicle_auth_user_id and v.revoked_at is null)
        then return deriro_private.err('PAIR_CODE_INVALID'); end if;
      insert into public.vehicles(family_id,auth_user_id,nickname,current_driver_member_id)
        values(me.family_id,code_row.vehicle_auth_user_id,name_arg,target_id) returning * into vehicle;
      update deriro_private.link_codes set used_at = now() where id = code_row.id;
      return deriro_private.ok(jsonb_build_object('vehicle',deriro_private.public_vehicle(vehicle)));

    when 'update_vehicle' then
      if char_length(name_arg) > 20 then return deriro_private.err('VALIDATION'); end if;
      if target_id is not null and not deriro_private.eligible_driver(me.family_id,target_id,null) then return deriro_private.err('NOT_FOUND'); end if;
      update public.vehicles v set nickname = coalesce(name_arg,v.nickname),
        current_driver_member_id = coalesce(target_id,v.current_driver_member_id)
        where v.id = id_arg and v.family_id = me.family_id and v.revoked_at is null returning * into vehicle;
      if not found then return deriro_private.err('NOT_FOUND'); end if;
      return deriro_private.ok(jsonb_build_object('vehicle',deriro_private.public_vehicle(vehicle)));
    else return deriro_private.err('VALIDATION');
  end case;
exception
  when unique_violation then return deriro_private.err('NAME_TAKEN');
  when invalid_text_representation or numeric_value_out_of_range then return deriro_private.err('VALIDATION');
end
$$;

create function deriro_private.revoke_vehicle(p_vehicle_id uuid, p_self boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor deriro_private.actor := deriro_private.current_actor();
  vehicle public.vehicles;
begin
  if auth.uid() is null then return deriro_private.err('NOT_AUTHENTICATED'); end if;
  if p_self then
    select * into vehicle from public.vehicles v where v.auth_user_id = auth.uid();
    if not found then return deriro_private.err('NOT_VEHICLE'); end if;
  elsif actor.kind = 'member' then
    select * into vehicle from public.vehicles v where v.id = p_vehicle_id and v.family_id = actor.family_id;
    if not found then return deriro_private.err('NOT_FOUND'); end if;
  else return deriro_private.err('FORBIDDEN');
  end if;
  if vehicle.revoked_at is not null then return deriro_private.ok('{}'); end if;
  perform 1 from public.pickups p where p.vehicle_id = vehicle.id and p.status in ('assigned','en_route','arrived')
    order by p.id for update;
  update public.pickups set vehicle_id = null, nav_session_id = null, nav_destination_revision = null, nav_status = 'none'
    where vehicle_id = vehicle.id and status in ('assigned','en_route','arrived');
  update public.vehicles set revoked_at = now(), current_driver_member_id = null,
    active_pickup_id = null, active_nav_session_id = null, active_destination_revision = null where id = vehicle.id;
  delete from public.vehicle_states where vehicle_id = vehicle.id;
  update public.routines set default_vehicle_id = null where default_vehicle_id = vehicle.id;
  return deriro_private.ok('{}');
end
$$;

revoke execute on function deriro_private.rate_retry(uuid,text,int,interval), deriro_private.code_digest(text,text),
  deriro_private.reserve_sms_budget(uuid,text),
  deriro_private.new_link(text,uuid,uuid,uuid,uuid,text), deriro_private.public_member(public.family_members),
  deriro_private.public_vehicle(public.vehicles), deriro_private.leave_member(public.family_members,uuid)
  from public, anon, authenticated, service_role;

create function public.create_family(p_display_name text, p_privacy_version text, p_phone_e164 text default null, p_sms_opt_in boolean default false, p_family_name text default null, p_location_consent boolean default false)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('create_family',jsonb_build_object('name',p_display_name,'privacy',p_privacy_version,'phone',p_phone_e164,'sms',p_sms_opt_in,'family_name',p_family_name,'location_consent',p_location_consent)) $$;

create function public.join_family(p_code text, p_display_name text, p_privacy_version text, p_phone_e164 text default null, p_sms_opt_in boolean default false, p_location_consent boolean default false)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('join_family',jsonb_build_object('code',p_code,'name',p_display_name,'privacy',p_privacy_version,'phone',p_phone_e164,'sms',p_sms_opt_in,'location_consent',p_location_consent)) $$;

create function public.create_family_invite()
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('create_family_invite','{}') $$;

create function public.preview_family_invite(p_code text)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('preview_family_invite',jsonb_build_object('code',p_code)) $$;

create function public.update_me(p_display_name text default null, p_phone_e164 text default null, p_sms_opt_in boolean default null, p_consent text default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('update_me',jsonb_build_object('name',p_display_name,'phone',p_phone_e164,'sms',p_sms_opt_in,'consent',p_consent)) $$;

create function public.update_family(p_name text)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('update_family',jsonb_build_object('name',p_name)) $$;

create function public.set_member_roles(p_member_id uuid,p_can_drive boolean,p_can_request boolean)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('set_member_roles',jsonb_build_object('id',p_member_id,'can_drive',p_can_drive,'can_request',p_can_request)) $$;

create function public.transfer_owner(p_member_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('transfer_owner',jsonb_build_object('id',p_member_id)) $$;

create function public.remove_member(p_member_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('remove_member',jsonb_build_object('id',p_member_id)) $$;

create function public.leave_family()
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('leave_family','{}') $$;

create function public.prepare_delete_account(p_confirm_family_delete boolean default false)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('prepare_delete_account',jsonb_build_object('confirm',p_confirm_family_delete)) $$;

create function public.add_rider(p_display_name text,p_kind text,p_birth_year int default null,p_consent text default null,p_phone_e164 text default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('add_rider',jsonb_build_object('name',p_display_name,'kind',p_kind,'birth_year',p_birth_year,'consent',p_consent,'phone',p_phone_e164)) $$;

create function public.update_rider(p_rider_id uuid,p_display_name text default null,p_phone_e164 text default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('update_rider',jsonb_build_object('id',p_rider_id,'name',p_display_name,'phone',p_phone_e164)) $$;

create function public.archive_rider(p_rider_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('archive_rider',jsonb_build_object('id',p_rider_id)) $$;

create function public.create_rider_invite(p_rider_id uuid,p_channel text default 'qr')
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('create_rider_invite',jsonb_build_object('id',p_rider_id,'channel',p_channel)) $$;

create function public.claim_rider_invite(p_code text,p_user_agent text default null,p_confirm_switch boolean default false,p_consent text default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('claim_rider_invite',jsonb_build_object('code',p_code,'user_agent',p_user_agent,'confirm_switch',p_confirm_switch,'consent',p_consent)) $$;

create function public.revoke_rider_device(p_device_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('revoke_rider_device',jsonb_build_object('id',p_device_id)) $$;

create function public.vehicle_pair_start()
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('vehicle_pair_start','{}') $$;

create function public.vehicle_pair_status()
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('vehicle_pair_status','{}') $$;

create function public.vehicle_pair_confirm(p_code text,p_nickname text,p_current_driver_member_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('vehicle_pair_confirm',jsonb_build_object('code',p_code,'name',p_nickname,'driver',p_current_driver_member_id)) $$;

create function public.update_vehicle(p_vehicle_id uuid,p_nickname text default null,p_current_driver_member_id uuid default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('update_vehicle',jsonb_build_object('id',p_vehicle_id,'name',p_nickname,'driver',p_current_driver_member_id)) $$;

create function public.vehicle_set_driver(p_member_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_account('vehicle_set_driver',jsonb_build_object('id',p_member_id)) $$;

create function public.revoke_vehicle(p_vehicle_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.revoke_vehicle(p_vehicle_id,false) $$;

create function public.vehicle_unpair_self()
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.revoke_vehicle(null,true) $$;

revoke execute on function
  deriro_private.manage_account(text,jsonb),
  deriro_private.revoke_vehicle(uuid,boolean),
  public.create_family(text,text,text,boolean,text,boolean),
  public.join_family(text,text,text,text,boolean,boolean),
  public.create_family_invite(),
  public.preview_family_invite(text),
  public.update_me(text,text,boolean,text),
  public.update_family(text),
  public.set_member_roles(uuid,boolean,boolean),
  public.transfer_owner(uuid),
  public.remove_member(uuid),
  public.leave_family(),
  public.prepare_delete_account(boolean),
  public.add_rider(text,text,int,text,text),
  public.update_rider(uuid,text,text),
  public.archive_rider(uuid),
  public.create_rider_invite(uuid,text),
  public.claim_rider_invite(text,text,boolean,text),
  public.revoke_rider_device(uuid),
  public.vehicle_pair_start(),
  public.vehicle_pair_status(),
  public.vehicle_pair_confirm(text,text,uuid),
  public.update_vehicle(uuid,text,uuid),
  public.vehicle_set_driver(uuid),
  public.revoke_vehicle(uuid),
  public.vehicle_unpair_self()
  from public, anon, authenticated, service_role;
grant execute on function
  deriro_private.manage_account(text,jsonb),
  deriro_private.revoke_vehicle(uuid,boolean),
  public.create_family(text,text,text,boolean,text,boolean),
  public.join_family(text,text,text,text,boolean,boolean),
  public.create_family_invite(),
  public.preview_family_invite(text),
  public.update_me(text,text,boolean,text),
  public.update_family(text),
  public.set_member_roles(uuid,boolean,boolean),
  public.transfer_owner(uuid),
  public.remove_member(uuid),
  public.leave_family(),
  public.prepare_delete_account(boolean),
  public.add_rider(text,text,int,text,text),
  public.update_rider(uuid,text,text),
  public.archive_rider(uuid),
  public.create_rider_invite(uuid,text),
  public.claim_rider_invite(text,text,boolean,text),
  public.revoke_rider_device(uuid),
  public.vehicle_pair_start(),
  public.vehicle_pair_status(),
  public.vehicle_pair_confirm(text,text,uuid),
  public.update_vehicle(uuid,text,uuid),
  public.vehicle_set_driver(uuid),
  public.revoke_vehicle(uuid),
  public.vehicle_unpair_self()
  to authenticated;
