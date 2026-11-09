# 데리러 차량 앱

Kotlin·Compose 차량 앱입니다. `demo`는 요청, 연결, 차량 값과 안내 결과를 기기에서 시뮬레이션합니다. `pleos`는 AAOS 기기에서 설정된 Supabase 백엔드와 Pleos SDK를 사용합니다.

## 빌드

JDK 17과 Android SDK Platform 35, Build Tools 35.0.0이 필요합니다. Android Studio에서 `apps/car`를 열거나 이 디렉터리에서 실행합니다.

```powershell
.\gradlew.bat :app:assembleDemoDebug :app:testDemoDebugUnitTest :app:lintDemoDebug
.\gradlew.bat :app:assemblePleosDebug :app:testPleosDebugUnitTest :app:lintPleosDebug
```

macOS와 Linux에서는 `bash ./gradlew`로 같은 작업을 실행할 수 있습니다. APK는 `app/build/outputs/apk/demo/debug/app-demo-debug.apk`, `app/build/outputs/apk/pleos/debug/app-pleos-debug.apk`에 각각 생성됩니다. 연결된 디바이스에는 `:app:installDemoDebug` 또는 `:app:installPleosDebug`로 설치할 수 있습니다.

## 데모 시연

1. 주차 상태에서 `데모 연결하기`를 누르면 예정 픽업이 나타납니다. QR은 데모 코드를 담은 예시입니다.
2. `설정`의 데모 패널에서 `가족 핀 요청 띄우기`를 누르면 성인 가족 구성원의 타는 곳과 메모가 표시됩니다. `위치 미확정 요청 띄우기`는 주차 상태에서 별도 위치 확인을 요구합니다.
3. 내비 실패를 보려면 먼저 `다음 안내 실패시키기`를 선택합니다. 출발한 뒤 안내가 실패해도 가는 중 상태가 유지됩니다. 재시도하면 새로운 안내 세션이 열립니다.
4. 주차 상태에서 `설정`을 열어 `이전 안내`와 `현재 안내` 콜백을 보낼 수 있습니다. 이전 안내는 재시도 또는 `안내 다시 열기`로 두 번째 세션을 만든 뒤 사용할 수 있습니다.
5. `도착했어요` 또는 현재 안내 콜백으로 도착을 기록한 뒤, 주차 상태에서 `태웠어요`로 완료합니다. 데모 주행 모드와 미확인 모드는 20초 뒤 주차 상태로 돌아옵니다.

앱 프로세스가 종료되면 데모 상태가 초기화됩니다.

## Pleos 빌드 설정

`pleos`를 구성하려면 세 값을 Gradle 속성이나 환경 변수로 제공하고 다시 빌드합니다.

| 설정 | 값 |
| --- | --- |
| `DERIRO_SUPABASE_URL` | 차량 RPC가 적용된 Supabase 프로젝트 주소 |
| `DERIRO_SUPABASE_PUBLISHABLE_KEY` | 해당 프로젝트의 publishable 키 또는 `anon` 키 |
| `DERIRO_WEB_URL` | 가족 웹 주소. 연결 QR의 `/p/vehicles/pair` 링크에 사용 |

세 값이 갖춰질 때까지 앱은 설정 안내를 표시합니다. HTTPS를 사용하며, 디버그 빌드에서는 로컬 `localhost`, `127.0.0.1`, `10.0.2.2`에서 HTTP도 사용할 수 있습니다. AAOS 에뮬레이터에서 개발 PC의 로컬 Supabase에 연결할 때는 `http://10.0.2.2:54321`을 사용할 수 있습니다. 휴대폰에서 QR을 열려면 휴대폰에서 접속할 수 있는 가족 웹 주소가 필요합니다.

1. Supabase에서 익명 로그인이 허용되고 차량 RPC가 적용된 상태에서 AAOS 기기에 `pleos` 앱을 설치합니다.
2. 주차 상태에서 필요할 때 차량 상태 권한을 확인한 뒤 연결 QR을 열거나 6자 코드를 보호자 웹에 입력합니다.
3. 주차 화면의 설정에서 운전자를 고르고, 차량 위치를 거리 추정에 사용할 경우 위치 권한을 허용합니다.
4. 안내 요청이 완료되면 앱에서 수동 도착을 기록합니다. 외부 지도 앱이 열린 경우 지도 앱에서 길 안내 여부를 확인합니다.

## 연동 지점

- `VehicleStateSource`는 AAOS의 잔여거리·기어·시동·속도와 Pleos Vehicle SDK의 연료·충전율을 읽습니다. API 지원 범위와 값의 시각을 보존합니다.
- `NavigationGateway`는 NaviHelper의 탐색 완료와 목적지 정보를 확인합니다. 데모는 세션과 목적지 버전을 확인할 수 있는 콜백을 사용합니다. 실제 SDK의 도착 이벤트는 수동 도착 경로를 사용합니다.
- `DrivingStateMonitor`는 AAOS 주행 제한을 우선 반영합니다. 기어와 속도도 주차로 확인된 경우 연결, 위치 확인, 설정 및 탑승 확인을 표시합니다.

실제 Pleos·AAOS 확인 범위는 [차량 검증 기록](../../docs/vehicle-verification.md)에 있습니다.
