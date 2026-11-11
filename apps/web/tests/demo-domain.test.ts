import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Actor, PickupAction } from '@deriro/contracts';
import { applyDemoAction, createRequest, declineFromCar, demoStart, exampleGps, freshDemo, minute, pairVehicle, renewPairCode, reviseRoutine, routineOccurrence, setDemoTime, setVehicleDriver, unpairVehicle, vehiclePaired, weekdayAt } from '../src/demo-domain.ts';
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

test('requests carry their family-wide offer and are not refused while nobody can drive (4.3 #1, F-08)', () => {
  const offer = request().pickups[0].offer;
  assert.equal(offer?.status, 'pending');
  assert.equal(offer?.fromMemberId, null);
  assert.equal(offer?.toMemberId, null);
  assert.equal(offer?.expiresAt, now + 60 * minute);
  const nobody = freshDemo();
  nobody.members = nobody.members.map((member) => ({ ...member, canDrive: false }));
  assert.equal(createRequest(nobody, rider, point, 0, now, 'pickup').ok, true);
});

test('an occurrence carries its routine notify time, which bounds a handoff on it (F-11)', () => {
  const seed = freshDemo();
  seed.routines[0] = { ...seed.routines[0], before: 30 };
  let state = ok(routineOccurrence(seed, seed.routines[0], now, 'pickup'));
  assert.equal(state.pickups[0].notifyBeforeMin, 30);
  state = act(state, dad, { type: 'offer', expectedVersion: 1, offerId: 'offer', toMemberId: mom.id });
  // 17:30 - 30 minutes has passed at 17:02, so the 5-minute fallback applies (with 20 it would be 17:10).
  assert.equal(state.pickups[0].offer?.expiresAt, now + 5 * minute);
});

test('the demo clock offers an open occurrence to every driver at its notify time, once (4.4 #4, F-15)', () => {
  const seed = freshDemo();
  seed.routines[1] = { ...seed.routines[1], days: [weekdayAt(now)], time: '17:30' };
  assert.equal(setDemoTime(seed, now).pickups.length, 0);
  const announced = setDemoTime(seed, now + 8 * minute);
  const music = (state: DemoState) => state.pickups.find((pickup) => state.occurrences[pickup.id] === 'music')!;
  const occurrence = music(announced);
  assert.equal(occurrence.status, 'open');
  assert.equal(occurrence.offer?.status, 'pending');
  assert.equal(occurrence.offer?.fromMemberId, null);
  assert.equal(occurrence.offer?.expiresAt, occurrence.wantedAt);
  const lapsed = setDemoTime(announced, occurrence.wantedAt);
  assert.equal(music(lapsed).offer?.status, 'expired');
  assert.ok(lapsed.history.some((event) => event.event === 'offer_expired' && event.pickupId === occurrence.id));
  assert.equal(music(setDemoTime(lapsed, occurrence.wantedAt + 5 * minute)).offer?.status, 'expired');
});

test('"못 가요" records the refusal of the driver; the last eligible driver closes the request offer (F-12, 8.7)', () => {
  const declined = ok(declineFromCar(request(), 'pickup', car, 1, now, 'offer'));
  assert.equal(declined.pickups[0].offer?.status, 'pending');
  assert.deepEqual(declined.pickups[0].offer?.declinedBy, [dad.id]);
  assert.ok(declined.history.some((event) => event.event === 'request_declined' && event.actor === dad.id));
  let own = ok(createRequest(freshDemo(), mom, point, 0, now, 'pickup'));
  own = ok(declineFromCar(own, 'pickup', car, 1, now, 'offer'));
  assert.equal(own.pickups[0].status, 'open');
  assert.equal(own.pickups[0].offer?.status, 'declined');
  // 4.3 #3: the driver who declined may still accept.
  assert.equal(act(own, dad, { type: 'accept' }).pickups[0].assigneeId, dad.id);
});

test('a car that lost the race hears who took the trip by name, with or without the request offer ID (V-03, 4.5)', () => {
  const requested = request();
  const taken = act(requested, mom, { type: 'accept' });
  const start = { type: 'vehicle_start', expectedVersion: 1, sessionId: 's', actionId: 'a' } as const;
  // The request card sends no offer ID, or the family-wide offer's ID it was drawn with.
  for (const offerId of [undefined, requested.pickups[0].offer?.id]) {
    const lost = applyDemoAction(taken, 'pickup', car, { ...start, offerId }, now);
    assert.equal(lost.ok ? 'ok' : lost.code, 'ALREADY_TAKEN');
    assert.equal(lost.ok ? undefined : lost.by, '엄마');
    assert.equal(lost.state, taken);
  }
  // A guardian who accepts too late is told the same name.
  const late = applyDemoAction(taken, 'pickup', dad, { type: 'accept' }, now);
  assert.equal(late.ok ? 'ok' : late.code, 'ALREADY_TAKEN');
  assert.equal(late.ok ? undefined : late.by, '엄마');
  // Other refusals name nobody.
  const stale = applyDemoAction(requested, 'pickup', car, { ...start, expectedVersion: 9 }, now);
  assert.equal(stale.ok ? 'ok' : stale.code, 'STALE_VERSION');
  assert.equal(stale.ok ? undefined : stale.by, undefined);
});

test('a routine edit moves its untouched occurrences, keeps accepted ones, and a delete cancels the rest (4.4 #12, S-28)', () => {
  const seed = freshDemo();
  const state = ok(routineOccurrence(seed, seed.routines[0], now, 'pickup'));
  const toMom = { ...seed.routines[0], assigneeId: mom.id, vehicleId: '', time: '17:40' };
  const moved = reviseRoutine(state, toMom, now);
  assert.equal(moved.pickups[0].assigneeId, mom.id);
  assert.equal(moved.pickups[0].vehicleId, null);
  assert.equal(moved.pickups[0].wantedAt, state.pickups[0].wantedAt + 10 * minute);
  assert.equal(moved.pickups[0].assignmentRound, 2);
  assert.ok(moved.history.some((event) => event.event === 'routine_reassigned' && event.actor === 'system'));
  const accepted = act(state, dad, { type: 'accept' });
  assert.equal(reviseRoutine(accepted, toMom, now).pickups[0].assigneeId, dad.id);
  assert.equal(reviseRoutine(state, seed.routines[0], now, true).pickups[0].status, 'cancelled');
  assert.equal(reviseRoutine(accepted, seed.routines[0], now, true).pickups[0].status, 'assigned');
  assert.equal(reviseRoutine(state, { ...toMom, enabled: false }, now), state);
});
