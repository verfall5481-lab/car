# 오픈소스 고지

이 문서는 데리러 로컬 개발판이 직접 사용하는 오픈소스의 이름, 버전, 라이선스 및 사용 위치를 기록합니다. 종속 패키지의 정확한 버전은 `pnpm-lock.yaml`과 차량 Gradle 잠금 파일에 있습니다. 각 링크에서 저작권과 라이선스 전문을 확인할 수 있습니다.

## 웹과 테스트

| 이름 및 버전 | 라이선스 및 저작권 | 사용 |
| --- | --- | --- |
| [React / React DOM 19.2.9](https://github.com/facebook/react/blob/v19.2.9/LICENSE) | MIT · Meta Platforms, Inc. and affiliates | 웹 렌더링, 원본 패키지 |
| [React Router 7.18.4](https://github.com/remix-run/react-router/blob/main/LICENSE.md) | MIT · React Training LLC 2015–2019, Remix Software Inc. 2020–2021, Shopify Inc. 2022–2023 | 웹 라우팅, 원본 패키지 |
| [Lucide React 0.577.0](https://github.com/lucide-icons/lucide/blob/main/LICENSE) | ISC 및 MIT · Lucide Contributors 2026, Cole Bemis 2013–2026 (Feather) | 선 아이콘, 원본 패키지 |
| [Vite 7.3.7](https://github.com/vitejs/vite/blob/v7.3.7/LICENSE), [Vite React 플러그인 5.2.0](https://github.com/vitejs/vite-plugin-react/blob/main/LICENSE) | MIT · Evan You and Vite contributors | 개발 서버와 빌드, 원본 패키지 |
| [TypeScript 5.9.3](https://github.com/microsoft/TypeScript/blob/v5.9.3/LICENSE.txt) | Apache-2.0 · Microsoft Corporation | 타입 검사, 원본 패키지 |
| [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/LICENSE) `@types/node` 22.15.3, `@types/react` 19.2.14, `@types/react-dom` 19.2.3 | MIT · Microsoft Corporation | 타입 정의, 원본 패키지 |
| [Playwright 1.59.1](https://github.com/microsoft/playwright/blob/v1.59.1/LICENSE) | Apache-2.0 · Microsoft Corporation | 브라우저 테스트, 원본 패키지 |
| [pnpm 10.26.2](https://github.com/pnpm/pnpm/blob/v10.26.2/LICENSE) | MIT · Zoltan Kochan and pnpm contributors | 의존성 설치 및 실행, 원본 도구 |
| [Supabase JavaScript 2.118.0](https://github.com/supabase/supabase-js/blob/master/LICENSE) | MIT · Supabase 2020 | Auth·Realtime·RPC 클라이언트, 원본 패키지 |
| [TanStack React Query 5.104.5](https://github.com/TanStack/query/blob/main/LICENSE) | MIT · Tanner Linsley 2021–현재 | 웹 데이터 캐시와 조회, 원본 패키지 |
| [Zod 4.3.6](https://github.com/colinhacks/zod/blob/main/LICENSE) | MIT · Colin McDonnell 2025 | RPC 값 검증, 원본 패키지 |
| [node-qrcode 1.5.4](https://github.com/soldair/node-qrcode/blob/master/license) | MIT · Ryan Day 2012 | 초대 QR 생성, 원본 패키지 |
| [DefinitelyTyped `@types/qrcode` 1.5.6](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/LICENSE) | MIT · Microsoft Corporation | QR 타입 정의, 원본 패키지 |

웹에는 [SUIT Variable v2.0.5](https://github.com/sun-typeface/SUIT/releases/tag/v2.0.5)를 원본 그대로 자체 호스팅합니다. Copyright (c) 2022, SUNN. SIL Open Font License 1.1 전문은 `apps/web/public/fonts/OFL-SUIT.txt`에 있습니다. 앱 아이콘과 예시 지도는 자체 제작했습니다.

## 백엔드와 SQL 테스트

| 이름 및 버전 | 라이선스 및 저작권 | 사용 |
| --- | --- | --- |
| [PGlite 0.3.15](https://github.com/electric-sql/pglite/blob/main/LICENSE) | Apache-2.0 · ElectricSQL 및 기여자 | 로컬 PostgreSQL SQL 통합 테스트, 원본 패키지 |
| [web-push 3.6.7](https://github.com/web-push-libs/web-push/blob/master/LICENSE) | MPL-2.0 · Web Push Libraries 기여자 | Edge Function의 VAPID 발송, 원본 패키지 |

## Android 차량 데모

| 이름 및 버전 | 라이선스 및 저작권 | 사용 |
| --- | --- | --- |
| [AndroidX](https://github.com/androidx/androidx/blob/androidx-main/LICENSE.txt) Activity Compose 1.10.1, Compose Foundation 1.7.8, Material 3 1.3.2, Lifecycle Runtime Compose 및 ViewModel KTX 2.8.7 | Apache-2.0 · Android Open Source Project | 화면 및 수명주기, 원본 패키지 |
| [Kotlin 2.0.21](https://github.com/JetBrains/kotlin/blob/v2.0.21/license/LICENSE.txt), [Kotlin Coroutines 1.9.0](https://github.com/Kotlin/kotlinx.coroutines/blob/1.9.0/LICENSE.txt) | Apache-2.0 · JetBrains s.r.o. 및 기여자 | 앱 언어 및 비동기 상태 처리, 원본 패키지 |
| [Android Gradle Plugin 8.8.2](https://android.googlesource.com/platform/tools/base/), [Gradle Wrapper 8.10.2](https://github.com/gradle/gradle/blob/v8.10.2/LICENSE) | Apache-2.0 · Android Open Source Project, Gradle Inc. 및 기여자 | Android 빌드, 원본 도구 |
| [ZXing Core 3.5.3](https://github.com/zxing/zxing/blob/zxing-3.5.3/LICENSE) | Apache-2.0 · ZXing authors | 데모 QR 생성, 원본 패키지 |
| [JUnit 4.13.2](https://github.com/junit-team/junit4/blob/r4.13.2/LICENSE-junit.txt) | EPL-1.0 · JUnit contributors | Android 단위 테스트, 원본 패키지 |

Pleos SDK와 튜토리얼 코드는 현재 차량 데모에 포함되어 있지 않습니다. 차량 연동 확인 상태는 [차량 검증 기록](docs/vehicle-verification.md)에 따로 기록합니다.
