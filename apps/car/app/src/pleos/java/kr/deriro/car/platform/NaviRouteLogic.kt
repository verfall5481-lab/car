package kr.deriro.car.platform

import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withTimeoutOrNull
import kr.deriro.car.data.vehicle.LatLng
import kr.deriro.car.data.vehicle.metersTo
import kr.deriro.car.nav.ARRIVAL_RADIUS_M
import kr.deriro.car.nav.ArrivalEvent
import kr.deriro.car.nav.Destination

/** A navigation destination within this distance of the requested point counts as the same place (POI and road snapping). */
internal const val ROUTE_TOLERANCE_M = 150.0

internal sealed interface RouteOutcome {
    /** The navigation routed our request. */
    data object Confirmed : RouteOutcome

    /** The navigation refused the request before routing it. */
    data class Rejected(val code: String) : RouteOutcome

    /** A route exists, but to a point farther than [ROUTE_TOLERANCE_M] from ours. */
    data class Mismatch(val meters: Double) : RouteOutcome

    /** No callback arrived at all. The connection may be stale. */
    data object NoEvidence : RouteOutcome
}

/** Collects NaviHelper callbacks for one route request. Thread-safe: callbacks may arrive on binder threads. */
internal class RouteAttempt(private val target: LatLng, private val toleranceM: Double = ROUTE_TOLERANCE_M) {
    private val result = CompletableDeferred<RouteOutcome>()
    private val routed = CompletableDeferred<Unit>()

    val routingCompleted: Boolean get() = routed.isCompleted

    fun onRoutingCompleted() {
        routed.complete(Unit)
    }

    /** Destination the navigation reports. Answers before routing completed describe an older route and are ignored. */
    fun onDestination(points: List<LatLng>) {
        if (!routed.isCompleted) return
        val nearest = points.filter(LatLng::isValid).minOfOrNull { it.metersTo(target) } ?: return
        result.complete(if (nearest <= toleranceM) RouteOutcome.Confirmed else RouteOutcome.Mismatch(nearest))
    }

    /** Errors after routing completed belong to follow-up queries and do not undo the route. */
    fun onError(code: String) {
        if (!routed.isCompleted) result.complete(RouteOutcome.Rejected(code))
    }

    suspend fun await(timeoutMs: Long, graceMs: Long): RouteOutcome {
        val early = withTimeoutOrNull(timeoutMs) {
            select<RouteOutcome?> {
                result.onAwait { it }
                routed.onAwait { null }
            }
        }
        if (early != null) return early
        if (result.isCompleted) return result.await()
        if (!routed.isCompleted) return RouteOutcome.NoEvidence
        // Routing completed is the navigation's own success signal; a missing destination echo does not undo it.
        return withTimeoutOrNull(graceMs) { result.await() } ?: RouteOutcome.Confirmed
    }

    fun cancel() {
        result.cancel()
        routed.cancel()
    }
}

/**
 * Attributes NaviHelper's identity-free `onDestinationArrived` to a requested pickup route (spec 13.1).
 * Automatic arrival is allowed only for the route this car is guiding to, never after guidance switched from
 * another pickup, never when the navigation destination changed away, and only with a position near the destination.
 */
internal class ArrivalTracker(
    private val radiusM: Double = ARRIVAL_RADIUS_M,
    private val toleranceM: Double = ROUTE_TOLERANCE_M,
    private val endGraceMs: Long = 120_000,
) {
    private class Tracked(val destination: Destination, val automatic: Boolean) {
        var endedAt: Instant? = null
        var unverified = false
    }

    private var tracked: Tracked? = null

    val watching: Destination?
        @Synchronized get() = tracked?.takeIf { it.automatic }?.destination

    @Synchronized
    fun track(destination: Destination) {
        val previous = tracked?.takeIf { it.endedAt == null }
        val switched = previous != null && (previous.destination.pickupId != destination.pickupId || !previous.automatic)
        tracked = Tracked(destination, automatic = !switched)
    }

    /** The pickup no longer needs guidance (arrived, completed, cancelled or replaced). */
    @Synchronized
    fun forget(pickupId: String? = null) {
        if (pickupId == null || tracked?.destination?.pickupId == pickupId) tracked = null
    }

    @Synchronized
    fun routeCancelled() {
        tracked = null
    }

    @Synchronized
    fun routeEnded(now: Instant) {
        tracked?.let { if (it.endedAt == null) it.endedAt = now }
    }

    /** Guidance is running again (status flicker around a reroute must not expire the route). */
    @Synchronized
    fun routeResumed() {
        tracked?.endedAt = null
    }

    @Synchronized
    fun destinationChanged() {
        tracked?.unverified = true
    }

    @Synchronized
    fun destinationReported(points: List<LatLng>) {
        val current = tracked ?: return
        val nearest = points.filter(LatLng::isValid).minOfOrNull { it.metersTo(current.destination.location) } ?: return
        if (nearest <= toleranceM) current.unverified = false else tracked = null
    }

    /** The destination an arrival callback belongs to, or null. The tracked route is consumed either way. */
    @Synchronized
    fun claimArrival(now: Instant): Destination? {
        val current = tracked ?: return null
        tracked = null
        val ended = current.endedAt
        if (ended != null && Duration.between(ended, now).toMillis() > endGraceMs) return null
        if (!current.automatic || current.unverified) return null
        return current.destination
    }

    fun arrivalEvent(destination: Destination, position: LatLng?, at: Instant): ArrivalEvent? {
        if (position == null || !position.isValid || destination.location.metersTo(position) > radiusM) return null
        return ArrivalEvent(destination.navSessionId, destination.destinationRevision, position, at)
    }
}
