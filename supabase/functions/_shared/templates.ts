import { appUrl } from "./http.ts";
import type { PushPayload } from "./providers.ts";

export type TemplateData = {
  rider_name?: string; place?: string; time?: string; who?: string; from?: string; to?: string;
  note?: string; vehicle?: string; vehicle_id?: string; required_km?: number; range_km?: number;
};

function subject(name: string) {
  const last = name.charCodeAt(name.length - 1);
  return `${name}${last >= 0xac00 && last <= 0xd7a3 && (last - 0xac00) % 28 ? "이" : "가"}`;
}

export function pushPayload(template: string, data: TemplateData, pickupId?: string): (PushPayload & { urgent: boolean }) | undefined {
  const rider = data.rider_name || "가족";
  const who = data.who || "담당자";
  const place = data.place || "픽업 장소";
  const time = data.time || "";
  const from = data.from || "가족";
  const to = data.to || who;
  const whenWhere = [time, place].filter(Boolean).join(" ");
  const text: Record<string, [string, string]> = {
    test_push: ["데리러 알림이 연결됐어요", "다음 픽업부터 알림을 받을 수 있어요"],
    child_request_new: [`${subject(rider)} 데리러 와 달래요`, `${whenWhere}. 먼저 수락한 사람이 가요`],
    child_request_repeat: ["아직 아무도 수락하지 않았어요", `${rider}, ${whenWhere}`],
    pickup_accepted: [`${subject(who)} ${rider} 픽업을 맡았어요`, whenWhere],
    pickup_en_route: [`${subject(who)} 출발했어요`, `${rider}, ${place}`],
    pickup_completed: [`${subject(rider)} 탔어요`, who],
    pickup_cancelled_by_child: [`${subject(rider)} 요청을 취소했어요`, place],
    pickup_cancelled: [`${rider} 픽업이 취소됐어요`, place],
    pickup_cancelled_urgent: [`${rider} 픽업이 취소됐어요`, "출발하지 않아도 돼요"],
    pickup_expired: [`${rider} 요청이 시간이 지나 닫혔어요`, "아무도 수락하지 않았어요. 전화해 주세요"],
    offer_to_you: [`${subject(from)} 부탁했어요`, [time, rider, place, data.note].filter(Boolean).join(" ")],
    offer_to_all: [`${subject(from)} 모두에게 부탁했어요`, [time, rider, place, data.note].filter(Boolean).join(" ")],
    offer_declined: [`${subject(to)} 못 간대요`, `${time} ${rider} 픽업은 여전히 내 담당이에요`],
    offer_all_declined: ["모두 못 간대요", `${time} ${rider} 픽업은 여전히 내 담당이에요`],
    offer_expired: [`${subject(to)} 답하지 않았어요`, `${time} ${rider} 픽업은 여전히 내 담당이에요`],
    offer_accepted: [`${subject(who)} 수락했어요`, `이제 ${time} ${rider} 픽업은 ${who} 담당이에요`],
    taken_over: [`${subject(who)} 대신 가기로 했어요`, `${time} ${rider}. 출발하지 않아도 돼요`],
    routine_reminder: ["곧 출발할 시간이에요", `${time} ${rider}, ${place}`],
    routine_not_departed: [`${time} ${rider} 픽업이 아직 출발하지 않았어요`, `담당 ${who}`],
    routine_open: [`${time} ${rider} 픽업을 맡을 사람이 없어요`, `${place}. 먼저 수락한 사람이 가요`],
    low_range: [`${data.vehicle || "차량"} 주행가능거리가 부족해요`, `내일까지 약 ${data.required_km}km 필요, 지금 ${data.range_km}km`],
    child_ready_early: [`${subject(rider)} 일찍 끝났대요`, `${place}에서 기다려요. 원래 ${time}`],
    child_not_met: [`${subject(rider)} 아직 못 만났대요`, `${place}. 전화로 확인해 주세요`],
    child_not_met_family: [`${subject(rider)} 아직 못 만났대요`, `담당 ${who}`],
    not_departed_assignee: [`${rider} 픽업, 아직 출발 전이에요`, whenWhere],
    not_departed_family: [`${rider} 픽업 담당 ${who}, 아직 출발 전이에요`, whenWhere],
    boarding_check: [`${subject(rider)} 탔는지 확인해 주세요`, "도착한 지 30분이 지났어요"],
    boarding_check_family: [`${rider} 탑승 확인이 아직 없어요`, `담당 ${who}, ${place}`],
    closed_unconfirmed: [`${rider} 픽업이 탑승 확인 없이 닫혔어요`, "아직 만나지 못했다면 바로 전화해 주세요"],
    closed_unconfirmed_not_met: [`${subject(rider)} 못 만났다고 한 뒤 확인이 없어요`, "지금 바로 전화해 주세요"],
    en_route_undone: [`${subject(who)} 아직 출발하지 않았대요`, `${rider}, ${place}`],
    child_assigned: [`${subject(who)} 데리러 간대`, `${place}에서 기다려`],
    child_en_route: [`${subject(who)} 출발했어`, ""],
    child_arrived: [`${subject(who)} 도착했어`, ""],
  };
  if (!Object.hasOwn(text, template)) return undefined;
  const riderPush = ["child_assigned", "child_en_route", "child_arrived"].includes(template);
  const route = riderPush ? "/c/" : data.vehicle_id ? `/p/vehicles/${data.vehicle_id}` : pickupId ? `/p/pickups/${pickupId}` : "/p/";
  const requireInteraction = ["child_request_new", "child_request_repeat", "taken_over", "pickup_cancelled_urgent", "child_not_met", "closed_unconfirmed_not_met"].includes(template);
  const urgent = requireInteraction || ["offer_to_you", "offer_to_all", "routine_reminder", "routine_open", "not_departed_assignee", "boarding_check"].includes(template);
  return { title: text[template][0], body: text[template][1], url: route,
    tag: data.vehicle_id ? `low_range:${data.vehicle_id}` : pickupId ? `pickup:${pickupId}` : template, requireInteraction, urgent };
}

export function smsText(template: string, data: TemplateData, pickupId?: string): string | undefined {
  if (!pickupId) return undefined;
  const url = appUrl(`/p/pickups/${pickupId}`);
  if (!url) return undefined;
  const rider = data.rider_name || "가족";
  switch (template) {
    case "esc_sms_open": return `[데리러] ${rider} 픽업 요청을 아직 아무도 수락하지 않았어요 ${url}`;
    case "esc_sms_open_urgent": return `[데리러][긴급] ${rider} 요청 10분째 미수락. 전화해 주세요 ${url}`;
    case "routine_open_sms": return `[데리러] ${data.time || ""} ${rider} 픽업 맡을 사람이 없어요 ${url}`;
  }
}
