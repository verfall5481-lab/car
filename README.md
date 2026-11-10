# 데리러

가족이 타는 곳을 정해 픽업을 부르고, 누가 데리러 오는지 함께 확인하는 앱입니다. [구현 명세 v0.4](docs/SPEC.md)와 [참고 보드](docs/references/review.json)를 기준으로 만들었습니다.

## 로컬 데모

Node.js 22.12 이상과 pnpm 10.26.2가 필요합니다.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

기본 주소는 `http://127.0.0.1:5173`입니다. 같은 브라우저에서 세 화면을 각각 탭으로 열면 픽업 진행이 공유됩니다.

| 화면 | 경로 | 시연 |
| --- | --- | --- |
| 간단 모드 | `/c/` | 장소와 타는 곳 선택, 지도 핀, 요청·취소, 진행·탑승 확인 |
| 보호자 | `/p/` | 수락, 인계, 대신 가기, 출발·도착·탑승, 가족·루틴·장소 관리 |
| 웹 차량 시뮬레이터 | `/v/` | 차에서 출발, 안내 실패·재시도, 주차·주행, 도착·탑승 |
| 데모 도구 | `/p/demo` | 시각 앞당기기, 오늘 루틴 회차 불러오기, 초기화 |

간단 모드에서 `수학학원`과 `후문 주차장`을 고르고 `데리러 와`를 누릅니다. 보호자 화면에서 엄마가 수락한 뒤 아빠에게 부탁합니다. 아빠가 수락할 때까지 엄마가 담당입니다. 차량 화면에서 출발·도착을 기록하고 간단 모드에서 `탔어`를 누르면 세 화면에 반영됩니다. 데모 지도와 위치, 차량 값, 코드, 알림은 시뮬레이션입니다.

## Supabase 연결 모드

`apps/web/.env.example`을 `apps/web/.env.local`로 복사하고 `VITE_APP_MODE=live`를 지정합니다. `VITE_SUPABASE_URL`과 `VITE_SUPABASE_PUBLISHABLE_KEY`에 같은 환경의 API 주소와 공개 키를 넣습니다. 레거시 공개 anon 키는 `VITE_SUPABASE_ANON_KEY`로 지정할 수 있습니다. 서버 키는 Edge Function 환경에만 설정합니다.

로컬 Supabase CLI와 Docker 엔진을 사용할 수 있는 환경에서는 저장소 루트에서 `supabase start`로 로컬 API를 시작합니다. 설정 파일의 기본 API 주소는 `http://127.0.0.1:54321`입니다. 로컬 상태에 표시되는 공개 키를 사용하고 웹 개발 서버를 다시 시작합니다. 로컬 인증은 익명 로그인을 허용하고, 이메일 템플릿은 `{{ .Token }}`을 사용합니다. 테스트 이메일은 로컬 Inbucket `http://127.0.0.1:54324`에서 확인합니다. 원격 연결을 구성할 때도 [이메일 OTP 템플릿](https://supabase.com/docs/guides/auth/auth-email-passwordless)과 익명 로그인 설정이 필요합니다.

| 선택 설정 | 동작 |
| --- | --- |
| `VITE_KAKAO_JS_KEY` | 허용된 도메인의 Kakao 지도와 장소 검색. 키가 없으면 저장 장소, 기기 위치, 좌표 입력을 사용합니다. |
| `VITE_ENABLE_KAKAO_LOGIN=true` | Kakao 로그인을 표시합니다. Supabase의 Kakao 공급자 설정과 `/p/auth/callback` 리디렉션 URL 등록이 필요합니다. |
| `VITE_TURNSTILE_SITE_KEY` | 이메일 코드 발송과 간단 모드 익명 로그인에 보안 확인을 표시합니다. 프로젝트의 전역 CAPTCHA는 차량 익명 가입에도 적용됩니다. 차량에서 챌린지를 지원하는 구성을 갖춘 뒤 함께 켭니다. |
| `VITE_VAPID_PUBLIC_KEY` | `/p/`, `/c/`별 웹 푸시 구독을 사용합니다. 발송용 비공개 키와 알림 공급자 환경은 서버에 설정합니다. |
| `VITE_DEMO=true` | 연결 모드에서 데모 가족으로 지정된 가족의 관리자에게 서버 데모 도구를 표시합니다. |
| `VITE_LIVE_VEHICLE_SIM=true` | 연결 모드의 `/v/`를 웹 차량 시뮬레이터로 바꿉니다. 익명 세션으로 실제 서버에 차량을 페어링하고 차량 RPC를 호출합니다. 기어와 주행가능거리는 항상 데모 값으로 보내고, 내비 안내 결과와 도착 콜백은 시뮬레이터 버튼으로 보냅니다. AAOS 기기 검증을 대신하지 않습니다. [명세 23.8](docs/SPEC.md) |

설정되지 않은 연결 모드는 화면에 연결 설정 누락을 표시합니다. `/v/`는 연결 모드에서도 기본적으로 브라우저 데모 시뮬레이터입니다. `VITE_LIVE_VEHICLE_SIM=true`이면 실제 서버 세션을 쓰는 웹 차량 시뮬레이터가 되며, 이때도 차량 값과 내비는 시뮬레이션입니다. iOS의 홈 화면 설치와 실제 알림 수신은 실기기 확인이 필요합니다. 정적 서버에서는 `/c/*`, `/p/*`, `/v/*`를 각 역할의 `index.html`로 연결하고 HTTPS를 사용합니다.

## 검증

```sh
pnpm typecheck
pnpm build
pnpm test
pnpm --filter @deriro/contracts test:sql
pnpm --filter @deriro/web exec playwright install chromium
pnpm test:e2e
```

Chromium 테스트는 데모와 로컬 모의 HTTP 서버에 연결한 웹의 인증·요청 흐름, 웹 차량 시뮬레이터의 차량 RPC 흐름을 검증합니다. SQL 통합 테스트는 별도로 실제 마이그레이션을 적용합니다. [웹 구현 범위와 검증 수준](docs/web-coverage.md), [백엔드 RPC 계약](docs/backend-api.md), [차량 빌드와 실행](apps/car/README.md), [오픈소스 고지](NOTICE.md)를 참고할 수 있습니다.
