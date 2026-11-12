// SPEC 24 갈 사람이 없을 때 in the web app: the demo rules (24.7), the screen decisions and the live mapping (24.6).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { addDays, familyDate } from '@deriro/contracts';
import type { Actor, PickupAction } from '@deriro/contracts';
import { copy, spokenClock } from '../src/copy.ts';
import {
  applyDemoAction, createRequest, declineFromCar, demoSchema, demoStart, freshDemo, heldPickupIds, minute, pickupDay, routineOccurrence,
  setDemoTime, setDemoUnavailableDay, unavailableFor,
} from '../src/demo-domain.ts';
import type { Change, DemoState } from '../src/demo-domain.ts';
import {
  driverGaps, fallbackByName, fallbackKey, fallbackOptions, fallbackStage, isNobodyAvailable, noDriverSections, routineGap, unavailableGrid, waitNoteFor,
} from '../src/guardian-view.ts';
import { declarationTitle, riderView } from '../src/rider-view.ts';
import { vehicleView } from '../src/vehicle-view.ts';
import { decodeRpc, pickupActionRpc, unavailableDayParams, upsertPlaceParams } from '../src/live/api.ts';
import { guardianState, overviewSchema, riderState, riderStateSchema, todaySchema, unavailableDaySchema } from '../src/live/models.ts';

const rider = { kind: 'rider', id: 'minjun' } as const;
const mom = { kind: 'member', id: 'mom' } as const;
const dad = { kind: 'member', id: 'dad' } as const;
const car = { kind: 'vehicle', id: 'our-car', driverId: 'dad', parked: true } as const;
const point = { source: 'saved_point', pickupPointId: 'front' } as const;
/** Wednesday 2026-11-04 17:02 in Seoul; the math routine (dad, Mon/Wed/Fri 17:30) runs today. */
const now = demoStart;
const today = familyDate(now);
const hour = 60 * minute;
const memory = { hidden: [], seenOffers: [], rangeSeen: false };

function ok(result: Change): DemoState {
  assert.equal(result.ok, true, result.ok ? undefined : result.code);
  return result.state;
}
function code(result: Change) {
  return result.ok ? 'ok' : result.code;
}
function off(state: DemoState, day: string, ...members: string[]) {
  return members.reduce((current, member) => ok(setDemoUnavailableDay(current, member, day, true, now)), state);
}
const find = (state: DemoState, id: string) => state.pickups.find((pickup) => pickup.id === id)!;
const act = (state: DemoState, id: string, actor: Actor, action: PickupAction, at = now) => ok(applyDemoAction(state, id, actor, action, at));
const declare = (version: number, note = '학원 안에서 기다리기') => ({ type: 'no_driver', expectedVersion: version, note }) as const;

test('24.7: the demo stores days off and place notes under a new schema; the academy has its note and nobody is off', () => {
  const seed = freshDemo();
  assert.equal(demoSchema, 3);
  assert.deepEqual(seed.unavailableDays, []);
  assert.equal(seed.places.find((place) => place.id === 'academy')?.fallbackNote, '학원 안에서 기다리기');
  assert.equal(seed.places.filter((place) => place.fallbackNote).length, 1);
});

test('S-57: a request is made when every driver is off; the rider sees open_nobody with the note, guardians the nobody card', () => {
  let state = off(freshDemo(), today, 'mom', 'dad');
  state = ok(createRequest(state, rider, point, 0, now, 'p'));
  const pickup = find(state, 'p');
  assert.equal(pickup.status, 'open');
  assert.equal(isNobodyAvailable(state, pickup), true);
  assert.equal(waitNoteFor(state, pickup), '학원 안에서 기다리기');
  const view = riderView(state, rider, now);
  assert.equal(view.screen, 'open_nobody');
  assert.equal(view.callEmphasized, true);
  // open_nobody comes before open_escalated (5 minutes without an answer).
  assert.equal(riderView(state, rider, now + 6 * minute).screen, 'open_nobody');
  for (const member of ['mom', 'dad']) assert.deepEqual(noDriverSections(state, member, state.pickups, now, []).nobody.map(({ id }) => id), ['p'], member);
  // Someone accepting turns the rider's screen to "assigned" at once.
  assert.equal(riderView(act(state, 'p', mom, { type: 'accept' }), rider, now).screen, 'assigned');
  // With one driver available it is an ordinary open request.
  const one = ok(createRequest(off(freshDemo(), today, 'mom'), rider, point, 0, now, 'p'));
  assert.equal(riderView(one, rider, now).screen, 'open');
  assert.deepEqual(noDriverSections(one, 'dad', one.pickups, now, []).nobody, []);
});

test('S-58: the last available driver declining from the car leaves nobody; mom, off today, may still take it', () => {
  let state = ok(createRequest(off(freshDemo(), today, 'mom'), rider, point, 0, now, 'p'));
  assert.equal(isNobodyAvailable(state, find(state, 'p')), false);
  state = ok(declineFromCar(state, 'p', car, 1, now, 'offer'));
  assert.equal(isNobodyAvailable(state, find(state, 'p')), true);
  assert.equal(riderView(state, rider, now).screen, 'open_nobody');
  assert.equal(find(act(state, 'p', mom, { type: 'accept' }), 'p').assigneeId, 'mom');
});

test('S-59, S-61: "못 간다고 알리기" ends the request; the rider and the guardians follow its stages and display window', () => {
  let state = ok(createRequest(freshDemo(), rider, point, 0, now, 'p'));
  state = act(state, 'p', mom, declare(1, '  학원 안에서 기다리기 '));
  const pickup = find(state, 'p');
  assert.equal(pickup.status, 'cancelled');
  assert.equal(pickup.cancelReason, 'no_driver');
  assert.equal(pickup.fallbackNote, '학원 안에서 기다리기');
  assert.equal(pickup.fallbackBy, 'mom');
  assert.equal(pickup.offer?.status, 'cancelled');
  assert.ok(state.history.some((event) => event.event === 'no_driver' && event.actor === 'mom'));
  assert.equal(fallbackByName(state, pickup), '엄마');
  // The rider: no_driver, not bound by the 60-second rule; the call buttons grow after 5 minutes.
  const first = riderView(state, rider, now + minute);
  assert.equal(first.screen, 'no_driver');
  assert.equal(first.callEmphasized, false);
  assert.equal(riderView(state, rider, now + 5 * minute).callEmphasized, true);
  // Guardians: 확인 전, then 미확인 5분. Closing the first card brings it back at 5 minutes.
  assert.equal(fallbackStage(state, pickup, now + minute), 'sent');
  assert.equal(fallbackStage(state, pickup, now + 5 * minute), 'unacked');
  assert.equal(noDriverSections(state, 'dad', state.pickups, now + minute, [])[`fallback`][0].stage, 'sent');
  assert.equal(noDriverSections(state, 'mom', state.pickups, now + minute, []).fallback.length, 1, 'the declarer sees it too');
  const closed = [fallbackKey(pickup, 'sent')];
  assert.equal(noDriverSections(state, 'dad', state.pickups, now + 2 * minute, closed).fallback.length, 0);
  assert.equal(noDriverSections(state, 'dad', state.pickups, now + 5 * minute, closed).fallback[0].stage, 'unacked');
  // Shown until max(wanted time, declaration) + 3 hours, then idle.
  assert.equal(fallbackStage(state, pickup, now + 3 * hour - 1), 'unacked');
  assert.equal(fallbackStage(state, pickup, now + 3 * hour), null);
  assert.equal(riderView(state, rider, now + 3 * hour).screen, 'idle');
  // Other cancellations stay ordinary.
  const ordinary = act(ok(createRequest(freshDemo(), rider, point, 0, now, 'p')), 'p', mom, { type: 'cancel', expectedVersion: 1 });
  assert.equal(fallbackStage(ordinary, find(ordinary, 'p'), now), null);
  assert.equal(riderView(ordinary, rider, now).screen, 'cancelled');
});

test('S-60: "알겠어" records the time once; the rider sees no_driver_acked and the guardians "확인했어요" for 10 minutes', () => {
  let state = act(ok(createRequest(freshDemo(), rider, point, 0, now, 'p')), 'p', mom, declare(1));
  state = act(state, 'p', rider, { type: 'ack_fallback' }, now + 2 * minute);
  const pickup = find(state, 'p');
  assert.equal(pickup.fallbackAckAt, now + 2 * minute);
  assert.ok(state.history.some((event) => event.event === 'fallback_acknowledged' && event.actor === 'minjun'));
  const again = applyDemoAction(state, 'p', rider, { type: 'ack_fallback' }, now + 4 * minute);
  assert.equal(again.ok, true);
  assert.equal(again.state, state, 'a repeat changes neither the time nor the history');
  assert.equal(riderView(state, rider, now + 3 * minute).screen, 'no_driver_acked');
  assert.equal(riderView(state, rider, now + 3 * minute, { dismissed: 'p' }).screen, 'idle', '"다시 요청" puts it away');
  assert.equal(noDriverSections(state, 'dad', state.pickups, now + 3 * minute, []).fallback[0].stage, 'acked');
  assert.equal(fallbackStage(state, pickup, now + 12 * minute - 1), 'acked');
  assert.equal(fallbackStage(state, pickup, now + 12 * minute), null);
  // A guardian cannot acknowledge for the rider.
  assert.equal(code(applyDemoAction(state, 'p', mom, { type: 'ack_fallback' }, now)), 'FORBIDDEN');
});

test('S-62, S-63: only the assignee declares an assigned trip, and not once it has left', () => {
  const assigned = act(ok(createRequest(freshDemo(), rider, point, 0, now, 'p')), 'p', dad, { type: 'accept', vehicleId: 'our-car' });
  const refused = applyDemoAction(assigned, 'p', mom, declare(2), now);
  assert.equal(code(refused), 'NOT_ASSIGNEE');
  assert.equal(find(refused.state, 'p').assigneeId, 'dad');
  const enRoute = act(assigned, 'p', dad, { type: 'depart', expectedVersion: 2 });
  assert.equal(code(applyDemoAction(enRoute, 'p', dad, declare(3), now)), 'INVALID_STATE');
  // The requester cancels instead; a blank line is refused.
  const own = ok(createRequest(freshDemo(), mom, point, 0, now, 'p'));
  assert.equal(code(applyDemoAction(own, 'p', mom, declare(1), now)), 'FORBIDDEN');
  assert.equal(code(applyDemoAction(own, 'p', dad, declare(1, '  '), now)), 'VALIDATION');
});

test('24.1 #5: a trip its driver declared shows on the car as the existing cancelled card, nothing new', () => {
  let state = act(ok(createRequest(freshDemo(), rider, point, 0, now, 'p')), 'p', dad, { type: 'accept', vehicleId: 'our-car' });
  state = act(state, 'p', dad, declare(2, '셔틀 타기'));
  const view = vehicleView(state, now, memory);
  assert.equal(view.pickup?.id, 'p');
  assert.equal(view.pickup?.status, 'cancelled');
  assert.equal(view.pending.length, 0);
  assert.equal(code(applyDemoAction(state, 'p', car, { type: 'ack_fallback' }, now)), 'FORBIDDEN');
});

test('S-65: a day off makes a new occurrence open and reopens an untouched one; an accepted one stays and is held', () => {
  const routine = freshDemo().routines[0];
  const created = ok(routineOccurrence(off(freshDemo(), today, 'dad'), routine, now, 'r'));
  assert.equal(find(created, 'r').status, 'open');
  assert.equal(find(created, 'r').assigneeId, null);
  const made = ok(routineOccurrence(freshDemo(), routine, now, 'r'));
  assert.equal(find(made, 'r').assigneeId, 'dad');
  const marked = ok(setDemoUnavailableDay(made, 'dad', today, true, now));
  assert.equal(find(marked, 'r').status, 'open');
  assert.equal(find(marked, 'r').vehicleId, null);
  assert.ok(marked.history.some((event) => event.event === 'routine_reassigned' && event.actor === 'dad' && event.pickupId === 'r'));
  assert.deepEqual(heldPickupIds(marked, 'dad', today), []);
  assert.equal(routineGap(marked, routine, now), true);
  assert.equal(routineGap(made, routine, now), false);
  const accepted = act(made, 'r', dad, { type: 'accept' });
  const kept = ok(setDemoUnavailableDay(accepted, 'dad', today, true, now));
  assert.equal(find(kept, 'r').assigneeId, 'dad');
  assert.deepEqual(heldPickupIds(kept, 'dad', today), ['r']);
  // Own days only, today to 60 days ahead, by a guardian who drives.
  assert.equal(code(setDemoUnavailableDay(made, 'dad', addDays(today, -1), true, now)), 'VALIDATION');
  assert.equal(code(setDemoUnavailableDay(made, 'dad', addDays(today, 61), true, now)), 'VALIDATION');
  assert.equal(code(setDemoUnavailableDay(made, 'aunt', today, true, now)), 'FORBIDDEN');
});

test('S-66: clearing the day gives the untouched open occurrence back, unless it was already offered to everyone', () => {
  const routine = freshDemo().routines[0];
  const marked = ok(setDemoUnavailableDay(ok(routineOccurrence(freshDemo(), routine, now, 'r')), 'dad', today, true, now));
  const cleared = ok(setDemoUnavailableDay(marked, 'dad', today, false, now));
  assert.equal(find(cleared, 'r').status, 'assigned');
  assert.equal(find(cleared, 'r').assigneeId, 'dad');
  assert.equal(find(cleared, 'r').vehicleId, 'our-car');
  // 17:12 is past the 17:10 notify time: the scheduler offers it to everyone, and clearing then leaves it open.
  const announced = setDemoTime(marked, now + 10 * minute);
  assert.equal(find(announced, 'r').offer?.status, 'pending');
  assert.equal(find(ok(setDemoUnavailableDay(announced, 'dad', today, false, now + 10 * minute)), 'r').status, 'open');
});

test('S-69: after a declaration the rider may ask again; the new request replaces the declaration screen', () => {
  let state = act(ok(createRequest(freshDemo(), rider, point, 0, now, 'p')), 'p', mom, declare(1));
  assert.equal(riderView(state, rider, now).screen, 'no_driver');
  state = ok(createRequest(state, rider, point, 0, now + minute, 'q'));
  const view = riderView(state, rider, now + minute);
  assert.equal(view.current?.id, 'q');
  assert.equal(view.screen, 'open');
});

test('24.5: a routine occurrence that ended with no_driver shows the declaration instead of the routine card', () => {
  const routine = freshDemo().routines[0];
  let state = ok(routineOccurrence(freshDemo(), routine, now, 'r'));
  assert.equal(riderView(state, rider, now).screen, 'routine_card');
  state = act(state, 'r', dad, declare(1));
  assert.equal(riderView(state, rider, now).screen, 'no_driver');
});

test('24.7: the demo makes tomorrow\'s occurrences for "내일", keeps them off the rider\'s card and other cars until announced', () => {
  const state = setDemoTime(freshDemo(), now);
  const tomorrow = state.pickups.filter((pickup) => pickupDay(pickup) === addDays(today, 1));
  assert.deepEqual(tomorrow.map((pickup) => state.occurrences[pickup.id]), ['music']);
  assert.equal(tomorrow[0].status, 'open');
  assert.equal(setDemoTime(state, now + minute).pickups.length, state.pickups.length, 'made once');
  assert.deepEqual(noDriverSections(state, 'mom', state.pickups, now, []).tomorrow.map(({ id }) => id), [tomorrow[0].id]);
  assert.deepEqual(noDriverSections(state, 'mom', state.pickups, now, []).nobody, [], 'tomorrow is not "지금"');
  assert.equal(isNobodyAvailable(state, tomorrow[0]), false);
  assert.equal(isNobodyAvailable(off(state, addDays(today, 1), 'mom', 'dad'), tomorrow[0]), true);
  assert.ok(!vehicleView(state, now, memory).visible.some((pickup) => pickup.id === tomorrow[0].id));
  // A routine card only within the server's window (an hour before to three hours after now).
  const seed = freshDemo();
  seed.routines[0] = { ...seed.routines[0], days: [3] };
  const thursday = setDemoTime(seed, now);
  const math = thursday.pickups.find((pickup) => thursday.occurrences[pickup.id] === 'math')!;
  assert.equal(math.assigneeId, 'dad');
  assert.equal(riderView(thursday, rider, now).screen, 'idle');
  assert.equal(riderView(thursday, rider, math.wantedAt - 2 * hour).screen, 'routine_card');
  // Tomorrow's default driver off tomorrow: the occurrence is made open.
  const offTomorrow = setDemoTime(off(seed, addDays(today, 1), 'dad'), now);
  assert.equal(offTomorrow.pickups.find((pickup) => offTomorrow.occurrences[pickup.id] === 'math')?.status, 'open');
});

test('P-18 choices: the place note first, presets without repeats; a pickup without a place has presets only', () => {
  assert.deepEqual(fallbackOptions('학원 안에서 기다리기', copy.fallbackPresets).map(({ note, place }) => [note, place]), [
    ['학원 안에서 기다리기', true], ['안에서 기다리기', false], ['셔틀 타기', false], ['걸어서 집에 오기', false], ['전화 기다리기', false],
  ]);
  assert.deepEqual(fallbackOptions('셔틀 타기', copy.fallbackPresets).map(({ note }) => note), ['셔틀 타기', '안에서 기다리기', '걸어서 집에 오기', '전화 기다리기']);
  assert.equal(fallbackOptions(null, copy.fallbackPresets)[0].note, '안에서 기다리기');
  const pinned = ok(createRequest(freshDemo(), rider, { source: 'map_pin', lat: 37.49, lng: 127.04, label: '역삼동 근처' }, 0, now, 'p'));
  assert.equal(waitNoteFor(pinned, find(pinned, 'p')), null);
});

test('P-19: the 14 days, and the routine days that need a driver because the default one is off', () => {
  const days = unavailableGrid(now);
  assert.equal(days.length, 14);
  assert.equal(days[0], today);
  assert.equal(days[13], addDays(today, 13));
  let state = off(freshDemo(), today, 'dad');
  state = off(state, addDays(today, 2), 'dad', 'mom');
  state = off(state, addDays(today, 5), 'dad');
  state = off(state, addDays(today, 1), 'dad');
  const gaps = driverGaps(state, now);
  // Wednesday (today), Friday (both off), next Monday. Thursday has no math routine.
  assert.deepEqual(gaps.map((gap) => [gap.day, gap.nobody, gap.pickup?.id ?? null]), [[today, false, null], [addDays(today, 2), true, null], [addDays(today, 5), false, null]]);
  const made = ok(routineOccurrence(state, state.routines[0], now, 'r'));
  assert.equal(driverGaps(made, now)[0].pickup?.id, 'r', 'an occurrence already made is a link');
  assert.equal(driverGaps(act(made, 'r', mom, { type: 'accept' }), now)[0].day, addDays(today, 2), 'a held one needs no decision');
  assert.equal(driverGaps(state, now + hour)[0].day, addDays(today, 2), 'a time already past is gone');
  assert.deepEqual(unavailableFor(state, find(made, 'r')), ['dad']);
});

test('24.5 copy: the date words of the declaration and the names of who is looking for a way', () => {
  const at = Date.parse('2026-11-05T17:30:00+09:00');
  const wanted = (wantedAt: number) => ({ ...ok(createRequest(freshDemo(), rider, point, 0, now, 'p')).pickups[0], wantedAt });
  assert.equal(spokenClock(at), '5시 30분');
  assert.equal(spokenClock(Date.parse('2026-11-05T18:00:00+09:00')), '6시');
  assert.equal(declarationTitle(wanted(now), now), '오늘은 데리러 못 가');
  assert.equal(declarationTitle(wanted(at), now), '내일 5시 30분은 데리러 못 가');
  assert.equal(declarationTitle(wanted(Date.parse('2026-11-05T18:00:00+09:00')), now), '내일 6시는 데리러 못 가');
  assert.equal(copy.nobodyFinding(['엄마', '아빠']), '엄마, 아빠가 방법을 찾고 있어');
  assert.equal(copy.nobodyFinding(['민준']), '민준이 방법을 찾고 있어');
  assert.equal(copy.nobodyFinding([]), '가족이 방법을 찾고 있어');
  assert.equal(copy.unavailableDefault('아빠'), '기본 담당 아빠가 못 가는 날');
  assert.equal(copy.noDriverRecord('엄마'), '엄마가 못 간다고 알림');
  assert.equal(copy.fallbackAckRecord('민준'), '민준이 확인');
});

function fixture(name: string) {
  return JSON.parse(readFileSync(new URL(`../../../supabase/tests/fixtures/${name}.json`, import.meta.url), 'utf8'));
}

test('live P-04 reads the server\'s nobody flag, days off, place note and the declaration from get_today', () => {
  const overview = decodeRpc(fixture('get_family_overview'), overviewSchema);
  const today = decodeRpc(fixture('get_today_nobody_available'), todaySchema);
  const at = Date.parse(today.server_time!);
  const state = guardianState(overview, today, undefined, at);
  const mom = '80000000-0000-4000-8000-000000000011';
  assert.deepEqual(state.unavailableDays, [{ memberId: mom, day: '2026-11-12' }]);
  const open = state.pickups.find((pickup) => pickup.status === 'open')!;
  assert.equal(isNobodyAvailable(state, open), true);
  assert.equal(waitNoteFor(state, open), '학원 안에서 기다리기');
  assert.deepEqual(unavailableFor(state, open), [mom]);
  const declared = state.pickups.find((pickup) => pickup.cancelReason === 'no_driver')!;
  assert.equal(declared.fallbackNote, '학원 안에서 기다리기');
  assert.equal(declared.fallbackBy, mom);
  assert.equal(declared.fallbackAckAt, at);
  // The overview fixture is another family: the name comes from the row's fallback_by_name.
  assert.equal(fallbackByName(state, declared), '엄마');
  assert.equal(fallbackStage(state, declared, at), 'acked');
  const sections = noDriverSections(state, overview.members[0].id, state.pickups, at, []);
  assert.deepEqual(sections.nobody.map(({ id }) => id), [open.id]);
  assert.deepEqual(sections.fallback.map(({ pickup, stage }) => [pickup.id, stage]), [[declared.id, 'acked']]);
});

test('live C-03 reads the declaration, its name and the call escalation from rider_get_state', () => {
  const data = decodeRpc(fixture('rider_get_state_no_driver'), riderStateSchema);
  const at = Date.parse(data.server_time);
  const requester = { kind: 'rider', id: data.rider.id } as const;
  const state = riderState(data, at);
  assert.equal(state.places[0].fallbackNote, '학원 안에서 기다리기');
  const view = riderView(state, requester, at);
  assert.equal(view.screen, 'no_driver');
  assert.equal(view.callEmphasized, false);
  assert.equal(view.current?.fallbackNote, '학원 안에서 기다리기');
  assert.equal(fallbackByName(state, view.current!), '엄마');
  assert.equal(riderView(state, requester, at + 5 * minute).callEmphasized, true);
  const row = data.actives[0];
  assert.equal(riderView(riderState({ ...data, actives: [{ ...row, escalation_stage: 1 }] }, at), requester, at).callEmphasized, true);
  const acked = riderState({ ...data, actives: [{ ...row, fallback_ack_at: data.server_time }] }, at);
  assert.equal(riderView(acked, requester, at + minute).screen, 'no_driver_acked');
  const open = riderState({ ...data, actives: [{ ...row, status: 'open', cancel_reason: null, cancelled_at: null, fallback_note: null, fallback_by_member_id: null, nobody_available: true }] }, at);
  assert.equal(riderView(open, requester, at).screen, 'open_nobody');
  assert.equal(waitNoteFor(open, open.pickups[0]), '학원 안에서 기다리기');
});

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

test('live RPCs for 24장 send the exact SQL parameters', () => {
  const id = '80000000-0000-4000-8000-000000000099';
  assert.deepEqual(pickupActionRpc(id, { type: 'no_driver', expectedVersion: 3, note: '셔틀 타기' }), ['declare_no_driver', { p_pickup_id: id, p_expected_version: 3, p_note: '셔틀 타기' }]);
  assert.deepEqual(pickupActionRpc(id, { type: 'ack_fallback' }, 'rider'), ['ack_fallback', { p_pickup_id: id }]);
  assert.deepEqual(pickupActionRpc(id, { type: 'ack_fallback' }), ['ack_fallback', { p_pickup_id: id }]);
  assert.deepEqual(unavailableDayParams('2026-11-13', true), { p_day: '2026-11-13', p_unavailable: true });
  const place = { label: ' 수학학원 ', kind: 'academy', lat: 37.5, lng: 127.03, radiusM: 150, fallbackNote: '  안에서 기다리기 ' };
  assert.equal(upsertPlaceParams(place).p_fallback_note, '안에서 기다리기');
  assert.equal(upsertPlaceParams({ ...place, fallbackNote: '   ' }).p_fallback_note, '', 'blank clears the note');
  const signatures = sqlSignatures();
  const calls: [string, Record<string, unknown>][] = [
    pickupActionRpc(id, { type: 'no_driver', expectedVersion: 3, note: '셔틀 타기' }),
    pickupActionRpc(id, { type: 'ack_fallback' }, 'rider'),
    ['set_unavailable_day', unavailableDayParams('2026-11-13', false)],
    ['upsert_place', upsertPlaceParams({ ...place, id })],
    ['upsert_place', upsertPlaceParams(place)],
  ];
  for (const [name, args] of calls) {
    const signature = signatures.get(name);
    assert.ok(signature, `${name} exists in the migrations`);
    const sent = Object.keys(args).filter((key) => args[key] !== undefined);
    for (const key of sent) assert.ok(signature.all.includes(key), `${name} has ${key}`);
    for (const key of signature.required) assert.ok(sent.includes(key), `${name} sends ${key}`);
  }
  assert.deepEqual(decodeRpc({ ok: true, data: { days: [{ member_id: id, day: '2026-11-13' }], held_pickup_ids: [id] } }, unavailableDaySchema).held_pickup_ids, [id]);
});
