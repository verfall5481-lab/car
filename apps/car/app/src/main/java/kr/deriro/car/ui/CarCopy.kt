package kr.deriro.car.ui

import java.time.Duration
import java.time.Instant
import kr.deriro.car.domain.PickupPhase

/** Copy shared by the demo and Pleos builds. Demo-only text lives in the demo source set (DemoCopy). */
internal object CarCopy {
    const val appName = "데리러"
    const val demoValue = "데모 값"
    const val parked = "주차 중"
    const val settings = "설정"
    const val back = "돌아가기"
    const val ok = "확인"
    const val stopToPair = "차를 세우고 연결해 주세요"
    const val pairTitle = "가족 휴대폰으로 연결해요"
    const val renew = "새 코드 만들기"
    const val expired = "연결 코드가 만료됐어요"
    const val carName = "우리 차"
    const val next = "다음 픽업"
    const val noPickups = "오늘 남은 픽업이 없어요"
    const val today = "오늘 목록"
    const val depart = "출발하고 안내"
    const val decline = "못 가요"
    const val accept = "수락"
    const val location = "위치 확인"
    const val locationUnconfirmed = "위치 확인 필요"
    const val parkToConfirm = "차를 세우고 위치를 확인해 주세요"
    const val routeHere = "이 위치로 안내"
    const val routeFailed = "내비를 열지 못했어요"
    const val retry = "다시 시도"
    const val continueManually = "직접 갈게요"
    const val reopen = "안내 다시 열기"
    const val arrived = "도착했어요"
    const val board = "태웠어요"
    const val parkToBoard = "차를 세우고 탑승을 확인해 주세요"
    const val boarded = "탑승 확인됨"
    const val rangeShort = "내일 픽업에 부족"
    const val unpair = "연결 해제"

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

    /** Name followed by the subject particle that fits its last syllable: 민준이, 할머니가. */
    fun subject(name: String): String {
        val last = name.trimEnd().lastOrNull() ?: return name
        val hasFinalConsonant = last in '가'..'힣' && (last - '가') % 28 != 0
        return name.trimEnd() + if (hasFinalConsonant) "이" else "가"
    }

    fun requestTitle(rider: String) = "${subject(rider)} 데리러 와 달래요"
    fun locationTitle(rider: String) = "${subject(rider)} 요청한 위치"
    fun enRouteTitle(rider: String) = "${rider}에게 가는 중"
    fun roundTrip(km: Int) = "왕복 약 ${km}km"
    fun pairingCode(code: String) = "코드  $code"
}
