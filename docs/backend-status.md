# 백엔드 구현과 검증 범위

가족·기기 연결, 위치와 픽업 진행, 차량 상태, 알림 대기열을 Supabase 마이그레이션과 인증 RPC로 구현했다. 웹 데모는 공유 상태 머신을 브라우저 저장소에서 실행한다. 라이브 모드는 별도의 Supabase URL과 공개 키를 사용한다. [RPC 계약](backend-api.md)

| 명세 | 로컬 구현 및 확인 |
|---|---|
| F-01~F-05, F-18~F-19 | 보호자 온보딩·초대·탈퇴·소유자 이관, rider 본인 또는 보호자 동의, 기기 연결·해지, 저장 장소·타는 곳, 차량 페어링. SQL에서 역할 분리, 코드의 해시 저장·일회성·시도 제한, 기기 해지, 탈퇴 이후 이력과 권한을 확인했다. |
| F-06, F-16 | 차량의 최신 기어·거리·연료·배터리·위치 샘플과 현재 운전자 관리. SQL에서 24시간 범위의 배정만 추정에 포함되는지, 예상 거리가 부족할 때 경고가 생기는지 확인했다. 차량 위치 또는 집 기준을 사용할 수 없으면 확인 필요로 반환한다. |
| F-07, F-21 | 한국 표준시로 루틴 회차 생성 및 미래 회차 수정·보관. 비활성화할 때 예정 회차를 유지하거나 취소할 수 있다. 회차 생성은 멱등이며, 인계 제안이나 명시적 수락으로 개별 변경된 회차는 보존한다. |
| F-08~F-14, F-22 | rider와 보호자의 요청, GPS 보정과 지도 핀, 수락과 인계, 차량의 거절과 출발, 내비 콜백 귀속, 수동 도착·탑승과 취소. 단위·SQL·동시성 테스트가 핵심 상태와 권한을 확인한다. |
| F-15, F-17 | 트랜잭션과 함께 생성되는 알림, 상태·수신 권한 재확인, 시도 횟수와 30초·2분·5분 재시도, 만료된 lease 회수, 가족별 문자 한도, 푸시 구독 해지, 3시간 뒤 미확인 종료. SQL은 대기열과 종료 상태를 검증했고 Deno 테스트는 외부 전송 경계를 모의했다. |
| F-20 | 브라우저 데모는 라이브 데이터와 분리된다. SQL 데모 RPC는 명시적으로 데모 표시한 가족의 소유자만 실행할 수 있다. 서버 초기화는 런타임 픽업·경고·알림을 지우고 등록된 루틴에서 회차를 다시 생성한다. 데모로 표시된 알림은 외부로 보내지 않는다. |
| §7.3, §8.8 | 종료 30일 뒤 원본 GPS 제거와 비저장 목적지 반올림, 장기 데이터 정리, 계정 삭제 전 가족 정리, Kakao 행정동 조회·Web Push·Twilio 문자·DryRun 어댑터. SQL에서 좌표 반올림과 메모 보존, 소유자 삭제 확인 절차를 확인했다. |

## 재실행

```sh
pnpm --filter @deriro/contracts test
pnpm --filter @deriro/contracts test:sql
pnpm --filter @deriro/contracts test:sql --write-fixtures
```

공유 상태 머신 9개 테스트와 PGlite 0.3.15의 PostgreSQL 17.5에서 pgTAP 검사 164개가 통과했다. 내장 DB는 Supabase의 인증 역할, 사용자 테이블과 `auth.uid()`를 모의한다. `--write-fixtures`는 SQL 호출 결과를 [피드 예시](../supabase/tests/fixtures)에 기록한다.

시나리오의 백엔드 조건 중 수락 경합과 권한(S-02, S-18, S-23~S-27), 요청·미출발·탑승 확인 타이머(S-03~S-04, S-20, S-33, S-44, S-48), 내비 실패와 도착 귀속(S-19, S-34), 대기 제안과 명시적 탑승(S-37, S-40, S-42), 탈퇴 후 이력(S-45), 거리 경고의 재알림과 행위자 기록(S-49~S-50), rider 권한과 지도 핀 보존(S-51~S-56)을 확인했다. 이 검사는 전체 기기·화면 시나리오의 통과 기록을 대신하지 않는다.

독립 PostgreSQL 18.1에서는 두 연결로 수락 경합, 수락과 인계 응답 경합, 같은 초대의 동시 사용, 워커의 중복 없는 분할 claim, 만료된 claim 회수를 확인했다. 다음 환경 변수는 별도 루프백 테스트 인스턴스에만 사용한다. 테스트는 임시 데이터베이스를 만든 뒤 정리한다.

```powershell
$env:DERIRO_TEST_PGPORT = "55432"
$env:DERIRO_TEST_PGUSER = "deriro_test"
$env:DERIRO_TEST_PSQL = "C:/Program Files/PostgreSQL/18/bin/psql.exe"
pnpm --filter @deriro/contracts test:sql:concurrency
```

Deno 2.5.6에서 Edge Functions 네 개의 형식 검사와 모의 HTTP 테스트 7개가 통과했다.

```sh
deno check --node-modules-dir=none --frozen --lock=supabase/functions/deno.lock supabase/functions/dispatch-notifications/index.ts supabase/functions/geo-reverse/index.ts supabase/functions/send-rider-invite/index.ts supabase/functions/delete-account/index.ts
deno test --node-modules-dir=none --frozen --lock=supabase/functions/deno.lock --allow-env supabase/functions/_shared/edge.test.ts
```

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
