// Every disagreement the suite tolerates. A step that disagrees fails unless it names one of these entries, and an
// entry whose step stops disagreeing fails too. `wrong` is the side that does not meet the scenario's expectation.
// SQL is never edited from this suite: an SQL entry is a report for the backend owner. A "ts" entry is composition
// in apps/web that the TS driver mirrors; packages/contracts itself has no "ts" entry.
import type { KnownDivergence } from "./model.ts";

export const knownDivergences: readonly KnownDivergence[] = [
  {
    id: "vehicle-sees-not-found",
    wrong: "sql",
    spec: "F-10 동시성, V-03 버튼 동작, 8.3.1 분기 표",
    summary: "a car whose driver lost the race gets NOT_FOUND from accept_pickup and vehicle_start_now on a pickup assigned to " +
      "someone else, instead of ALREADY_TAKEN (accept) and NO_VALID_OFFER (start); the transition's vehicle visibility " +
      "check runs before both rules",
  },
  {
    id: "last-car-decline-keeps-request-offer",
    wrong: "sql",
    spec: "8.7 decline 분기, F-12, 4.4 #7",
    summary: "vehicle_decline on an open request records the refusal but never resolves the request offer, so when the last " +
      "eligible driver declines from the car the offer stays pending and 8.7's \"모두 거절했어요\" never happens; respond_offer " +
      "on the same offer would close it as declined",
  },
  {
    id: "car-declines-request-offer",
    wrong: "ts",
    spec: "F-12 (event name not specified; 7.2 lists offer_declined only)",
    summary: "apps/web/src/vehicle.tsx cannotGo answers a pending request offer with respond_offer(decline), which emits " +
      "offer_declined; SQL vehicle_decline emits request_declined. Unreachable in the demo today: demo requests carry no " +
      "request offer, and then cannotGo writes a request_declined history row like SQL",
  },
  {
    id: "demo-occurrence-notify-before",
    wrong: "ts",
    spec: "F-11 제안 만료 시각",
    summary: "apps/web/src/demo-domain.ts routineOccurrence/makePickup does not copy Routine.before into Pickup.notifyBeforeMin, " +
      "so a demo handoff on an occurrence whose notify time is not 20 minutes expires later than the server's",
  },
  {
    id: "demo-scheduler-has-no-routine-offer",
    wrong: "ts",
    spec: "4.4 #4, F-15 루틴 회차 (알림 시점 open)",
    summary: "apps/web/src/demo-domain.ts setDemoTime never creates the family-wide offer that run_escalations creates for an " +
      "open routine occurrence at its notify time",
  },
];
