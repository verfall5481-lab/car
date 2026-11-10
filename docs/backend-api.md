# 백엔드 RPC 계약

RPC 인자명은 `p_`로 시작한다. 성공 응답은 `{ok:true,data:{…}}`, 업무 오류는 `{ok:false,error:{code,detail}}`이다. ID는 UUID, 시각은 ISO 8601, 행 필드는 snake_case다. 날짜와 루틴 시각은 한국 표준시를 사용한다.

모든 RPC는 `POST /rest/v1/rpc/{name}`으로 호출한다(supabase-js `rpc()` 기본값). 함수는 VOLATILE로 선언돼 있어 PostgREST가 GET 호출을 받지 않는다. 조회 RPC 중 `rider_get_state`는 기기 마지막 접속 시각을 기록한다.

`NAME_TAKEN`은 같은 가족 안의 활성 보호자·rider·차량 이름, 같은 장소의 활성 타는 곳 이름이 겹칠 때만 돌려준다. `VALIDATION`은 형식이 맞지 않는 입력과 차량 상태 값의 범위 위반에 쓴다. 그 밖의 제약 위반은 업무 오류로 바꾸지 않고 PostgREST 오류 응답으로 그대로 올라온다. 클라이언트는 이를 서버 결함으로 다룬다.

## 보호자와 rider

| RPC | 인자 | 성공 데이터 |
|---|---|---|
| `create_family` | display_name, privacy_version, phone_e164?, sms_opt_in?, family_name?, location_consent? | family, member |
| `join_family` | code, display_name, privacy_version, phone_e164?, sms_opt_in?, location_consent? | family, member |
| `update_me` | display_name?, phone_e164?, sms_opt_in?, consent? | member |
| `create_family_invite` | | code, url, expires_at |
| `preview_family_invite` | code | family_name, inviter_name |
| `update_family` | name | family |
| `transfer_owner`, `set_member_roles`, `remove_member` | member_id, 역할 편집 시 can_drive, can_request | member 또는 빈 객체 |
| `leave_family` | | 빈 객체 |
| `add_rider` | display_name, kind, birth_year?, consent?, phone_e164? | rider |
| `update_rider`, `archive_rider` | rider_id, 편집 시 display_name?, phone_e164? | rider 또는 빈 객체 |
| `create_rider_invite` | rider_id, channel? | code, url, expires_at, rider_name. 문자 채널은 phone_e164 포함 |
| `claim_rider_invite` | code, user_agent?, confirm_switch?, consent? | rider, device_id, family_guardians 또는 needs_switch_confirm |
| `revoke_rider_device` | device_id | 빈 객체 |
| `get_family_overview` | | family, me, members, riders, rider_devices, vehicles, places, pickup_points, routines, consents, setup_checklist |
| `rider_get_state` | | rider, callable_guardians, places, pickup_points, actives, today, server_time |
| `get_today` | days? | active, timeline, pending_offers_to_me, alerts, notification_failures, server_time |
| `get_pickup` | pickup_id | pickup, offers, events, assignee, vehicle, vehicle_state, required_km, range |

`leave_family`와 `remove_member`는 떠나는 보호자가 요청자인 미종료 픽업을 `cancelled`(`cancelled_by_kind=system`)로 닫는다. 그래서 에스컬레이션과 문자가 멈추고, 이미 수락한 사람에게 취소 알림이 간다. 떠나는 보호자가 담당하던 픽업은 owner에게 넘기고, owner가 운전할 수 없으면 다른 운전 가능 보호자에게 넘긴다. 후임은 아직 출발하지 않았으므로 `en_route`·`arrived` 픽업도 `assigned`로 돌아가고 출발·도착 시각과 내비 세션이 지워진다. 이벤트는 `member_reassigned`(이전 상태 포함)이며 새 담당자와 rider에게 알림이 간다. 넘길 사람이 없으면 픽업을 취소한다.

하나의 인증 사용자는 보호자, rider 기기, 차량 중 하나다(2.1). 익명 세션이 영구 계정으로 바뀌어도 활성 rider 기기나 차량 연결이 남아 있으면 `create_family`·`join_family`는 `ALREADY_IN_FAMILY`를 돌려준다. 페어링 코드를 받은 세션이 더 이상 익명이 아니면 `vehicle_pair_confirm`은 `PAIR_CODE_INVALID`다.

`set_member_roles`로 `can_drive`를 끈 보호자는 이미 맡은 픽업을 넘길 때까지 그대로 담당하지만 출발할 수 없다. `mark_en_route`는 `FORBIDDEN`이고, `offer_pickup`으로 넘기거나 다른 보호자가 `take_over`할 수 있다. 루틴이 바뀌어 회차를 다시 계산할 때도 운전할 수 없는 기본 담당자에게는 배정하지 않는다(`ensure_occurrences`와 같은 규칙).

`update_me`와 `update_rider`의 전화번호에 빈 문자열을 넘기면 지워진다. `null`과 인자 생략은 현재 값을 유지한다. 본인 위치 동의는 `location_consent`로 가입 시 기록하거나 `update_me(p_consent)`로 기록한다. `p_consent`는 동의 문서 버전이다.

## 장소, 루틴, 차량

| RPC | 인자 | 성공 데이터 |
|---|---|---|
| `upsert_place` | label, kind, lat, lng, radius_m?, place_id? | place |
| `upsert_pickup_point` | place_id, label, lat, lng, note?, pickup_point_id? | pickup_point |
| `archive_place`, `archive_pickup_point`, `archive_routine` | 해당 ID | 빈 객체 |
| `upsert_routine` | rider_id 또는 rider_member_id, place_id, weekdays, time_local, notify_before_min?, default_assignee_member_id?, default_vehicle_id?, start_date?, end_date?, pickup_point_id?, routine_id?, active?, cancel_future? | routine |
| `ensure_occurrences` | days? | created |
| `vehicle_pair_start` | | code, url, expires_at |
| `vehicle_pair_status` | | paired, vehicle? |
| `vehicle_pair_confirm` | code, nickname, current_driver_member_id | vehicle |
| `update_vehicle` | vehicle_id, nickname?, current_driver_member_id? | vehicle |
| `vehicle_set_driver` | member_id | vehicle |
| `revoke_vehicle`, `vehicle_unpair_self` | 보호자 해지 시 vehicle_id | 빈 객체 |
| `upsert_vehicle_state` | gear, collected_at, range_km?, fuel_pct?, soc_pct?, energy_type?, ignition?, lat?, lng?, location_at?, is_demo_value? | alert, state |
| `vehicle_get_feed` | | vehicle, drivers, state, cards, active_trip, today, alerts, server_time |
| `ack_vehicle_alert` | alert_id | 빈 객체 |

`get_today`는 읽기만 한다. 루틴 회차는 루틴 저장, `ensure_occurrences`, 매시 5분 스케줄러(오늘부터 2일치)가 만든다.

차량·픽업의 `range.verdict`는 `low`, `sufficient`, `check_required` 중 하나다. `sufficient`는 모든 픽업의 필요 거리를 계산할 수 있고 주행가능거리 값이 6시간 이내일 때만 나온다. 24시간 이내 값으로 부족하면 `low`다. 출발점이 없거나, 값이 없거나, 오래됐는데 부족하지 않으면 `check_required`다. 경고는 24시간 이내 값으로 만들거나 갱신하고, 6시간 이내 값으로 충분할 때 또는 24시간 창에 배정이 없을 때만 닫는다.

저장 장소의 `kind`는 `home`, `school`, `academy`, `other`다. `weekdays`는 월요일을 비트 0으로 하는 7비트 마스크다. 차량 기어는 `P`, `R`, `N`, `D`, `unknown`을 받는다. 차량 상태의 시각은 수집 시각이다. 피드에서 `is_stale`과 `is_demo_value`를 확인할 수 있다.

## 픽업과 푸시

- `member_create_request`, `rider_create_request`는 `wanted_in_min`(0, 10, 20, 30)과 `place_id`, `pickup_point_id`, `pin`, `gps` 중 하나를 받는다. `pin` 객체는 `lat`, `lng`, `note?`, `current_location?`을 받는다. `gps` 객체는 `lat`, `lng`, `accuracy_m?`을 받는다.
- `accept_pickup`은 `pickup_id`, `vehicle_id?`를 받는다. `offer_pickup`, `respond_offer`, `cancel_offer`, `take_over`, `mark_en_route`, `mark_completed`, `cancel_pickup`, `confirm_location`, `skip_occurrence`, `undo_en_route`, `rider_ready_early`, `rider_report_not_met`, `vehicle_decline`에는 `expected_version`이 필요하다.
- `vehicle_start_now`는 `pickup_id`, `expected_version`, `action_id`, `offer_id?`를 받고 `pickup`, `dest`, `nav_session_id`, `destination_revision`을 돌려준다. `mark_arrived`의 `source=manual`은 `expected_version`, `source=nav_callback`은 `nav_session_id`와 `destination_revision`을 사용한다. `report_nav_result`는 `pickup_id`, `nav_session_id`, `result`, `error_code?`를 받는다.
- 보호자 취소 사유에는 `resolved_by_phone`, `mistake`, `other_way_home`, `other`를 사용한다. 도착한 픽업은 `not_met`으로 취소할 수 있다. 루틴 건너뛰기는 `skipped`로 기록된다.
- 차량이 `offer_pickup`을 부르면 `to_member_id`와 `note` 없이 가족 전체에게만 넘길 수 있고, 둘 중 하나라도 있으면 `FORBIDDEN`이다. 차량 앱은 `vehicle_decline`을 쓴다.
- `register_push_subscription`은 `endpoint`, `p256dh`, `auth`를 받고 `unregister_push_subscription`은 `endpoint`를 받는다. 다른 계정이 등록한 엔드포인트는 등록하면 `FORBIDDEN`이고, 해지는 자기 구독만 지우며 없어도 성공한다. `enqueue_test_push`는 인자 없이 호출한다.
- GPS 요청의 "OO동 근처" 라벨은 발송 워커가 비동기로 채운다. 표시용 라벨이라 `version`과 `destination_revision`을 올리지 않으므로, 라벨이 바뀌어도 클라이언트가 가진 `expected_version`은 그대로 유효하다. 가족 피드 변경 알림으로 새 라벨을 다시 읽는다.

## 서비스 역할 전용

Edge Function만 호출한다. `svc_claim_outbox(limit, lease_sec)`, `svc_outbox_still_valid(id, token)`, `svc_finish_outbox(id, token, status, error?, delivered_subscription_ids?)`, `svc_release_outbox(id, token)`, `svc_prune_push_subscription(subscription_id, endpoint)`, `svc_apply_geo_label(id, token, label)`, `svc_maintenance(action)`.

- 푸시 작업의 `svc_outbox_still_valid`는 아직 받지 않은 구독만 `subscriptions`로, 이미 받은 구독 수를 `delivered_count`로 돌려준다.
- `svc_finish_outbox`의 `delivered_subscription_ids`는 이번 시도에서 받은 구독이다. 작업 행에 누적되므로 재시도는 남은 구독에만 보낸다. 마지막 시도까지 일부만 받았으면 `sent`, 하나도 받지 못했으면 `failed`다.
