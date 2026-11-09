package kr.deriro.car.domain

import java.time.Instant
import kr.deriro.car.data.vehicle.LatLng
import kr.deriro.car.nav.ArrivalEvent
import kr.deriro.car.nav.Destination
import kr.deriro.car.nav.NavResult
import kr.deriro.car.nav.matchesArrival
import kr.deriro.car.ux.DrivingMode

enum class PickupPhase { REQUESTED, ASSIGNED, EN_ROUTE, ARRIVED, COMPLETED }
enum class LocationSource { SAVED_POINT, SAVED_PLACE, MAP_PIN, GPS }
enum class Guidance { STARTING, REQUESTED, FAILED, MANUAL }

data class PickupLocation(
    val place: String,
    val boardingPoint: String? = null,
    val note: String? = null,
    val coordinates: LatLng,
    val source: LocationSource,
    val confirmed: Boolean = source != LocationSource.GPS,
    val revision: Int = 1,
) {
    val label: String
        get() {
            val destination = listOfNotNull(place, boardingPoint).joinToString(" ")
            return if (note == null) destination else "$destination, ‘$note’"
        }
}

data class RouteSession(
    val destination: Destination,
    val requestedAt: Instant,
    val guidance: Guidance = Guidance.STARTING,
)

data class Pickup(
    val id: String,
    val rider: String,
    val timeLabel: String,
    val location: PickupLocation,
    val phase: PickupPhase,
    val roundTripKm: Int?,
    val route: RouteSession? = null,
) {
    fun beginRoute(sessionId: String, now: Instant): Pickup {
        if (!location.confirmed || !location.coordinates.isValid || route?.guidance == Guidance.STARTING ||
            phase !in setOf(PickupPhase.REQUESTED, PickupPhase.ASSIGNED, PickupPhase.EN_ROUTE)
        ) return this

        val destination = Destination(location.coordinates, location.label, id, sessionId, location.revision)
        return copy(phase = PickupPhase.EN_ROUTE, route = RouteSession(destination, now))
    }

    fun recordNavResult(sessionId: String, result: NavResult): Pickup {
        val current = route ?: return this
        if (phase != PickupPhase.EN_ROUTE || current.guidance != Guidance.STARTING ||
            current.destination.navSessionId != sessionId
        ) return this

        val guidance = when (result) {
            NavResult.Requested -> Guidance.REQUESTED
            is NavResult.Failed -> Guidance.FAILED
            is NavResult.MapOpened -> Guidance.MANUAL
        }
        return copy(route = current.copy(guidance = guidance))
    }

    fun continueWithoutNavigation(): Pickup {
        val current = route ?: return this
        if (phase != PickupPhase.EN_ROUTE || current.guidance != Guidance.FAILED) return this
        return copy(route = current.copy(guidance = Guidance.MANUAL))
    }

    fun arrive(event: ArrivalEvent? = null): Pickup {
        if (phase != PickupPhase.EN_ROUTE) return this
        val current = route ?: return this
        if (event != null) {
            if (current.guidance != Guidance.REQUESTED || current.destination.pickupId != id ||
                current.destination.destinationRevision != location.revision ||
                !current.destination.matchesArrival(event, current.requestedAt)
            ) return this
        } else if (current.guidance != Guidance.REQUESTED && current.guidance != Guidance.MANUAL) {
            return this
        }
        return copy(phase = PickupPhase.ARRIVED)
    }

    fun board(mode: DrivingMode): Pickup = if (phase == PickupPhase.ARRIVED && mode.allowsParkedControls) {
        copy(phase = PickupPhase.COMPLETED)
    } else {
        this
    }
}
