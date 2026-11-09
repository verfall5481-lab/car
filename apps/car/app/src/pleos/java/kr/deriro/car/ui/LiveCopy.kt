package kr.deriro.car.ui

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.roundToInt
import kr.deriro.car.live.LivePickup
import kr.deriro.car.live.RangeAlert
import kr.deriro.car.live.VehicleConnection
import kr.deriro.car.ux.DrivingMode

internal object LiveCopy {
    const val setup = "서버 연결 설정이 필요해요"
    const val setupDetail = "차량 앱의 서버 주소, 공개 키, 가족 웹 주소를 확인해 주세요."
    const val pairScan = "휴대폰 카메라로 QR을 찍어요."
    const val pairConfirm = "휴대폰에서 코드를 확인하고 연결해요."
    const val qr = "가족 휴대폰 연결 QR"
    const val createPair = "연결 코드 만들기"
    const val pairWaiting = "연결 코드를 준비하고 있어요"
    const val permissions = "차량 권한 확인"
    const val permissionsNeeded = "차량 상태 권한을 확인해 주세요"
    const val locationPermission = "차량 위치 사용"
    const val locationPrivacy = "허용하면 픽업 거리 추정에 최근 차량 위치를 사용해요."
    const val locationCoordinates = "요청 좌표"
    const val refresh = "새로고침"
    const val connected = "연결됨"
    const val checking = "연결 확인 중"
    const val offline = "오프라인"
    const val working = "처리 중"
    const val unavailable = "차량 정보 없음"
    const val stale = "오래된 정보"
    const val unknownRider = "가족"
    const val unknownLocation = "픽업 위치"
    const val noDriver = "운전자 선택 필요"
    const val driveSettings = "지금 운전하는 사람"
    const val appInformation = "앱 정보"
    const val openSource = "AndroidX·Compose·Kotlin·ZXing·Gradle의 오픈소스 라이선스는 Apache-2.0입니다."
    const val unpair = "이 차량의 연결을 해제할까요?"
    const val routeMap = "지도 앱을 열었어요"
    const val routeMapDetail = "지도 앱에서 길 안내를 확인해 주세요."
    const val routeRequested = "안내를 요청했어요"
    const val routeWaiting = "안내 요청 중"
    const val routeChange = "안내 바꾸기"
    const val keepRoute = "그대로"
    const val arrivedShared = "가족에게 도착을 알렸어요"
    const val parkToBoard = "차를 세우고 탑승을 확인해 주세요"
    const val today = "오늘"
    const val tomorrow = "내일"
    const val nearPlace = "근처 저장 장소"
    const val requestLocation = "요청한 위치"
    const val confirmLocationOnly = "이 위치로 확정"
    const val takeOverDenied = "다른 가족이 먼저 맡았어요"
    const val staleAction = "상태가 바뀌었어요. 다시 확인해 주세요."
    const val failed = "처리하지 못했어요. 다시 확인해 주세요."

    private val clock = DateTimeFormatter.ofPattern("HH:mm", Locale.KOREA).withZone(ZoneId.of("Asia/Seoul"))

    fun status(mode: DrivingMode) = when (mode) {
        DrivingMode.PARKED -> "주차 중"
        DrivingMode.DRIVING -> "주행 중"
        DrivingMode.UNKNOWN -> "차량 상태 미확인"
    }

    fun link(connection: VehicleConnection, lastContact: Instant?) = when (connection) {
        VehicleConnection.ONLINE -> connected
        VehicleConnection.CHECKING -> checking
        VehicleConnection.OFFLINE -> if (lastContact == null) offline else "$offline, 마지막 확인 ${clock.format(lastContact)}"
    }

    fun failure(code: String, detail: String?) = when (code) {
        "ALREADY_TAKEN" -> detail?.let { "${it}님이 먼저 맡았어요" } ?: takeOverDenied
        "STALE_VERSION", "INVALID_STATE", "OFFER_NOT_PENDING", "PICKUP_EXPIRED", "NO_VALID_OFFER" -> staleAction
        "SESSION_EXPIRED", "VEHICLE_REVOKED", "NOT_VEHICLE" -> "연결이 끊겼어요. 다시 연결해 주세요."
        "PARK_REQUIRED" -> "차를 세우고 다시 시도해 주세요."
        "LOCATION_UNCONFIRMED" -> CarCopy.locationUnconfirmed
        "RATE_LIMITED", "HTTP_429" -> "잠시 뒤 다시 시도해 주세요."
        "NETWORK" -> offline
        else -> failed
    }

    fun code(code: String) = CarCopy.pairingCode(code.chunked(3).joinToString("-"))
    fun driver(name: String) = "운전자 $name"
    fun currentRange(km: Double) = "현재 주행가능거리 ${km.roundToInt()}km"
    fun energy(range: Double?, fuel: Double?, soc: Double?) = when {
        range != null -> "주행가능 ${range.roundToInt()}km"
        fuel != null -> "연료 ${fuel.roundToInt()}%"
        soc != null -> "배터리 ${soc.roundToInt()}%"
        else -> unavailable
    }
    fun requiredRange(km: Double) = "내일까지 픽업에 약 ${km.roundToInt()}km가 필요해요"
    fun rangeDetail(alert: RangeAlert) = alert.pickupCount?.let { "픽업 ${it}건 기준, 추정치예요" } ?: "픽업 예상 거리예요"
    fun rider(pickup: LivePickup) = pickup.rider ?: unknownRider
    fun place(pickup: LivePickup) = pickup.placeLine ?: unknownLocation
    fun pickupLine(pickup: LivePickup) = listOfNotNull(pickup.timeLabel, pickup.rider, pickup.placeLine).joinToString(", ")
    fun pickupMeta(pickup: LivePickup) = listOfNotNull(pickup.assignee, pickupStatus(pickup.status)).joinToString(", ")
    fun switch(active: String, next: String) = "지금 가는 $active 픽업 안내를 $next 픽업으로 바꿀까요?"
    fun accuracy(meters: Int) = "정확도 약 ${meters}m"
    fun distance(meters: Int) = "${meters}m"
    fun approxTrip(km: Double) = "왕복 약 ${km.roundToInt()}km"
    fun otherAlerts(count: Int) = "다른 알림 ${count}개"
    fun appVersion(version: String) = "버전 $version"

    fun cardTitle(kind: String, rider: String, from: String?) = when (kind) {
        "cancelled_urgent" -> "$rider 픽업이 취소됐어요"
        "not_met" -> "$rider 님이 아직 못 만났대요"
        "child_ready" -> "$rider 님이 일찍 끝났대요"
        "offer_to_me" -> from?.let { "$it 님이 부탁했어요" } ?: "가족이 픽업을 부탁했어요"
        "offer_expired_mine" -> from?.let { "$it 님이 아직 답하지 않았어요" } ?: "아직 부탁에 답이 없어요"
        "not_departed" -> "아직 출발 전이에요"
        "routine_reminder" -> "곧 출발할 시간이에요"
        "routine_open" -> "담당을 정할 시간이에요"
        "boarding_check" -> "$rider 님이 탔나요?"
        "low_range" -> "주행가능거리를 확인해 주세요"
        else -> CarCopy.requestTitle(rider)
    }

    fun cardDetail(kind: String): String? = when (kind) {
        "cancelled_urgent" -> "안내를 종료해도 돼요"
        "not_met" -> "전화로 확인해 주세요"
        "boarding_check" -> "도착한 지 30분이 지났어요"
        else -> null
    }

    fun action(name: String, offer: Boolean) = when (name) {
        "start_now" -> CarCopy.depart
        "accept" -> CarCopy.accept
        "decline" -> if (offer) "거절" else CarCopy.decline
        "handoff_all" -> CarCopy.decline
        "boarded", "board" -> CarCopy.board
        "ack", "acknowledge", "dismiss" -> CarCopy.ok
        "location" -> CarCopy.location
        else -> null
    }

    fun pickupStatus(status: String) = when (status) {
        "open" -> "요청 들어옴"
        "assigned" -> "담당 정해짐"
        "en_route" -> "가는 중"
        "arrived" -> "도착"
        "completed" -> "탑승 완료"
        "cancelled" -> "취소됨"
        "closed_unconfirmed" -> "탑승 미확인"
        "expired" -> "만료됨"
        else -> "상태 확인 중"
    }
}
