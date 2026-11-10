# 백엔드 구현과 검증 범위

가족·기기 연결, 위치와 픽업 진행, 차량 상태, 알림 대기열을 Supabase 마이그레이션과 인증 RPC로 구현했다. 웹 데모는 `packages/contracts`의 TypeScript 상태 머신을 브라우저 저장소에서 실행한다. 이 상태 머신은 SQL 전이와 같은 규칙을 따르지만 별도 구현이다. 라이브 모드는 별도의 Supabase URL과 공개 키를 사용한다. [RPC 계약](backend-api.md)

| 명세 | 로컬 구현 및 확인 |
|---|---|
| F-01~F-05, F-18~F-19 | 보호자 온보딩·초대·탈퇴·소유자 이관, rider 본인 또는 보호자 동의, 기기 연결·해지, 저장 장소·타는 곳, 차량 페어링. SQL에서 역할 분리, 코드의 해시 저장·일회성·시도 제한, 기기 해지, 탈퇴 이후 이력과 권한을 확인했다. 탈퇴하는 보호자가 요청한 미종료 픽업은 닫히고, 담당하던 픽업은 owner에게 `assigned`로 넘어가며 출발·내비 상태가 지워진다. rider를 보관하면 그 rider의 미종료 픽업은 보관한 보호자의 취소로 닫히고, 담당자에게 취소 알림(이미 출발했으면 긴급)이 간다. |
| F-06, F-16 | 차량의 최신 기어·거리·연료·배터리·위치 샘플과 현재 운전자 관리. SQL에서 24시간 범위의 배정만 추정에 포함되는지, 예상 거리가 부족할 때 경고가 생기는지 확인했다. 차량 위치 또는 집 기준을 사용할 수 없거나 값이 6시간보다 오래되면 "충분" 대신 확인 필요로 반환한다. 24시간보다 오래된 값은 경고를 만들지도 닫지도 않는다(부록 A.3). |
| F-07, F-21 | 한국 표준시로 루틴 회차 생성 및 미래 회차 수정·보관. 회차는 루틴 저장과 매시 스케줄러가 만들며 `get_today`는 읽기만 한다. 비활성화할 때 예정 회차를 유지하거나 취소할 수 있다. 회차 생성은 멱등이며, 인계 제안이나 명시적 수락으로 개별 변경된 회차는 보존한다. 루틴 보관이나 비활성화로 취소된 회차에는 `cancelled` 이벤트가 남고 담당자·가족에게 취소 알림이 간다. 루틴 수정으로 회차의 담당이 바뀌면 대기 중인 가족 전체 제안은 거둬지고, 알림 없는 시스템 이벤트 `routine_reassigned`가 남는다. |
| F-08~F-14, F-22 | rider와 보호자의 요청, GPS 보정과 지도 핀, 수락과 인계, 차량의 거절과 출발, 내비 콜백 귀속, 수동 도착·탑승과 취소. 단위·SQL·동시성 테스트가 핵심 상태와 권한을 확인한다. 제안은 대상이 수락할 때만 `accepted`가 된다. 기본 담당자가 자기 회차를 처음 수락하면 자신이 보낸 대기 제안은 `cancelled`로 거둬진다(4.4). |
| F-15, F-17 | 트랜잭션과 함께 생성되는 알림, 상태·수신 권한 재확인, 시도 횟수와 30초·2분·5분 재시도, 만료된 lease 회수, 가족별 문자 한도, 푸시 구독 해지, 3시간 뒤 미확인 종료. 웹 푸시는 구독별 성공을 기록해 재시도가 받지 못한 구독에만 간다. SQL은 대기열과 종료 상태를 검증했고 Deno 테스트는 외부 전송 경계를 모의했다. |
| F-20 | 브라우저 데모는 라이브 데이터와 분리된다. SQL 데모 RPC는 명시적으로 데모 표시한 가족의 소유자만 실행할 수 있다. 서버 초기화는 런타임 픽업·경고·알림을 지우고 등록된 루틴에서 회차를 다시 생성한다. 데모로 표시된 알림은 외부로 보내지 않는다. |
| §7.3, §8.8 | 종료 30일 뒤 원본 GPS 제거와 비저장 목적지 반올림, 장기 데이터 정리, 계정 삭제 전 가족 정리, Kakao 행정동 조회·Web Push·Twilio 문자·DryRun 어댑터. SQL에서 좌표 반올림과 메모 보존, 소유자 삭제 확인 절차를 확인했다. 행정동 라벨은 8.8의 "dispatch 내에서 직접" 방식으로 `dispatch-notifications`가 `geo` 아웃박스 작업을 처리해 기록한다. 별도 `geo-reverse` 함수는 두지 않는다. 라벨 기록은 `version`과 `destination_revision`을 올리지 않는다. |

## 재실행

```sh
pnpm --filter @deriro/contracts test
pnpm --filter @deriro/contracts test:sql
pnpm --filter @deriro/contracts test:sql --write-fixtures
```

단위 테스트 12개(상태 머신 9개, 푸시 결과 집계 3개)와 PGlite 0.3.15의 PostgreSQL 17.5에서 pgTAP 검사 2,653개가 통과했다. 2,653개는 전체 마이그레이션 위의 다섯 파일(isolation 2,312, operations 77, pickup_lifecycle 53, regressions 102, scheduler 34)과 마이그레이션 접두 검사 75개다. 내장 DB는 Supabase의 인증 역할, 사용자 테이블과 `auth.uid()`를 모의한다. `public` 스키마의 기본 권한 부여(새 테이블·시퀀스·함수를 `anon`·`authenticated`·`service_role`에 부여)와 `supabase_realtime` 게시도 재현하므로, 회수를 빠뜨린 마이그레이션은 이 검사에서 실패한다. PostgREST, Realtime 서버, pg_cron, pg_net, Vault는 재현하지 않는다. `--write-fixtures`는 SQL 호출 결과를 [피드 예시](../supabase/tests/fixtures)에 기록한다. 예시의 거리 경고 값은 실행 시각에 따라 달라진다. 내일 17:30 회차가 24시간 창에 들어오는지에 따라 정해지기 때문이다.

마이그레이션은 순서대로 적용할 때 각 파일이 유효하다. 테이블·열·제약·인덱스·RLS·권한은 모두 첫 파일(`deriro_foundation`)에 있고, 이후 파일은 함수와 트리거만 더한다. PL/pgSQL은 문장을 실행할 때 이름을 확인하므로, `test:sql`은 앞의 두·세·네 파일만 적용한 DB에서 그 파일들의 함수를 실행하는 접두 검사를 먼저 돌린다(`packages/contracts/test-db/prefix`). [회귀 테스트](../supabase/tests/regressions.test.sql)는 탈퇴 처리, 행정동 라벨과 버전, 구독별 푸시 재시도, 제약 이름 기반 오류 변환, 주행가능거리 판정, 읽기 전용 `get_today`를 확인한다. 수락 시 제안 처리(보낸 사람이 자기 회차를 수락하면 제안은 수락이 아니라 취소, 받는 사람에게 사실과 다른 알림 없음)와 rider 보관·루틴 보관·루틴 비활성화의 취소 이벤트와 알림도 확인한다. 루틴 수정으로 담당이 바뀐 회차에 가족 전체 제안이 남지 않는지(다른 보호자의 RLS 조회·오늘 피드·차량 카드·제안 응답)와, 그 변경이 알림 없이 이벤트로만 기록되는지도 확인한다. 이 검사들은 수정 전 마이그레이션에서 실패하는 것을 확인했다.

[격리 테스트](../supabase/tests/isolation.test.sql)는 가족 단위 격리(2.1)와 역할표(2.2, 23)를 증명한다. 가족 A·B와 데모 가족 D에 owner, guardian, `can_drive`·`can_request`가 꺼진 guardian, 탈퇴한 보호자, 활성·해지된 rider 기기, 활성·해지된 차량, 묶이지 않은 익명 사용자, 가족 없는 일반 계정, JWT 없는 `anon`, `service_role`을 둔다. 모든 호출은 주체로 전환해 실행하고, 호출 전후로 모든 테이블의 행을 가족별로 지문화한 뒤 되돌린다.

- 카탈로그: 공개 RPC는 모두 SECURITY INVOKER이고 `search_path`를 비운다. `anon`과 `PUBLIC`은 어떤 함수도 실행하지 못하고, `svc_*`는 `service_role`만 실행한다. `authenticated`가 실행할 수 있는 `deriro_private` 함수는 RLS 헬퍼(`member_family`, `member_id`)와 공개 RPC가 위임하는 SECURITY DEFINER 함수뿐이다. 모든 테이블에 RLS가 켜져 있고, 정책은 `authenticated`의 SELECT뿐이다. 테이블별로 읽을 수 있는 열을 정확히 고정하고, 시퀀스·`deriro_private` 테이블에는 API 역할 권한이 없다. Realtime은 `family_feed_changes`와 `pickup_offers`만 게시한다.
- 직접 접근: 공개 테이블 18개와 주체 18명의 모든 조합에서 SELECT는 자기 가족 행만(보호자가 아니면 0행) 돌려주거나 42501로 거부되고, INSERT·UPDATE·DELETE는 42501이다. 부여되지 않은 열(전화번호, 인증 사용자 ID, 원본 GPS, 내비 세션 등)은 보호자도 선택하지 못한다.
- 역할표: 공개 함수 72개를 모두 분류한 101개 호출을 가족 A의 주체 13명이 각각 실행한다. 허용된 칸은 성공하고 가족 A의 행만 바꾸며, 나머지 칸은 오류를 돌려주고 아무것도 바꾸지 않는다. 분류되지 않은 공개 함수가 생기면 실패한다.
- 가족 간: ID를 받는 모든 RPC를 가족 B의 owner·rider 기기·차량이 가족 A의 ID로 호출한다. 모두 거부되고, 아무 행도 바뀌지 않으며, 응답은 존재하지 않는 ID일 때와 같고(존재 여부 노출 없음), 가족 A의 ID·이름·전화번호를 담지 않는다. 초대·페어링 코드와 푸시 엔드포인트, 각 피드도 같은 기준으로 확인한다.

시나리오의 백엔드 조건 중 수락 경합과 권한(S-02, S-18, S-23~S-27), 요청·미출발·탑승 확인 타이머(S-03~S-04, S-20, S-33, S-44, S-48), 내비 실패와 도착 귀속(S-19, S-34), 대기 제안과 명시적 탑승(S-37, S-40, S-42), 탈퇴 후 이력(S-45), 거리 경고의 재알림과 행위자 기록(S-49~S-50), rider 권한과 지도 핀 보존(S-51~S-56)을 확인했다. 이 검사는 전체 기기·화면 시나리오의 통과 기록을 대신하지 않는다.

독립 PostgreSQL 18.1과 CI의 PostgreSQL 17.5 서비스 컨테이너에서 두 연결로 수락 경합, 수락과 인계 응답 경합, 같은 초대의 동시 사용, 워커의 중복 없는 분할 claim, 만료된 claim 회수를 확인했다. 다음 환경 변수는 별도 루프백 테스트 인스턴스에만 사용한다. 테스트는 임시 데이터베이스를 만든 뒤 정리한다.

```powershell
$env:DERIRO_TEST_PGPORT = "55432"
$env:DERIRO_TEST_PGUSER = "deriro_test"
$env:DERIRO_TEST_PSQL = "C:/Program Files/PostgreSQL/18/bin/psql.exe"
pnpm --filter @deriro/contracts test:sql:concurrency
```

Edge Functions 세 개의 형식 검사와 모의 HTTP 테스트 9개는 CI의 `edge-functions` 작업이 Deno 2.5.6으로 실행한다. 이번 변경(구독별 푸시 재시도 테스트 2개 추가, `geo-reverse` 제거) 이후 로컬에서는 Deno를 실행하지 못했다. 같은 집계 규칙은 Node 단위 테스트(`push-outcome.test.ts`)로 확인했다.

```sh
deno check --node-modules-dir=none --frozen --lock=supabase/functions/deno.lock supabase/functions/dispatch-notifications/index.ts supabase/functions/send-rider-invite/index.ts supabase/functions/delete-account/index.ts supabase/functions/_shared/edge.test.ts
deno test --node-modules-dir=none --frozen --lock=supabase/functions/deno.lock --allow-env supabase/functions/_shared/edge.test.ts
```

## 알려진 한계: 차량 신뢰 모델

명세가 허용하는 설계이며 보안 통제가 아니다.

- 페어링된 차량은 익명 Auth 사용자다. 차량 RPC는 그 차량의 현재 운전자 보호자 권한으로 수락·출발·제안 응답을 처리한다.
- `vehicle_set_driver`(8.3, "차량(주차 중, 클라이언트 판단)")로 차량이 가족의 운전 가능 보호자 중 누구든 현재 운전자로 고를 수 있다. 그래서 페어링된 차량 기기 하나가 사실상 가족의 모든 운전 가능 보호자를 대신할 수 있다.
- 주차 전용 동작(운전자 변경, 위치 확정, 차량 탑승 확인, 주차 중 경로 전환)이 보는 기어 값은 차량이 `upsert_vehicle_state`로 직접 보고한다. 서버는 30초 이내 기록인지만 확인하고 값 자체는 검증하지 않는다. 운전 중 조작을 줄이는 UX 장치일 뿐 위조를 막지 못한다.
- 차량이 넘기기를 할 때는 거절(`vehicle_decline`)로 가족 전체에 넘길 수만 있다. 받는 사람을 고르거나 메모를 붙이는 `offer_pickup`은 폰에서 담당 보호자가 한다(2.2).
- 대응은 보호자의 차량 해지(`revoke_vehicle`)다. 해지하면 차량 세션은 즉시 가족 데이터와 픽업 전이에 접근하지 못한다. 분실된 차량 기기는 해지 전까지 가족 자격 증명처럼 다뤄야 한다.
- 실제 차량 SDK의 서명된 기어·위치 신호로 바꾸는 일은 이 범위 밖이다.

## 알려진 한계: 연결 코드 추측과 Auth 빈도 제한

rider 연결 코드는 숫자 8자리(10^8가지, [결정])이고 10분 동안 유효하다. `claim_rider_invite`는 가족을 가리지 않고 모든 유효 코드와 비교하므로, 동시에 유효한 코드가 K개면 추측 한 번의 성공 확률은 K/10^8이다. RPC는 인증 사용자 하나에 10분 5회만 허용한다(성공·실패 모두 센다). 그러나 익명 로그인으로 인증 사용자를 새로 만들 수 있으므로, 실제 상한은 Supabase Auth의 IP별 빈도 제한이 정한다. 그래서 `supabase/config.toml`의 `[auth.rate_limit]`에 다음 값을 명시했다. 키 이름과 단위는 Supabase CLI 2.83.0의 설정 템플릿과 Auth 빈도 제한 문서에서 확인했다.

| 키 | 값 | 단위 | CLI 기본값 |
|---|---|---|---|
| `anonymous_users` | 10 | IP별 1시간. 버킷 크기도 10 | 30 |
| `sign_in_sign_ups` | 15 | IP별 5분, 익명 로그인 제외 | 30 |
| `token_verifications` | 15 | IP별 5분(이메일 OTP 확인) | 30 |
| `token_refresh` | 150 | IP별 5분(세션 갱신 포함) | 150 |
| `email_sent` | 30 | 프로젝트 전체 1시간. 사용자 SMTP일 때만 적용 | 2 |

IP 하나, 유효 코드 1개(K=1) 기준 계산은 다음과 같다.

- 처음 10분: 익명 사용자 최대 약 12명(버킷 10 + 10분 재충전 약 2) × 5회 = 약 60회. 성공 확률은 약 6×10^-7이다.
- 익명 사용자는 지워지지 않고 시간당 10명씩 쌓인다. 세션은 JWT 만료(기본 3,600초)마다 갱신해야 하므로 IP 하나가 계속 쓸 수 있는 사용자는 `token_refresh` 기준 시간당 150×12 = 1,800명이다. 약 7.5일(1,800 ÷ 10시간당) 뒤에는 10분마다 1,800×5 = 9,000회, 코드 하나의 유효 시간 동안 성공 확률 9×10^-5, 하루(10분 구간 144개) 누적 약 1.3%까지 오른다.
- IP를 여러 개 쓰면 IP 수에 비례해 늘어난다. 유효 코드가 K개면 K배다.
- 이메일 OTP(6자리, 10분 유효)는 `token_verifications`로 IP 하나당 OTP 유효 시간 동안 최대 약 60회(버킷 30 + 10분 재충전 30), 성공 확률 약 6×10^-5로 묶인다.

따라서 8자리 코드의 추측 저항은 RPC의 사용자별 제한만으로는 성립하지 않고, 위 Auth 제한과 선택 사항인 CAPTCHA(익명 로그인에 hCaptcha 또는 Turnstile, Supabase 권장)에 기댄다. CAPTCHA는 웹·차량 클라이언트가 토큰을 함께 보내야 해서 설정하지 않았다. 연결하지 않은 채 남은 익명 사용자 정리와 코드 실패의 전역 집계도 구현하지 않았다. `anonymous_users`를 낮추면 통신사 NAT나 학교 Wi-Fi처럼 IP를 공유하는 기기가 429를 받을 수 있다. `email_sent`는 사용자 SMTP를 켰을 때만 적용되므로, 운영에서 보호자 로그인 메일이 막히지 않도록 CLI 기본값 2 대신 30으로 두었다.

확인한 범위는 Supabase CLI 2.83.0이 이 설정 파일을 해석하는 데까지다. Docker 없이 `supabase status`가 설정 해석을 통과해 Docker 연결 단계에서 멈추는 것과, 같은 파일에 잘못된 값을 넣으면 해석 단계에서 거부되는 것을 봤다. 로컬 GoTrue나 실제 Supabase 프로젝트에 적용해 429 응답을 확인하지는 않았다. 이 파일은 로컬 `supabase start`에 쓰이며, 호스팅 프로젝트에는 `supabase config push`나 대시보드로 따로 반영해야 한다.

## 로컬 Supabase와 외부 연결

Docker 엔진을 사용할 수 없어 GoTrue OTP 수신, 실제 PostgREST·Realtime·Edge Runtime, pg_cron과 pg_net 예약, Supabase DB Advisors는 이 환경에서 실행하지 못했다. Docker가 동작하는 로컬 환경에서는 다음을 사용한다.

```sh
pnpm dlx supabase@2.83.0 start
pnpm dlx supabase@2.83.0 test db --local
pnpm dlx supabase@2.83.0 db advisors --local
pnpm dlx supabase@2.83.0 functions serve --env-file supabase/functions/.env.local
```

로컬 메일은 `http://127.0.0.1:54324`에서 확인한다. OTP 템플릿은 6자리 숫자를 표시한다. 웹·차량 앱에는 `supabase status`가 표시하는 API URL과 공개 키를 사용한다.

- [로컬 Edge 환경 예시](../supabase/functions/.env.example)는 문자와 푸시를 DryRun으로 설정한다. 알림 작업에서 DryRun은 모의 실행을 뜻하는 `skipped`로 기록된다.
- 즉시·주기 발송은 Vault의 `deriro_dispatch_url`과 `deriro_dispatch_secret`을 읽는다. URL은 `dispatch-notifications` 경로이며, Edge의 `DISPATCH_SECRET`과 동일한 임의 값을 설정한다. 큐의 claim·재검증·완료 API는 서비스 역할에만 허용된다.
- 실제 문자는 `SMS_PROVIDER=twilio`와 `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`가 필요하다. 발신 번호 정책, 한국 발송, 비용, 메시지 분할은 공급자 계약과 실제 발송에서 확인해야 한다. Web Push는 `PUSH_PROVIDER=web_push`, `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`를 사용한다. 주소 보정은 `GEOCODER_PROVIDER=kakao` 및 `KAKAO_REST_API_KEY`로 켜며, 행정동 수준 라벨을 보관한다.
- 지도 핀의 국내 검증은 위도·경도 범위와 요청 위치가 있을 때의 50km 거리 제한을 사용한다. 행정 경계를 정밀하게 판별하는 검증은 포함되지 않았다. 주차 전용 차량 동작은 30초 이내 주차 기어 기록을 요구한다.
- 개인정보 취급과 계정 삭제는 가족 범위, 동의 이력, 해지와 정리 RPC를 검증했다. 실제 Auth 사용자 삭제, 운영 개인정보 처리방침과 입점 검토는 로컬 SQL 모의 검증 범위 밖이다.

기반 문서 [Supabase Auth 메일 템플릿](https://supabase.com/docs/guides/auth/auth-email-templates), [pg_cron](https://supabase.com/docs/guides/database/extensions/pg_cron), [pg_net](https://supabase.com/docs/guides/database/extensions/pg_net), [Twilio 메시지 API](https://www.twilio.com/docs/messaging/api/message-resource), [Kakao 로컬 API](https://developers.kakao.com/docs/ko/local/dev-guide)
