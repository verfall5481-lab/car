create type deriro_private.actor as (
  kind text, id uuid, family_id uuid, member_id uuid, rider_id uuid, can_drive boolean, can_request boolean
);

create function deriro_private.current_actor()
returns deriro_private.actor
language plpgsql stable set search_path = ''
as $$
declare
  actor deriro_private.actor;
  uid uuid := auth.uid();
begin
  if uid is null then return null; end if;

  select 'member', m.id, m.family_id, m.id, null::uuid, m.can_drive,
    m.can_request and m.location_consented_at is not null
    into actor
    from public.family_members m join auth.users u on u.id = m.auth_user_id
    where m.auth_user_id = uid and m.left_at is null and not u.is_anonymous;
  if found then return actor; end if;

  select 'rider', d.id, d.family_id, null::uuid, r.id, false, r.location_consented_at is not null
    into actor
    from public.rider_devices d join public.riders r on (r.family_id, r.id) = (d.family_id, d.rider_id)
      join auth.users u on u.id = d.auth_user_id
    where d.auth_user_id = uid and u.is_anonymous and d.revoked_at is null and r.archived_at is null;
  if found then return actor; end if;

  select 'vehicle', v.id, v.family_id, m.id, null::uuid, m.can_drive, false
    into actor
    from public.vehicles v join public.family_members m
      on (m.family_id, m.id) = (v.family_id, v.current_driver_member_id)
      join auth.users u on u.id = v.auth_user_id
    where v.auth_user_id = uid and u.is_anonymous and v.revoked_at is null and m.left_at is null;
  return actor;
end
$$;

create function deriro_private.ok(p_data jsonb)
returns jsonb language sql immutable set search_path = ''
as $$ select jsonb_build_object('ok', true, 'data', p_data) $$;

create function deriro_private.err(p_code text, p_detail jsonb default '{}')
returns jsonb language sql immutable set search_path = ''
as $$ select jsonb_build_object('ok', false, 'error', jsonb_build_object('code', p_code, 'detail', p_detail)) $$;

-- Raw GPS fixes never leave the database through an RPC response.
create function deriro_private.safe_pickup(p_pickup public.pickups)
returns jsonb language sql stable set search_path = '' as $$
  select to_jsonb(p_pickup) - array['raw_lat','raw_lng','raw_accuracy_m']
$$;

create function deriro_private.pickup_result(p_pickup public.pickups)
returns jsonb language sql stable set search_path = ''
as $$ select deriro_private.ok(jsonb_build_object('pickup', deriro_private.safe_pickup(p_pickup))) $$;

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

create function deriro_private.add_event(p_pickup public.pickups, p_actor deriro_private.actor,
  p_type text, p_payload jsonb default '{}')
returns void language sql set search_path = ''
as $$
  insert into public.pickup_events(family_id, pickup_id, actor_kind, actor_id, event_type, payload)
  values (p_pickup.family_id, p_pickup.id, case p_actor.kind when 'member' then 'guardian'
    else coalesce(p_actor.kind, 'system') end, p_actor.id, p_type, p_payload)
$$;

create function deriro_private.eligible_driver(p_family_id uuid, p_member_id uuid, p_requester_member_id uuid)
returns boolean language sql stable set search_path = ''
as $$
  select exists (select 1 from public.family_members m
    where m.family_id = p_family_id and m.id = p_member_id and m.left_at is null and m.can_drive
      and m.id is distinct from p_requester_member_id)
$$;

create function deriro_private.selected_vehicle(p_family_id uuid, p_member_id uuid, p_vehicle_id uuid)
returns boolean language sql stable set search_path = ''
as $$
  select p_vehicle_id is null or exists (select 1 from public.vehicles v
    where v.family_id = p_family_id and v.id = p_vehicle_id
      and v.current_driver_member_id = p_member_id and v.revoked_at is null)
$$;

create function deriro_private.distance_m(p_lat1 double precision, p_lng1 double precision,
  p_lat2 double precision, p_lng2 double precision)
returns double precision language sql immutable strict set search_path = ''
as $$
  select 12742000 * asin(sqrt(least(1,
    power(sin(radians(p_lat2 - p_lat1) / 2), 2) +
    cos(radians(p_lat1)) * cos(radians(p_lat2)) * power(sin(radians(p_lng2 - p_lng1) / 2), 2)
  )))
$$;

create function deriro_private.create_request(p_actor_kind text, p_wanted_in_min int,
  p_place_id uuid, p_pickup_point_id uuid, p_pin jsonb, p_gps jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  actor deriro_private.actor := deriro_private.current_actor();
  pickup public.pickups;
  place public.places;
  point public.pickup_points;
  dest_source public.location_source;
  dest_lat double precision;
  dest_lng double precision;
  dest_label text;
  dest_note text;
  confirmed boolean := true;
  accuracy_m double precision;
  current_lat double precision;
  current_lng double precision;
  payload jsonb;
  retry_after int;
begin
  if auth.uid() is null then return deriro_private.err('NOT_AUTHENTICATED'); end if;
  if p_actor_kind = 'rider' and actor.kind is null and exists(select 1 from public.rider_devices d
    where d.auth_user_id = auth.uid() and d.revoked_at is not null) then
    return deriro_private.err('DEVICE_REVOKED');
  end if;
  if actor.kind is distinct from p_actor_kind or not coalesce(actor.can_request, false) then
    return deriro_private.err('FORBIDDEN');
  end if;
  perform 1 from public.families where id=actor.family_id for key share;
  if not found then return deriro_private.err('NOT_FOUND'); end if;
  if p_wanted_in_min is null or p_wanted_in_min not in (0, 10, 20, 30) then
    return deriro_private.err('VALIDATION', '{"field":"wanted_in_min"}');
  end if;
  if num_nonnulls(p_place_id, p_pickup_point_id, p_pin, p_gps) <> 1 then
    return deriro_private.err('VALIDATION', '{"field":"location"}');
  end if;

  if p_pickup_point_id is not null then
    select pp.* into point from public.pickup_points pp join public.places pl
      on (pp.family_id, pp.place_id) = (pl.family_id, pl.id)
      where pp.family_id = actor.family_id and pp.id = p_pickup_point_id
        and pp.archived_at is null and pl.archived_at is null;
    if not found then return deriro_private.err('NOT_FOUND'); end if;
    dest_source := 'saved_point';
    dest_lat := point.lat;
    dest_lng := point.lng;
    dest_label := point.label;
    dest_note := point.note;
    p_place_id := point.place_id;
  elsif p_place_id is not null then
    select * into place from public.places pl
      where pl.family_id = actor.family_id and pl.id = p_place_id and pl.archived_at is null;
    if not found then return deriro_private.err('NOT_FOUND'); end if;
    dest_source := 'saved_place';
    dest_lat := place.lat;
    dest_lng := place.lng;
    dest_label := place.label;
  else
    payload := coalesce(p_pin, p_gps);
    if jsonb_typeof(payload) is distinct from 'object'
      or jsonb_typeof(payload->'lat') is distinct from 'number'
      or jsonb_typeof(payload->'lng') is distinct from 'number'
    then return deriro_private.err('VALIDATION', '{"field":"location"}'); end if;
    dest_lat := (payload->>'lat')::double precision;
    dest_lng := (payload->>'lng')::double precision;
    if not (dest_lat between -90 and 90 and dest_lng between -180 and 180) then
      return deriro_private.err('VALIDATION', '{"field":"location"}');
    end if;
    if p_pin is not null then
      dest_source := 'map_pin';
      dest_label := '지도에서 고른 곳';
      dest_note := payload->>'note';
      if not (dest_lat between 33 and 39 and dest_lng between 124 and 132)
        or char_length(dest_note) > 40 or (payload ? 'note' and jsonb_typeof(payload->'note') <> 'string')
      then return deriro_private.err('VALIDATION', '{"field":"pin"}'); end if;
      if payload ? 'current_location' then
        if jsonb_typeof(payload#>'{current_location,lat}') is distinct from 'number'
          or jsonb_typeof(payload#>'{current_location,lng}') is distinct from 'number'
        then return deriro_private.err('VALIDATION', '{"field":"pin"}'); end if;
        current_lat := (payload#>>'{current_location,lat}')::double precision;
        current_lng := (payload#>>'{current_location,lng}')::double precision;
        if not (current_lat between -90 and 90 and current_lng between -180 and 180)
          or deriro_private.distance_m(dest_lat, dest_lng, current_lat, current_lng) > 50000
        then return deriro_private.err('VALIDATION', '{"field":"pin"}'); end if;
      end if;
    else
      dest_source := 'gps';
      dest_label := '현재 위치';
      confirmed := false;
      if coalesce(jsonb_typeof(payload->'accuracy_m'), 'null') not in ('number', 'null')
        then return deriro_private.err('VALIDATION', '{"field":"gps"}'); end if;
      accuracy_m := coalesce((payload->>'accuracy_m')::double precision, 50);
      if not (accuracy_m between 0 and 40000000) then return deriro_private.err('VALIDATION', '{"field":"gps"}'); end if;
      if accuracy_m <= 300 then
        select pl.* into place from public.places pl
          cross join lateral (select deriro_private.distance_m(dest_lat, dest_lng, pl.lat, pl.lng) as metres) distance
          where pl.family_id = actor.family_id and pl.archived_at is null
            and distance.metres <= greatest(pl.radius_m, accuracy_m)
          order by distance.metres, pl.id limit 1;
        if found then
          confirmed := true;
          dest_lat := place.lat;
          dest_lng := place.lng;
          dest_label := place.label;
          p_place_id := place.id;
        end if;
      end if;
    end if;
  end if;

  if exists(select 1 from public.pickups p where p.family_id=actor.family_id and p.source='request'
    and p.status in ('open','assigned','en_route','arrived')
    and (p.rider_id=actor.rider_id or p.rider_member_id=actor.member_id))
  then return deriro_private.err('ACTIVE_REQUEST_EXISTS'); end if;
  retry_after := deriro_private.rate_retry(coalesce(actor.rider_id,actor.member_id),'pickup_request',3,interval '10 minutes');
  if retry_after > 0 then return deriro_private.err('RATE_LIMITED',jsonb_build_object('retry_after_sec',retry_after)); end if;
  insert into public.pickups(family_id, rider_id, rider_member_id, source, place_id, pickup_point_id,
    location_source, location_confirmed, dest_lat, dest_lng, dest_label, pin_note, wanted_at, raw_lat, raw_lng, raw_accuracy_m)
  values (actor.family_id, actor.rider_id, actor.member_id, 'request', p_place_id, p_pickup_point_id,
    dest_source, confirmed, dest_lat, dest_lng, dest_label, dest_note, now() + make_interval(mins => p_wanted_in_min),
    (p_gps->>'lat')::double precision,(p_gps->>'lng')::double precision,(p_gps->>'accuracy_m')::double precision)
  on conflict do nothing returning * into pickup;
  if not found then return deriro_private.err('ACTIVE_REQUEST_EXISTS'); end if;
  insert into public.pickup_offers(family_id, pickup_id, origin, expires_at)
  values (pickup.family_id, pickup.id, 'request', pickup.wanted_at + interval '60 minutes');
  perform deriro_private.add_event(pickup, actor, 'created');
  return deriro_private.pickup_result(pickup);
exception
  when numeric_value_out_of_range or invalid_text_representation then
    return deriro_private.err('VALIDATION', '{"field":"location"}');
end
$$;

create function deriro_private.resolve_offer(p_offer_id uuid, p_status public.offer_status, p_member_id uuid default null)
returns void language sql set search_path = ''
as $$
  update public.pickup_offers set status = p_status, resolved_at = now(), resolved_by_member_id = p_member_id
    where id = p_offer_id and status = 'pending'
$$;

-- 4.4 #7, 8.7: a family-wide offer is declined once every driver it was for has declined it, from a phone or a car.
create function deriro_private.everyone_declined(p_offer public.pickup_offers, p_pickup public.pickups)
returns boolean language sql stable set search_path = ''
as $$
  select not exists (select 1 from public.family_members m where m.family_id = p_pickup.family_id and m.can_drive
    and m.left_at is null and m.id is distinct from p_pickup.rider_member_id and m.id is distinct from p_offer.from_member_id
    and not exists (select 1 from public.offer_responses r where r.offer_id = p_offer.id and r.member_id = m.id))
$$;

create function deriro_private.expire_pickup(p_pickup public.pickups)
returns public.pickups language plpgsql set search_path = ''
as $$
begin
  update public.pickup_offers set status = 'expired', resolved_at = now()
    where pickup_id = p_pickup.id and status = 'pending';
  update public.pickups set status = 'expired', expired_at = now() where id = p_pickup.id returning * into p_pickup;
  perform deriro_private.add_event(p_pickup, null, 'expired');
  return p_pickup;
end
$$;

create function deriro_private.vehicle_start_result(p_pickup public.pickups)
returns jsonb language sql stable set search_path = ''
as $$
  select deriro_private.ok(jsonb_build_object(
    'pickup', deriro_private.safe_pickup(p_pickup), 'nav_session_id', p_pickup.nav_session_id,
    'destination_revision', p_pickup.destination_revision,
    'dest', jsonb_build_object('lat', p_pickup.dest_lat, 'lng', p_pickup.dest_lng, 'label', p_pickup.dest_label, 'note', p_pickup.pin_note)))
$$;

-- The pickup row is locked first, including when an offer ID is the initial lookup key.
create function deriro_private.transition(p_action text, p_pickup_id uuid, p_expected_version int, p_input jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  actor deriro_private.actor := deriro_private.current_actor();
  pickup public.pickups;
  offer public.pickup_offers;
  vehicle public.vehicles;
  place public.places;
  offer_id uuid := (p_input->>'offer_id')::uuid;
  target_id uuid := (p_input->>'to_member_id')::uuid;
  selected_vehicle_id uuid := (p_input->>'vehicle_id')::uuid;
  action_id uuid := (p_input->>'action_id')::uuid;
  callback_session_id uuid := (p_input->>'nav_session_id')::uuid;
  callback_revision int := (p_input->>'destination_revision')::int;
  location_place_id uuid := (p_input->>'place_id')::uuid;
  next_nav_session_id uuid;
  is_assignee boolean;
  is_requester boolean;
  is_driver boolean;
  is_offer_target boolean;
  lost_race boolean;
  parked boolean := false;
  event_type text;
  prior_event text;
  previous_assignee_id uuid;
  note text := p_input->>'note';
  reason text := coalesce(p_input->>'reason', 'cancelled');
  response text := p_input->>'response';
  arrival_source text := p_input->>'source';
  expiry timestamptz;
  pickup_time_limit interval;
  latitude double precision;
  longitude double precision;
  label text;
begin
  if auth.uid() is null then return deriro_private.err('NOT_AUTHENTICATED'); end if;
  if actor.kind is null then
    if exists(select 1 from public.rider_devices d where d.auth_user_id=auth.uid() and d.revoked_at is not null)
      then return deriro_private.err('DEVICE_REVOKED'); end if;
    if exists(select 1 from public.vehicles v where v.auth_user_id=auth.uid() and v.revoked_at is not null)
      then return deriro_private.err('VEHICLE_REVOKED'); end if;
    return deriro_private.err('FORBIDDEN');
  end if;
  if p_action in ('rider_cancel','rider_board') then
    if actor.kind <> 'rider' then return deriro_private.err('FORBIDDEN'); end if;
    p_action := case when p_action='rider_cancel' then 'cancel' else 'board' end;
  end if;
  perform 1 from public.families where id=actor.family_id for key share;
  if not found then return deriro_private.err('NOT_FOUND'); end if;
  if p_action in ('respond_offer', 'cancel_offer') then
    select o.pickup_id into p_pickup_id from public.pickup_offers o where o.id = offer_id and o.family_id = actor.family_id;
  end if;
  select * into pickup from public.pickups p where p.id = p_pickup_id and p.family_id = actor.family_id for update;
  if not found then return deriro_private.err('NOT_FOUND'); end if;

  is_requester := (actor.kind = 'rider' and actor.rider_id is not distinct from pickup.rider_id)
    or (actor.kind = 'member' and actor.member_id is not distinct from pickup.rider_member_id);
  if actor.kind = 'rider' and not is_requester then return deriro_private.err('NOT_FOUND'); end if;
  is_driver := coalesce(actor.can_drive, false) and actor.member_id is distinct from pickup.rider_member_id;
  is_assignee := (actor.kind = 'member' and actor.member_id is not distinct from pickup.assignee_member_id)
    or (actor.kind = 'vehicle' and actor.id is not distinct from pickup.vehicle_id);
  if actor.kind = 'vehicle' and not (is_assignee or is_driver) then return deriro_private.err('NOT_FOUND'); end if;

  if offer_id is not null and (p_action in ('respond_offer', 'cancel_offer') or
    (p_action = 'vehicle_start' and pickup.status = 'assigned' and actor.member_id is distinct from pickup.assignee_member_id))
  then
    select * into offer from public.pickup_offers o where o.id = offer_id and o.pickup_id = pickup.id for update;
  else
    select * into offer from public.pickup_offers o where o.pickup_id = pickup.id and o.status = 'pending' for update;
  end if;
  is_offer_target := is_driver and actor.member_id is distinct from offer.from_member_id
    and (offer.to_member_id is null or actor.member_id = offer.to_member_id);

  -- A car acts on its own trip, an open pickup, its driver's assignment or an offer to its driver (2.2). A car whose
  -- driver lost the race still learns why, so accept and vehicle_start reach their rules (F-10 ALREADY_TAKEN, 8.3.1
  -- NO_VALID_OFFER). Another family's pickup is NOT_FOUND above, before anything about it is read.
  if actor.kind = 'vehicle' and not (is_assignee or (is_driver and
    (p_action in ('accept', 'vehicle_start') or pickup.status = 'open'
      or (pickup.status = 'assigned' and pickup.assignee_member_id = actor.member_id)
      or (offer.status is not distinct from 'pending' and is_offer_target))))
  then return deriro_private.err('NOT_FOUND'); end if;

  if actor.kind = 'vehicle' then
    -- A vehicle can switch guidance between pickups. Serialize on the vehicle after pickup and offer.
    select * into vehicle from public.vehicles v
      where v.id = actor.id and v.current_driver_member_id = actor.member_id and v.revoked_at is null for update;
    if not found then return deriro_private.err('FORBIDDEN'); end if;
    selected_vehicle_id := vehicle.id;
    select exists(select 1 from public.vehicle_states s where s.vehicle_id = vehicle.id and s.gear = 'P'
      and s.collected_at between now() - interval '30 seconds' and now()) into parked;
  end if;

  if p_action = 'accept' and is_assignee and is_driver and pickup.accepted_at is not null
    and pickup.status in ('assigned', 'en_route', 'arrived')
  then return deriro_private.pickup_result(pickup); end if;
  if p_action = 'respond_offer' and response = 'accept' and is_offer_target
    and offer.status = 'accepted' and offer.resolved_by_member_id = actor.member_id
  then return deriro_private.ok(jsonb_build_object('pickup', deriro_private.safe_pickup(pickup), 'offer', to_jsonb(offer))); end if;
  if p_action = 'vehicle_start' and actor.kind = 'vehicle' and is_assignee and is_driver
    and pickup.status = 'en_route' and pickup.last_start_action_id = action_id then
    if pickup.nav_session_id = vehicle.active_nav_session_id
      and pickup.destination_revision = pickup.nav_destination_revision
    then return deriro_private.vehicle_start_result(pickup); end if;
    return deriro_private.err('STALE_VERSION', jsonb_build_object('pickup', deriro_private.safe_pickup(pickup)));
  end if;

  -- "출발하고 안내" pressed on a request or routine card (no offer) of a trip someone else now holds, from a car that is
  -- not the trip's car: the car lost the race. Its card was drawn before the winner's acceptance changed the version,
  -- and the only outcome is the ALREADY_TAKEN rejection below, which writes nothing. So, like accept_pickup, the race
  -- result comes before the version check (4.5, V-03, S-02). Every other start keeps the check (8.3.1).
  lost_race := p_action = 'vehicle_start' and actor.kind = 'vehicle' and offer_id is null and not is_assignee
    and pickup.status in ('assigned', 'en_route', 'arrived') and pickup.assignee_member_id is distinct from actor.member_id;
  if p_action <> 'accept' and not lost_race and not (p_action = 'arrive' and arrival_source is not distinct from 'nav_callback')
    and p_action <> 'nav_result' and pickup.version is distinct from p_expected_version
  then return deriro_private.err('STALE_VERSION', jsonb_build_object('pickup', deriro_private.safe_pickup(pickup))); end if;

  case p_action
    when 'accept' then
      if not is_driver then return deriro_private.err('FORBIDDEN'); end if;
      if pickup.status = 'open' and now() >= pickup.wanted_at + interval '60 minutes' then
        pickup := deriro_private.expire_pickup(pickup);
        return deriro_private.err('PICKUP_EXPIRED', jsonb_build_object('pickup', deriro_private.safe_pickup(pickup)));
      end if;
      if pickup.status in ('assigned', 'en_route', 'arrived') and pickup.assignee_member_id is distinct from actor.member_id then
        return deriro_private.err('ALREADY_TAKEN', jsonb_build_object('by',
          (select display_name from public.family_members where id = pickup.assignee_member_id)));
      end if;
      if pickup.status not in ('open', 'assigned') then return deriro_private.err('INVALID_STATE'); end if;
      if not deriro_private.selected_vehicle(pickup.family_id, actor.member_id, selected_vehicle_id) then
        return deriro_private.err('VALIDATION', '{"field":"vehicle_id"}');
      end if;
      update public.pickups set status = 'assigned', assignee_member_id = actor.member_id, accepted_at = now(),
        vehicle_id = coalesce(selected_vehicle_id, pickup.vehicle_id),
        is_customized = pickup.is_customized or pickup.source = 'routine'
        where id = pickup.id returning * into pickup;
      -- Only a target accepts an offer (4.4 #5). The default assignee confirming a trip they had offered away
      -- (handoff or vehicle "못 가요") withdraws that offer instead (4.4 #9, F-11).
      perform deriro_private.resolve_offer(offer.id, case when is_offer_target then 'accepted'::public.offer_status
        else 'cancelled'::public.offer_status end, actor.member_id);
      event_type := 'accepted';

    when 'offer' then
      -- A member who has since lost can_drive can still hand off a trip they hold. A vehicle offers for its driver.
      if not is_assignee or (actor.kind = 'vehicle' and not is_driver) then return deriro_private.err('NOT_ASSIGNEE'); end if;
      if actor.member_id is distinct from pickup.assignee_member_id then return deriro_private.err('NOT_ASSIGNEE'); end if;
      -- A vehicle hands off only by declining, to every driver at once (2.2). Choosing a recipient or writing a note
      -- is a phone action of the assignee.
      if actor.kind = 'vehicle' and (target_id is not null or note is not null) then return deriro_private.err('FORBIDDEN'); end if;
      if pickup.status <> 'assigned' then return deriro_private.err('INVALID_STATE'); end if;
      if target_id = actor.member_id then return deriro_private.err('CANNOT_ACCEPT_OWN_OFFER'); end if;
      if target_id is not null and not deriro_private.eligible_driver(pickup.family_id, target_id, pickup.rider_member_id) then
        return deriro_private.err('NOT_FOUND');
      end if;
      if char_length(note) > 40 then return deriro_private.err('VALIDATION', '{"field":"note"}'); end if;
      pickup_time_limit := make_interval(mins => coalesce((select notify_before_min from public.routines where id = pickup.routine_id), 20));
      expiry := least(now() + interval '10 minutes', pickup.wanted_at - pickup_time_limit);
      if expiry <= now() then expiry := now() + interval '5 minutes'; end if;
      perform deriro_private.resolve_offer(offer.id, 'superseded');
      insert into public.pickup_offers(family_id, pickup_id, origin, from_member_id, to_member_id, note, expires_at)
        values (pickup.family_id, pickup.id, case when actor.kind = 'vehicle' then 'vehicle' else 'guardian' end,
          actor.member_id, target_id, note, expiry) returning * into offer;
      if pickup.source = 'routine' then
        update public.pickups set is_customized = true where id = pickup.id returning * into pickup;
      end if;
      perform deriro_private.add_event(pickup, actor, 'offered', jsonb_build_object('offer_id', offer.id));
      return deriro_private.ok(jsonb_build_object('offer', to_jsonb(offer)));

    when 'cancel_offer' then
      if actor.kind <> 'member' or offer.from_member_id is distinct from actor.member_id then
        return deriro_private.err('FORBIDDEN');
      end if;
      if offer.status <> 'pending' then return deriro_private.err('OFFER_NOT_PENDING'); end if;
      perform deriro_private.resolve_offer(offer.id, 'cancelled', actor.member_id);
      event_type := 'offer_cancelled';

    when 'respond_offer' then
      if response is null or response not in ('accept', 'decline') then return deriro_private.err('VALIDATION'); end if;
      if offer.id is null then return deriro_private.err('NOT_FOUND'); end if;
      if actor.member_id = offer.from_member_id then return deriro_private.err('CANNOT_ACCEPT_OWN_OFFER'); end if;
      if not is_offer_target then return deriro_private.err('FORBIDDEN'); end if;
      if offer.status <> 'pending' then return deriro_private.err('OFFER_NOT_PENDING'); end if;
      if pickup.status = 'open' and now() >= pickup.wanted_at + interval '60 minutes' then
        pickup := deriro_private.expire_pickup(pickup);
        return deriro_private.err('PICKUP_EXPIRED', jsonb_build_object('pickup', deriro_private.safe_pickup(pickup)));
      end if;
      if now() >= offer.expires_at then
        perform deriro_private.resolve_offer(offer.id, 'expired');
        perform deriro_private.add_event(pickup, null, 'offer_expired', jsonb_build_object('offer_id', offer.id));
        return deriro_private.err('OFFER_NOT_PENDING');
      end if;
      if pickup.status not in ('open', 'assigned') then return deriro_private.err('INVALID_STATE'); end if;
      if response = 'decline' then
        insert into public.offer_responses(family_id, offer_id, member_id)
          values (pickup.family_id, offer.id, actor.member_id) on conflict do nothing;
        if found then
          if offer.to_member_id is not null or deriro_private.everyone_declined(offer, pickup)
          then perform deriro_private.resolve_offer(offer.id, 'declined', actor.member_id); end if;
          perform deriro_private.add_event(pickup, actor, 'offer_declined', jsonb_build_object('offer_id', offer.id));
        end if;
      else
        if not deriro_private.selected_vehicle(pickup.family_id, actor.member_id, selected_vehicle_id) then
          return deriro_private.err('VALIDATION', '{"field":"vehicle_id"}');
        end if;
        update public.pickups set status = 'assigned', assignee_member_id = actor.member_id, vehicle_id = selected_vehicle_id,
          accepted_at = now(), is_customized = true where id = pickup.id returning * into pickup;
        perform deriro_private.resolve_offer(offer.id, 'accepted', actor.member_id);
        perform deriro_private.add_event(pickup, actor, 'offer_accepted', jsonb_build_object('offer_id', offer.id));
      end if;
      select * into offer from public.pickup_offers o where o.id = offer_id;
      return deriro_private.ok(jsonb_build_object('pickup', deriro_private.safe_pickup(pickup), 'offer', to_jsonb(offer)));

    when 'take_over' then
      if actor.kind <> 'member' or not is_driver then return deriro_private.err('FORBIDDEN'); end if;
      if pickup.status = 'en_route' then return deriro_private.err('ALREADY_EN_ROUTE'); end if;
      if pickup.status <> 'assigned' then return deriro_private.err('INVALID_STATE'); end if;
      if is_assignee then return deriro_private.pickup_result(pickup); end if;
      if not deriro_private.selected_vehicle(pickup.family_id, actor.member_id, selected_vehicle_id) then
        return deriro_private.err('VALIDATION', '{"field":"vehicle_id"}');
      end if;
      previous_assignee_id := pickup.assignee_member_id;
      update public.pickups set assignee_member_id = actor.member_id, vehicle_id = selected_vehicle_id,
        accepted_at = now(), is_customized = pickup.is_customized or pickup.source = 'routine'
        where id = pickup.id returning * into pickup;
      perform deriro_private.resolve_offer(offer.id, 'cancelled');
      event_type := 'took_over';

    when 'depart' then
      if actor.kind <> 'member' or not is_assignee then return deriro_private.err('NOT_ASSIGNEE'); end if;
      -- An assignee whose can_drive was turned off after accepting holds the trip until it is handed off, but cannot
      -- start driving it (23.1). The vehicle path checks the same permission through is_driver.
      if not is_driver then return deriro_private.err('FORBIDDEN'); end if;
      if pickup.status <> 'assigned' then return deriro_private.err('INVALID_STATE'); end if;
      if not pickup.location_confirmed then return deriro_private.err('LOCATION_UNCONFIRMED'); end if;
      perform deriro_private.resolve_offer(offer.id, 'cancelled');
      update public.pickups set status = 'en_route', en_route_at = now() where id = pickup.id returning * into pickup;
      event_type := 'en_route';

    when 'undo_en_route' then
      if not is_assignee then return deriro_private.err('NOT_ASSIGNEE'); end if;
      if pickup.status <> 'en_route' or pickup.en_route_at is null or pickup.en_route_at < now()-interval '5 minutes' then
        return deriro_private.err('INVALID_STATE');
      end if;
      update public.pickups set status='assigned',en_route_at=null,nav_session_id=null,
        nav_destination_revision=null,nav_status='none',last_start_action_id=null where id=pickup.id returning * into pickup;
      update public.vehicles set active_pickup_id=null,active_nav_session_id=null,active_destination_revision=null
        where id=pickup.vehicle_id and active_pickup_id=pickup.id;
      event_type := 'en_route_undone';

    when 'vehicle_start' then
      if actor.kind <> 'vehicle' or not is_driver then return deriro_private.err('FORBIDDEN'); end if;
      if action_id is null then return deriro_private.err('VALIDATION', '{"field":"action_id"}'); end if;
      if pickup.status = 'open' and now() >= pickup.wanted_at + interval '60 minutes' then
        pickup := deriro_private.expire_pickup(pickup);
        return deriro_private.err('PICKUP_EXPIRED', jsonb_build_object('pickup', deriro_private.safe_pickup(pickup)));
      end if;
      -- The car lost the race (see lost_race) and hears who won, as accept_pickup does (V-03, S-02). With an offer ID
      -- the handoff rules below apply, and the trip's own car keeps its branch (8.3.1).
      if lost_race then
        return deriro_private.err('ALREADY_TAKEN', jsonb_build_object('by',
          (select display_name from public.family_members where id = pickup.assignee_member_id)));
      end if;
      if not pickup.location_confirmed then return deriro_private.err('LOCATION_UNCONFIRMED'); end if;
      if vehicle.active_pickup_id is not null and vehicle.active_pickup_id <> pickup.id and not parked then
        return deriro_private.err('FORBIDDEN');
      end if;
      if pickup.status = 'open' then
        if pickup.wanted_at > now() + interval '15 minutes' then return deriro_private.err('INVALID_STATE'); end if;
        perform deriro_private.resolve_offer(offer.id, 'accepted', actor.member_id);
        prior_event := 'accepted';
      elsif pickup.status = 'assigned' and actor.member_id = pickup.assignee_member_id then
        perform deriro_private.resolve_offer(offer.id, 'cancelled');
      elsif pickup.status = 'assigned' then
        if offer_id is null or offer.status is distinct from 'pending' or not is_offer_target then
          return deriro_private.err('NO_VALID_OFFER');
        end if;
        if now() >= offer.expires_at then
          perform deriro_private.resolve_offer(offer.id, 'expired');
          perform deriro_private.add_event(pickup, null, 'offer_expired', jsonb_build_object('offer_id', offer.id));
          return deriro_private.err('NO_VALID_OFFER');
        end if;
        perform deriro_private.resolve_offer(offer.id, 'accepted', actor.member_id);
        prior_event := 'offer_accepted';
      elsif pickup.status <> 'en_route' or not is_assignee then
        return deriro_private.err('INVALID_STATE');
      end if;
      next_nav_session_id := gen_random_uuid();
      event_type := case when pickup.status = 'en_route' then 'navigation_requested' else 'en_route' end;
      update public.pickups p set status = 'en_route', vehicle_id = vehicle.id,
        assignee_member_id = case when prior_event is not null then actor.member_id else p.assignee_member_id end,
        accepted_at = case when prior_event is not null then now() else p.accepted_at end,
        is_customized = p.is_customized or (prior_event is not null and p.source = 'routine'),
        en_route_at = coalesce(p.en_route_at, now()),
        nav_session_id = next_nav_session_id, nav_destination_revision = p.destination_revision,
        nav_status = 'requested', last_start_action_id = action_id
        where p.id = pickup.id returning p.* into pickup;
      update public.vehicles set active_pickup_id = pickup.id, active_nav_session_id = next_nav_session_id,
        active_destination_revision = pickup.destination_revision where id = vehicle.id;
      if prior_event is not null then
        perform deriro_private.add_event(pickup, actor, prior_event, jsonb_strip_nulls(jsonb_build_object('offer_id',offer.id)));
      end if;
      perform deriro_private.add_event(pickup, actor, event_type);
      return deriro_private.vehicle_start_result(pickup);

    when 'nav_result' then
      if actor.kind <> 'vehicle' or not is_assignee then return deriro_private.err('NOT_ASSIGNEE'); end if;
      if response is null or response not in ('ok', 'failed') then return deriro_private.err('VALIDATION'); end if;
      if callback_session_id is not null and pickup.nav_session_id = callback_session_id
        and vehicle.active_nav_session_id = callback_session_id and pickup.destination_revision = pickup.nav_destination_revision
        and pickup.status = 'en_route' and pickup.nav_status = 'requested'
      then
        update public.pickups set nav_status = response where id = pickup.id;
        if response = 'failed' then
          perform deriro_private.add_event(pickup,actor,'nav_failed',jsonb_strip_nulls(jsonb_build_object(
            'nav_session_id',callback_session_id,'error_code',
            case when p_input->>'error_code' ~ '^[A-Za-z0-9_-]{1,64}$' then p_input->>'error_code' end)));
        end if;
      end if;
      return deriro_private.ok('{}');

    when 'arrive' then
      if not is_assignee then return deriro_private.err('NOT_ASSIGNEE'); end if;
      if arrival_source = 'nav_callback' then
        if actor.kind <> 'vehicle' then return deriro_private.err('FORBIDDEN'); end if;
        if pickup.status <> 'en_route' or callback_session_id is null or callback_revision is null
          or pickup.nav_session_id is distinct from callback_session_id
          or pickup.destination_revision is distinct from callback_revision
          or pickup.nav_destination_revision is distinct from callback_revision
          or vehicle.active_pickup_id is distinct from pickup.id
          or vehicle.active_nav_session_id is distinct from callback_session_id
          or vehicle.active_destination_revision is distinct from callback_revision
        then
          perform deriro_private.add_event(pickup, actor, 'arrival_ignored');
          return deriro_private.ok('{"ignored":true}');
        end if;
      elsif arrival_source is distinct from 'manual' then return deriro_private.err('VALIDATION');
      end if;
      if pickup.status <> 'en_route' then return deriro_private.err('INVALID_STATE'); end if;
      update public.pickups set status = 'arrived', arrived_at = now(),arrived_source=arrival_source where id = pickup.id returning * into pickup;
      event_type := 'arrived';

    when 'board' then
      if not is_assignee and not is_requester then return deriro_private.err('FORBIDDEN'); end if;
      if actor.kind = 'vehicle' and not parked then return deriro_private.err('FORBIDDEN'); end if;
      if pickup.status <> 'arrived' then return deriro_private.err('INVALID_STATE'); end if;
      update public.pickups set status = 'completed', completed_at = now(),
        completed_by_kind=case when actor.kind='member' then 'guardian' else actor.kind end
        where id = pickup.id returning * into pickup;
      event_type := 'completed';

    when 'cancel' then
      if actor.kind <> 'member' and not is_requester then return deriro_private.err('FORBIDDEN'); end if;
      reason := case reason when 'phone_resolved' then 'resolved_by_phone' when 'misclick' then 'mistake'
        when 'other_transport' then 'other_way_home' else reason end;
      if actor.kind='rider' and reason='cancelled' then reason := 'child_cancelled'; end if;
      if reason not in ('cancelled','skipped','not_met','resolved_by_phone','mistake','other_way_home','other','child_cancelled')
        or (reason='child_cancelled' and actor.kind<>'rider')
      then return deriro_private.err('VALIDATION'); end if;
      if reason = 'skipped' and (actor.kind <> 'member' or pickup.source <> 'routine' or pickup.status not in ('open','assigned')) then
        return deriro_private.err('INVALID_STATE');
      end if;
      if pickup.status not in ('open', 'assigned', 'en_route', 'arrived')
        or (pickup.status = 'arrived' and (actor.kind <> 'member' or reason <> 'not_met'))
        or (actor.kind = 'rider' and pickup.source <> 'request')
      then return deriro_private.err('INVALID_STATE'); end if;
      perform deriro_private.resolve_offer(offer.id, 'cancelled');
      update public.pickups set status = 'cancelled', cancelled_at = now(), cancel_reason = reason,is_customized = true,
        cancelled_by_kind=case when actor.kind='member' then 'guardian' else actor.kind end
        where id = pickup.id returning * into pickup;
      event_type := 'cancelled';

    when 'confirm_location' then
      if actor.kind <> 'member' and (actor.kind <> 'vehicle' or not is_driver or not parked) then
        return deriro_private.err('FORBIDDEN');
      end if;
      if pickup.status not in ('open', 'assigned', 'en_route', 'arrived') then return deriro_private.err('INVALID_STATE'); end if;
      if location_place_id is not null then
        select * into place from public.places pl where pl.id = location_place_id and pl.family_id = pickup.family_id and pl.archived_at is null;
        if not found then return deriro_private.err('NOT_FOUND'); end if;
      end if;
      latitude := coalesce(place.lat, (p_input->>'lat')::double precision);
      longitude := coalesce(place.lng, (p_input->>'lng')::double precision);
      label := btrim(coalesce(place.label, p_input->>'label'));
      if latitude is null or longitude is null or not (latitude between -90 and 90 and longitude between -180 and 180)
        or label is null or char_length(label) not between 1 and 40
      then return deriro_private.err('VALIDATION', '{"field":"location"}'); end if;
      if pickup.location_confirmed and row(pickup.dest_lat, pickup.dest_lng, pickup.dest_label, pickup.place_id)
        is not distinct from row(latitude, longitude, label, location_place_id)
      then return deriro_private.pickup_result(pickup); end if;
      update public.pickups set location_confirmed = true, dest_lat = latitude, dest_lng = longitude, dest_label = label,
        place_id = location_place_id, pickup_point_id = null, pin_note = null,
        location_source = case when location_place_id is null then 'gps'::public.location_source else 'saved_place'::public.location_source end,
        is_customized = true where id = pickup.id returning * into pickup;
      event_type := 'location_confirmed';

    when 'ready' then
      if not is_requester then return deriro_private.err('FORBIDDEN'); end if;
      if pickup.source <> 'routine' or pickup.status not in ('open', 'assigned') then return deriro_private.err('INVALID_STATE'); end if;
      if pickup.rider_ready_at is not null then return deriro_private.pickup_result(pickup); end if;
      update public.pickups set rider_ready_at = now() where id = pickup.id returning * into pickup;
      if pickup.status = 'open' and offer.id is null and pickup.routine_offer_created_at is null then
        insert into public.pickup_offers(family_id, pickup_id, origin, expires_at)
          values (pickup.family_id, pickup.id, 'routine', greatest(pickup.wanted_at, now() + interval '10 minutes'));
        update public.pickups set routine_offer_created_at=now() where id=pickup.id returning * into pickup;
      end if;
      event_type := 'rider_ready';

    when 'not_met' then
      if not is_requester then return deriro_private.err('FORBIDDEN'); end if;
      if pickup.status <> 'arrived' then return deriro_private.err('INVALID_STATE'); end if;
      if pickup.not_met_reported_at > now() - interval '5 minutes' then return deriro_private.err('RATE_LIMITED'); end if;
      update public.pickups set not_met_reported_at = now() where id = pickup.id returning * into pickup;
      event_type := 'not_met_reported';

    else
      return deriro_private.err('VALIDATION');
  end case;

  if pickup.status in ('completed', 'cancelled') then
    update public.vehicles set active_pickup_id = null, active_nav_session_id = null, active_destination_revision = null
      where id = pickup.vehicle_id and active_pickup_id = pickup.id;
  end if;
  perform deriro_private.add_event(pickup, actor, event_type, jsonb_strip_nulls(jsonb_build_object(
    'vehicle_id',selected_vehicle_id,'previous_assignee_id',previous_assignee_id)));
  return deriro_private.pickup_result(pickup);
exception
  when numeric_value_out_of_range or invalid_text_representation then
    return deriro_private.err('VALIDATION');
end
$$;

-- Public RPC signatures are invoker wrappers around the restricted private dispatchers.
create function public.member_create_request(p_wanted_in_min int default 0, p_place_id uuid default null, p_pickup_point_id uuid default null,
  p_pin jsonb default null, p_gps jsonb default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.create_request('member', p_wanted_in_min, p_place_id, p_pickup_point_id, p_pin, p_gps) $$;

create function public.rider_create_request(p_wanted_in_min int default 0, p_place_id uuid default null, p_pickup_point_id uuid default null,
  p_pin jsonb default null, p_gps jsonb default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.create_request('rider', p_wanted_in_min, p_place_id, p_pickup_point_id, p_pin, p_gps) $$;

create function public.accept_pickup(p_pickup_id uuid, p_vehicle_id uuid default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.transition('accept', p_pickup_id, null,
    jsonb_build_object('vehicle_id', p_vehicle_id)) $$;

create function public.offer_pickup(p_pickup_id uuid, p_expected_version int, p_to_member_id uuid default null, p_note text default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.transition('offer', p_pickup_id, p_expected_version,
    jsonb_build_object('to_member_id', p_to_member_id, 'note', p_note)) $$;

create function public.respond_offer(p_offer_id uuid, p_response text, p_expected_version int, p_vehicle_id uuid default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.transition('respond_offer', null, p_expected_version,
    jsonb_build_object('offer_id', p_offer_id, 'response', p_response, 'vehicle_id', p_vehicle_id)) $$;

create function public.cancel_offer(p_offer_id uuid, p_expected_version int)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.transition('cancel_offer', null, p_expected_version,
    jsonb_build_object('offer_id', p_offer_id)) $$;

create function public.take_over(p_pickup_id uuid, p_expected_version int, p_vehicle_id uuid default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.transition('take_over', p_pickup_id, p_expected_version,
    jsonb_build_object('vehicle_id', p_vehicle_id)) $$;

create function public.mark_en_route(p_pickup_id uuid, p_expected_version int)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.transition('depart', p_pickup_id, p_expected_version,
    '{}') $$;

create function public.vehicle_start_now(p_pickup_id uuid, p_expected_version int, p_action_id uuid, p_offer_id uuid default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.transition('vehicle_start', p_pickup_id, p_expected_version,
    jsonb_build_object('action_id', p_action_id, 'offer_id', p_offer_id)) $$;

create function public.mark_arrived(p_pickup_id uuid, p_source text, p_nav_session_id uuid default null,
  p_destination_revision int default null, p_expected_version int default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.transition('arrive', p_pickup_id, p_expected_version,
    jsonb_build_object('source', p_source, 'nav_session_id', p_nav_session_id, 'destination_revision', p_destination_revision)) $$;

create function public.report_nav_result(p_pickup_id uuid, p_nav_session_id uuid, p_result text,p_error_code text default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.transition('nav_result', p_pickup_id, null,
    jsonb_build_object('nav_session_id', p_nav_session_id, 'response', p_result,'error_code',p_error_code)) $$;

create function public.mark_completed(p_pickup_id uuid, p_expected_version int)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.transition('board', p_pickup_id, p_expected_version,
    '{}') $$;

create function public.cancel_pickup(p_pickup_id uuid, p_expected_version int, p_reason text default 'cancelled')
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.transition('cancel', p_pickup_id, p_expected_version,
    jsonb_build_object('reason', p_reason)) $$;

create function public.confirm_location(p_pickup_id uuid, p_expected_version int, p_lat double precision,
  p_lng double precision, p_label text, p_place_id uuid default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.transition('confirm_location', p_pickup_id, p_expected_version,
    jsonb_build_object('lat', p_lat, 'lng', p_lng, 'label', p_label, 'place_id', p_place_id)) $$;

create function public.rider_ready_early(p_pickup_id uuid, p_expected_version int)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.transition('ready', p_pickup_id, p_expected_version,
    '{}') $$;

create function public.rider_report_not_met(p_pickup_id uuid, p_expected_version int)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.transition('not_met', p_pickup_id, p_expected_version,
    '{}') $$;

-- Revoke privileges on these objects explicitly for projects with legacy default grants.
revoke execute on all functions in schema deriro_private from public, anon, authenticated, service_role;
grant execute on function deriro_private.member_family(), deriro_private.member_id(boolean) to authenticated;
revoke execute on function
  deriro_private.create_request(text, int, uuid, uuid, jsonb, jsonb),
  deriro_private.transition(text, uuid, int, jsonb),
  public.member_create_request(int, uuid, uuid, jsonb, jsonb),
  public.rider_create_request(int, uuid, uuid, jsonb, jsonb),
  public.accept_pickup(uuid, uuid),
  public.offer_pickup(uuid, int, uuid, text),
  public.respond_offer(uuid, text, int, uuid),
  public.cancel_offer(uuid, int),
  public.take_over(uuid, int, uuid),
  public.mark_en_route(uuid, int),
  public.vehicle_start_now(uuid, int, uuid, uuid),
  public.mark_arrived(uuid, text, uuid, int, int),
  public.report_nav_result(uuid, uuid, text, text),
  public.mark_completed(uuid, int),
  public.cancel_pickup(uuid, int, text),
  public.confirm_location(uuid, int, double precision, double precision, text, uuid),
  public.rider_ready_early(uuid, int),
  public.rider_report_not_met(uuid, int)
  from public, anon, authenticated, service_role;
grant execute on function
  deriro_private.create_request(text, int, uuid, uuid, jsonb, jsonb),
  deriro_private.transition(text, uuid, int, jsonb),
  public.member_create_request(int, uuid, uuid, jsonb, jsonb),
  public.rider_create_request(int, uuid, uuid, jsonb, jsonb),
  public.accept_pickup(uuid, uuid),
  public.offer_pickup(uuid, int, uuid, text),
  public.respond_offer(uuid, text, int, uuid),
  public.cancel_offer(uuid, int),
  public.take_over(uuid, int, uuid),
  public.mark_en_route(uuid, int),
  public.vehicle_start_now(uuid, int, uuid, uuid),
  public.mark_arrived(uuid, text, uuid, int, int),
  public.report_nav_result(uuid, uuid, text, text),
  public.mark_completed(uuid, int),
  public.cancel_pickup(uuid, int, text),
  public.confirm_location(uuid, int, double precision, double precision, text, uuid),
  public.rider_ready_early(uuid, int),
  public.rider_report_not_met(uuid, int)
  to authenticated;
