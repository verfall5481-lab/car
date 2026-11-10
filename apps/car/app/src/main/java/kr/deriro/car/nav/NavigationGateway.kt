package kr.deriro.car.nav

import java.time.Instant
import kotlinx.coroutines.flow.Flow
import kr.deriro.car.data.vehicle.LatLng
import kr.deriro.car.data.vehicle.metersTo

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

/** Radius around the destination inside which an arrival position is accepted. */
const val ARRIVAL_RADIUS_M = 200.0

/** Automatic arrival requires proven session ownership. Untagged events use manual arrival. */
fun Destination.matchesArrival(event: ArrivalEvent, requestedAt: Instant): Boolean {
    if (event.navSessionId != navSessionId || event.destinationRevision != destinationRevision ||
        event.at.isBefore(requestedAt) || !location.isValid || !event.location.isValid
    ) return false
    return location.metersTo(event.location) <= ARRIVAL_RADIUS_M
}
