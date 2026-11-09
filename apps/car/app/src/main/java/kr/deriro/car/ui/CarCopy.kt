package kr.deriro.car.ui

import java.time.Duration
import java.time.Instant
import kr.deriro.car.data.vehicle.VehicleSnapshot
import kr.deriro.car.domain.PickupPhase
import kr.deriro.car.ux.DrivingMode
import kotlin.math.roundToInt

internal object CarCopy {
    const val appName = "데리러"
    const val demo = "데모 값"
    const val parked = "주차 중"
    const val driving = "주행 중 · 데모"
    const val unknown = "상태 미확인 · 데모"
    const val drivingPreview = "주행 미리보기"
    const val settings = "설정"
    const val back = "돌아가기"
    const val ok = "확인"
    const val stopToPair = "차를 세우고 연결해 주세요"
    const val pairTitle = "가족 휴대폰으로 연결해요"
    const val pairDemo = "연결 코드와 QR을 미리 볼 수 있어요."
    const val qrDemo = "연결용 QR 예시"
    const val pairLocally = "데모 연결하기"
    const val renew = "새 코드 만들기"
    const val expired = "연결 코드가 만료됐어요"
    const val carName = "우리 차"
    const val driver = "운전자 아빠"
    const val paired = "데모 연결됨"
    const val next = "다음 픽업"
    const val assigned = "담당 아빠"
    const val noPickups = "오늘 남은 픽업이 없어요"
    const val today = "오늘 목록"
    const val depart = "출발하고 안내"
    const val decline = "못 가요"
    const val accept = "수락"
    const val location = "위치 확인"
    const val locationUnconfirmed = "위치 확인 필요"
    const val parkToConfirm = "차를 세우고 위치를 확인해 주세요"
    const val nearSavedPlace = "수학학원 350m"
    const val accuracy = "정확도 약 220m"
    const val mapDemo = "위치 예시 · 데모"
    const val routeHere = "이 위치로 안내"
    const val routeStarting = "데모 안내 요청 중"
    const val routeRequested = "데모 안내 요청됨"
    const val routeFailed = "내비를 열지 못했어요"
    const val retry = "다시 시도"
    const val continueManually = "직접 갈게요"
    const val reopen = "안내 다시 열기"
    const val arrived = "도착했어요"
    const val arrivalRecorded = "도착 상태를 기록했어요 · 데모"
    const val board = "태웠어요"
    const val parkToBoard = "차를 세우고 탑승을 확인해 주세요"
    const val boarded = "탑승 확인됨"
    const val declined = "못 간다고 표시했어요 · 데모"
    const val rangeAlert = "내일까지 픽업에 약 62km가 필요해요"
    const val rangeEstimate = "픽업 2건 기준, 데모 추정치예요"
    const val rangeShort = "내일 픽업에 부족"
    const val demoPanel = "데모 패널"
    const val localOnly = "이 기기에서 차량과 가족 요청을 시뮬레이션해요."
    const val rangeOverride = "주행가능거리 덮어쓰기"
    const val rangeLimits = "0~600km"
    const val hideRange = "거리값 끄기"
    const val restoreRange = "거리값 켜기"
    const val ignition = "시동 상태"
    const val simulateDriving = "20초간 주행"
    const val simulateUnknown = "20초간 상태 미확인"
    const val savedPinRequest = "가족 핀 요청 띄우기"
    const val gpsRequest = "위치 미확정 요청 띄우기"
    const val resetScheduled = "예정 픽업 불러오기"
    const val failNext = "다음 안내 실패시키기"
    const val cancelFailure = "실패 시뮬레이션 해제"
    const val callback = "도착 콜백 시뮬레이션"
    const val currentCallback = "현재 안내"
    const val oldCallback = "이전 안내"
    const val ignoredCallback = "이전 안내 콜백을 무시했어요"
    const val unpair = "연결 해제"
    const val unpairTitle = "데모 연결을 해제할까요?"

    fun status(phase: PickupPhase) = when (phase) {
        PickupPhase.REQUESTED -> "요청 들어옴"
        PickupPhase.ASSIGNED -> "담당 정해짐"
        PickupPhase.EN_ROUTE -> "가는 중"
        PickupPhase.ARRIVED -> "도착"
        PickupPhase.COMPLETED -> "탑승 완료"
    }

    fun expires(now: Instant, expiresAt: Instant): String {
        val seconds = Duration.between(now, expiresAt).seconds.coerceAtLeast(0)
        return "${seconds / 60}분 ${seconds % 60}초 남음"
    }

    fun mode(mode: DrivingMode) = when (mode) {
        DrivingMode.PARKED -> parked
        DrivingMode.DRIVING -> driving
        DrivingMode.UNKNOWN -> unknown
    }

    fun energy(vehicle: VehicleSnapshot?) = when {
        vehicle?.rangeKm != null -> "주행가능 ${vehicle.rangeKm.roundToInt()}km"
        vehicle?.fuelPct != null -> "연료 ${vehicle.fuelPct.roundToInt()}%"
        vehicle?.socPct != null -> "배터리 ${vehicle.socPct.roundToInt()}%"
        else -> "차량 값 확인 중"
    }

    fun requestTitle(rider: String) = "${rider}의 픽업 요청"
    fun locationTitle(rider: String) = "${rider}의 요청 위치"
    fun enRouteTitle(rider: String) = "${rider}에게 가는 중"
    fun roundTrip(km: Int) = "왕복 약 ${km}km"
    fun pairingCode(code: String) = "코드  $code"
    fun arrivedByCallback(rider: String) = "${rider}의 데모 도착 콜백을 반영했어요"
}
