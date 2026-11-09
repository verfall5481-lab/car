package kr.deriro.car.nav

import java.time.Instant
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import kotlinx.coroutines.flow.Flow
import kr.deriro.car.data.vehicle.LatLng

data class Destination(
    val location: LatLng,
    val label: String,
    val pickupId: String,
    val navSessionId: String,
    val destinationRevision: Int,
)

data class ArrivalEvent(
    val navSessionId: String?,
    val destinationRevision: Int?,
    val location: LatLng,
    val at: Instant,
)

sealed interface NavResult {
    data object Requested : NavResult
    data class Failed(val code: String) : NavResult
    data class MapOpened(val sdkError: String) : NavResult
}

interface NavigationGateway {
    suspend fun startRoute(dest: Destination): NavResult
    val arrivals: Flow<ArrivalEvent>
    fun supportsArrivalCallback(): Boolean
}

/** Automatic arrival requires proven session ownership. Untagged events use manual arrival. */
fun Destination.matchesArrival(event: ArrivalEvent, requestedAt: Instant): Boolean {
    if (event.navSessionId != navSessionId || event.destinationRevision != destinationRevision ||
        event.at.isBefore(requestedAt) || !location.isValid || !event.location.isValid
    ) return false

    val latDelta = Math.toRadians(event.location.lat - location.lat)
    val lngDelta = Math.toRadians(event.location.lng - location.lng)
    val a = sin(latDelta / 2) * sin(latDelta / 2) +
        cos(Math.toRadians(location.lat)) * cos(Math.toRadians(event.location.lat)) *
        sin(lngDelta / 2) * sin(lngDelta / 2)
    val meters = 2 * 6_371_000 * asin(sqrt(a.coerceIn(0.0, 1.0)))
    return meters <= 200
}
