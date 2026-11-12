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
| `get_today` | days? | active, timeline, pending_offers_to_me, alerts, notification_failures, unavailable_days, server_time |
| `get_pickup` | pickup_id | pickup, offers, events, assignee, vehicle, vehicle_state, required_km, range |

`leave_family`와 `remove_member`는 떠나는 보호자가 요청자인 미종료 픽업을 `cancelled`(`cancelled_by_kind=system`)로 닫는다. 그래서 에스컬레이션과 문자가 멈추고, 이미 수락한 사람에게 취소 알림이 간다. 떠나는 보호자가 담당하던 픽업은 owner에게 넘기고, owner가 운전할 수 없으면 다른 운전 가능 보호자에게 넘긴다. 후임은 아직 출발하지 않았으므로 `en_route`·`arrived` 픽업도 `assigned`로 돌아가고 출발·도착 시각과 내비 세션이 지워진다. 이벤트는 `member_reassigned`(이전 상태 포함)이며 새 담당자와 rider에게 알림이 간다. 넘길 사람이 없으면 픽업을 취소한다.

`archive_rider`는 rider의 기기를 모두 해지하고 루틴을 보관한다. 그 rider의 미종료 픽업(`open`, `assigned`, `en_route`, `arrived`)은 보관한 보호자의 취소로 닫힌다(`cancelled_by_kind=guardian`, 이벤트 `cancelled`, `payload.cause=rider_archived`). 그래서 담당자와 가족에게 취소 알림이 간다. 이미 출발한 픽업이면 긴급 알림(`pickup_cancelled_urgent`)이 가고 배정 차량에는 긴급 카드가 뜬다.

하나의 인증 사용자는 보호자, rider 기기, 차량 중 하나다(2.1). 익명 세션이 영구 계정으로 바뀌어도 활성 rider 기기나 차량 연결이 남아 있으면 `create_family`·`join_family`는 `ALREADY_IN_FAMILY`를 돌려준다. 페어링 코드를 받은 세션이 더 이상 익명이 아니면 `vehicle_pair_confirm`은 `PAIR_CODE_INVALID`다.

`set_member_roles`로 `can_drive`를 끈 보호자는 이미 맡은 픽업을 넘길 때까지 그대로 담당하지만 출발할 수 없다. `mark_en_route`는 `FORBIDDEN`이고, `offer_pickup`으로 넘기거나 다른 보호자가 `take_over`할 수 있다. 루틴이 바뀌어 회차를 다시 계산할 때도 운전할 수 없는 기본 담당자에게는 배정하지 않는다(`ensure_occurrences`와 같은 규칙).

`update_me`와 `update_rider`의 전화번호에 빈 문자열을 넘기면 지워진다. `null`과 인자 생략은 현재 값을 유지한다. 본인 위치 동의는 `location_consent`로 가입 시 기록하거나 `update_me(p_consent)`로 기록한다. `p_consent`는 동의 문서 버전이다.

## 장소, 루틴, 차량

| RPC | 인자 | 성공 데이터 |
|---|---|---|
| `upsert_place` | label, kind, lat, lng, radius_m?, place_id?, fallback_note? | place |
| `upsert_pickup_point` | place_id, label, lat, lng, note?, pickup_point_id? | pickup_point |
| `archive_place`, `archive_pickup_point`, `archive_routine` | 해당 ID | 빈 객체 |
| `upsert_routine` | rider_id 또는 rider_member_id, place_id, weekdays, time_local, notify_before_min?, default_assignee_member_id?, default_vehicle_id?, start_date?, end_date?, pickup_point_id?, routine_id?, active?, cancel_future? | routine |
| `ensure_occurrences` | days? | created |
| `set_unavailable_day` | day, unavailable | days, held_pickup_ids |
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

`upsert_routine`에 `active=false`, `cancel_future=true`를 넘기면 앞으로의 `open`·`assigned` 회차를 이미 수락된 회차까지 `skipped`로 취소한다. 회차마다 호출한 보호자의 `cancelled` 이벤트(`cause=routine_paused`)가 남고 취소 알림이 간다. `archive_routine`과 회차를 없애는 루틴 수정은 개별 변경 없는 미래 회차만 시스템 취소로 닫는다(`cancel_reason=routine_archived`, `cancelled_by_kind=system`, 이벤트 `cause`는 `routine_archived` 또는 `routine_changed`). 이때도 기본 담당자와 가족에게 같은 취소 알림이 간다. 수락, 넘기기 제안, 위치 확인 등으로 개별 변경된 회차는 그대로 남는다.

루틴 수정으로 개별 변경 없는 미래 회차의 담당이 바뀌면(`open`→`assigned`, `assigned`→`open`, 다른 기본 담당자) 그 회차의 대기 중인 가족 전체 루틴 제안은 `cancelled`(`resolved_by_member_id` 없음)로 거둬진다. 그래서 다른 보호자의 부탁 목록과 차량 카드에서 사라지고, 그 제안으로 `respond_offer`를 부르면 `OFFER_NOT_PENDING`이다. 담당이 바뀔 때마다 시스템 이벤트 `routine_reassigned`(`previous_assignee_id`, `previous_status`, `cause=routine_changed`)가 남는다. 이 이벤트는 알림을 만들지 않는다. 새 기본 담당자는 알림 시점의 루틴 리마인더로 알게 된다. 다시 `open`이 된 회차는 루틴 제안이 아직 없었을 때만 스케줄러가 공지한다. 루틴 제안은 회차마다 한 번만 만들기 때문이다(`routine_offer_created_at`). 그 밖의 경우 보호자가 `open` 회차를 직접 수락한다. 담당이 그대로인 수정(시각, 장소, 알림 시점 등)은 대기 제안을 유지한다.

차량·픽업의 `range.verdict`는 `low`, `sufficient`, `check_required` 중 하나다. `sufficient`는 모든 픽업의 필요 거리를 계산할 수 있고 주행가능거리 값이 6시간 이내일 때만 나온다. 24시간 이내 값으로 부족하면 `low`다. 출발점이 없거나, 값이 없거나, 오래됐는데 부족하지 않으면 `check_required`다. 경고는 24시간 이내 값으로 만들거나 갱신하고, 6시간 이내 값으로 충분할 때 또는 24시간 창에 배정이 없을 때만 닫는다.

저장 장소의 `kind`는 `home`, `school`, `academy`, `other`다. `weekdays`는 월요일을 비트 0으로 하는 7비트 마스크다. 차량 기어는 `P`, `R`, `N`, `D`, `unknown`을 받는다. 차량 상태의 시각은 수집 시각이다. 피드에서 `is_stale`과 `is_demo_value`를 확인할 수 있다.

## 픽업과 푸시

- `member_create_request`, `rider_create_request`는 `wanted_in_min`(0, 10, 20, 30)과 `place_id`, `pickup_point_id`, `pin`, `gps` 중 하나를 받는다. `pin` 객체는 `lat`, `lng`, `note?`, `current_location?`을 받는다. `gps` 객체는 `lat`, `lng`, `accuracy_m?`을 받는다.
- `accept_pickup`은 대기 제안을 그 제안의 대상이 수락할 때만 `accepted`로 닫는다. 기본 담당으로 배정된 회차를 담당자가 처음 수락할 때 자신이 보낸 넘기기 제안(차량의 "못 가요" 포함)이 대기 중이면 그 제안은 `cancelled`로 거둬지고 `resolved_by_member_id`는 수락한 사람이다. 받는 사람의 부탁 알림은 건너뛰고, 다른 보호자에게는 일반 수락 정보 알림(`pickup_accepted`)만 간다.
- `accept_pickup`은 `pickup_id`, `vehicle_id?`를 받는다. `offer_pickup`, `respond_offer`, `cancel_offer`, `take_over`, `mark_en_route`, `mark_completed`, `cancel_pickup`, `confirm_location`, `skip_occurrence`, `undo_en_route`, `rider_ready_early`, `rider_report_not_met`, `vehicle_decline`에는 `expected_version`이 필요하다.
- `vehicle_start_now`는 `pickup_id`, `expected_version`, `action_id`, `offer_id?`를 받고 `pickup`, `dest`, `nav_session_id`, `destination_revision`을 돌려준다. `mark_arrived`의 `source=manual`은 `expected_version`, `source=nav_callback`은 `nav_session_id`와 `destination_revision`을 사용한다. `report_nav_result`는 `pickup_id`, `nav_session_id`, `result`, `error_code?`를 받는다.
- 보호자 취소 사유에는 `resolved_by_phone`, `mistake`, `other_way_home`, `other`를 사용한다. 도착한 픽업은 `not_met`으로 취소할 수 있다. 루틴 건너뛰기는 `skipped`로 기록된다.
- 차량이 `offer_pickup`을 부르면 `to_member_id`와 `note` 없이 가족 전체에게만 넘길 수 있고, 둘 중 하나라도 있으면 `FORBIDDEN`이다. 차량 앱은 `vehicle_decline`을 쓴다.
- 차량은 자기 픽업, `open` 픽업, 운전자가 맡은 픽업, 운전자에게 온 제안에만 동작한다. 그 밖의 픽업은 `NOT_FOUND`다. 다만 운전자가 운전할 수 있고 요청자가 아니면, 다른 사람이 먼저 맡은 픽업에 부른 `accept_pickup`은 `ALREADY_TAKEN`(`detail.by`=맡은 사람의 호칭)을 받는다. 요청·루틴 카드에서 부른 `vehicle_start_now`도, 다른 사람이 맡은 픽업(`assigned`, `en_route`, `arrived`)이고 이 차가 그 픽업의 배정 차량이 아니면 같은 `ALREADY_TAKEN`을 받는다(V-03). `offer_id`가 없을 때와, 피드 카드에 실린 그 픽업의 가족 전체 제안(보낸 사람 없는 요청·루틴 제안) ID일 때 모두 그렇다. 이 경합 결과는 `accept_pickup`처럼 버전 검사보다 먼저 판단한다(4.5). 그래서 카드를 그린 뒤 다른 사람이 맡아 버전이 바뀌었어도 `ALREADY_TAKEN`을 받고, 아무것도 바뀌지 않는다. 보낸 사람이 있는 인계 제안(보호자의 넘기기, 차량의 "못 가요")의 ID를 넣어 부를 때, 다른 사람이 맡은 `assigned` 픽업에서 그 제안이 운전자에게 유효하지 않으면(대기 중이 아님, 만료, 다른 대상) `NO_VALID_OFFER`다. 다른 픽업의 제안 ID나 없는 ID도 `NO_VALID_OFFER`다. 방금 만료된 제안은 `expired`로 저장한 뒤 거절한다(8.3.1). 그 밖의 출발(자기 픽업, `open` 픽업, 인계 제안 ID를 넣은 호출, 운전자가 바뀐 배정 차량의 안내 다시 열기)은 버전 검사를 먼저 하므로, 오래된 카드면 현재 픽업이 담긴 `STALE_VERSION`을 받는다. 도착, 탑승 확인, 위치 확인, 출발 되돌리기, 내비 결과는 그대로 `NOT_FOUND`다. 다른 가족의 픽업 ID는 존재하지 않는 ID와 같은 응답을 받는다.
- 열린 요청에 `vehicle_decline`을 부를 때, 아직 거절하지 않은 운전 가능 보호자가 그 차의 운전자뿐이면 요청 제안은 `declined`로 닫힌다(`resolved_by_member_id`=그 운전자). `respond_offer(decline)`과 같은 규칙이다(4.4 #7). 요청 제안에는 보낸 사람이 없으므로 두 경로 모두 거절 알림을 보내지 않는다. 요청은 `open`으로 남고, 거절한 사람도 나중에 직접 수락할 수 있다.
- `register_push_subscription`은 `endpoint`, `p256dh`, `auth`를 받고 `unregister_push_subscription`은 `endpoint`를 받는다. 다른 계정이 등록한 엔드포인트는 등록하면 `FORBIDDEN`이고, 해지는 자기 구독만 지우며 없어도 성공한다. `enqueue_test_push`는 인자 없이 호출한다.
- GPS 요청의 "OO동 근처" 라벨은 발송 워커가 비동기로 채운다. 표시용 라벨이라 `version`과 `destination_revision`을 올리지 않으므로, 라벨이 바뀌어도 클라이언트가 가진 `expected_version`은 그대로 유효하다. 가족 피드 변경 알림으로 새 라벨을 다시 읽는다.

## 갈 사람이 없을 때 (SPEC 24장)

| RPC | 인자 | 성공 데이터 |
|---|---|---|
| `declare_no_driver` | pickup_id, expected_version, note | pickup |
| `ack_fallback` | pickup_id | pickup |
| `set_unavailable_day` | day, unavailable | days, held_pickup_ids |

- `declare_no_driver`는 "못 간다고 알리기"(24.3 20·21번)다. `open` 픽업은 요청자가 아닌 보호자 누구나(운전하지 않는 보호자 포함), `assigned` 픽업은 담당자만 부른다. `note`는 앞뒤 공백(스페이스, 탭, 줄바꿈)을 지운 뒤 1~40자다. 성공하면 픽업은 `cancelled`가 되고 `cancel_reason=no_driver`, `fallback_note`(지운 뒤의 문구), `fallback_by_member_id`, `cancelled_by_kind=guardian`, `is_customized=true`가 기록된다. 대기 제안은 `cancelled`, 이벤트는 `no_driver`이며 `version`이 1 오른다. 루틴 회차를 이렇게 끝내도 루틴은 그대로다.
- `declare_no_driver` 오류: 차량과 rider 기기는 `FORBIDDEN`이다. 픽업을 읽기 전에 거부하므로 어떤 ID를 넣어도 같은 응답이다(S-64). 요청한 보호자 본인은 `FORBIDDEN`, 버전 불일치는 `STALE_VERSION`(현재 픽업 포함), `en_route`·`arrived`·종료 상태는 `INVALID_STATE`, 다른 보호자가 담당한 `assigned`는 `NOT_ASSIGNEE`, `note` 범위 밖은 `VALIDATION`(`detail.field=note`)이다. 원하는 시각 + 60분이 지난 `open` 픽업은 4.5대로 그 자리에서 `expired`로 바꾸고 `PICKUP_EXPIRED`를 돌려준다. 다른 가족의 픽업은 없는 ID와 같은 `NOT_FOUND`다.
- `ack_fallback`은 "알겠어"(22번)다. 그 픽업의 요청자, 곧 rider 기기 또는 요청한 보호자만 부른다. `expected_version`은 받지 않는다. 처음 부를 때 `fallback_ack_at`과 이벤트 `fallback_acknowledged`를 남기고, 다시 부르면 바뀐 것 없이 같은 픽업으로 성공한다. `version`은 오르지 않는다. 차량은 `FORBIDDEN`(픽업을 읽기 전), 요청자가 아닌 보호자는 `FORBIDDEN`, 다른 rider의 기기는 `NOT_FOUND`, `cancelled`이면서 `cancel_reason=no_driver`가 아닌 픽업은 `INVALID_STATE`다.
- `set_unavailable_day`는 호출한 보호자 본인의 "못 가는 날"을 켜거나(`unavailable=true`) 끈다. `day`는 가족 시간대 날짜이며 오늘부터 60일 뒤까지만 받는다. 범위 밖이나 `null`은 `VALIDATION`, `can_drive=false`인 보호자는 `FORBIDDEN`, rider 기기와 차량은 `NOT_GUARDIAN`이다. 같은 값을 다시 보내도 성공한다. `days`는 가족 전체(활성 보호자)의 오늘부터 60일 뒤까지 `[{member_id, day}]`이고, `held_pickup_ids`는 그날 호출한 보호자가 계속 맡고 있는 픽업(`assigned`, `en_route`, `arrived`)이다. P-19의 "이날 맡은 픽업 1건은 그대로예요"에 쓴다.
- `set_unavailable_day`는 같은 트랜잭션에서 그날의 개별 변경 없는(`is_customized=false`) 미래 루틴 회차를 다시 계산한다. 켜면 호출한 보호자가 담당인 `assigned` 회차가 `open`이 되고(대기 제안 `cancelled`), 끄면 루틴의 기본 담당이 호출한 보호자인 `open` 회차가 다시 그 보호자 담당이 된다. 가족 전체 제안을 이미 만든 회차(`routine_offer_created_at`)는 끌 때 건드리지 않는다. 이벤트는 `routine_reassigned`(`cause`는 `unavailable_day` 또는 `unavailable_day_cleared`, 주체는 호출한 보호자)이고 알림은 없다. 다시 `open`이 된 회차의 알림 시점이 지났으면 다음 스케줄러 실행이 가족 전체 제안과 `routine_open`을 만든다.
- 회차 생성(`ensure_occurrences`)과 루틴 수정(`upsert_routine`의 재계산)도 기본 담당이 그 날짜에 못 가는 날이면 회차를 `open`으로 둔다. 다른 보호자에게 자동으로 배정하지 않는다.
- `upsert_place`의 `fallback_note`(못 갈 때 안내)는 생략하거나 `null`이면 현재 값을 유지한다(새 장소는 없음). 빈 문자열이나 공백만 있으면 지운다. 앞뒤 공백을 지운 뒤 40자를 넘으면 `VALIDATION`이다.
- "갈 수 있는 운전자"는 요청 수신 대상(`can_drive`, 탈퇴하지 않음, 요청자 본인 제외) 중 픽업 날짜(`wanted_at`의 가족 시간대 날짜)가 못 가는 날이 아니고, 픽업의 마지막 제안이 가족 전체 제안(보낸 사람 없음)일 때 그 제안을 거절하지 않은 사람이다(`deriro_private.available_drivers`). "갈 사람 없음"은 `open` 픽업의 이 목록이 비어 있는 상태이며 저장하지 않는다. 공용 상태 머신의 `availableDrivers`, `nobodyAvailable`과 같은 정의다.

피드 필드

- `get_today`의 `active`·`timeline` 줄: 픽업 행의 `cancel_reason`, `fallback_note`, `fallback_by_member_id`, `fallback_ack_at`와 함께 `fallback_by_name`(알린 보호자 호칭), `no_available_driver`(갈 사람 없음), `unavailable_member_ids`(픽업 날짜가 못 가는 날인 활성 보호자, P-06), `place_fallback_note`(목적지 장소의 못 갈 때 안내, P-18 기본값)를 싣는다. 최상위 `unavailable_days`는 오늘부터 14일 동안 가족 활성 보호자의 `[{member_id, day}]`다. 내일 회차("내일" 구역)까지 받으려면 `days=2`로 부른다.
- `get_pickup`의 `pickup`도 위 줄과 같은 필드를 가진다. `events`에는 `no_driver`(주체 보호자)와 `fallback_acknowledged`(주체 rider 또는 보호자)가 남는다.
- `get_family_overview`와 `rider_get_state`의 `places`에는 `fallback_note`가 있다.
- `rider_get_state`의 `actives` 줄: `nobody_available`(갈 사람 없음, `open_nobody`), `wait_note`(목적지 장소의 못 갈 때 안내, 모든 줄), `fallback_by_name`, 그리고 픽업 행의 `cancel_reason`, `fallback_note`, `fallback_by_member_id`, `fallback_ack_at`. `cancelled`·`no_driver` 픽업은 확인 전이면 `max(wanted_at, cancelled_at) + 3시간`까지, 확인 뒤에는 10분 동안 계속 내려 준다. 확인 없이 5분이 지나면 `escalation_stage=1`이다(전화 버튼 강조).
- `vehicle_get_feed`는 바뀌지 않는다. 카드, `active_trip`, `today`, `nearby_places`에서 새 열을 뺀다. 못 간다고 알린 픽업은 기존 취소처럼 보인다. 픽업 행을 그대로 돌려주는 RPC 응답의 `pickup`에는 차량 RPC를 포함해 새 열 세 개가 함께 실린다(대개 `null`).

알림(24.4)

| 템플릿 | 만드는 때 | 받는 사람 | 채널 | `dedupe_key` | 발송 직전 조건 |
|---|---|---|---|---|---|
| `nobody_available` | 요청이 만들어질 때 이미 갈 사람이 없거나, 가족 전체 제안 거절로 갈 사람이 없어진 때 | 보호자 전원(요청한 보호자 제외) | 긴급 푸시 | `na:{pickup}:{member}` | 픽업 `open` |
| `no_driver` | 이벤트 `no_driver` | 보호자 전원 − 알린 사람 | 정보 푸시 | `no_driver:{event}:{member}` | 픽업 `cancelled` |
| `fallback_acknowledged` | 이벤트 `fallback_acknowledged` | 보호자 전원(요청한 보호자 제외) | 정보 푸시 | `fallback_acknowledged:{event}:{member}` | 픽업 `cancelled` |
| `fallback_unacked` | 알린 뒤 5분 미확인(스케줄러) | 보호자 전원(요청한 보호자 제외, 알린 사람 포함) | 긴급 푸시 | `fb5:{pickup}:{member}` | `cancelled`, `fallback_ack_at` 없음 |
| `fallback_unacked_sms` | 알린 뒤 10분 미확인(스케줄러) | 위 대상 중 문자 수신 동의자 | 문자 | `fb10:{pickup}:{member}` | `cancelled`, `fallback_ack_at` 없음 |
| `tomorrow_open`, `tomorrow_nobody` | 가족 시간대 20:00 이후 스케줄러, 내일 날짜의 `open` 루틴 회차 | 보호자 전원(요청한 보호자 제외) | 푸시 | `tmr:{pickup}:{member}` | 픽업 `open` |

- `nobody_available`은 픽업마다 한 번이다. 요청 생성과 거절이 같은 `na:` 키를 쓴다. 거절은 폰(`respond_offer`)과 차량(`vehicle_decline`) 모두 해당한다. 못 가는 날을 표시해서 갈 사람이 없어진 경우에는 보내지 않는다.
- 미확인 재알림은 부르는 사람 화면에 남아 있는 동안(`max(wanted_at, cancelled_at) + 3시간`)만 만든다. 확인되면 아직 대기 중인 단계는 `skipped`가 되고, 워커가 이미 잡은 단계는 `svc_outbox_still_valid`가 `valid=false`를 돌려준다.
- `tomorrow_nobody`는 그 회차의 갈 수 있는 운전자가 0명일 때, 아니면 `tomorrow_open`이다. 두 템플릿은 같은 `tmr:` 키를 쓰므로 회차마다 하나만 간다. 20:00 뒤에 `open`이 된 회차는 다음 실행에서 보낸다.
- 푸시·문자 문구는 `supabase/functions/_shared/templates.ts`에 있다. 페이로드에는 기존 필드 외에 `fallback_note`, `fallback_by`(호칭)가 있다.

## 서비스 역할 전용

Edge Function만 호출한다. `svc_claim_outbox(limit, lease_sec)`, `svc_outbox_still_valid(id, token)`, `svc_finish_outbox(id, token, status, error?, delivered_subscription_ids?)`, `svc_release_outbox(id, token)`, `svc_prune_push_subscription(subscription_id, endpoint)`, `svc_apply_geo_label(id, token, label)`, `svc_maintenance(action)`.

- 푸시 작업의 `svc_outbox_still_valid`는 아직 받지 않은 구독만 `subscriptions`로, 이미 받은 구독 수를 `delivered_count`로 돌려준다.
- `svc_finish_outbox`의 `delivered_subscription_ids`는 이번 시도에서 받은 구독이다. 작업 행에 누적되므로 재시도는 남은 구독에만 보낸다. 마지막 시도까지 일부만 받았으면 `sent`, 하나도 받지 못했으면 `failed`다.
