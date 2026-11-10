// The scenario table. Each scenario names the SPEC scenario (S-xx) or section it checks. Expectations are what
// SPEC requires; both implementations must meet them and agree with each other on every comparable field.
// Unless a scenario overrides it, the family is `defaultFamily` in model.ts: 엄마 (mom) and 아빠 (dad) drive,
// 이모 (aunt) cannot drive, rider 민준 (minjun), and 아빠's car (car), parked.
import { defaultFamily } from "./model.ts";
import type { RequestSpec, RoutineSpec, Scenario } from "./model.ts";

function request(overrides: Partial<RequestSpec> = {}): RequestSpec {
  return { key: "p", kind: "request", by: "minjun", at: { place: "academy" }, ...overrides };
}

function routine(overrides: Partial<RoutineSpec> = {}): RoutineSpec {
  return { key: "p", kind: "routine", rider: "minjun", place: "academy", wantedInMin: 60, ...overrides };
}

const twoRiders = { riders: [...defaultFamily.riders, { key: "seoyeon", name: "서연" }] };
const grandpa = { members: [...defaultFamily.members, { key: "grandpa", name: "할아버지" }] };
const lowAccuracyGps = { gps: { lat: 37.4981, lng: 127.0441, accuracyM: 900 } };

export const scenarios: readonly Scenario[] = [
  {
    name: "1. S-01, F-13: request, accept, depart, manual arrival, rider boards; arrival alone never completes (S-20 principle)",
    pickups: [request()],
    created: { p: { status: "open", confirmed: true, version: 1, round: 0, set: [], offer: { from: null, to: null, expiresInMin: 60 } } },
    steps: [
      {
        actor: "mom", do: { type: "accept" },
        expect: {
          status: "assigned", assignee: "mom", vehicle: null, version: 2, round: 1, set: ["acceptedAt"],
          offer: null, resolved: { from: null, status: "accepted", by: "mom" }, events: ["accepted"],
        },
      },
      { actor: "minjun", do: { type: "board" }, expect: { code: "INVALID_STATE", status: "assigned", events: [] } },
      {
        actor: "mom", do: { type: "depart" },
        expect: { status: "en_route", version: 3, set: ["acceptedAt", "enRouteAt"], navSession: false, events: ["en_route"] },
      },
      {
        actor: "mom", do: { type: "arrive" },
        expect: { status: "arrived", version: 4, set: ["acceptedAt", "enRouteAt", "arrivedAt"], events: ["arrived"] },
      },
      { clock: 45 },
      { actor: "system", do: { type: "sweep" }, expect: { status: "arrived", version: 4, events: [] } },
      {
        actor: "minjun", do: { type: "board" },
        expect: { status: "completed", version: 5, events: ["completed"], sql: { stamps: ["completedAt"] } },
      },
      { actor: "minjun", do: { type: "board" }, expect: { code: "INVALID_STATE", status: "completed", events: [] } },
    ],
  },
  {
    name: "2. S-02, S-37: a later driver gets ALREADY_TAKEN; the winner's retry succeeds without a second event",
    pickups: [request()],
    steps: [
      { actor: "mom", do: { type: "accept" }, expect: { assignee: "mom", version: 2, events: ["accepted"] } },
      { actor: "dad", do: { type: "accept" }, expect: { code: "ALREADY_TAKEN", assignee: "mom", version: 2, events: [] } },
      { actor: "mom", do: { type: "accept" }, expect: { assignee: "mom", version: 2, events: [] } },
      { actor: "mom", do: { type: "depart" }, expect: { status: "en_route", version: 3 } },
      { actor: "dad", do: { type: "accept" }, expect: { code: "ALREADY_TAKEN", status: "en_route", events: [] } },
      { actor: "mom", do: { type: "accept" }, expect: { status: "en_route", version: 3, events: [] } },
      // F-10, V-03 button table: the car that loses also hears who took it ("엄마가 먼저 맡았어요").
      {
        actor: "car", do: { type: "accept" }, divergence: "vehicle-sees-not-found",
        expect: { code: "ALREADY_TAKEN", assignee: "mom", events: [] },
      },
    ],
  },
  {
    name: "3. S-52, S-53: a guardian requester cannot accept their own request; a can_drive=false member cannot accept",
    pickups: [request({ by: "mom", at: { point: "back" } })],
    created: { p: { status: "open", confirmed: true, offer: { from: null, to: null } } },
    steps: [
      { actor: "mom", do: { type: "accept" }, expect: { code: "FORBIDDEN", status: "open", events: [] } },
      { actor: "aunt", do: { type: "accept" }, expect: { code: "FORBIDDEN", status: "open", events: [] } },
      { actor: "dad", do: { type: "accept", vehicle: "car" }, expect: { assignee: "dad", vehicle: "car", events: ["accepted"] } },
    ],
  },
  {
    name: "4. S-07, S-08: a directed handoff keeps the assignee until the target accepts; a decline keeps it too",
    pickups: [routine({ assignee: "mom" })],
    created: { p: { status: "assigned", assignee: "mom", round: 1, set: [], offer: null } },
    steps: [
      {
        actor: "mom", do: { type: "accept" },
        expect: { assignee: "mom", version: 2, round: 1, set: ["acceptedAt"], events: ["accepted"], sql: { customized: true } },
      },
      {
        actor: "mom", do: { type: "offer", to: "dad" },
        expect: { assignee: "mom", version: 2, offer: { from: "mom", to: "dad", declinedBy: [], expiresInMin: 10 }, events: ["offered"] },
      },
      {
        actor: "dad", do: { type: "respond", response: "decline" },
        expect: {
          assignee: "mom", version: 2, offer: null, resolved: { from: "mom", status: "declined", by: "dad" },
          events: ["offer_declined"],
        },
      },
      { actor: "mom", do: { type: "offer", to: "dad" }, expect: { offer: { from: "mom", to: "dad" }, events: ["offered"] } },
      { actor: "dad", do: { type: "respond", response: "accept", vehicle: "aunt" }, expect: { code: "VALIDATION", assignee: "mom" } },
      {
        actor: "dad", do: { type: "respond", response: "accept", vehicle: "car" },
        expect: {
          assignee: "dad", vehicle: "car", version: 3, round: 2, set: ["acceptedAt"], offer: null,
          resolved: { from: "mom", status: "accepted", by: "dad" }, events: ["offer_accepted"],
        },
      },
      { actor: "dad", do: { type: "respond", response: "accept" }, expect: { assignee: "dad", version: 3, events: [] } },
      { actor: "mom", do: { type: "depart" }, expect: { code: "NOT_ASSIGNEE", status: "assigned", events: [] } },
    ],
  },
  {
    name: "5. F-11, 4.4 #7: a handoff to everyone survives one decline and closes when every target declines; the sender cannot accept it",
    family: grandpa,
    pickups: [request()],
    steps: [
      { actor: "mom", do: { type: "accept" }, expect: { assignee: "mom" } },
      {
        actor: "mom", do: { type: "offer" },
        expect: { offer: { from: "mom", to: null, declinedBy: [], expiresInMin: 5 }, events: ["offered"] },
      },
      {
        actor: "mom", do: { type: "respond", response: "accept" },
        expect: { code: "CANNOT_ACCEPT_OWN_OFFER", offer: { from: "mom", to: null }, events: [] },
      },
      { actor: "aunt", do: { type: "respond", response: "decline" }, expect: { code: "FORBIDDEN", events: [] } },
      {
        actor: "dad", do: { type: "respond", response: "decline" },
        expect: { offer: { from: "mom", to: null, declinedBy: ["dad"] }, resolved: null, events: ["offer_declined"] },
      },
      {
        actor: "dad", do: { type: "respond", response: "decline" },
        expect: { offer: { from: "mom", to: null, declinedBy: ["dad"] }, events: [] },
      },
      {
        actor: "grandpa", do: { type: "respond", response: "decline" },
        expect: {
          assignee: "mom", offer: null, resolved: { from: "mom", status: "declined", by: "grandpa" }, events: ["offer_declined"],
        },
      },
      { actor: "grandpa", do: { type: "respond", response: "accept" }, expect: { code: "OFFER_NOT_PENDING", assignee: "mom" } },
    ],
  },
  {
    name: "6. S-28, 4.4 #9: a default assignee who offered the trip away and then confirms it withdraws the offer",
    pickups: [routine({ assignee: "dad", vehicle: "car" })],
    steps: [
      {
        actor: "dad", do: { type: "offer", to: "mom" },
        expect: { assignee: "dad", version: 1, offer: { from: "dad", to: "mom" }, events: ["offered"], sql: { customized: true } },
      },
      {
        actor: "dad", do: { type: "accept" },
        expect: {
          assignee: "dad", vehicle: "car", version: 2, round: 1, set: ["acceptedAt"], offer: null,
          resolved: { from: "dad", status: "cancelled", by: "dad" }, events: ["accepted"], sql: { customized: true },
        },
      },
      { actor: "mom", do: { type: "respond", response: "accept" }, expect: { code: "OFFER_NOT_PENDING", assignee: "dad" } },
      { actor: "dad", do: { type: "accept" }, expect: { assignee: "dad", version: 2, events: [] } },
    ],
  },
  {
    name: "7. F-12, 4.4 #3 and #9: the car's \"못 가요\" offers its own trip to everyone; the driver confirming by phone withdraws it",
    pickups: [routine({ assignee: "dad", vehicle: "car" })],
    steps: [
      {
        actor: "car", do: { type: "vehicle_decline" },
        expect: { assignee: "dad", version: 1, offer: { from: "dad", to: null, declinedBy: [] }, events: ["offered"] },
      },
      {
        actor: "dad", do: { type: "accept" },
        expect: { assignee: "dad", offer: null, resolved: { from: "dad", status: "cancelled", by: "dad" }, events: ["accepted"] },
      },
    ],
  },
  {
    name: "8. S-09: \"내가 대신 갈게\" takes the trip and cancels the pending offer; it is refused once the trip is en route",
    pickups: [routine({ assignee: "mom" })],
    steps: [
      { actor: "mom", do: { type: "offer", to: "dad" }, expect: { offer: { from: "mom", to: "dad" } } },
      { actor: "aunt", do: { type: "take_over" }, expect: { code: "FORBIDDEN", assignee: "mom", events: [] } },
      {
        actor: "dad", do: { type: "take_over" },
        expect: {
          assignee: "dad", version: 2, round: 2, set: ["acceptedAt"], offer: null,
          resolved: { from: "mom", status: "cancelled", by: null }, events: ["took_over"], sql: { customized: true },
        },
      },
      { actor: "dad", do: { type: "take_over" }, expect: { assignee: "dad", version: 2, events: [] } },
      { actor: "dad", do: { type: "depart" }, expect: { status: "en_route", events: ["en_route"] } },
      { actor: "mom", do: { type: "take_over" }, expect: { code: "ALREADY_EN_ROUTE", assignee: "dad", events: [] } },
    ],
  },
  {
    name: "9. S-40: the sender departing while a handoff is pending cancels the offer",
    pickups: [request()],
    steps: [
      { actor: "mom", do: { type: "accept" }, expect: { assignee: "mom" } },
      { actor: "mom", do: { type: "offer", to: "dad" }, expect: { offer: { from: "mom", to: "dad" } } },
      {
        actor: "mom", do: { type: "depart" },
        expect: {
          status: "en_route", assignee: "mom", offer: null, resolved: { from: "mom", status: "cancelled", by: null },
          events: ["en_route"],
        },
      },
      { actor: "dad", do: { type: "respond", response: "accept" }, expect: { code: "OFFER_NOT_PENDING", assignee: "mom", events: [] } },
    ],
  },
  {
    name: "10. S-41: an offer past its expiry is stored expired when the target answers (no cron needed)",
    pickups: [request()],
    steps: [
      { actor: "mom", do: { type: "accept" }, expect: { assignee: "mom" } },
      // wanted_at is now, so min(now + 10, wanted_at - 20) has passed and the offer gets the 5-minute fallback (F-11).
      { actor: "mom", do: { type: "offer", to: "dad" }, expect: { offer: { from: "mom", to: "dad", expiresInMin: 5 } } },
      { clock: 6 },
      {
        actor: "dad", do: { type: "respond", response: "accept" },
        expect: {
          code: "OFFER_NOT_PENDING", assignee: "mom", offer: null, resolved: { from: "mom", status: "expired", by: null },
          events: ["offer_expired"],
        },
      },
      {
        actor: "dad", do: { type: "respond", response: "accept" },
        expect: { code: "OFFER_NOT_PENDING", assignee: "mom", resolved: null, events: [] },
      },
    ],
  },
  {
    name: "11. S-42: accepting an open request after wanted_at + 60 minutes expires it and the expiry is kept",
    pickups: [request()],
    steps: [
      { clock: 59 },
      { actor: "system", do: { type: "sweep" }, expect: { status: "open", events: [] } },
      { clock: 2 },
      {
        actor: "dad", do: { type: "accept" },
        expect: {
          code: "PICKUP_EXPIRED", status: "expired", assignee: null, version: 2, offer: null,
          resolved: { from: null, status: "expired", by: null }, events: ["expired"], sql: { stamps: ["expiredAt"] },
        },
      },
      { actor: "mom", do: { type: "accept" }, expect: { code: "INVALID_STATE", status: "expired", events: [] } },
    ],
  },
  {
    name: "12. 4.3 #12: the scheduler expires an open request at wanted_at + 60 minutes",
    pickups: [request()],
    steps: [
      { clock: 61 },
      {
        actor: "system", do: { type: "sweep" },
        expect: { status: "expired", version: 2, resolved: { from: null, status: "expired", by: null }, events: ["expired"] },
      },
    ],
  },
  {
    name: "13. S-07: the scheduler expires an unanswered handoff and the assignee keeps the trip",
    pickups: [routine({ assignee: "mom" })],
    steps: [
      { actor: "mom", do: { type: "offer", to: "dad" }, expect: { offer: { from: "mom", to: "dad", expiresInMin: 10 } } },
      { clock: 11 },
      {
        actor: "system", do: { type: "sweep" },
        expect: { assignee: "mom", offer: null, resolved: { from: "mom", status: "expired", by: null }, events: ["offer_expired"] },
      },
      { actor: "dad", do: { type: "respond", response: "accept" }, expect: { code: "OFFER_NOT_PENDING", assignee: "mom" } },
    ],
  },
  {
    name: "14. F-11: a handoff expires at min(now + 10 min, wanted_at - the routine's notify_before_min)",
    pickups: [routine({ assignee: "mom", wantedInMin: 50, notifyBeforeMin: 45 })],
    steps: [
      {
        actor: "mom", do: { type: "offer", to: "dad" }, divergence: { demo: "demo-occurrence-notify-before" },
        expect: { offer: { from: "mom", to: "dad", expiresInMin: 5 } },
      },
    ],
  },
  {
    name: "15. 4.4 #1: a new handoff supersedes the pending one; the sender can withdraw it (부탁 취소)",
    pickups: [routine({ assignee: "mom" })],
    steps: [
      { actor: "mom", do: { type: "offer", to: "dad" }, expect: { offer: { from: "mom", to: "dad" } } },
      {
        actor: "mom", do: { type: "offer" },
        expect: { offer: { from: "mom", to: null }, resolved: { from: "mom", status: "superseded", by: null }, events: ["offered"] },
      },
      { actor: "dad", do: { type: "cancel_offer" }, expect: { code: "FORBIDDEN", offer: { from: "mom", to: null } } },
      {
        actor: "mom", do: { type: "cancel_offer" },
        expect: { offer: null, resolved: { from: "mom", status: "cancelled", by: "mom" }, events: ["offer_cancelled"], version: 1 },
      },
      { actor: "mom", do: { type: "cancel_offer" }, expect: { code: "OFFER_NOT_PENDING", events: [] } },
      { actor: "dad", do: { type: "respond", response: "accept" }, expect: { code: "OFFER_NOT_PENDING", assignee: "mom" } },
    ],
  },
  {
    name: "16. F-11 validation: a handoff target must be an eligible driver other than the sender; a note is at most 40 characters",
    pickups: [request()],
    steps: [
      { actor: "mom", do: { type: "accept", vehicle: "car" }, expect: { code: "VALIDATION", status: "open" } },
      { actor: "mom", do: { type: "accept" }, expect: { assignee: "mom" } },
      { actor: "mom", do: { type: "offer", to: "aunt" }, expect: { code: "NOT_FOUND", offer: null, events: [] } },
      { actor: "mom", do: { type: "offer", to: "mom" }, expect: { code: "CANNOT_ACCEPT_OWN_OFFER", offer: null } },
      { actor: "mom", do: { type: "offer", to: "dad", note: "가".repeat(41) }, expect: { code: "VALIDATION", offer: null } },
      { actor: "dad", do: { type: "offer", to: "mom" }, expect: { code: "NOT_ASSIGNEE", offer: null } },
      { actor: "mom", do: { type: "offer", to: "dad", note: "야근" }, expect: { offer: { from: "mom", to: "dad" } } },
    ],
  },
  {
    name: "17. S-29: after a destination change a stale expected_version on depart and on vehicle start is STALE_VERSION",
    pickups: [request()],
    steps: [
      { actor: "dad", do: { type: "accept", vehicle: "car" }, expect: { assignee: "dad", vehicle: "car", version: 2 } },
      {
        actor: "mom", do: { type: "confirm_location", place: "home" },
        expect: { version: 3, destinationRevision: 2, confirmed: true, events: ["location_confirmed"] },
      },
      { actor: "dad", do: { type: "depart", version: { stale: 1 } }, expect: { code: "STALE_VERSION", status: "assigned", version: 3 } },
      {
        actor: "car", do: { type: "vehicle_start", version: { stale: 1 } },
        expect: { code: "STALE_VERSION", status: "assigned", navSession: false, events: [] },
      },
      {
        actor: "car", do: { type: "vehicle_start" },
        expect: { status: "en_route", version: 4, navSession: true, active: { car: "p" }, events: ["en_route"] },
      },
    ],
  },
  {
    name: "18. 4.3 #4, 8.3.1: \"출발하고 안내\" on an open request accepts, departs and issues a session at once; a retry returns it",
    pickups: [request()],
    steps: [
      {
        actor: "car", do: { type: "vehicle_start" },
        expect: {
          status: "en_route", assignee: "dad", vehicle: "car", version: 2, round: 1, set: ["acceptedAt", "enRouteAt"],
          navSession: true, newNavSession: true, offer: null, resolved: { from: null, status: "accepted", by: "dad" },
          events: ["accepted", "en_route"], active: { car: "p" }, sql: { navStatus: "requested" },
        },
      },
      { actor: "car", do: { type: "vehicle_start", retry: true }, expect: { version: 2, newNavSession: false, events: [] } },
      { actor: "mom", do: { type: "accept" }, expect: { code: "ALREADY_TAKEN", assignee: "dad" } },
    ],
  },
  {
    name: "19. 8.3.1: \"출발하고 안내\" on the driver's own default assignment departs without a new acceptance",
    pickups: [routine({ assignee: "dad", vehicle: "car", wantedInMin: 10 })],
    steps: [
      {
        actor: "car", do: { type: "vehicle_start" },
        expect: {
          status: "en_route", assignee: "dad", version: 2, round: 1, set: ["enRouteAt"], navSession: true,
          events: ["en_route"], active: { car: "p" },
        },
      },
    ],
  },
  {
    name: "20. S-39, 4.3 #18: \"출발하고 안내\" from a handoff card accepts the offer and departs in one step; NO_VALID_OFFER otherwise",
    pickups: [routine({ assignee: "mom" })],
    steps: [
      {
        actor: "car", do: { type: "vehicle_start" }, divergence: "vehicle-sees-not-found",
        expect: { code: "NO_VALID_OFFER", assignee: "mom", events: [] },
      },
      { actor: "mom", do: { type: "offer", to: "dad" }, expect: { offer: { from: "mom", to: "dad" } } },
      { actor: "car", do: { type: "vehicle_start" }, expect: { code: "NO_VALID_OFFER", assignee: "mom", events: [] } },
      {
        actor: "car", do: { type: "vehicle_start", withOffer: true },
        expect: {
          status: "en_route", assignee: "dad", vehicle: "car", version: 2, round: 2, set: ["acceptedAt", "enRouteAt"],
          offer: null, resolved: { from: "mom", status: "accepted", by: "dad" }, events: ["offer_accepted", "en_route"],
          active: { car: "p" },
        },
      },
    ],
  },
  {
    name: "21. S-05, S-06: an unconfirmed GPS request can be accepted but not started until a parked car confirms the location",
    pickups: [request({ at: lowAccuracyGps })],
    created: { p: { status: "open", confirmed: false } },
    steps: [
      { actor: "car", do: { type: "vehicle_start" }, expect: { code: "LOCATION_UNCONFIRMED", status: "open", events: [] } },
      { park: "car", parked: false },
      { actor: "car", do: { type: "confirm_location", place: "academy" }, expect: { code: "FORBIDDEN", confirmed: false } },
      { actor: "car", do: { type: "accept" }, expect: { status: "assigned", assignee: "dad", vehicle: "car", version: 2 } },
      { actor: "car", do: { type: "vehicle_start" }, expect: { code: "LOCATION_UNCONFIRMED", status: "assigned" } },
      { park: "car", parked: true },
      {
        actor: "car", do: { type: "confirm_location", place: "academy" },
        expect: { confirmed: true, destinationRevision: 2, version: 3, events: ["location_confirmed"] },
      },
      { actor: "car", do: { type: "vehicle_start" }, expect: { status: "en_route", events: ["en_route"], active: { car: "p" } } },
    ],
  },
  {
    name: "22. F-10: more than 15 minutes before wanted_at an open request can be accepted but not started",
    pickups: [request({ wantedInMin: 30 })],
    steps: [
      { actor: "car", do: { type: "vehicle_start" }, expect: { code: "INVALID_STATE", status: "open", events: [] } },
      { clock: 16 },
      { actor: "car", do: { type: "vehicle_start" }, expect: { status: "en_route", events: ["accepted", "en_route"] } },
    ],
  },
  {
    name: "23. S-19: a navigation failure keeps the departure; a retry issues a new session and the old session's callback is ignored",
    pickups: [request()],
    steps: [
      { actor: "car", do: { type: "vehicle_start" }, expect: { status: "en_route", sql: { navStatus: "requested" } } },
      {
        actor: "car", do: { type: "nav_result", result: "failed" },
        notComparable: { events: "TS has no navigation result action; the demo marks the car's navError when it starts" },
        expect: { status: "en_route", version: 2, navSession: true, sql: { navStatus: "failed", events: ["nav_failed"] } },
      },
      {
        actor: "car", do: { type: "vehicle_start" },
        expect: {
          status: "en_route", version: 2, newNavSession: true, events: ["navigation_requested"], sql: { navStatus: "requested" },
        },
      },
      {
        actor: "car", do: { type: "nav_arrival", session: "previous" },
        expect: { ignored: true, status: "en_route", version: 2, events: ["arrival_ignored"] },
      },
      { actor: "car", do: { type: "nav_arrival" }, expect: { status: "arrived", version: 3, events: ["arrived"] } },
    ],
  },
  {
    name: "24. S-34 (가): after the destination changes, a callback of the earlier guidance is ignored until guidance reopens",
    pickups: [request()],
    steps: [
      { actor: "car", do: { type: "vehicle_start" }, expect: { status: "en_route", version: 2 } },
      { actor: "mom", do: { type: "confirm_location", place: "home" }, expect: { destinationRevision: 2, version: 3 } },
      { actor: "car", do: { type: "nav_arrival" }, expect: { ignored: true, status: "en_route", events: ["arrival_ignored"] } },
      {
        actor: "car", do: { type: "nav_arrival", revision: "current" },
        expect: { ignored: true, status: "en_route", events: ["arrival_ignored"] },
      },
      { actor: "car", do: { type: "vehicle_start" }, expect: { newNavSession: true, events: ["navigation_requested"] } },
      { actor: "car", do: { type: "nav_arrival" }, expect: { status: "arrived", events: ["arrived"] } },
    ],
  },
  {
    name: "25. S-34 (나): a moving car cannot switch guidance; after a parked switch, the first pickup's late callback is ignored",
    family: twoRiders,
    pickups: [request({ key: "a" }), request({ key: "b", by: "seoyeon" })],
    steps: [
      { actor: "car", pickup: "a", do: { type: "vehicle_start" }, expect: { status: "en_route", active: { car: "a" } } },
      { park: "car", parked: false },
      { actor: "car", pickup: "b", do: { type: "vehicle_start" }, expect: { code: "FORBIDDEN", status: "open", active: { car: "a" } } },
      { park: "car", parked: true },
      { actor: "car", pickup: "b", do: { type: "vehicle_start" }, expect: { status: "en_route", active: { car: "b" } } },
      {
        actor: "car", pickup: "a", do: { type: "nav_arrival" },
        expect: { ignored: true, status: "en_route", events: ["arrival_ignored"], active: { car: "b" } },
      },
      { actor: "car", pickup: "a", do: { type: "arrive" }, expect: { status: "arrived", events: ["arrived"] } },
      { actor: "car", pickup: "b", do: { type: "nav_arrival" }, expect: { status: "arrived", events: ["arrived"] } },
    ],
  },
  {
    name: "26. 8.3.1 order: a moving car on another trip is refused (FORBIDDEN) before the 15-minute rule is checked",
    family: twoRiders,
    pickups: [request({ key: "a" }), request({ key: "b", by: "seoyeon", wantedInMin: 30 })],
    steps: [
      { actor: "car", pickup: "a", do: { type: "vehicle_start" }, expect: { status: "en_route" } },
      { park: "car", parked: false },
      { actor: "car", pickup: "b", do: { type: "vehicle_start" }, expect: { code: "FORBIDDEN", status: "open" } },
    ],
  },
  {
    name: "27. F-13, 2.2: boarding only from arrived; a car only while parked; an unrelated member may not",
    pickups: [request()],
    steps: [
      { actor: "dad", do: { type: "accept", vehicle: "car" }, expect: { vehicle: "car" } },
      { actor: "dad", do: { type: "depart" }, expect: { status: "en_route" } },
      { actor: "car", do: { type: "board" }, expect: { code: "INVALID_STATE", status: "en_route" } },
      { actor: "car", do: { type: "arrive" }, expect: { status: "arrived", version: 4 } },
      { park: "car", parked: false },
      { actor: "car", do: { type: "board" }, expect: { code: "FORBIDDEN", status: "arrived" } },
      { actor: "mom", do: { type: "board" }, expect: { code: "FORBIDDEN", status: "arrived" } },
      { actor: "aunt", do: { type: "board" }, expect: { code: "FORBIDDEN", status: "arrived" } },
      { park: "car", parked: true },
      { actor: "car", do: { type: "board" }, expect: { status: "completed", version: 5, events: ["completed"] } },
    ],
  },
  {
    name: "28. F-13: the guardian assignee confirms boarding by phone",
    pickups: [request()],
    steps: [
      { actor: "mom", do: { type: "accept" }, expect: { assignee: "mom" } },
      { actor: "mom", do: { type: "depart" }, expect: { status: "en_route" } },
      { actor: "mom", do: { type: "arrive" }, expect: { status: "arrived" } },
      { actor: "mom", do: { type: "board" }, expect: { status: "completed", events: ["completed"] } },
    ],
  },
  {
    name: "29. S-10: the rider cancels their own request while the car is en route; the car's guidance ends",
    pickups: [request()],
    steps: [
      { actor: "dad", do: { type: "accept", vehicle: "car" }, expect: { assignee: "dad" } },
      { actor: "car", do: { type: "vehicle_start" }, expect: { status: "en_route", active: { car: "p" } } },
      {
        actor: "minjun", do: { type: "cancel" },
        expect: {
          status: "cancelled", version: 4, events: ["cancelled"], active: { car: null },
          sql: { cancelReason: "child_cancelled", stamps: ["cancelledAt"] },
        },
      },
    ],
  },
  {
    name: "30. F-14: a rider cannot cancel a routine occurrence; skipped is only for routine open or assigned occurrences",
    pickups: [routine({ assignee: "mom" }), request({ key: "q" }), routine({ key: "r", assignee: "dad" })],
    steps: [
      { actor: "minjun", do: { type: "cancel" }, expect: { code: "INVALID_STATE", status: "assigned" } },
      { actor: "mom", do: { type: "skip" }, expect: { status: "cancelled", events: ["cancelled"], sql: { cancelReason: "skipped" } } },
      { actor: "mom", do: { type: "skip" }, expect: { code: "INVALID_STATE", status: "cancelled" } },
      { actor: "mom", pickup: "q", do: { type: "skip" }, expect: { code: "INVALID_STATE", status: "open" } },
      { actor: "dad", pickup: "r", do: { type: "depart" }, expect: { status: "en_route" } },
      { actor: "dad", pickup: "r", do: { type: "skip" }, expect: { code: "INVALID_STATE", status: "en_route" } },
    ],
  },
  {
    name: "31. 4.3 #11, 4.4 #10: cancelling a pickup cancels its pending offer",
    pickups: [request()],
    steps: [
      { actor: "dad", do: { type: "accept" }, expect: { assignee: "dad" } },
      { actor: "dad", do: { type: "offer", to: "mom" }, expect: { offer: { from: "dad", to: "mom" } } },
      {
        actor: "dad", do: { type: "cancel", reason: "resolved_by_phone" },
        expect: {
          status: "cancelled", offer: null, resolved: { from: "dad", status: "cancelled", by: null }, events: ["cancelled"],
          sql: { cancelReason: "resolved_by_phone" },
        },
      },
    ],
  },
  {
    name: "32. 4.3 #14, F-14: after arrival a guardian cancels only as not_met; neither the rider nor the car can cancel",
    pickups: [request()],
    steps: [
      { actor: "dad", do: { type: "accept", vehicle: "car" }, expect: { assignee: "dad" } },
      { actor: "dad", do: { type: "depart" }, expect: { status: "en_route" } },
      { actor: "dad", do: { type: "arrive" }, expect: { status: "arrived" } },
      { actor: "minjun", do: { type: "cancel" }, expect: { code: "INVALID_STATE", status: "arrived" } },
      { actor: "mom", do: { type: "cancel", reason: "other" }, expect: { code: "INVALID_STATE", status: "arrived" } },
      { actor: "car", do: { type: "cancel" }, expect: { code: "FORBIDDEN", status: "arrived" } },
      {
        actor: "mom", do: { type: "cancel", reason: "not_met" },
        expect: { status: "cancelled", events: ["cancelled"], sql: { cancelReason: "not_met" } },
      },
    ],
  },
  {
    name: "33. S-32, F-21: \"일찍 끝났어\" records readiness on the occurrence without creating a pickup, once",
    pickups: [routine({ assignee: "dad", vehicle: "car", wantedInMin: 30 })],
    steps: [
      {
        actor: "minjun", do: { type: "ready" },
        expect: {
          status: "assigned", assignee: "dad", version: 2, set: ["readyAt"], offer: null, pickupCount: 1, events: ["rider_ready"],
        },
      },
      { actor: "minjun", do: { type: "ready" }, expect: { version: 2, pickupCount: 1, events: [] } },
      { actor: "dad", do: { type: "depart" }, expect: { status: "en_route" } },
      { actor: "minjun", do: { type: "ready" }, expect: { code: "INVALID_STATE", status: "en_route" } },
    ],
  },
  {
    name: "34. 4.3 #16, F-15: \"일찍 끝났어\" on an open occurrence also offers it to every driver",
    pickups: [routine({ wantedInMin: 30 })],
    created: { p: { status: "open", offer: null } },
    steps: [
      {
        actor: "minjun", do: { type: "ready" },
        expect: {
          status: "open", version: 2, set: ["readyAt"], pickupCount: 1, events: ["rider_ready"],
          offer: { from: null, to: null, declinedBy: [], expiresInMin: 30 },
        },
      },
      {
        actor: "dad", do: { type: "respond", response: "accept" },
        expect: { status: "assigned", assignee: "dad", resolved: { from: null, status: "accepted", by: "dad" }, events: ["offer_accepted"] },
      },
    ],
  },
  {
    name: "35. S-38, F-22: \"아직 못 만났어\" only after arrival, at most once in 5 minutes; the pickup stays arrived",
    pickups: [request()],
    steps: [
      { actor: "dad", do: { type: "accept" }, expect: { assignee: "dad" } },
      { actor: "minjun", do: { type: "not_met" }, expect: { code: "INVALID_STATE", status: "assigned" } },
      { actor: "dad", do: { type: "depart" }, expect: { status: "en_route" } },
      { actor: "dad", do: { type: "arrive" }, expect: { status: "arrived", version: 4 } },
      {
        actor: "minjun", do: { type: "not_met" },
        expect: {
          status: "arrived", version: 4, set: ["acceptedAt", "enRouteAt", "arrivedAt", "notMetAt"], events: ["not_met_reported"],
        },
      },
      { clock: 2 },
      { actor: "minjun", do: { type: "not_met" }, expect: { code: "RATE_LIMITED", status: "arrived", events: [] } },
      { clock: 4 },
      { actor: "minjun", do: { type: "not_met" }, expect: { status: "arrived", events: ["not_met_reported"] } },
    ],
  },
  {
    name: "36. F-13, 4.3 #15: \"아직 안 떠났어요\" within 5 minutes returns to assigned and ends the guidance; not after",
    pickups: [request()],
    steps: [
      { actor: "car", do: { type: "vehicle_start" }, expect: { status: "en_route", active: { car: "p" } } },
      { clock: 4 },
      {
        actor: "dad", do: { type: "undo" },
        expect: {
          status: "assigned", assignee: "dad", version: 3, navSession: false, set: ["acceptedAt"], active: { car: null },
          events: ["en_route_undone"], sql: { navStatus: "none" },
        },
      },
      { actor: "car", do: { type: "vehicle_start" }, expect: { status: "en_route", newNavSession: true, active: { car: "p" } } },
      { clock: 6 },
      { actor: "dad", do: { type: "undo" }, expect: { code: "INVALID_STATE", status: "en_route" } },
      { actor: "car", do: { type: "undo" }, expect: { code: "INVALID_STATE", status: "en_route" } },
    ],
  },
  {
    name: "37. F-12: \"못 가요\" on an open request records this driver's refusal; the request stays open and that driver may still accept",
    pickups: [request()],
    steps: [
      {
        actor: "car", do: { type: "vehicle_decline" }, divergence: { spec: "car-declines-request-offer" },
        expect: { status: "open", version: 1, offer: { from: null, to: null, declinedBy: ["dad"] }, events: ["request_declined"] },
      },
      {
        actor: "dad", do: { type: "accept" },
        expect: { assignee: "dad", resolved: { from: null, status: "accepted", by: "dad" }, events: ["accepted"] },
      },
    ],
  },
  {
    name: "38. F-12, 8.7: when the only eligible driver's car declines a guardian's request, the request offer is resolved",
    pickups: [request({ by: "mom" })],
    steps: [
      {
        actor: "car", do: { type: "vehicle_decline" }, divergence: { spec: "last-car-decline-keeps-request-offer" },
        expect: { status: "open", offer: null, resolved: { from: null, status: "declined", by: "dad" } },
      },
    ],
  },
  {
    name: "39. 23.1: an assignee who lost can_drive keeps the trip and may hand it off, but cannot depart",
    pickups: [routine({ assignee: "mom" })],
    steps: [
      { actor: "mom", do: { type: "accept" }, expect: { assignee: "mom" } },
      { member: "mom", canDrive: false },
      { actor: "mom", do: { type: "depart" }, expect: { code: "FORBIDDEN", status: "assigned" } },
      { actor: "mom", do: { type: "offer", to: "dad" }, expect: { offer: { from: "mom", to: "dad" } } },
      { actor: "dad", do: { type: "respond", response: "accept" }, expect: { assignee: "dad", events: ["offer_accepted"] } },
    ],
  },
  {
    name: "40. 2.2, F-13: a car acts only on trips it drives, is offered or may take",
    pickups: [request()],
    steps: [
      { actor: "mom", do: { type: "accept" }, expect: { assignee: "mom" } },
      { actor: "mom", do: { type: "depart" }, expect: { status: "en_route" } },
      { actor: "car", do: { type: "arrive" }, expect: { code: "NOT_FOUND", status: "en_route" } },
      { actor: "car", do: { type: "undo" }, expect: { code: "NOT_FOUND", status: "en_route" } },
      { actor: "car", do: { type: "confirm_location", place: "home" }, expect: { code: "NOT_FOUND", destinationRevision: 1 } },
      { actor: "mom", do: { type: "arrive" }, expect: { status: "arrived" } },
      { actor: "car", do: { type: "board" }, expect: { code: "NOT_FOUND", status: "arrived" } },
    ],
  },
  {
    name: "41. F-15, 4.4 #4: at notify time the scheduler offers an open routine occurrence to every driver, once",
    pickups: [routine({ wantedInMin: 15 })],
    steps: [
      {
        actor: "system", do: { type: "sweep" }, divergence: { spec: "demo-scheduler-has-no-routine-offer" },
        expect: { status: "open", offer: { from: null, to: null, expiresInMin: 15 } },
      },
      {
        actor: "dad", do: { type: "accept" }, divergence: { spec: "demo-scheduler-has-no-routine-offer" },
        expect: { assignee: "dad", resolved: { from: null, status: "accepted", by: "dad" }, events: ["accepted"] },
      },
    ],
  },
  {
    name: "42. 4.4 #11, 8.3.1: the sender's car starting the trip it offered away cancels the offer",
    pickups: [routine({ assignee: "dad", vehicle: "car", wantedInMin: 10 })],
    steps: [
      { actor: "dad", do: { type: "offer", to: "mom" }, expect: { offer: { from: "dad", to: "mom", expiresInMin: 5 } } },
      {
        actor: "car", do: { type: "vehicle_start" },
        expect: {
          status: "en_route", assignee: "dad", offer: null, resolved: { from: "dad", status: "cancelled", by: null },
          events: ["en_route"], active: { car: "p" },
        },
      },
      { actor: "mom", do: { type: "respond", response: "accept" }, expect: { code: "OFFER_NOT_PENDING", assignee: "dad" } },
    ],
  },
];
