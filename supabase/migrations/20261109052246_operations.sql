-- Places, routines, feeds and vehicle telemetry RPCs. Tables live in the foundation migration.
create function deriro_private.rider_name(p_pickup public.pickups)
returns text language sql stable set search_path = '' as $$
  select coalesce(
    (select r.display_name from public.riders r where r.id = p_pickup.rider_id),
    (select m.display_name from public.family_members m where m.id = p_pickup.rider_member_id))
$$;

create function deriro_private.member_name(p_member_id uuid)
returns text language sql stable set search_path = '' as $$
  select display_name from public.family_members where id = p_member_id
$$;

create function deriro_private.pickup_feed_row(p_pickup public.pickups)
returns jsonb language sql stable set search_path = '' as $$
  select deriro_private.safe_pickup(p_pickup) || jsonb_build_object(
    'rider_name',deriro_private.rider_name(p_pickup),
    'child_name',deriro_private.rider_name(p_pickup),
    'assignee_display_name',deriro_private.member_name(p_pickup.assignee_member_id))
$$;

-- Guardian feeds (get_today, get_pickup) add what 24.5 shows: "갈 사람 없음", who cannot drive on the pickup's date
-- (P-06), the place's "못 갈 때 안내" for the P-18 sheet, and who declared that nobody can go.
create function deriro_private.guardian_feed_row(p_pickup public.pickups)
returns jsonb language sql stable set search_path = '' as $$
  select deriro_private.pickup_feed_row(p_pickup) || jsonb_build_object(
    'no_available_driver',p_pickup.status = 'open' and cardinality(deriro_private.available_drivers(p_pickup)) = 0,
    'unavailable_member_ids',coalesce((select jsonb_agg(u.member_id order by u.member_id) from public.member_unavailable_days u
      join public.families f on f.id = u.family_id
      join public.family_members m on m.id = u.member_id and m.left_at is null
      where u.family_id = p_pickup.family_id and u.day = (p_pickup.wanted_at at time zone f.timezone)::date),'[]'),
    'place_fallback_note',(select pl.fallback_note from public.places pl where pl.id = p_pickup.place_id),
    'fallback_by_name',deriro_private.member_name(p_pickup.fallback_by_member_id))
$$;

-- 24.5: the vehicle feed does not change. A no_driver pickup reaches the car as an ordinary cancellation.
create function deriro_private.vehicle_feed_row(p_pickup public.pickups)
returns jsonb language sql stable set search_path = '' as $$
  select deriro_private.pickup_feed_row(p_pickup) - array['fallback_note','fallback_by_member_id','fallback_ack_at']
$$;

create function deriro_private.active_status(p_status public.pickup_status)
returns boolean language sql immutable set search_path = '' as $$
  select p_status in ('open','assigned','en_route','arrived')
$$;

-- F-16 / A.2: required distance is an estimate. "sufficient" needs every pickup computed and a range
-- reading that is not stale (6 hours, the P-06 freshness rule). A shortage can still be reported from a
-- reading up to 24 hours old (A.3), because warning early is the safe direction.
create function deriro_private.range_summary(p_vehicle public.vehicles, p_pickup public.pickups default null)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  telemetry public.vehicle_states;
  base_lat double precision;
  base_lng double precision;
  origin text;
  total int;
  computable int;
  ids uuid[];
  km double precision;
  known_range double precision;
  stale boolean;
begin
  select * into telemetry from public.vehicle_states s where s.vehicle_id = p_vehicle.id;
  if telemetry.location_at >= now() - interval '30 minutes' then
    base_lat := telemetry.lat;
    base_lng := telemetry.lng;
    origin := 'vehicle';
  else
    select p.lat,p.lng into base_lat,base_lng from public.places p
      where p.family_id = p_vehicle.family_id and p.kind = 'home' and p.archived_at is null order by p.id limit 1;
    if found then origin := 'home'; end if;
  end if;

  select count(*)::int,coalesce(array_agg(p.id order by p.id),'{}'),
    sum(deriro_private.distance_m(base_lat,base_lng,p.dest_lat,p.dest_lng) * 0.0026)
    into total,ids,km
    from public.pickups p where p.family_id = p_vehicle.family_id and (
      (p_pickup.id is not null and p.id = p_pickup.id) or
      (p_pickup.id is null and p.vehicle_id = p_vehicle.id and p.status = 'assigned'
        and p.wanted_at between now() and now()+interval '24 hours')
    );
  -- One origin serves every pickup, so either all of them are computable or none is.
  computable := case when origin is null then 0 else total end;
  if telemetry.collected_at >= now() - interval '24 hours' then known_range := telemetry.range_km; end if;
  stale := coalesce(telemetry.collected_at < now() - interval '6 hours', true);
  return jsonb_build_object('required_km',round(km::numeric,1),'computable',computable,
    'total',total,'origin_source',origin,'pickup_ids',to_jsonb(ids),'range_km',known_range,'is_demo_value',coalesce(telemetry.is_demo_value,false),
    'is_stale',stale,
    'verdict',case when total = 0 or computable = 0 or known_range is null or km is null then 'check_required'
      when known_range < km + greatest(15,km * 0.2) then 'low'
      when computable = total and not stale then 'sufficient'
      else 'check_required' end);
end
$$;

-- A.3. Missing or day-old telemetry neither creates nor closes a warning. With no assignment in the window
-- the warning closes. A warning closes otherwise only on a "sufficient" verdict, which needs fresh data.
create function deriro_private.recompute_low_range(p_vehicle_id uuid)
returns jsonb language plpgsql set search_path = '' as $$
declare
  vehicle public.vehicles;
  telemetry public.vehicle_states;
  summary jsonb;
  alert public.vehicle_alerts;
  needed double precision;
  available double precision;
  ids uuid[];
begin
  select * into vehicle from public.vehicles where id = p_vehicle_id and revoked_at is null;
  if not found then return null; end if;
  select * into telemetry from public.vehicle_states s where s.vehicle_id = vehicle.id;
  if telemetry.vehicle_id is null or telemetry.range_km is null or telemetry.collected_at < now() - interval '24 hours' then
    return null;
  end if;
  summary := deriro_private.range_summary(vehicle);
  if summary->>'verdict' <> 'low' then
    if summary->>'verdict' = 'sufficient' or (summary->>'total')::int = 0 then
      update public.vehicle_alerts set resolved_at = now(),updated_at = now() where vehicle_id = vehicle.id and resolved_at is null;
    end if;
    return null;
  end if;
  needed := (summary->>'required_km')::double precision;
  available := (summary->>'range_km')::double precision;
  select array_agg(value::uuid order by value) into ids from jsonb_array_elements_text(summary->'pickup_ids');
  insert into public.vehicle_alerts as a(family_id,vehicle_id,range_km,required_km,pickup_count,pickup_ids,is_demo_value)
    values(vehicle.family_id,vehicle.id,available,needed,cardinality(ids),ids,(summary->>'is_demo_value')::boolean)
  on conflict (vehicle_id) where resolved_at is null do update set
    range_km = excluded.range_km, required_km = excluded.required_km, pickup_count = excluded.pickup_count,
    pickup_ids = excluded.pickup_ids, is_demo_value = excluded.is_demo_value,
    alert_revision = case when a.pickup_ids is distinct from excluded.pickup_ids then a.alert_revision+1 else a.alert_revision end,
    acknowledged_at = case when a.pickup_ids is distinct from excluded.pickup_ids then null else a.acknowledged_at end,
    updated_at = case when a.pickup_ids is distinct from excluded.pickup_ids then now() else a.updated_at end
  returning * into alert;
  return to_jsonb(alert);
end
$$;

create function deriro_private.ensure_occurrences(p_family_id uuid,p_days int)
returns int language plpgsql set search_path = '' as $$
declare
  added int;
begin
  insert into public.pickups(family_id,rider_id,rider_member_id,source,routine_id,occurrence_date,status,assignment_round,
    assignee_member_id,vehicle_id,place_id,pickup_point_id,location_source,location_confirmed,dest_lat,dest_lng,dest_label,pin_note,wanted_at)
  select r.family_id,r.rider_id,r.rider_member_id,'routine',r.id,day.value::date,
    case when holder.id is null then 'open'::public.pickup_status else 'assigned'::public.pickup_status end,
    case when holder.id is null then 0 else 1 end,holder.id,case when holder.id is not null then vehicle.id end,r.place_id,point.id,
    case when point.id is null then 'saved_place'::public.location_source else 'saved_point'::public.location_source end,
    true,coalesce(point.lat,p.lat),coalesce(point.lng,p.lng),coalesce(point.label,p.label),point.note,
    (day.value::date + r.time_local) at time zone f.timezone
  from public.routines r
  join public.families f on f.id = r.family_id
  join public.places p on (p.family_id,p.id) = (r.family_id,r.place_id) and p.archived_at is null
  left join public.pickup_points point on (point.family_id,point.place_id,point.id) = (r.family_id,r.place_id,r.pickup_point_id) and point.archived_at is null
  left join public.family_members driver on (driver.family_id,driver.id) = (r.family_id,r.default_assignee_member_id)
    and driver.left_at is null and driver.can_drive and driver.id is distinct from r.rider_member_id
  left join public.vehicles vehicle on (vehicle.family_id,vehicle.id) = (r.family_id,r.default_vehicle_id)
    and vehicle.revoked_at is null and vehicle.current_driver_member_id = driver.id
  cross join lateral generate_series((now() at time zone f.timezone)::date,
    (now() at time zone f.timezone)::date + p_days - 1, interval '1 day') as day(value)
  -- 24.3: on the default driver's "못 가는 날" the occurrence is open. Nobody else is assigned automatically.
  cross join lateral (select case when not exists(select 1 from public.member_unavailable_days u
    where u.member_id = driver.id and u.day = day.value::date) then driver.id end as id) as holder
  where (p_family_id is null or r.family_id = p_family_id) and r.active and r.archived_at is null
    and (r.pickup_point_id is null or point.id is not null)
    and day.value::date >= r.start_date and (r.end_date is null or day.value::date <= r.end_date)
    and (r.weekdays & (1 << (extract(isodow from day.value)::int - 1))) <> 0
    and (day.value::date + r.time_local) at time zone f.timezone >= now()
    and (r.rider_id is null or exists(select 1 from public.riders rr where rr.id = r.rider_id and rr.archived_at is null))
    and (r.rider_member_id is null or exists(select 1 from public.family_members mm where mm.id = r.rider_member_id and mm.left_at is null))
  on conflict (routine_id,occurrence_date) do nothing;
  get diagnostics added = row_count;
  return added;
end
$$;

create function deriro_private.revise_routine()
returns trigger language plpgsql set search_path = '' as $$
declare
  place public.places;
  point public.pickup_points;
  occurrence public.pickups;
  effective_at timestamptz;
  tz text;
  driver_id uuid;
  car_id uuid;
  previous_assignee_id uuid;
  previous_status public.pickup_status;
  occurrence_driver_id uuid;
  occurrence_car_id uuid;
begin
  if new is not distinct from old then return new; end if;
  if not new.active and new.archived_at is null then return new; end if;
  select timezone into tz from public.families where id = new.family_id;
  select * into place from public.places where id = new.place_id and archived_at is null;
  select * into point from public.pickup_points where id = new.pickup_point_id and archived_at is null;
  -- The default driver takes a revised occurrence only while still eligible, by the same rule as ensure_occurrences.
  -- A default whose can_drive was turned off must not become the assignee of a trip they never accepted (23.1).
  select m.id into driver_id from public.family_members m where m.family_id = new.family_id
    and m.id = new.default_assignee_member_id and m.left_at is null and m.can_drive and m.id is distinct from new.rider_member_id;
  select v.id into car_id from public.vehicles v where v.family_id = new.family_id and v.id = new.default_vehicle_id
    and v.revoked_at is null and v.current_driver_member_id = driver_id;
  for occurrence in select * from public.pickups p
    where p.routine_id = new.id and not p.is_customized and p.wanted_at >= now()
      and p.status in ('open','assigned') order by p.id for update
  loop
    effective_at := (occurrence.occurrence_date + new.time_local) at time zone tz;
    if new.archived_at is not null or not new.active or place.id is null or (new.pickup_point_id is not null and point.id is null)
      or occurrence.occurrence_date < new.start_date or occurrence.occurrence_date > new.end_date
      or (new.weekdays & (1 << (extract(isodow from occurrence.occurrence_date)::int - 1))) = 0
      or effective_at < now()
    then
      update public.pickup_offers set status = 'cancelled',resolved_at = now() where pickup_id = occurrence.id and status = 'pending';
      update public.pickups set status = 'cancelled',cancelled_at = now(),cancel_reason = 'routine_archived',cancelled_by_kind = 'system'
        where id = occurrence.id returning * into occurrence;
      -- A system cancellation (F-14) is still a transition with an event (4.5), so a default assignee who was
      -- already reminded about the trip is told it is off.
      perform deriro_private.add_event(occurrence, null, 'cancelled', jsonb_build_object('cause',
        case when new.archived_at is not null then 'routine_archived' else 'routine_changed' end));
    else
      -- 24.3: on the default driver's "못 가는 날" the occurrence stays open, as ensure_occurrences creates it.
      if exists(select 1 from public.member_unavailable_days u where u.member_id = driver_id and u.day = occurrence.occurrence_date) then
        occurrence_driver_id := null;
        occurrence_car_id := null;
      else
        occurrence_driver_id := driver_id;
        occurrence_car_id := car_id;
      end if;
      previous_assignee_id := occurrence.assignee_member_id;
      previous_status := occurrence.status;
      -- A pending family-wide routine offer asked for a driver while nobody held the trip. When the recompute gives the
      -- occurrence another holder (open to assigned, assigned to open, or a different default driver), the system
      -- withdraws that offer (4.4 cancelled; superseded is only for a newer offer, 4.4 #1).
      if previous_assignee_id is distinct from occurrence_driver_id then
        update public.pickup_offers set status = 'cancelled',resolved_at = now() where pickup_id = occurrence.id and status = 'pending';
      end if;
      update public.pickups set status = case when occurrence_driver_id is null then 'open'::public.pickup_status else 'assigned'::public.pickup_status end,
        rider_id = new.rider_id,rider_member_id = new.rider_member_id,assignee_member_id = occurrence_driver_id,
        vehicle_id = occurrence_car_id,
        place_id = new.place_id,pickup_point_id = point.id,location_source = case when point.id is null
          then 'saved_place'::public.location_source else 'saved_point'::public.location_source end,
        location_confirmed = true,dest_lat = coalesce(point.lat,place.lat),dest_lng = coalesce(point.lng,place.lng),
        dest_label = coalesce(point.label,place.label),pin_note = point.note,wanted_at = effective_at,cancelled_at = null,cancel_reason = null
        where id = occurrence.id returning * into occurrence;
      -- A new holder is a transition and gets an event (4.5). The event queues no notice, so a routine edit does not
      -- push the family per occurrence: the scheduler reminds a new default driver and announces an open occurrence at
      -- most once (A.4, routine_offer_created_at is kept).
      if previous_assignee_id is distinct from occurrence_driver_id then
        perform deriro_private.add_event(occurrence, null, 'routine_reassigned', jsonb_strip_nulls(jsonb_build_object(
          'previous_assignee_id', previous_assignee_id, 'previous_status', previous_status, 'cause', 'routine_changed')));
      end if;
    end if;
  end loop;
  if new.active and new.archived_at is null then perform deriro_private.ensure_occurrences(new.family_id,2); end if;
  return new;
end
$$;
create trigger revise_routine after update on public.routines for each row execute function deriro_private.revise_routine();

create function deriro_private.manage_schedule(p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor deriro_private.actor := deriro_private.current_actor();
  id_arg uuid := (p_data->>'id')::uuid;
  place_id_arg uuid := (p_data->>'place_id')::uuid;
  point_id_arg uuid := (p_data->>'point_id')::uuid;
  rider_id_arg uuid := (p_data->>'rider_id')::uuid;
  member_id_arg uuid := (p_data->>'rider_member_id')::uuid;
  driver_id_arg uuid := (p_data->>'driver_id')::uuid;
  vehicle_id_arg uuid := (p_data->>'vehicle_id')::uuid;
  label_arg text := nullif(btrim(p_data->>'label'),'');
  note_arg text := nullif(btrim(p_data->>'note'),'');
  kind_arg text := p_data->>'kind';
  lat_arg double precision := (p_data->>'lat')::double precision;
  lng_arg double precision := (p_data->>'lng')::double precision;
  radius_arg int := (p_data->>'radius')::int;
  days_arg int := (p_data->>'days')::int;
  place public.places;
  point public.pickup_points;
  routine public.routines;
  occurrence public.pickups;
  week_arg smallint := (p_data->>'weekdays')::smallint;
  time_arg time := (p_data->>'time')::time;
  notify_arg int := (p_data->>'notify_before')::int;
  start_arg date := coalesce((p_data->>'start_date')::date,(now() at time zone 'Asia/Seoul')::date);
  end_arg date := (p_data->>'end_date')::date;
  active_arg boolean := coalesce((p_data->>'active')::boolean,true);
  -- upsert_place: null keeps the current "못 갈 때 안내" (a new place has none), an empty or blank line clears it.
  fallback_given boolean := p_data->>'fallback_note' is not null;
  fallback_arg text := nullif(deriro_private.trim_note(p_data->>'fallback_note'),'');
  day_arg date := (p_data->>'day')::date;
  unavailable_arg boolean := (p_data->>'unavailable')::boolean;
  tz text;
  today_local date;
  next_driver uuid;
  next_car uuid;
  previous_assignee uuid;
  previous_state public.pickup_status;
  blockers jsonb;
  violated text;
begin
  if auth.uid() is null then return deriro_private.err('NOT_AUTHENTICATED'); end if;
  if actor.kind is distinct from 'member' then return deriro_private.err('NOT_GUARDIAN'); end if;
  perform 1 from public.families where id=actor.family_id for key share;
  if not found then return deriro_private.err('NOT_FOUND'); end if;
  if p_action = 'set_unavailable_day' then
    -- 24.3 못 가는 날: a guardian who can drive marks or clears one of their own days, today to 60 days ahead (family time
    -- zone). Trips already held stay held. An untouched (not customized) upcoming occurrence on that day follows the change
    -- (4.4 #12, routine_reassigned without a notice): marking reopens the member's default assignment, clearing gives
    -- back an open one whose routine default is the member, unless the family-wide offer was already made.
    if not coalesce(actor.can_drive,false) then return deriro_private.err('FORBIDDEN'); end if;
    select f.timezone into tz from public.families f where f.id=actor.family_id;
    today_local := (now() at time zone tz)::date;
    if day_arg is null or unavailable_arg is null or day_arg < today_local or day_arg > today_local + 60 then
      return deriro_private.err('VALIDATION');
    end if;
    if unavailable_arg then
      insert into public.member_unavailable_days(family_id,member_id,day) values(actor.family_id,actor.member_id,day_arg)
        on conflict do nothing;
    else
      delete from public.member_unavailable_days where member_id=actor.member_id and day=day_arg;
    end if;
    for occurrence in select p.* from public.pickups p where p.family_id=actor.family_id and p.source='routine'
      and not p.is_customized and p.wanted_at>=now() and p.status in ('open','assigned')
      and (p.wanted_at at time zone tz)::date=day_arg order by p.id for update
    loop
      if unavailable_arg then
        continue when occurrence.status<>'assigned' or occurrence.assignee_member_id is distinct from actor.member_id;
        next_driver := null;
        next_car := null;
      else
        continue when occurrence.status<>'open' or occurrence.routine_offer_created_at is not null;
        select * into routine from public.routines r where r.id=occurrence.routine_id;
        continue when routine.default_assignee_member_id is distinct from actor.member_id
          or not deriro_private.eligible_driver(actor.family_id,actor.member_id,occurrence.rider_member_id);
        next_driver := actor.member_id;
        next_car := (select v.id from public.vehicles v where v.family_id=actor.family_id and v.id=routine.default_vehicle_id
          and v.revoked_at is null and v.current_driver_member_id=actor.member_id);
      end if;
      previous_assignee := occurrence.assignee_member_id;
      previous_state := occurrence.status;
      update public.pickup_offers set status='cancelled',resolved_at=now() where pickup_id=occurrence.id and status='pending';
      update public.pickups set status=case when next_driver is null then 'open'::public.pickup_status else 'assigned'::public.pickup_status end,
        assignee_member_id=next_driver,vehicle_id=next_car where id=occurrence.id returning * into occurrence;
      perform deriro_private.add_event(occurrence,actor,'routine_reassigned',jsonb_strip_nulls(jsonb_build_object(
        'previous_assignee_id',previous_assignee,'previous_status',previous_state,
        'cause',case when unavailable_arg then 'unavailable_day' else 'unavailable_day_cleared' end)));
    end loop;
    return deriro_private.ok(jsonb_build_object(
      'days',coalesce((select jsonb_agg(jsonb_build_object('member_id',u.member_id,'day',u.day) order by u.day,u.member_id)
        from public.member_unavailable_days u join public.family_members m on m.id=u.member_id and m.left_at is null
        where u.family_id=actor.family_id and u.day between today_local and today_local+60),'[]'),
      'held_pickup_ids',coalesce((select jsonb_agg(p.id order by p.wanted_at,p.id) from public.pickups p
        where p.family_id=actor.family_id and p.assignee_member_id=actor.member_id and p.status in ('assigned','en_route','arrived')
          and (p.wanted_at at time zone tz)::date=day_arg),'[]')));
  end if;
  if p_action in ('upsert_place','upsert_pickup_point') and
    (label_arg is null or char_length(label_arg) > case when p_action = 'upsert_place' then 40 else 20 end
      or lat_arg is null or lng_arg is null or not (lat_arg between -90 and 90 and lng_arg between -180 and 180))
  then return deriro_private.err('VALIDATION'); end if;
  if p_action in ('upsert_place','archive_place') then
    if id_arg is not null then
      select * into place from public.places p where p.id=id_arg and p.family_id=actor.family_id and p.archived_at is null for update;
      if not found then return deriro_private.err('NOT_FOUND'); end if;
    end if;
    if p_action = 'archive_place' then
      if place.id is null then return deriro_private.err('NOT_FOUND'); end if;
      select jsonb_agg(r.id) into blockers from public.routines r where r.place_id=place.id and r.archived_at is null and r.active;
      if blockers is not null then return deriro_private.err('FORBIDDEN',jsonb_build_object('routines',blockers)); end if;
      update public.places set archived_at=now() where id=place.id;
      update public.pickup_points set archived_at=now() where place_id=place.id and archived_at is null;
      return deriro_private.ok('{}');
    end if;
    if kind_arg is null or kind_arg not in ('home','school','academy','other') or radius_arg is null or radius_arg not between 50 and 500
      or char_length(fallback_arg) > 40
      then return deriro_private.err('VALIDATION'); end if;
    if place.id is null then
      insert into public.places(family_id,label,kind,lat,lng,radius_m,fallback_note)
        values(actor.family_id,label_arg,kind_arg,lat_arg,lng_arg,radius_arg,fallback_arg)
        returning * into place;
    else
      update public.places set label=label_arg,kind=kind_arg,lat=lat_arg,lng=lng_arg,radius_m=radius_arg,
        fallback_note=case when fallback_given then fallback_arg else place.fallback_note end where id=place.id returning * into place;
    end if;
    return deriro_private.ok(jsonb_build_object('place',to_jsonb(place)));
  end if;
  if p_action in ('upsert_pickup_point','archive_pickup_point') then
    if id_arg is not null then
      select * into point from public.pickup_points p where p.id=id_arg and p.family_id=actor.family_id and p.archived_at is null for update;
      if not found then return deriro_private.err('NOT_FOUND'); end if;
    end if;
    if p_action = 'archive_pickup_point' then
      if point.id is null then return deriro_private.err('NOT_FOUND'); end if;
      select jsonb_agg(r.id) into blockers from public.routines r where r.pickup_point_id=point.id and r.archived_at is null and r.active;
      if blockers is not null then return deriro_private.err('FORBIDDEN',jsonb_build_object('routines',blockers)); end if;
      update public.pickup_points set archived_at=now() where id=point.id;
      return deriro_private.ok('{}');
    end if;
    if char_length(note_arg)>40 then return deriro_private.err('VALIDATION'); end if;
    select * into place from public.places p where p.id=place_id_arg and p.family_id=actor.family_id and p.archived_at is null for share;
    if not found or (point.id is not null and point.place_id<>place.id) then return deriro_private.err('NOT_FOUND'); end if;
    if point.id is null then
      insert into public.pickup_points(family_id,place_id,label,lat,lng,note) values(actor.family_id,place.id,label_arg,lat_arg,lng_arg,note_arg)
        returning * into point;
    else
      update public.pickup_points set label=label_arg,lat=lat_arg,lng=lng_arg,note=note_arg where id=point.id returning * into point;
    end if;
    return deriro_private.ok(jsonb_build_object('pickup_point',to_jsonb(point)));
  end if;
  if p_action = 'ensure_occurrences' then
    if days_arg is null or days_arg not between 1 and 7 then return deriro_private.err('VALIDATION'); end if;
    return deriro_private.ok(jsonb_build_object('created',deriro_private.ensure_occurrences(actor.family_id,days_arg)));
  end if;
  if p_action not in ('archive_routine','upsert_routine') then return deriro_private.err('VALIDATION'); end if;
  if id_arg is not null then
    select * into routine from public.routines r where r.id=id_arg and r.family_id=actor.family_id and r.archived_at is null for update;
    if not found then return deriro_private.err('NOT_FOUND'); end if;
  end if;
  if p_action = 'archive_routine' then
    if routine.id is null then return deriro_private.err('NOT_FOUND'); end if;
    update public.routines set archived_at=now(),active=false where id=routine.id;
    return deriro_private.ok('{}');
  end if;
  if num_nonnulls(rider_id_arg,member_id_arg)<>1 or week_arg is null or week_arg not between 1 and 127 or time_arg is null
    or notify_arg is null or notify_arg not between 5 and 120 or end_arg < start_arg
  then return deriro_private.err('VALIDATION'); end if;
  if rider_id_arg is not null and not exists(select 1 from public.riders r where r.id=rider_id_arg and r.family_id=actor.family_id and r.archived_at is null)
    then return deriro_private.err('NOT_FOUND'); end if;
  if member_id_arg is not null and not exists(select 1 from public.family_members m where m.id=member_id_arg and m.family_id=actor.family_id and m.left_at is null)
    then return deriro_private.err('NOT_FOUND'); end if;
  select * into place from public.places p where p.id=place_id_arg and p.family_id=actor.family_id and p.archived_at is null for share;
  if not found then return deriro_private.err('NOT_FOUND'); end if;
  if point_id_arg is not null and not exists(select 1 from public.pickup_points p
    where p.id=point_id_arg and p.place_id=place.id and p.family_id=actor.family_id and p.archived_at is null)
    then return deriro_private.err('NOT_FOUND'); end if;
  if driver_id_arg is not null and not deriro_private.eligible_driver(actor.family_id,driver_id_arg,member_id_arg)
    then return deriro_private.err('NOT_FOUND'); end if;
  if not deriro_private.selected_vehicle(actor.family_id,driver_id_arg,vehicle_id_arg) then return deriro_private.err('NOT_FOUND'); end if;
  if routine.id is null then
    insert into public.routines(family_id,rider_id,rider_member_id,place_id,pickup_point_id,weekdays,time_local,notify_before_min,
      default_assignee_member_id,default_vehicle_id,start_date,end_date,active)
      values(actor.family_id,rider_id_arg,member_id_arg,place.id,point_id_arg,week_arg,time_arg,notify_arg,driver_id_arg,vehicle_id_arg,start_arg,end_arg,active_arg)
      returning * into routine;
    perform deriro_private.ensure_occurrences(actor.family_id,2);
  else
    if not active_arg and coalesce((p_data->>'cancel_future')::boolean,false) then
      perform 1 from public.pickups p where p.routine_id=routine.id and p.wanted_at>=now()
        and p.status in ('open','assigned') order by p.id for update;
      update public.pickup_offers set status='cancelled',resolved_at=now()
        where status='pending' and pickup_id in (select id from public.pickups where routine_id=routine.id
          and wanted_at>=now() and status in ('open','assigned'));
      -- This guardian skips each future occurrence, including ones another guardian already accepted, so each one
      -- records who cancelled it and queues the cancellation notice (F-14, 16.1 보호자 취소).
      for occurrence in select * from public.pickups p where p.routine_id=routine.id and p.wanted_at>=now()
        and p.status in ('open','assigned') order by p.id
      loop
        update public.pickups set status='cancelled',cancel_reason='skipped',cancelled_at=now(),is_customized=true,
          cancelled_by_kind='guardian' where id=occurrence.id returning * into occurrence;
        perform deriro_private.add_event(occurrence,actor,'cancelled','{"cause":"routine_paused"}');
      end loop;
    end if;
    update public.routines set rider_id=rider_id_arg,rider_member_id=member_id_arg,place_id=place.id,pickup_point_id=point_id_arg,
      weekdays=week_arg,time_local=time_arg,notify_before_min=notify_arg,default_assignee_member_id=driver_id_arg,
      default_vehicle_id=vehicle_id_arg,start_date=start_arg,end_date=end_arg,active=active_arg where id=routine.id returning * into routine;
  end if;
  return deriro_private.ok(jsonb_build_object('routine',to_jsonb(routine)));
exception
  when unique_violation then
    get stacked diagnostics violated = constraint_name;
    if violated = 'pickup_points_active_label' then return deriro_private.err('NAME_TAKEN'); end if;
    raise;
  when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then return deriro_private.err('VALIDATION');
end
$$;

create function deriro_private.vehicle_state_row(p_state public.vehicle_states)
returns jsonb language sql stable set search_path = '' as $$
  select case when p_state.vehicle_id is null then null else
    (to_jsonb(p_state) - array['lat','lng','location_at']) || jsonb_build_object(
      'range_km',case when p_state.collected_at >= now()-interval '24 hours' then p_state.range_km end,
      'is_stale',p_state.collected_at < now()-interval '6 hours') end
$$;

create function deriro_private.visible_offer(p_pickup public.pickups,p_member public.family_members)
returns jsonb language sql stable set search_path = '' as $$
  select to_jsonb(o) || jsonb_build_object('declined_by',
    coalesce((select jsonb_agg(r.member_id) from public.offer_responses r where r.offer_id=o.id),'[]'))
  from public.pickup_offers o where o.pickup_id=p_pickup.id
    and ((o.from_member_id=p_member.id and (o.status='pending' or o.resolved_at>=now()-interval '30 minutes'))
      or (p_member.can_drive and p_pickup.rider_member_id is distinct from p_member.id
        and o.status='pending' and (o.to_member_id is null or o.to_member_id=p_member.id)))
  order by (o.status='pending') desc,o.created_at desc,o.id limit 1
$$;

create function deriro_private.read_feed(p_surface text,p_id uuid,p_days int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor deriro_private.actor := deriro_private.current_actor();
  uid uuid := auth.uid();
  me public.family_members;
  fam public.families;
  rider public.riders;
  device public.rider_devices;
  vehicle public.vehicles;
  telemetry public.vehicle_states;
  pickup public.pickups;
  active_trip public.pickups;
  eligible boolean;
  parked boolean := false;
  result jsonb;
  range_data jsonb;
  boundary timestamptz;
begin
  if uid is null then return deriro_private.err('NOT_AUTHENTICATED'); end if;
  if p_surface = 'rider' then
    if actor.kind is distinct from 'rider' then
      return deriro_private.err(case when exists(select 1 from public.rider_devices d where d.auth_user_id=uid and d.revoked_at is not null)
        then 'DEVICE_REVOKED' else 'NOT_RIDER_DEVICE' end);
    end if;
    select * into rider from public.riders where id=actor.rider_id;
    select * into fam from public.families where id=actor.family_id;
    update public.rider_devices set last_seen_at=now() where id=actor.id and last_seen_at < now()-interval '1 minute';
    select jsonb_build_object(
      'rider',to_jsonb(rider)-array['phone_e164','birth_year'],
      'callable_guardians',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'display_name',m.display_name,'phone_e164',m.phone_e164))
        from public.family_members m where m.family_id=actor.family_id and m.left_at is null and m.phone_e164 is not null),'[]'),
      'places',coalesce((select jsonb_agg(to_jsonb(p)) from public.places p where p.family_id=actor.family_id and p.archived_at is null),'[]'),
      'pickup_points',coalesce((select jsonb_agg(to_jsonb(p)) from public.pickup_points p where p.family_id=actor.family_id and p.archived_at is null),'[]'),
      -- 24.5: an unacknowledged no_driver pickup stays until max(wanted_at, cancelled_at) + 3 hours, an acknowledged one
      -- for 10 minutes. Unacknowledged after 5 minutes, the call buttons grow (escalation_stage 1, as open_escalated).
      'actives',coalesce((select jsonb_agg(deriro_private.pickup_feed_row(p) - array['dest_lat','dest_lng','nav_session_id','last_start_action_id']
        || jsonb_build_object('escalation_stage',case when p.status='expired' then 2 when p.status='open'
          and p.created_at <= now()-interval '5 minutes'/fam.demo_time_scale then 1
          when p.cancel_reason='no_driver' and p.fallback_ack_at is null
            and p.cancelled_at <= now()-interval '5 minutes'/fam.demo_time_scale then 1 else 0 end,
          'can_cancel',p.source='request' and p.status in ('open','assigned','en_route'),
          'cancel_needs_confirm',p.status='en_route',
          'can_report_not_met',p.status='arrived' and (p.not_met_reported_at is null or p.not_met_reported_at <= now()-interval '5 minutes'),
          'nobody_available',p.status='open' and cardinality(deriro_private.available_drivers(p))=0,
          'wait_note',(select pl.fallback_note from public.places pl where pl.id=p.place_id),
          'fallback_by_name',deriro_private.member_name(p.fallback_by_member_id))
        order by case p.status when 'arrived' then 0 when 'en_route' then 1 when 'assigned' then 2 when 'open' then 3 else 4 end,p.wanted_at)
        from public.pickups p where p.rider_id=rider.id and (
          (deriro_private.active_status(p.status) and (p.source='request' or p.rider_ready_at is not null or p.status in ('en_route','arrived')))
          or (p.status in ('completed','cancelled','expired') and coalesce(p.completed_at,p.cancelled_at,p.expired_at) >= now()-interval '60 seconds')
          or (p.status='closed_unconfirmed' and p.closed_unconfirmed_at >= now()-interval '10 minutes')
          or (p.cancel_reason='no_driver' and ((p.fallback_ack_at is null and now() < greatest(p.wanted_at,p.cancelled_at)+interval '3 hours')
            or p.fallback_ack_at >= now()-interval '10 minutes')))),'[]'),
      'today',coalesce((select jsonb_agg(deriro_private.pickup_feed_row(p) - array['dest_lat','dest_lng','nav_session_id','last_start_action_id']
        || jsonb_build_object('can_ready_early',p.status in ('open','assigned') and p.rider_ready_at is null)
        order by p.wanted_at) from public.pickups p where p.rider_id=rider.id and p.source='routine'
        and deriro_private.active_status(p.status) and p.wanted_at between now()-interval '60 minutes' and now()+interval '3 hours'),'[]'),
      'server_time',now()) into result;
    return deriro_private.ok(result);
  end if;

  if p_surface = 'vehicle' then
    select v.* into vehicle from public.vehicles v join auth.users u on u.id=v.auth_user_id
      where v.auth_user_id=uid and u.is_anonymous;
    if not found then return deriro_private.err('NOT_VEHICLE'); end if;
    if vehicle.revoked_at is not null then return deriro_private.err('VEHICLE_REVOKED'); end if;
    select * into fam from public.families where id=vehicle.family_id;
    select * into telemetry from public.vehicle_states s where s.vehicle_id=vehicle.id;
    parked := coalesce(telemetry.gear='P' and telemetry.collected_at between now()-interval '30 seconds' and now(),false);
    select * into active_trip from public.pickups p where p.id=vehicle.active_pickup_id and p.status in ('en_route','arrived');
    eligible := deriro_private.eligible_driver(vehicle.family_id,vehicle.current_driver_member_id,null);
    boundary := ((now() at time zone fam.timezone)::date + 2)::timestamp at time zone fam.timezone;
    range_data := deriro_private.range_summary(vehicle);
    with visible as (
      select p as row, p.wanted_at, o.id as offer_id, o.note as offer_note, o.from_member_id, o.status as offer_status,
        (o.status='pending' and o.expires_at>now() and o.from_member_id is distinct from vehicle.current_driver_member_id
          and (o.to_member_id is null or o.to_member_id=vehicle.current_driver_member_id)
          and not exists(select 1 from public.offer_responses r where r.offer_id=o.id and r.member_id=vehicle.current_driver_member_id)) as offered,
        (p.assignee_member_id=vehicle.current_driver_member_id and (p.vehicle_id is null or p.vehicle_id=vehicle.id)) as own,
        r.notify_before_min
      from public.pickups p
      left join lateral (select * from public.pickup_offers o where o.pickup_id=p.id and
        (o.status='pending' or (o.status='expired' and o.from_member_id=vehicle.current_driver_member_id and o.resolved_at>=now()-interval '10 minutes'))
        order by (o.status='pending') desc,o.created_at desc limit 1) o on true
      left join public.routines r on r.id=p.routine_id
      where eligible and p.family_id=vehicle.family_id and p.rider_member_id is distinct from vehicle.current_driver_member_id and
        (deriro_private.active_status(p.status) or (p.status='cancelled' and p.vehicle_id=vehicle.id and p.en_route_at is not null
          and p.cancelled_at>=now()-interval '10 minutes'))
        and not exists(select 1 from deriro_private.pickup_declines d where d.pickup_id=p.id
          and d.member_id=vehicle.current_driver_member_id and p.status='open')
    ), cards as (
      select *, case
        when (v.row).status='cancelled' then 'cancelled_urgent'
        when (v.row).status='arrived' and (v.row).vehicle_id=vehicle.id and (v.row).not_met_reported_at is not null then 'not_met'
        when (v.row).status='open' and (v.row).source='request' and coalesce(v.offered,true) then 'child_request'
        when (v.row).status='assigned' and v.own and (v.row).rider_ready_at is not null then 'child_ready'
        when (v.row).status='assigned' and v.offered and not coalesce(v.own,false) then 'offer_to_me'
        when (v.row).status='assigned' and v.own and (v.row).source='request' and
          greatest((v.row).wanted_at,(v.row).accepted_at) <= now()-interval '10 minutes' then 'not_departed'
        when (v.row).status='assigned' and v.own and v.offer_status='expired' then 'offer_expired_mine'
        when (v.row).status='assigned' and v.own and ((v.row).source='request'
          or (v.row).wanted_at <= now()+make_interval(mins => coalesce(v.notify_before_min,20))) then 'routine_reminder'
        when (v.row).status='open' and (v.row).source='routine' and v.offered then 'routine_open'
        when (v.row).status='arrived' and (v.row).vehicle_id=vehicle.id and parked
          and (v.row).arrived_at <= now()-interval '30 minutes' then 'boarding_check'
      end as kind from visible v
    ), ordered as (
      select *, case kind when 'cancelled_urgent' then 1 when 'not_met' then 2 when 'child_request' then 3
        when 'child_ready' then 4 when 'offer_to_me' then 5 when 'not_departed' then 6 when 'offer_expired_mine' then 7
        when 'routine_reminder' then 8 when 'routine_open' then 9 when 'boarding_check' then 10 end as priority
      from cards where kind is not null order by priority,wanted_at limit 20
    )
    select jsonb_build_object(
      'vehicle',deriro_private.public_vehicle(vehicle) || jsonb_build_object('family_name',fam.name,'current_driver',
        jsonb_build_object('id',vehicle.current_driver_member_id,'display_name',deriro_private.member_name(vehicle.current_driver_member_id))),
      'drivers',coalesce((select jsonb_agg(deriro_private.public_member(m)) from public.family_members m where m.family_id=vehicle.family_id
        and m.left_at is null and m.can_drive),'[]'),
      'state',deriro_private.vehicle_state_row(telemetry),
      'range',range_data,
      'cards',coalesce((select jsonb_agg(deriro_private.vehicle_feed_row(c.row) || jsonb_build_object(
        'kind',c.kind,'pickup_id',(c.row).id,'offer_id',c.offer_id,'offer_note',c.offer_note,'from_name',deriro_private.member_name(c.from_member_id),
        'dest',jsonb_build_object('lat',(c.row).dest_lat,'lng',(c.row).dest_lng,'label',(c.row).dest_label,'note',(c.row).pin_note),
        'accuracy_m',case when not (c.row).location_confirmed then round((c.row).raw_accuracy_m)::int end,
        'wanted_in_min',greatest(0,ceil(extract(epoch from (c.row).wanted_at-now())/60)::int),
        'requested_ago_sec',greatest(0,extract(epoch from now()-(c.row).created_at)::int),
        'required_km',(deriro_private.range_summary(vehicle,c.row))->'required_km','required_is_estimate',true,
        'primary_action',case when c.kind in ('cancelled_urgent','not_met','offer_expired_mine') then 'ack'
          when c.kind='boarding_check' then 'boarded'
          when not (c.row).location_confirmed then case when parked then 'confirm_location' else 'accept' end
          when c.kind='routine_open' or ((c.row).status='open' and (c.row).wanted_at>now()+interval '15 minutes')
            or (vehicle.active_pickup_id is not null and vehicle.active_pickup_id<>(c.row).id and not parked) then 'accept' else 'start_now' end,
        'secondary_action',case when c.kind in ('child_request','offer_to_me','routine_open') then 'decline'
          when c.kind in ('child_ready','not_departed','routine_reminder') then 'handoff_all' end,
        'urgency',case when c.priority<=6 then 'high' else 'normal' end)
        order by c.priority,c.wanted_at) from ordered c),'[]'),
      'active_trip',case when active_trip.id is not null then deriro_private.vehicle_feed_row(active_trip) || jsonb_build_object(
        'pickup_id',active_trip.id,'nav_session_id',vehicle.active_nav_session_id,'destination_revision',vehicle.active_destination_revision) end,
      'today',case when parked then coalesce((select jsonb_agg(deriro_private.vehicle_feed_row(p)
        order by (p.vehicle_id=vehicle.id) desc nulls last,p.wanted_at) from public.pickups p
        where p.family_id=vehicle.family_id and p.wanted_at<boundary and p.wanted_at>=now()-interval '1 day'
          and (p.vehicle_id=vehicle.id or (eligible and p.rider_member_id is distinct from vehicle.current_driver_member_id))),'[]') else '[]'::jsonb end,
      'nearby_places',case when parked and eligible then coalesce((select jsonb_agg((to_jsonb(pl) - 'fallback_note') || jsonb_build_object('distance_m',
        deriro_private.distance_m(coalesce(active_trip.dest_lat,(select (o.row).dest_lat from ordered o order by o.priority,o.wanted_at limit 1)),
          coalesce(active_trip.dest_lng,(select (o.row).dest_lng from ordered o order by o.priority,o.wanted_at limit 1)),pl.lat,pl.lng)))
        from public.places pl where pl.family_id=vehicle.family_id and pl.archived_at is null),'[]') else '[]'::jsonb end,
      'alerts',case when parked and (range_data->>'verdict')='low' then coalesce((select jsonb_agg(to_jsonb(a)) from public.vehicle_alerts a
        where a.vehicle_id=vehicle.id and a.resolved_at is null and a.acknowledged_at is null),'[]') else '[]'::jsonb end,
      'server_time',now()) into result;
    return deriro_private.ok(result);
  end if;

  if actor.kind is distinct from 'member' then return deriro_private.err('NOT_GUARDIAN'); end if;
  select * into me from public.family_members where id=actor.member_id;
  select * into fam from public.families where id=actor.family_id;
  case p_surface
    when 'family' then
      result := jsonb_build_object(
        'family',to_jsonb(fam),'me',to_jsonb(me)-'auth_user_id',
        'members',coalesce((select jsonb_agg(deriro_private.public_member(m) order by m.role desc,m.display_name)
          from public.family_members m where m.family_id=fam.id and m.left_at is null),'[]'),
        'riders',coalesce((select jsonb_agg(to_jsonb(r) order by r.display_name) from public.riders r where r.family_id=fam.id and r.archived_at is null),'[]'),
        'rider_devices',coalesce((select jsonb_agg(to_jsonb(d)-'auth_user_id') from public.rider_devices d where d.family_id=fam.id and d.revoked_at is null),'[]'),
        'consents',coalesce((select jsonb_agg(to_jsonb(c) order by c.granted_at desc) from public.consents c
          where c.family_id=fam.id and (c.member_id=me.id or c.rider_id is not null)),'[]'),
        'vehicles',coalesce((select jsonb_agg(deriro_private.public_vehicle(v) || jsonb_build_object(
          'state',deriro_private.vehicle_state_row(s),'range',deriro_private.range_summary(v))) from public.vehicles v
          left join public.vehicle_states s on s.vehicle_id=v.id where v.family_id=fam.id and v.revoked_at is null),'[]'),
        'places',coalesce((select jsonb_agg(to_jsonb(p)) from public.places p where p.family_id=fam.id and p.archived_at is null),'[]'),
        'pickup_points',coalesce((select jsonb_agg(to_jsonb(p)) from public.pickup_points p where p.family_id=fam.id and p.archived_at is null),'[]'),
        'routines',coalesce((select jsonb_agg(to_jsonb(r)) from public.routines r where r.family_id=fam.id and r.archived_at is null),'[]'),
        'setup_checklist',jsonb_build_object(
          'rider',exists(select 1 from public.riders r where r.family_id=fam.id and r.archived_at is null),
          'place',exists(select 1 from public.places p where p.family_id=fam.id and p.archived_at is null),
          'vehicle',exists(select 1 from public.vehicles v where v.family_id=fam.id and v.revoked_at is null)));
    when 'today' then
      -- Read only. Occurrences come from routine saves, ensure_occurrences and the hourly scheduler (section 9).
      if p_days is null or p_days not between 1 and 2 then return deriro_private.err('VALIDATION'); end if;
      boundary := ((now() at time zone fam.timezone)::date + p_days)::timestamp at time zone fam.timezone;
      with visible as (
        select p as row,p.wanted_at,
          deriro_private.active_status(p.status) as active
        from public.pickups p where p.family_id=fam.id and p.wanted_at<boundary and
          (deriro_private.active_status(p.status) or p.wanted_at >= date_trunc('day',now(),fam.timezone))
          and (p.status<>'open' or p.rider_member_id=me.id or me.can_drive)
      )
      select jsonb_build_object(
        'active',coalesce(jsonb_agg(deriro_private.guardian_feed_row(v.row) || jsonb_build_object('offer',deriro_private.visible_offer(v.row,me))
          order by v.wanted_at) filter (where v.active),'[]'),
        'timeline',coalesce(jsonb_agg(deriro_private.guardian_feed_row(v.row) || jsonb_build_object('offer',deriro_private.visible_offer(v.row,me))
          order by v.wanted_at) filter (where not v.active or (v.row).source='routine'),'[]'),
        -- 24.6: every active guardian's "못 가는 날" from today for 14 days (P-19, P-04 "내일").
        'unavailable_days',coalesce((select jsonb_agg(jsonb_build_object('member_id',u.member_id,'day',u.day) order by u.day,u.member_id)
          from public.member_unavailable_days u join public.family_members m on m.id=u.member_id and m.left_at is null
          where u.family_id=fam.id and u.day between (now() at time zone fam.timezone)::date
            and (now() at time zone fam.timezone)::date+13),'[]'),
        'pending_offers_to_me',coalesce((select jsonb_agg(to_jsonb(o)) from public.pickup_offers o join public.pickups p on p.id=o.pickup_id
          where o.family_id=fam.id and o.status='pending' and o.expires_at>now() and me.can_drive
            and p.rider_member_id is distinct from me.id and o.from_member_id is distinct from me.id
            and (o.to_member_id is null or o.to_member_id=me.id)
            and not exists(select 1 from public.offer_responses r where r.offer_id=o.id and r.member_id=me.id)),'[]'),
        'alerts',coalesce((select jsonb_agg(to_jsonb(a)) from public.vehicle_alerts a join public.vehicle_states s on s.vehicle_id=a.vehicle_id
          where a.family_id=fam.id and a.resolved_at is null and s.collected_at>=now()-interval '6 hours'),'[]'),
        'notification_failures',jsonb_build_object('sms_failed',case when me.role='owner' then
          (select count(*) from public.notifications_outbox n where n.family_id=fam.id and n.channel='sms'
            and n.status='failed' and n.finished_at>=now()-interval '24 hours') else 0 end),
        'server_time',now()) into result from visible v;
    when 'pickup' then
      select * into pickup from public.pickups p where p.family_id=fam.id and p.id=p_id;
      if not found then return deriro_private.err('NOT_FOUND'); end if;
      select * into vehicle from public.vehicles v where v.id=pickup.vehicle_id;
      select * into telemetry from public.vehicle_states s where s.vehicle_id=vehicle.id;
      if vehicle.id is not null then range_data := deriro_private.range_summary(vehicle,pickup); end if;
      result := jsonb_build_object(
        'pickup',deriro_private.guardian_feed_row(pickup),
        'offers',coalesce((select jsonb_agg(to_jsonb(o)||jsonb_build_object('declined_by',
          coalesce((select jsonb_agg(r.member_id) from public.offer_responses r where r.offer_id=o.id),'[]'))
          order by (o.status='pending') desc,o.created_at desc,o.id)
          from public.pickup_offers o where o.pickup_id=pickup.id and (o.from_member_id=me.id or (me.can_drive
            and pickup.rider_member_id is distinct from me.id and (o.to_member_id is null or o.to_member_id=me.id)))),'[]'),
        'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from public.pickup_events e where e.pickup_id=pickup.id),'[]'),
        'assignee',(select deriro_private.public_member(m) from public.family_members m where m.id=pickup.assignee_member_id),
        'vehicle',deriro_private.public_vehicle(vehicle),'vehicle_state',deriro_private.vehicle_state_row(telemetry),
        'required_km',range_data->'required_km','range',range_data);
    else return deriro_private.err('VALIDATION');
  end case;
  return deriro_private.ok(result);
end
$$;

create function deriro_private.vehicle_operation(p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor deriro_private.actor := deriro_private.current_actor();
  vehicle public.vehicles;
  pickup public.pickups;
  offer public.pickup_offers;
  telemetry public.vehicle_states;
  alert jsonb;
  collected timestamptz := (p_data->>'collected_at')::timestamptz;
  location_at_arg timestamptz := (p_data->>'location_at')::timestamptz;
  gear_arg text := p_data->>'gear';
  lat_arg double precision := (p_data->>'lat')::double precision;
  lng_arg double precision := (p_data->>'lng')::double precision;
  id_arg uuid := (p_data->>'id')::uuid;
  version_arg int := (p_data->>'version')::int;
  violated text;
begin
  if auth.uid() is null then return deriro_private.err('NOT_AUTHENTICATED'); end if;
  if p_action='ack' and actor.kind='member' then
    update public.vehicle_alerts a set acknowledged_at=coalesce(a.acknowledged_at,now()) where a.family_id=actor.family_id and a.id=id_arg;
    return case when found then deriro_private.ok('{}') else deriro_private.err('NOT_FOUND') end;
  end if;
  select v.* into vehicle from public.vehicles v join auth.users u on u.id=v.auth_user_id
    where v.auth_user_id=auth.uid() and u.is_anonymous;
  if not found then return deriro_private.err('NOT_VEHICLE'); end if;
  if vehicle.revoked_at is not null then return deriro_private.err('VEHICLE_REVOKED'); end if;
  case p_action
    when 'state' then
      if collected is null or collected>now()+interval '30 seconds' or collected<now()-interval '1 day'
        or gear_arg is null or gear_arg not in ('P','R','N','D','unknown')
        or num_nonnulls(lat_arg,lng_arg,location_at_arg) not in (0,3)
        or location_at_arg>collected+interval '30 seconds'
      then return deriro_private.err('VALIDATION'); end if;
      select v.* into vehicle from public.vehicles v where v.id=vehicle.id and v.revoked_at is null for update;
      if not found then return deriro_private.err('VEHICLE_REVOKED'); end if;
      insert into public.vehicle_states as s(vehicle_id,gear,collected_at,range_km,fuel_pct,soc_pct,energy_type,ignition,lat,lng,location_at,is_demo_value)
      values(vehicle.id,gear_arg,collected,(p_data->>'range_km')::double precision,(p_data->>'fuel_pct')::double precision,
        (p_data->>'soc_pct')::double precision,p_data->>'energy_type',p_data->>'ignition',lat_arg,lng_arg,location_at_arg,
        coalesce((p_data->>'is_demo_value')::boolean,false))
      on conflict (vehicle_id) do update set gear=excluded.gear,collected_at=excluded.collected_at,range_km=excluded.range_km,
        fuel_pct=excluded.fuel_pct,soc_pct=excluded.soc_pct,energy_type=excluded.energy_type,ignition=excluded.ignition,
        lat=excluded.lat,lng=excluded.lng,location_at=excluded.location_at,is_demo_value=excluded.is_demo_value
      where excluded.collected_at>s.collected_at returning * into telemetry;
      if not found then select * into telemetry from public.vehicle_states s where s.vehicle_id=vehicle.id; end if;
      alert := deriro_private.recompute_low_range(vehicle.id);
      return deriro_private.ok(jsonb_build_object('state',deriro_private.vehicle_state_row(telemetry),'alert',alert));
    when 'ack' then
      update public.vehicle_alerts a set acknowledged_at=coalesce(a.acknowledged_at,now()) where a.vehicle_id=vehicle.id and a.id=id_arg;
      return case when found then deriro_private.ok('{}') else deriro_private.err('NOT_FOUND') end;
    when 'decline' then
      if actor.kind is distinct from 'vehicle' or not coalesce(actor.can_drive,false) then return deriro_private.err('FORBIDDEN'); end if;
      select * into pickup from public.pickups p where p.id=id_arg and p.family_id=vehicle.family_id for update;
      if not found or pickup.rider_member_id=actor.member_id then return deriro_private.err('NOT_FOUND'); end if;
      if pickup.version is distinct from version_arg then return deriro_private.err('STALE_VERSION',jsonb_build_object('pickup',deriro_private.safe_pickup(pickup))); end if;
      if pickup.status='open' and pickup.source='request' then
        if now()>=pickup.wanted_at+interval '60 minutes' then
          pickup := deriro_private.expire_pickup(pickup);
          return deriro_private.err('PICKUP_EXPIRED');
        end if;
        select * into offer from public.pickup_offers o where o.pickup_id=pickup.id and o.status='pending' for update;
        insert into deriro_private.pickup_declines values (pickup.id,actor.member_id) on conflict do nothing;
        if found then
          if offer.id is not null then
            insert into public.offer_responses(family_id,offer_id,member_id) values(pickup.family_id,offer.id,actor.member_id) on conflict do nothing;
            -- The rule respond_offer(decline) applies: the last driver to decline closes the request offer (4.4 #7, 8.7).
            if deriro_private.everyone_declined(offer,pickup) then
              perform deriro_private.resolve_offer(offer.id,'declined',actor.member_id);
            end if;
          end if;
          perform deriro_private.add_event(pickup,actor,'request_declined');
        end if;
        return deriro_private.ok('{}');
      elsif pickup.status='assigned' and pickup.vehicle_id=vehicle.id and pickup.assignee_member_id=actor.member_id then
        return deriro_private.transition('offer',pickup.id,version_arg,'{}');
      else
        select * into offer from public.pickup_offers o where o.pickup_id=pickup.id and o.status='pending';
        if not found then return deriro_private.err('OFFER_NOT_PENDING'); end if;
        return deriro_private.transition('respond_offer',null,version_arg,jsonb_build_object('offer_id',offer.id,'response','decline'));
      end if;
    else return deriro_private.err('VALIDATION');
  end case;
exception
  -- Telemetry outside the vehicle_states value checks is a validation error; any other check violation
  -- (including one raised by a nested transition) is a defect and propagates.
  when check_violation then
    get stacked diagnostics violated = constraint_name;
    if violated in ('vehicle_states_gear_check','vehicle_states_range_km_check','vehicle_states_fuel_pct_check',
      'vehicle_states_soc_pct_check','vehicle_states_energy_type_check','vehicle_states_ignition_check',
      'vehicle_states_lat_check','vehicle_states_lng_check','vehicle_states_location_check')
    then return deriro_private.err('VALIDATION'); end if;
    raise;
  when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow
    then return deriro_private.err('VALIDATION');
end
$$;

revoke execute on function deriro_private.rider_name(public.pickups),
  deriro_private.member_name(uuid),deriro_private.pickup_feed_row(public.pickups),deriro_private.active_status(public.pickup_status),
  deriro_private.guardian_feed_row(public.pickups),deriro_private.vehicle_feed_row(public.pickups),
  deriro_private.range_summary(public.vehicles,public.pickups),deriro_private.recompute_low_range(uuid),
  deriro_private.ensure_occurrences(uuid,int),deriro_private.revise_routine(),deriro_private.vehicle_state_row(public.vehicle_states),
  deriro_private.visible_offer(public.pickups,public.family_members)
  from public, anon, authenticated, service_role;

create function public.upsert_place(p_label text,p_kind text,p_lat double precision,p_lng double precision,p_radius_m int default 150,p_place_id uuid default null,
  p_fallback_note text default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_schedule('upsert_place',jsonb_build_object('label',p_label,'kind',p_kind,'lat',p_lat,'lng',p_lng,'radius',p_radius_m,'id',p_place_id,
  'fallback_note',p_fallback_note)) $$;

create function public.archive_place(p_place_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_schedule('archive_place',jsonb_build_object('id',p_place_id)) $$;

create function public.upsert_pickup_point(p_place_id uuid,p_label text,p_lat double precision,p_lng double precision,p_note text default null,p_pickup_point_id uuid default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_schedule('upsert_pickup_point',jsonb_build_object('place_id',p_place_id,'label',p_label,'lat',p_lat,'lng',p_lng,'note',p_note,'id',p_pickup_point_id)) $$;

create function public.archive_pickup_point(p_pickup_point_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_schedule('archive_pickup_point',jsonb_build_object('id',p_pickup_point_id)) $$;

create function public.upsert_routine(p_rider_id uuid,p_rider_member_id uuid,p_place_id uuid,p_weekdays int,p_time_local time,
  p_notify_before_min int default 20,p_default_assignee_member_id uuid default null,p_default_vehicle_id uuid default null,
  p_start_date date default null,p_end_date date default null,p_pickup_point_id uuid default null,p_routine_id uuid default null,
  p_active boolean default true,p_cancel_future boolean default false)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_schedule('upsert_routine',jsonb_build_object('rider_id',p_rider_id,'rider_member_id',p_rider_member_id,'place_id',p_place_id,
  'weekdays',p_weekdays,'time',p_time_local,'notify_before',p_notify_before_min,'driver_id',p_default_assignee_member_id,
  'vehicle_id',p_default_vehicle_id,'start_date',p_start_date,'end_date',p_end_date,'point_id',p_pickup_point_id,'id',p_routine_id,
  'active',p_active,'cancel_future',p_cancel_future)) $$;

create function public.archive_routine(p_routine_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_schedule('archive_routine',jsonb_build_object('id',p_routine_id)) $$;

create function public.set_unavailable_day(p_day date,p_unavailable boolean)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_schedule('set_unavailable_day',jsonb_build_object('day',p_day,'unavailable',p_unavailable)) $$;

create function public.ensure_occurrences(p_days int default 2)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.manage_schedule('ensure_occurrences',jsonb_build_object('days',p_days)) $$;

create function public.get_family_overview()
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.read_feed('family',null,null) $$;

create function public.rider_get_state()
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.read_feed('rider',null,null) $$;

create function public.vehicle_get_feed()
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.read_feed('vehicle',null,null) $$;

create function public.get_today(p_days int default 1)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.read_feed('today',null,p_days) $$;

create function public.get_pickup(p_pickup_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.read_feed('pickup',p_pickup_id,null) $$;

create function public.skip_occurrence(p_pickup_id uuid,p_expected_version int)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.transition('cancel',p_pickup_id,p_expected_version,'{"reason":"skipped"}') $$;

create function public.undo_en_route(p_pickup_id uuid,p_expected_version int)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.transition('undo_en_route',p_pickup_id,p_expected_version,'{}') $$;

create function public.rider_cancel_request(p_pickup_id uuid,p_expected_version int)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.transition('rider_cancel',p_pickup_id,p_expected_version,'{}') $$;

create function public.rider_mark_boarded(p_pickup_id uuid,p_expected_version int)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.transition('rider_board',p_pickup_id,p_expected_version,'{}') $$;

create function public.upsert_vehicle_state(p_gear text,p_collected_at timestamptz,p_range_km double precision default null,p_fuel_pct double precision default null,
  p_soc_pct double precision default null,p_energy_type text default null,p_ignition text default null,p_lat double precision default null,
  p_lng double precision default null,p_location_at timestamptz default null,p_is_demo_value boolean default false)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.vehicle_operation('state',jsonb_build_object('gear',p_gear,'collected_at',p_collected_at,
  'range_km',p_range_km,'fuel_pct',p_fuel_pct,'soc_pct',p_soc_pct,'energy_type',p_energy_type,'ignition',p_ignition,
  'lat',p_lat,'lng',p_lng,'location_at',p_location_at,'is_demo_value',p_is_demo_value)) $$;

create function public.ack_vehicle_alert(p_alert_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.vehicle_operation('ack',jsonb_build_object('id',p_alert_id)) $$;

create function public.vehicle_decline(p_pickup_id uuid,p_expected_version int)
returns jsonb language sql security invoker set search_path = ''
as $$ select deriro_private.vehicle_operation('decline',jsonb_build_object('id',p_pickup_id,'version',p_expected_version)) $$;

revoke execute on function
  deriro_private.manage_schedule(text,jsonb),
  deriro_private.read_feed(text,uuid,int),
  deriro_private.vehicle_operation(text,jsonb),
  public.upsert_place(text,text,double precision,double precision,int,uuid,text),
  public.set_unavailable_day(date,boolean),
  public.archive_place(uuid),
  public.upsert_pickup_point(uuid,text,double precision,double precision,text,uuid),
  public.archive_pickup_point(uuid),
  public.upsert_routine(uuid,uuid,uuid,int,time,int,uuid,uuid,date,date,uuid,uuid,boolean,boolean),
  public.archive_routine(uuid),
  public.ensure_occurrences(int),
  public.get_family_overview(),
  public.rider_get_state(),
  public.vehicle_get_feed(),
  public.get_today(int),
  public.get_pickup(uuid),
  public.skip_occurrence(uuid,int),
  public.undo_en_route(uuid,int),
  public.rider_cancel_request(uuid,int),
  public.rider_mark_boarded(uuid,int),
  public.upsert_vehicle_state(text,timestamptz,double precision,double precision,double precision,text,text,double precision,double precision,timestamptz,boolean),
  public.ack_vehicle_alert(uuid),
  public.vehicle_decline(uuid,int)
  from public, anon, authenticated, service_role;
grant execute on function
  deriro_private.manage_schedule(text,jsonb),
  deriro_private.read_feed(text,uuid,int),
  deriro_private.vehicle_operation(text,jsonb),
  public.upsert_place(text,text,double precision,double precision,int,uuid,text),
  public.set_unavailable_day(date,boolean),
  public.archive_place(uuid),
  public.upsert_pickup_point(uuid,text,double precision,double precision,text,uuid),
  public.archive_pickup_point(uuid),
  public.upsert_routine(uuid,uuid,uuid,int,time,int,uuid,uuid,date,date,uuid,uuid,boolean,boolean),
  public.archive_routine(uuid),
  public.ensure_occurrences(int),
  public.get_family_overview(),
  public.rider_get_state(),
  public.vehicle_get_feed(),
  public.get_today(int),
  public.get_pickup(uuid),
  public.skip_occurrence(uuid,int),
  public.undo_en_route(uuid,int),
  public.rider_cancel_request(uuid,int),
  public.rider_mark_boarded(uuid,int),
  public.upsert_vehicle_state(text,timestamptz,double precision,double precision,double precision,text,text,double precision,double precision,timestamptz,boolean),
  public.ack_vehicle_alert(uuid),
  public.vehicle_decline(uuid,int)
  to authenticated;
