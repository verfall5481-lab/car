# 데리러 차량 검증 기록

2026-11-09 · Windows 11

`apps/car`는 API 28 이상을 대상으로 하는 Kotlin·Compose 프로젝트입니다. `demo`는 로컬 시뮬레이션이고 `pleos`는 실제 Supabase RPC와 AAOS·Pleos SDK에 연결할 수 있도록 분리했습니다. `pleos`에는 Android Automotive 기기 요구 조건과 연동에 필요한 권한이 선언되어 있습니다. 두 빌드의 실행 화면에 주행 최적화 선언(`distractionOptimized`)을 넣었습니다. 실제 노출 승인은 Pleos 심사 결과에 따릅니다.

## 로컬 검증

- JDK 17, Gradle 8.10.2, Android SDK Platform 35, Build Tools 35.0.0에서 `demo`와 `pleos`의 디버그 APK 빌드, 단위 테스트와 Android lint가 통과했습니다. 의존성 잠금 파일을 사용해 오프라인에서도 실행했습니다. 두 lint 보고서는 각각 오류 0건과 고정된 의존성의 업데이트 알림 5건입니다.
- 고유 단위 테스트는 31개입니다. 공통 테스트 6개(`src/test`)는 두 flavor에서 각각 실행되므로 실행 기준으로는 demo 6개, pleos 31개(공통 6개 + Pleos 전용 25개)가 통과했습니다. 이전 기록의 "Pleos 12개"는 공통 4개를 다시 센 수치였고, 고유 테스트는 12개였습니다.
- 공통 테스트는 내비 실패 후 출발 유지, 세션 갱신, 이전 세션·목적지 버전·원거리 콜백 차단, 주차 후 탑승, 미확정 GPS 제한과 핀 메모, 한국어 조사 처리, V-00 글자·간격 최소값을 확인합니다.
- Pleos 전용 테스트는 로컬 HTTP 서버로 익명 로그인, 401 토큰 교체와 복구, 세션 해제 시 캐시 삭제, 동일 동작 ID 재시도, 공개 키 제한을 확인합니다. 저장소에 있는 `vehicle_get_feed` 응답 예시(`supabase/tests/fixtures`)와 내비 실패 보고도 검사합니다. 이 예시를 다시 만드는 스크립트는 없으므로 SQL이 바뀌면 함께 갱신해야 합니다.
- `LiveCarViewModel`은 가짜 서버·차량 신호·내비로 검사합니다. 주행 잠금, 내비 실패 후 출발 유지와 보고, 이전 세션 도착 무시, 내비 결과 대기열 재전송, 알림음 키, 오프라인과 응답 오류 구분, 백그라운드 동기화와 취소 헤드업, 주행 중 `ALREADY_TAKEN` 안내, 운전자 미선택 상태를 확인합니다. 내비 경로 확인(150m 허용), 도착 귀속, 주행 모드 규칙과 대기열 저장도 순수 로직 테스트로 확인합니다.
- 디버그 APK ID는 `kr.deriro.car.demo`와 `kr.deriro.car`입니다. 최소 API 28, 대상 API 35이며 `pleos`는 Android Automotive가 필요합니다. 두 APK의 서명을 확인했고 `pleos` 배포 변형의 매니페스트에서 HTTP가 차단된 것을 확인했습니다. `adb devices -l`에 연결된 장치가 없었습니다.
- 공식 샘플 `959981d`의 원본 `assembleDebug`는 `ai.pleos.playground:Vehicle:2.3.1` 의존성을 찾지 못해 실패했습니다. 공식 저장소에서 해당 POM은 HTTP 404, 가이드 기준인 2.3.2의 POM은 HTTP 200이었습니다. [2.3.1 POM](https://nexus-playground.pleos.ai/repository/maven-releases/ai/pleos/playground/Vehicle/2.3.1/Vehicle-2.3.1.pom) · [2.3.2 POM](https://nexus-playground.pleos.ai/repository/maven-releases/ai/pleos/playground/Vehicle/2.3.2/Vehicle-2.3.2.pom)
- 샘플의 임시 복제본에서 버전 카탈로그 한 줄을 2.3.2로 바꾼 뒤 `assembleDebug`가 통과했습니다. 샘플과 데모 모두 Pleos AVD 설치 및 실행은 미검증입니다.

## 의존성과 전송 방식

- Vehicle SDK `2.3.2`와 NaviHelper `3.0.5`는 2026-10-19에 공개됐습니다. 2026-11-09 기준 21일이 지난 버전이며 Gradle에 버전을 고정했습니다. [Pleos 공식 릴리스 노트](https://document.pleos.ai/docs/pleos-only/release-note/sdk-release-note)
- HTTP 테스트에만 사용하는 MockWebServer `4.12.0`은 2023-10-17, JVM JSON 파서 `20250107`은 2025-01-07 공개본입니다. 정확한 버전과 전이 의존성을 `apps/car/app/gradle.lockfile`에 기록했습니다. [MockWebServer 아티팩트](https://repo.maven.apache.org/maven2/com/squareup/okhttp3/mockwebserver/4.12.0/) · [JSON-java 릴리스](https://github.com/stleary/JSON-java/releases/tag/20250107)
- 설계서의 전송 라이브러리 선택을 조정했습니다. 차량 앱의 익명 로그인·갱신과 PostgREST RPC는 Android `HttpURLConnection`으로 직접 호출해 런타임 라이브러리를 줄였습니다. 로컬 HTTP와 실제 SQL 응답으로 계약을 확인했습니다. 실제 Supabase Auth 서비스 및 Pleos 차량 네트워크에서의 동작은 별도 시험 항목입니다. [Supabase 익명 로그인](https://supabase.com/docs/guides/auth/auth-anonymous)

## Pleos 실측 항목

| 항목 | 확인한 근거 | Pleos 실측 및 대체 동작 |
| --- | --- | --- |
| VR-01 주행가능거리 | Android 차량 하드웨어 문서는 `CAR_ENERGY` 권한과 거리 단위 m를 명시합니다. Pleos Virtual Console 문서는 Energy에서 잔여거리를 설정할 수 있다고 안내합니다. [Android 권한](https://developer.android.com/training/cars/apps/library/car-hardware-api) · [Android 단위](https://developer.android.com/reference/androidx/car/app/hardware/info/EnergyLevel) · [Pleos Virtual Console](https://document.pleos.ai/en/docs/connect/guide/getting-started/application-development/use-vehicle-emulator) | `CarPropertyManager`의 `RANGE_REMAINING`을 km로 변환하고, 거리 미지원 시 Pleos Vehicle SDK 2.3.2의 지원 확인을 거친 `getFuelPercent()`·`getEvBatteryStateOfCharge()` 값으로 보조 표시합니다. 실제 Pleos 앱의 읽기와 권한은 미검증입니다. |
| VR-03 에뮬레이터 차량값 주입 | 현재 공식 절차는 Pleos Connect Emulator v2.1.0 이상에서 Virtual Console을 실행하고 Motion·Energy 값을 조작하는 방식입니다. [Virtual Console 설정](https://document.pleos.ai/en/docs/connect/guide/getting-started/application-development/use-vehicle-emulator) · [콜드 부팅 설정](https://document.pleos.ai/en/docs/connect/guide/getting-started/application-development/configure-pleos-connect-emulator) | Pleos AVD와 `vhal_fifo` 방식은 미검증. 데모 차량값과 주행 모드 변경을 구현했습니다. |
| VR-04 NaviHelper 목적지와 도착 | 공식 문서는 `requestRoute()` 이후 성공·실패를 콜백으로 확인하도록 안내하며, `onDestinationArrived()`를 문서화합니다. 3.0.5 아티팩트의 `DestinationArrivedInfo`는 시간·거리·이름·주소만 제공합니다. [목적지 안내](https://document.pleos.ai/en/docs/pleos-only/connect-sdk-pleos/NaviHelper/destinations) · [이벤트 리스너](https://document.pleos.ai/en/api-reference/connect-sdk-pleos/NaviHelper/event-listeners) | 탐색 완료를 성공으로 보고, 목적지 응답이 오면 150m 안인지 확인합니다. 내비가 받아들인 경로 위에는 지도 앱을 열지 않습니다. 연결이 끊기거나 응답이 없으면 NaviHelper를 다시 만들고 한 번 더 확인합니다. 도착 콜백은 설계서 13.1에 따라 마지막 요청 경로로 귀속합니다. 다른 픽업으로 전환한 뒤, 목적지가 바뀐 뒤, 도착 위치가 200m 밖일 때는 보내지 않습니다. 앱은 현재 세션과 목적지 버전을 다시 확인한 뒤 `mark_arrived(source=nav_callback)`를 보내고, 서버도 다시 검사합니다. AVD에서 실제 목적지 전달과 콜백 순서는 미검증입니다. |
| VR-08 주행 제한 | Pleos는 `CarUxRestrictions`와 지역 정책에 따라 제한을 적용하며, 일반 앱의 주행 중 접근은 최적화 선언 및 심사 기준을 따릅니다. [주행 규제 개발 가이드](https://document.pleos.ai/docs/pleos-only/vehicle-app-developer-guide/driving-restriction-development-guide) · [지역별 정책](https://document.pleos.ai/docs/pleos-only/vehicle-app-planning-guide/driving-restiction-policy) | 두 빌드의 실행 화면에 `distractionOptimized`를 선언했습니다. 주행 및 상태 미확인 시 단일 카드, 최대 두 버튼, 본문 세 줄, 스크롤 없음, 주차 전용 화면 닫기를 적용합니다. 글자는 정보 24sp·본문 28sp 이상, 버튼 간격 24dp 이상이며 좁은 화면에서도 줄이지 않습니다. 주행 중 실패도 3초 안내로 보여줍니다. `pleos`는 AAOS 규제와 기어·속도를 확인합니다. AVD에서 런처 노출과 주행 중 실행은 미검증입니다. |
| VR-10 해상도·방향·안전 영역 | 현재 Pleos 안내의 테스트 이미지는 API 34이며, 최소 GPU 요구 조건은 RTX 3060 Laptop 6GB 또는 RX 6600M 8GB입니다. 이 PC에서 확인한 GPU는 GTX 1650 4GB입니다. [에뮬레이터 설치](https://document.pleos.ai/en/docs/connect/guide/getting-started/application-development/setup-connect-sdk-emulator) · [GPU와 환경 조건](https://document.pleos.ai/en/docs/connect/guide/getting-started/application-development/configure-pleos-connect-emulator) | Pleos AVD 미설치. 코드에 화면 폭 기준 2열·1열 전환과 시스템 안전 영역을 적용했습니다. 실제 디스플레이에서의 렌더링은 미검증입니다. |
| VR-12 샘플 라이선스 | 공개 샘플 커밋 `959981d`의 전체 파일 목록에 `LICENSE` 또는 `NOTICE`가 없으며, README에서 재사용 라이선스를 찾지 못했습니다. README와 공식 가이드는 Vehicle SDK `2.3.2` 기준을 제시하고 같은 커밋의 버전 카탈로그는 `2.3.1`을 고정합니다. [샘플 트리](https://github.com/Pleos-Playground/pleos-sample-vehicle-app/tree/959981d960ec71144accb27af5ae5d341e72a644) · [버전 카탈로그](https://github.com/Pleos-Playground/pleos-sample-vehicle-app/blob/959981d960ec71144accb27af5ae5d341e72a644/gradle/libs.versions.toml) · [공식 샘플 가이드](https://document.pleos.ai/en/docs/pleos-only/tutorial/vehicle-sdk-sample-app) | 코드 재사용 권한 미확인. 앱 코드는 새로 작성했고 Gradle Wrapper는 Gradle 공식 배포본에서 가져왔습니다. |

## 차량 앱 구현 범위

| 설계 | 구현 | 외부 확인 항목 |
| --- | --- | --- |
| F-05, V-01 | 익명 로그인, 토큰 갱신, 6자 QR·만료, 3초 페어링 확인, 연결 해제. 세션과 최근 피드는 Android Keystore 기반 암호화 저장소에 보관합니다. | 실제 Auth 및 가족 웹과의 페어링 |
| F-06, F-16, V-07 | 초기 수집, 시동·5km 변화, 5분 주기 업로드, 최신 상태 재시도, 서버 주행가능거리 경고. 주차 중 피드 및 조작에는 서버의 30초 주차 검사를 위해 약 20초 주기로 주차 상태를 갱신합니다. 속도는 전송하지 않습니다. 위치는 플랫폼 `LocationManager`로 주기 갱신을 받고, 최근 값이 없으면 시간 제한을 두고 새 위치를 요청합니다. | 기기별 속성·권한, 위치 허용, 시동 종료 직전 업로드, 서버 차량값 주입 |
| V-02·03·08·09 | 서버 피드 10초 폴링, 오류 시 최대 30초 간격, 최근 성공 데이터 표시, 요청·부탁·경고 카드, 오늘·내일 목록, 운전자 변경, 앱 정보. 서버에 닿지 못할 때만 오프라인으로 보고 주 버튼을 끕니다. 서버 오류와 응답 해석 오류는 상태 줄에만 표시하고 버튼은 유지합니다. 운전자가 없으면 "운전자를 선택해 주세요"를 보여줍니다. | Pleos에서의 네트워크 및 WebSocket, 실제 화면 크기 |
| F-12·13, V-04·05·06 | RPC로 수락·거절·넘기기, 주차 후 위치 확인과 안내 전환, 새 세션 재시도, 도착 및 탑승 구분. 내비 결과는 저장되는 대기열에 넣은 뒤 보고하므로 연결이 끊기거나 앱이 재시작돼도 덮어쓰거나 잃지 않습니다. 위치 화면은 서버 좌표와 근처 저장 장소를 표시합니다. | 카카오 또는 Pleos 지도 이미지, 경로 서비스의 실측 동작 |
| F-20, V-09 데모 | 기기 내 가짜 값, 안내 실패·이전 콜백·탑승 흐름. | 데모 화면과 실제 AVD 배치 검증 |
| V-00, 13.3 | 주행 화면 제한. 내비가 앞에 있어도 동기화·차량 상태 업로드·피드를 계속하고(앞 10초, 가는 중 10초, 그 외 뒤 30초), 가는 중에는 `dataSync` 포그라운드 서비스로 프로세스를 유지합니다. 새 카드는 앞에서는 시스템 알림음 1회, 뒤에서는 요청·부탁·취소 헤드업 알림(카드 버튼 2개)으로 알립니다. 알림음은 카드 종류와 대상이 같으면 버전이 바뀌어도 다시 울리지 않습니다. | 주행 최적화 승인, 백그라운드 헤드업 및 포그라운드 서비스 정책(VR-07) |

## Pleos 연동 시험 절차

1. 지원 사양의 Pleos AVD를 콜드 부팅하고 샘플의 실제 SDK 의존성과 AVD Vehicle Service 버전을 확인합니다.
2. Virtual Console에서 잔여거리, 연료 또는 배터리, 기어를 조작하고 샘플의 권한 및 읽기 결과를 기록합니다. 잔여거리 m 값을 km로 변환해 데모 경계 모델에 매핑합니다.
3. 서로 다른 목적지로 연속 요청한 뒤 도착 콜백을 기록합니다. 요청 식별자 또는 동등한 근거를 확인한 경우에만 자동 도착을 연결합니다.
4. 앱 카테고리와 `CarUxRestrictions` 기준을 검토하고 주차·주행 전환, 두 화면 방향의 인셋, 좁은 멀티윈도우에서의 버튼과 글자 표시를 확인합니다.
