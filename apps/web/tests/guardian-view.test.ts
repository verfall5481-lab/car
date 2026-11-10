import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { requestRecipients } from '@deriro/contracts';
import { decodeRpc } from '../src/live/api.ts';
import { guardianState, overviewSchema, todaySchema } from '../src/live/models.ts';
import { createRequest, freshDemo, demoStart } from '../src/demo-domain.ts';
import type { DemoState } from '../src/demo-domain.ts';
import { guardianOffer } from '../src/guardian-view.ts';

type Row = Record<string, unknown> & { offer: Record<string, unknown> };

function fixture(name: string) {
  return JSON.parse(readFileSync(new URL(`../../../supabase/tests/fixtures/${name}.json`, import.meta.url), 'utf8'));
}

const overview = decodeRpc(fixture('get_family_overview'), overviewSchema);

/** get_today as the server returns it, with its active row rewritten. */
function liveToday(rewrite: (row: Row) => Row): DemoState {
  const raw = fixture('get_today');
  raw.data.active = raw.data.active.map(rewrite);
  return guardianState(overview, decodeRpc(raw, todaySchema), undefined, 100_000);
}

const openRequest = (row: Row, declinedBy: string[] = []): Row => ({
  ...row, status: 'open', assignee_member_id: null, assignee_display_name: null, vehicle_id: null, accepted_at: null,
  assignment_round: 0,
  offer: { ...row.offer, origin: 'request', from_member_id: null, to_member_id: null, note: null, declined_by: declinedBy },
});

function views(state: DemoState) {
  const pickup = state.pickups[0];
  return state.members.map((member) => ({
    member: member.id,
    ...guardianOffer(pickup, member.id, requestRecipients(pickup, state.members).memberIds.includes(member.id)),
  }));
}

test('live P-04: an open request with its family-wide offer is "내가 갈게" for every driver, not a handoff', () => {
  const state = liveToday((row) => openRequest(row));
  assert.equal(state.pickups[0].offer?.status, 'pending');
  assert.equal(state.pickups[0].offer?.fromMemberId, null);
  for (const view of views(state)) {
    assert.equal(view.received, null, view.member);
    assert.equal(view.sent, null, view.member);
    assert.equal(view.canAccept, true, view.member);
  }
});

test('live P-04: a driver whose car declined the request may still accept it (4.3 #3)', () => {
  const declined = overview.members.map((member) => member.id);
  for (const view of views(liveToday((row) => openRequest(row, declined)))) assert.equal(view.canAccept, true, view.member);
});

test('live P-04: a handoff to me is "나에게 온 부탁" and the sender sees it as sent', () => {
  const state = liveToday((row) => row);
  const offer = state.pickups[0].offer!;
  const [receiver] = views(state).filter((view) => view.member === offer.toMemberId);
  const [sender] = views(state).filter((view) => view.member === offer.fromMemberId);
  assert.equal(receiver.received?.id, offer.id);
  assert.equal(receiver.canAccept, false);
  assert.equal(sender.sent?.id, offer.id);
  assert.equal(sender.received, null);
});

test('demo P-04: a fresh request reads the same as the live one', () => {
  const created = createRequest(freshDemo(), { kind: 'rider', id: 'minjun' }, { source: 'saved_place', placeId: 'academy' }, 0, demoStart, 'p');
  assert.equal(created.ok, true);
  for (const view of views(created.state)) {
    assert.equal(view.received, null, view.member);
    assert.equal(view.canAccept, view.member !== 'aunt', view.member);
  }
});
