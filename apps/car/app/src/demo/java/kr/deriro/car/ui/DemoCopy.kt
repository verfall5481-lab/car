package kr.deriro.car.ui

import kotlin.math.roundToInt
import kr.deriro.car.data.vehicle.VehicleSnapshot
import kr.deriro.car.ux.DrivingMode

/** Demo-only copy and fixture text. It is compiled into the demo build only. */
internal object DemoCopy {
    const val demo = CarCopy.demoValue
    const val driving = "주행 중 · 데모"
    const val unknown = "상태 미확인 · 데모"
    const val drivingPreview = "주행 미리보기"
    const val pairDemo = "연결 코드와 QR을 미리 볼 수 있어요."
    const val qrDemo = "연결용 QR 예시"
    const val pairLocally = "데모 연결하기"
    const val currentDriver = "지금 운전하는 사람"
    const val driverBusy = "안내 중에는 운전자를 바꿀 수 없어요"
    const val paired = "데모 연결됨"
    const val assigned = "담당 아빠"
    const val nearSavedPlace = "수학학원 350m"
    const val accuracy = "정확도 약 220m"
    const val mapDemo = "위치 예시 · 데모"
    const val routeStarting = "데모 안내 요청 중"
    const val routeRequested = "데모 안내 요청됨"
    const val arrivalRecorded = "도착 상태를 기록했어요 · 데모"
    const val declined = "못 간다고 표시했어요 · 데모"
    const val rangeAlert = "내일까지 픽업에 약 62km가 필요해요"
    const val rangeEstimate = "픽업 2건 기준, 데모 추정치예요"
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
    const val unpairTitle = "데모 연결을 해제할까요?"
    const val vehicleChecking = "차량 값 확인 중"

    fun mode(mode: DrivingMode) = when (mode) {
        DrivingMode.PARKED -> CarCopy.parked
        DrivingMode.DRIVING -> driving
        DrivingMode.UNKNOWN -> unknown
    }

    fun energy(vehicle: VehicleSnapshot?) = when {
        vehicle?.rangeKm != null -> "주행가능 ${vehicle.rangeKm.roundToInt()}km"
        vehicle?.fuelPct != null -> "연료 ${vehicle.fuelPct.roundToInt()}%"
        vehicle?.socPct != null -> "배터리 ${vehicle.socPct.roundToInt()}%"
        else -> vehicleChecking
    }

    fun driver(name: String) = "운전자 $name"

    fun arrivedByCallback(rider: String) = "${rider}의 데모 도착 콜백을 반영했어요"
}
