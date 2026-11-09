# 백엔드 RPC 계약

RPC 인자명은 `p_`로 시작한다. 성공 응답은 `{ok:true,data:{…}}`, 업무 오류는 `{ok:false,error:{code,detail}}`이다. ID는 UUID, 시각은 ISO 8601, 행 필드는 snake_case다. 날짜와 루틴 시각은 한국 표준시를 사용한다.

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

저장 장소의 `kind`는 `home`, `school`, `academy`, `other`다. `weekdays`는 월요일을 비트 0으로 하는 7비트 마스크다. 차량 기어는 `P`, `R`, `N`, `D`, `unknown`을 받는다. 차량 상태의 시각은 수집 시각이다. 피드에서 `is_stale`과 `is_demo_value`를 확인할 수 있다.

## 픽업과 푸시

- `member_create_request`, `rider_create_request`는 `wanted_in_min`(0, 10, 20, 30)과 `place_id`, `pickup_point_id`, `pin`, `gps` 중 하나를 받는다. `pin` 객체는 `lat`, `lng`, `note?`, `current_location?`을 받는다. `gps` 객체는 `lat`, `lng`, `accuracy_m?`을 받는다.
- `accept_pickup`은 `pickup_id`, `vehicle_id?`를 받는다. `offer_pickup`, `respond_offer`, `cancel_offer`, `take_over`, `mark_en_route`, `mark_completed`, `cancel_pickup`, `confirm_location`, `skip_occurrence`, `undo_en_route`, `rider_ready_early`, `rider_report_not_met`, `vehicle_decline`에는 `expected_version`이 필요하다.
- `vehicle_start_now`는 `pickup_id`, `expected_version`, `action_id`, `offer_id?`를 받고 `pickup`, `dest`, `nav_session_id`, `destination_revision`을 돌려준다. `mark_arrived`의 `source=manual`은 `expected_version`, `source=nav_callback`은 `nav_session_id`와 `destination_revision`을 사용한다. `report_nav_result`는 `pickup_id`, `nav_session_id`, `result`, `error_code?`를 받는다.
- 보호자 취소 사유에는 `resolved_by_phone`, `mistake`, `other_way_home`, `other`를 사용한다. 도착한 픽업은 `not_met`으로 취소할 수 있다. 루틴 건너뛰기는 `skipped`로 기록된다.
- `register_push_subscription`은 `endpoint`, `p256dh`, `auth`를 받고 `unregister_push_subscription`은 `endpoint`를 받는다. `enqueue_test_push`는 인자 없이 호출한다.
