// The 24.4 notice texts the dispatch worker renders (supabase/functions/_shared/templates.ts). Deno is not needed:
// these templates do not read the environment.
import assert from "node:assert/strict";
import test from "node:test";
import { pushPayload, smsText } from "../../../supabase/functions/_shared/templates.ts";

const data = { rider_name: "민준", place: "수학학원", time: "17:30", fallback_note: "학원 안에서 기다리기", fallback_by: "엄마" };

test("24.4 push texts for 갈 사람이 없을 때", () => {
  const text = (template: string) => {
    const payload = pushPayload(template, data, "p1");
    assert.ok(payload, template);
    return [payload.title, payload.body, payload.urgent];
  };
  assert.deepEqual(text("nobody_available"),
    ["민준 픽업, 갈 수 있는 사람이 없어요", "17:30 수학학원. 누가 갈지 정하거나 못 간다고 알려 주세요", true]);
  assert.deepEqual(text("no_driver"), ["엄마가 민준에게 못 간다고 알렸어요", "대신 할 일: 학원 안에서 기다리기", false]);
  assert.deepEqual(text("fallback_acknowledged"), ["민준이 확인했어요", "학원 안에서 기다리기", false]);
  assert.deepEqual(text("fallback_unacked"), ["민준이 아직 확인하지 않았어요", "전화로 알려 주세요", true]);
  assert.deepEqual(text("tomorrow_open"), ["내일 17:30 민준 픽업, 담당이 없어요", "누가 갈지 미리 정해 주세요", false]);
  assert.deepEqual(text("tomorrow_nobody"), ["내일 17:30 민준 픽업, 담당이 없어요", "갈 수 있는 사람이 없어요. 미리 정해 주세요", false]);
  assert.equal(pushPayload("no_driver", data, "p1")?.url, "/p/pickups/p1");
});

test("24.4 SMS after ten minutes without an acknowledgement needs no link", () => {
  assert.equal(smsText("fallback_unacked_sms", data, "p1"), "[데리러] 민준이 못 간다는 안내를 아직 확인하지 않았어요. 전화해 주세요.");
  assert.equal(smsText("fallback_unacked_sms", { ...data, rider_name: "지아" }, "p1"),
    "[데리러] 지아가 못 간다는 안내를 아직 확인하지 않았어요. 전화해 주세요.");
});
