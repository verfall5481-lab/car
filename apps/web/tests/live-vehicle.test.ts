import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { PickupAction } from '@deriro/contracts';
import { authStorageKeys, decodeRpc, pickupActionRpc } from '../src/live/api.ts';
import {
  alertParams,
  declineParams,
  driverParams,
  navResultParams,
  pairingState,
  pairTicketSchema,
  vehicleFeedSchema,
  vehicleStartSchema,
  vehicleState,
  vehicleStateParams,
} from '../src/live/vehicle-models.ts';
import type { VehicleFeed } from '../src/live/vehicle-models.ts';
import { destinationLabel, nameOf, vehiclePaired } from '../src/demo-domain.ts';
import { vehicleView } from '../src/vehicle-view.ts';

const fixtureUrl = new URL('../../../supabase/tests/fixtures/vehicle_get_feed.json', import.meta.url);
const raw = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as { ok: true; data: Record<string, unknown> & { cards: Record<string, unknown>[] } };
const feed = decodeRpc(raw, vehicleFeedSchema);
const serverNow = Date.parse(feed.server_time);
const sim = { parked: true, rangeKm: 48 };
const memory = { hidden: [], seenOffers: [], rangeSeen: false };
const request = feed.cards[0];
const dad = feed.vehicle.current_driver_member_id!;
const mom = feed.drivers.find((row) => row.id !== dad)!.id;

/** The fixture with its first card changed, decoded through the same schema as a live response. */
function variant(change: (data: Record<string, unknown> & { cards: Record<string, unknown>[] }) => void): VehicleFeed {
  const copy = structuredClone(raw);
  change(copy.data);
  return decodeRpc(copy, vehicleFeedSchema);
}

/** Parameter names of every public SQL function, from the migrations in order (a later definition wins). */
function sqlSignatures() {
  const directory = new URL('../../../supabase/migrations/', import.meta.url);
  const signatures = new Map<string, { all: string[]; required: string[] }>();
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = readFileSync(new URL(file, directory), 'utf8');
    for (const match of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(([^)]*)\)/gi)) {
      const parameters = match[2].split(',').map((part) => part.trim()).filter(Boolean);
      signatures.set(match[1], {
        all: parameters.map((part) => part.split(/\s+/)[0]),
        required: parameters.filter((part) => !/\sdefault\s/i.test(part)).map((part) => part.split(/\s+/)[0]),
      });
    }
  }
  return signatures;
}

test('vehicle feed projection accepts the actual SQL feed and keeps the server card decisions', () => {
  const state = vehicleState(feed, sim, true, serverNow + 2_000);
  const pickup = state.pickups.find((row) => row.id === request.pickup_id)!;
  assert.equal(state.vehicle.name, '우리 차');
  assert.equal(state.familyName, '테스트 가족');
  assert.equal(nameOf(state, state.vehicle.currentDriverId), '아빠');
  assert.equal(state.vehicle.isDemoValue, true);
  assert.equal(state.vehicle.range, 48);
  assert.ok(vehiclePaired(state.vehicle));
  assert.equal(state.advance, -2_000);
  assert.deepEqual(state.members.filter((member) => member.canDrive).map((member) => member.name).sort(), ['아빠', '엄마']);
  assert.equal(nameOf(state, pickup.requester.id), '할머니');
  // 23.5: the car shows the saved place, the pickup point and the rider's note.
  assert.equal(destinationLabel(state, pickup.destination), '수학학원, 후문, 후문 벤치');
  assert.deepEqual(state.vehicleFeed?.cards[request.pickup_id], { kind: 'child_request', order: 0, primary: 'start_now', secondary: 'decline', requiredKm: 27.1 });
  assert.equal(pickup.offer?.fromMemberId, null);

  const view = vehicleView(state, serverNow, memory);
  assert.equal(view.pickup?.id, request.pickup_id);
  assert.equal(view.cards.length, 1);
  assert.equal(view.receivedOffer(pickup), null);
  assert.equal(view.primary(pickup), 'start');
  assert.equal(view.requiredKm(pickup), 27.1);
  assert.equal(view.rangeWarning, null);
  // The routine pickup on this car is the next pickup, not a card: the server did not raise one.
  const routine = state.pickups.find((row) => row.source === 'routine')!;
  assert.equal(view.cardRank(routine), 2);
  assert.deepEqual(view.pending.map((row) => row.id), [request.pickup_id, routine.id]);
});

test('a handoff card becomes an offer from its sender to this driver, and departing from it passes the offer', () => {
  const handoff = variant((data) => Object.assign(data.cards[0], {
    kind: 'offer_to_me', status: 'assigned', assignee_member_id: mom, assignee_display_name: '엄마', from_name: '엄마', offer_note: '야근이야',
  }));
  const state = vehicleState(handoff, sim, true, serverNow);
  const pickup = state.pickups.find((row) => row.id === request.pickup_id)!;
  const view = vehicleView(state, serverNow, memory);
  const offer = view.receivedOffer(pickup);
  assert.equal(offer?.fromMemberId, mom);
  assert.equal(offer?.toMemberId, dad);
  assert.equal(offer?.note, '야근이야');
  assert.equal(view.primary(pickup), 'start');
  assert.ok(view.visible.some((row) => row.id === pickup.id));
  const start: PickupAction = { type: 'vehicle_start', expectedVersion: pickup.version, sessionId: 'local', actionId: 'action-1', offerId: offer!.id };
  assert.deepEqual(pickupActionRpc(pickup.id, start, 'vehicle'), ['vehicle_start_now', {
    p_pickup_id: pickup.id, p_expected_version: 1, p_action_id: 'action-1', p_offer_id: request.offer_id,
  }]);

  // A sender who no longer drives still has a name on the card; "수락" is the only main action the server allows here.
  const outsider = variant((data) => Object.assign(data.cards[0], { kind: 'offer_to_me', status: 'assigned', from_name: '이모', primary_action: 'accept' }));
  const outsiderState = vehicleState(outsider, { parked: false, rangeKm: 48 }, true, serverNow);
  const card = outsiderState.pickups.find((row) => row.id === request.pickup_id)!;
  const outsiderView = vehicleView(outsiderState, serverNow, memory);
  assert.equal(nameOf(outsiderState, outsiderView.receivedOffer(card)?.fromMemberId), '이모');
  assert.equal(outsiderView.primary(card), 'accept');
  assert.ok(!outsiderState.members.find((member) => member.name === '이모')?.canDrive);
});

test('the active trip carries the car session, and a failed navigation keeps the trip en route', () => {
  const session = '5d1e1f2a-0000-4000-8000-00000000aaaa';
  const trip = (navStatus: string) => variant((data) => {
    const [card] = data.cards;
    data.cards = [];
    data.active_trip = { ...card, status: 'en_route', assignee_member_id: dad, vehicle_id: feed.vehicle.id, en_route_at: feed.server_time,
      nav_session_id: session, nav_destination_revision: 1, destination_revision: 1, nav_status: navStatus, version: 2 };
  });
  const failed = vehicleState(trip('failed'), sim, true, serverNow);
  const pickup = failed.pickups.find((row) => row.id === request.pickup_id)!;
  assert.equal(failed.vehicle.activePickupId, pickup.id);
  assert.equal(failed.vehicle.activeSessionId, session);
  assert.equal(failed.vehicle.activeDestinationRevision, 1);
  assert.equal(failed.vehicle.navError, true);
  assert.equal(pickup.status, 'en_route');
  assert.equal(pickup.navigation?.sessionId, session);
  assert.equal(vehicleView(failed, serverNow, memory).pickup?.id, pickup.id);
  assert.equal(vehicleState(trip('requested'), sim, true, serverNow).vehicle.navError, false);
  // An arrival callback carries the car's active session and destination revision.
  const callback: PickupAction = { type: 'arrive', source: 'nav_callback', sessionId: session, destinationRevision: 1 };
  assert.deepEqual(pickupActionRpc(pickup.id, callback, 'vehicle'), ['mark_arrived', {
    p_pickup_id: pickup.id, p_source: 'nav_callback', p_nav_session_id: session, p_destination_revision: 1,
  }]);
  assert.deepEqual(pickupActionRpc(pickup.id, { type: 'arrive', source: 'manual', expectedVersion: 2 }, 'vehicle'), ['mark_arrived', {
    p_pickup_id: pickup.id, p_expected_version: 2, p_source: 'manual',
  }]);
  assert.deepEqual(pickupActionRpc(pickup.id, { type: 'board', expectedVersion: 3 }, 'vehicle'), ['mark_completed', { p_pickup_id: pickup.id, p_expected_version: 3 }]);
});

test('server cards decide urgent cancellations, range warnings and which day rows stay visible', () => {
  const minute = 60_000;
  const ago = (minutes: number) => new Date(serverNow - minutes * minute).toISOString();
  const [routineRow] = raw.data.today as Record<string, unknown>[];
  const state = vehicleState(variant((data) => {
    const [card] = data.cards;
    data.cards = [
      { ...card, pickup_id: 'cancelled-trip', id: 'cancelled-trip', kind: 'cancelled_urgent', status: 'cancelled', assignee_member_id: dad,
        vehicle_id: feed.vehicle.id, en_route_at: ago(12), cancelled_at: ago(2), primary_action: 'ack', secondary_action: null },
      card,
    ];
    data.alerts = [{ id: 'alert-1', range_km: 5, required_km: 27.1, pickup_count: 2, acknowledged_at: null, resolved_at: null }];
    data.today = [
      ...(data.today as Record<string, unknown>[]),
      { ...routineRow, id: 'done-recently', status: 'completed', completed_at: ago(5) },
      { ...routineRow, id: 'done-earlier', status: 'completed', completed_at: ago(25) },
      { ...routineRow, id: 'other-car', status: 'completed', completed_at: ago(1), vehicle_id: 'another-vehicle' },
      { ...routineRow, id: 'declined-request', status: 'open', source: 'request', assignee_member_id: null, vehicle_id: null },
    ];
  }), sim, true, serverNow);
  const view = vehicleView(state, serverNow, memory);
  assert.equal(view.pickup?.id, 'cancelled-trip');
  assert.equal(vehicleView(state, serverNow, { ...memory, hidden: ['cancelled-trip'] }).pickup?.id, request.pickup_id);
  assert.deepEqual(view.rangeWarning, { id: 'alert-1', requiredKm: 27.1, rangeKm: 5, pickupCount: 2, alertId: 'alert-1' });
  const ids = state.pickups.map((row) => row.id);
  assert.ok(ids.includes('done-recently'));
  assert.ok(!ids.includes('done-earlier'));
  assert.ok(!ids.includes('other-car'));
  // An open request the server no longer lists as a card (for example one this driver declined) stays hidden.
  assert.ok(ids.includes('declined-request'));
  assert.ok(!view.visible.some((row) => row.id === 'declined-request'));
});

test('vehicle RPC parameter builders use the exact SQL parameter names', () => {
  const signatures = sqlSignatures();
  const pickupId = request.pickup_id;
  const calls: [string, Record<string, unknown>][] = [
    pickupActionRpc(pickupId, { type: 'vehicle_start', expectedVersion: 1, sessionId: 'local', actionId: 'a' }, 'vehicle'),
    pickupActionRpc(pickupId, { type: 'arrive', source: 'manual', expectedVersion: 2 }, 'vehicle'),
    pickupActionRpc(pickupId, { type: 'arrive', source: 'nav_callback', sessionId: 's', destinationRevision: 1 }, 'vehicle'),
    pickupActionRpc(pickupId, { type: 'board', expectedVersion: 3 }, 'vehicle'),
    pickupActionRpc(pickupId, { type: 'accept' }, 'vehicle'),
    pickupActionRpc(pickupId, { type: 'respond_offer', expectedVersion: 1, offerId: 'o', response: 'accept' }, 'vehicle'),
    pickupActionRpc(pickupId, { type: 'confirm_location', expectedVersion: 1, destination: { source: 'gps', lat: 37.5, lng: 127, label: 'here', confirmed: true } }, 'vehicle'),
    ['report_nav_result', navResultParams(pickupId, 's', false)],
    ['upsert_vehicle_state', vehicleStateParams(sim, new Date(serverNow))],
    ['vehicle_decline', declineParams({ id: pickupId, version: 1 })],
    ['vehicle_set_driver', driverParams(dad)],
    ['ack_vehicle_alert', alertParams('alert-1')],
  ];
  for (const [name, args] of calls) {
    const signature = signatures.get(name);
    assert.ok(signature, `${name} exists in the migrations`);
    const sent = Object.keys(args).filter((key) => args[key] !== undefined);
    for (const key of sent) assert.ok(signature.all.includes(key), `${name} has ${key}`);
    for (const key of signature.required) assert.ok(sent.includes(key), `${name} sends ${key}`);
  }
  assert.deepEqual(navResultParams(pickupId, 's', true), { p_pickup_id: pickupId, p_nav_session_id: 's', p_result: 'ok', p_error_code: undefined });
  assert.ok(signatures.get('vehicle_pair_start')?.all.length === 0);
  assert.ok(signatures.get('vehicle_unpair_self')?.all.length === 0);
  assert.ok(signatures.get('vehicle_get_feed')?.all.length === 0);
});

test('every simulated vehicle state is uploaded as a demo value', () => {
  const at = new Date(serverNow);
  for (const parked of [true, false]) {
    for (const rangeKm of [0, 48, 600]) {
      const params = vehicleStateParams({ parked, rangeKm }, at);
      assert.equal(params.p_is_demo_value, true);
      assert.equal(params.p_gear, parked ? 'P' : 'D');
      assert.equal(params.p_range_km, rangeKm);
      assert.equal(params.p_collected_at, feed.server_time.replace('+00:00', 'Z'));
    }
  }
});

test('pairing codes are checked, the start response is decoded, and the vehicle session has its own storage', () => {
  const expires = new Date(serverNow + 10 * 60_000).toISOString();
  assert.deepEqual(decodeRpc({ ok: true, data: { code: 'K7Q2M9', url: '/p/vehicles/pair?code=K7Q2M9', expires_at: expires } }, pairTicketSchema), { code: 'K7Q2M9', expiresAt: Date.parse(expires) });
  assert.equal(decodeRpc({ ok: true, data: { code: 'K7Q-2M9', expires_at: expires } }, pairTicketSchema).code, 'K7Q2M9');
  assert.throws(() => decodeRpc({ ok: true, data: { code: 'K7Q2M0', expires_at: expires } }, pairTicketSchema), /BAD_RESPONSE/);
  const pairing = pairingState({ code: 'K7Q2M9', expiresAt: Date.parse(expires) }, sim, true);
  assert.equal(vehiclePaired(pairing.vehicle), false);
  assert.equal(pairing.vehicle.pairing?.code, 'K7Q2M9');
  assert.equal(pairing.pickups.length, 0);

  const [card] = raw.data.cards;
  const started = decodeRpc({ ok: true, data: {
    pickup: { ...card, status: 'en_route', nav_session_id: 'session-1', nav_destination_revision: 1 },
    nav_session_id: 'session-1', destination_revision: 1, dest: { lat: 37.5501, lng: 127.1, label: '후문', note: '후문 벤치' },
  } }, vehicleStartSchema);
  assert.equal(started.nav_session_id, 'session-1');
  assert.equal(started.pickup.status, 'en_route');

  assert.equal(authStorageKeys.vehicle, 'deriro-vehicle-auth');
  assert.equal(new Set(Object.values(authStorageKeys)).size, 3);
});
