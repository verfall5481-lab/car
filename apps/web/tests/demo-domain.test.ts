import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Actor, PickupAction } from '@deriro/contracts';
import { applyDemoAction, createRequest, demoStart, exampleGps, freshDemo, minute, pairVehicle, renewPairCode, routineOccurrence, setDemoTime, setVehicleDriver, unpairVehicle, vehiclePaired } from '../src/demo-domain.ts';
import type { Change, DemoState } from '../src/demo-domain.ts';

const rider = { kind: 'rider', id: 'minjun' } as const;
const dad = { kind: 'member', id: 'dad' } as const;
const mom = { kind: 'member', id: 'mom' } as const;
const car = { kind: 'vehicle', id: 'our-car', driverId: 'dad', parked: true } as const;
const point = { source: 'saved_point', pickupPointId: 'back' } as const;
const now = demoStart;

function ok(result: Change): DemoState {
  assert.equal(result.ok, true, result.ok ? undefined : result.code);
  return result.state;
}
function request(state = freshDemo()) {
  return ok(createRequest(state, rider, point, 0, now, 'pickup'));
}
function act(state: DemoState, actor: Actor, action: PickupAction) {
  return ok(applyDemoAction(state, 'pickup', actor, action, now));
}

test('handoff leaves responsibility with sender until recipient accepts', () => {
  let state = act(request(), mom, { type: 'accept' });
  state = act(state, mom, { type: 'offer', expectedVersion: 2, offerId: 'offer', toMemberId: dad.id });
  assert.equal(state.pickups[0].assigneeId, mom.id);
  const expired = setDemoTime(state, now + 15 * minute);
  assert.equal(expired.pickups[0].offer?.status, 'expired');
  assert.equal(expired.pickups[0].assigneeId, mom.id);
  assert.equal(expired.pickups[0].version, 2);
  state = act(state, dad, { type: 'respond_offer', expectedVersion: 2, offerId: 'offer', response: 'accept', vehicleId: car.id });
  assert.equal(state.pickups[0].assigneeId, dad.id);
  assert.equal(state.pickups[0].vehicleId, car.id);
});

test('navigation failure keeps departure and old callbacks do not arrive', () => {
  const setup = freshDemo();
  setup.vehicle.navFails = true;
  let state = act(request(setup), car, { type: 'vehicle_start', expectedVersion: 1, actionId: 'nav', sessionId: 'current' });
  assert.equal(state.pickups[0].status, 'en_route');
  assert.equal(state.vehicle.navError, true);
  const stale = applyDemoAction(state, 'pickup', car, { type: 'arrive', source: 'nav_callback', sessionId: 'old', destinationRevision: 1 }, now);
  assert.ok(stale.ok && stale.ignored);
  assert.equal(stale.state.pickups[0].status, 'en_route');
  state = act(state, car, { type: 'arrive', source: 'nav_callback', sessionId: 'current', destinationRevision: 1 });
  assert.equal(state.pickups[0].status, 'arrived');
  state = act(state, rider, { type: 'board', expectedVersion: 3 });
  assert.equal(state.pickups[0].status, 'completed');
  assert.equal(state.vehicle.activePickupId, null);
});

test('example GPS requires confirmation, while a saved point carries its note', () => {
  const gps = ok(createRequest(freshDemo(), rider, exampleGps, 0, now, 'pickup'));
  assert.equal(gps.pickups[0].destination.confirmed, false);
  const blocked = applyDemoAction(gps, 'pickup', car, { type: 'vehicle_start', expectedVersion: 1, actionId: 'nav', sessionId: 'current' }, now);
  assert.ok(!blocked.ok && blocked.code === 'LOCATION_UNCONFIRMED');
  const saved = request();
  assert.equal(saved.pickups[0].destination.confirmed, true);
  assert.equal(saved.pickups[0].destination.note, '후문 벤치 앞');
});

test('ready early updates a routine occurrence without accepting or creating a request', () => {
  const seed = freshDemo();
  const state = ok(routineOccurrence(seed, seed.routines[0], now, 'pickup'));
  assert.equal(state.pickups[0].acceptedAt, null);
  const ready = act(state, rider, { type: 'ready', expectedVersion: 1 });
  assert.equal(ready.pickups.length, 1);
  assert.equal(ready.pickups[0].readyAt, now);
  assert.equal(ready.pickups[0].acceptedAt, null);
});

test('unpairing keeps the assignee but frees the car, and only the code on the car pairs it again (F-05)', () => {
  let state = act(request(), dad, { type: 'accept', vehicleId: car.id });
  state = ok(unpairVehicle(state, now));
  assert.equal(vehiclePaired(state.vehicle), false);
  assert.equal(state.pickups[0].assigneeId, dad.id);
  assert.equal(state.pickups[0].vehicleId, null);
  assert.equal(state.vehicle.currentDriverId, null);
  assert.equal(state.routines.find((routine) => routine.id === 'math')?.vehicleId, '');
  const code = state.vehicle.pairing!.code;
  assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
  const failed = applyDemoAction(state, 'pickup', car, { type: 'vehicle_start', expectedVersion: state.pickups[0].version, sessionId: 's', actionId: 'a' }, now);
  assert.equal(failed.ok ? '' : failed.code, 'FORBIDDEN');
  const wrong = pairVehicle(state, code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA', '우리 차', 'mom', now);
  assert.equal(wrong.ok ? '' : wrong.code, 'CODE_INVALID');
  const late = pairVehicle(state, code, '우리 차', 'mom', now + 10 * minute);
  assert.equal(late.ok ? '' : late.code, 'CODE_EXPIRED');
  const notDriver = pairVehicle(state, code, '우리 차', 'aunt', now);
  assert.equal(notDriver.ok ? '' : notDriver.code, 'VALIDATION');
  state = ok(pairVehicle(state, `${code.slice(0, 3)}-${code.slice(3).toLowerCase()}`, ' 엄마 차 ', 'mom', now));
  assert.equal(vehiclePaired(state.vehicle), true);
  assert.equal(state.vehicle.name, '엄마 차');
  assert.equal(state.vehicle.currentDriverId, 'mom');
  assert.equal(state.vehicle.pairing, null);
  const again = pairVehicle(state, code, '우리 차', 'mom', now);
  assert.equal(again.ok ? '' : again.code, 'ALREADY_PAIRED');
  assert.equal(renewPairCode(state, now).ok, false);
});

test('driver changes only to an eligible member and never mid-trip (V-09)', () => {
  let state = freshDemo();
  const aunt = setVehicleDriver(state, 'aunt');
  assert.equal(aunt.ok ? '' : aunt.code, 'NOT_FOUND');
  state = ok(setVehicleDriver(state, 'mom'));
  assert.equal(state.vehicle.currentDriverId, 'mom');
  state = act(request(state), mom, { type: 'accept', vehicleId: car.id });
  state = act(state, { ...car, driverId: 'mom' }, { type: 'vehicle_start', expectedVersion: state.pickups[0].version, sessionId: 's', actionId: 'a' });
  const busy = setVehicleDriver(state, 'dad');
  assert.equal(busy.ok ? '' : busy.code, 'VEHICLE_BUSY');
});
