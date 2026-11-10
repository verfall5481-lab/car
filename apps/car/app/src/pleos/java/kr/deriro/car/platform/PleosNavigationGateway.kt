package kr.deriro.car.platform

import ai.pleos.playground.navi.constants.NaviErrorCode
import ai.pleos.playground.navi.constants.NavigationStatus
import ai.pleos.playground.navi.data.CurrentLocationInfo
import ai.pleos.playground.navi.data.DestinationArrivedInfo
import ai.pleos.playground.navi.data.DestinationInfo
import ai.pleos.playground.navi.data.RouteInfo
import ai.pleos.playground.navi.data.RouteStartInfo
import ai.pleos.playground.navi.helper.NaviHelper
import ai.pleos.playground.navi.helper.listener.NaviHelperEventListener
import android.content.Context
import android.content.Intent
import android.net.Uri
import java.time.Instant
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kr.deriro.car.data.vehicle.LatLng
import kr.deriro.car.data.vehicle.metersTo
import kr.deriro.car.live.NAV_DESTINATION_MISMATCH
import kr.deriro.car.live.RouteNavigator
import kr.deriro.car.nav.ArrivalEvent
import kr.deriro.car.nav.Destination
import kr.deriro.car.nav.NavResult

/**
 * Pleos NaviHelper 3.0.5 behind [RouteNavigator].
 *
 * - The helper is rebuilt whenever it fails to initialize, reports a later failure, throws, or stops answering,
 *   and is reconnected in the background while a route is being watched for arrival.
 * - A route counts as requested when the navigation finishes routing it and, if it reports a destination,
 *   that destination is within [ROUTE_TOLERANCE_M] of ours. The geo: map is opened only when the navigation
 *   refused or never handled the request, never on top of a route it accepted.
 * - `onDestinationArrived` carries no request identity, so it is attributed through [ArrivalTracker]
 *   (spec 13.1) and tagged with the tracked session and destination revision; the view model and the server
 *   check both again before `mark_arrived(source = nav_callback)`.
 */
internal class PleosNavigationGateway(
    private val context: Context,
    private val scope: CoroutineScope,
    private val locate: suspend () -> LatLng?,
    private val clock: () -> Instant = Instant::now,
) : RouteNavigator {
    private val routeLock = Mutex()
    private val connection = AtomicReference<Connection?>(null)
    @Volatile private var attempt: RouteAttempt? = null
    @Volatile private var destinationProbe: CompletableDeferred<List<LatLng>>? = null
    @Volatile private var positionProbe: CompletableDeferred<LatLng>? = null
    @Volatile private var keepAlive: Job? = null
    @Volatile private var closed = false
    private val tracker = ArrivalTracker()
    private val events = MutableSharedFlow<ArrivalEvent>(extraBufferCapacity = 8)

    override val arrivals = events.asSharedFlow()
    override fun supportsArrivalCallback() = true

    private class Connection(val helper: NaviHelper) {
        @Volatile var alive = true
        var listener: NaviHelperEventListener? = null
    }

    private inner class ConnectionListener(private val owner: Connection) : NaviHelperEventListener {
        private val current: Boolean get() = owner.alive && connection.get() === owner

        override fun onRoutingCompleted() {
            if (!current) return
            val pending = attempt ?: return
            pending.onRoutingCompleted()
            runCatching { owner.helper.getDestinationInfo() }
        }

        override fun onRouteStarted(routeStartInfo: RouteStartInfo) {
            if (current) attempt?.onRoutingCompleted()
        }

        override fun onDestinationInfo(destinationInfo: DestinationInfo) {
            if (!current) return
            val points = destinationInfo.points()
            attempt?.onDestination(points)
            destinationProbe?.complete(points)
            tracker.destinationReported(points)
        }

        override fun onError(errorCode: NaviErrorCode) {
            if (current) attempt?.onError(errorCode.name)
        }

        override fun onRouteCancelled() {
            if (current) tracker.routeCancelled()
        }

        // onRouteEnded is deprecated in 3.0.5; the navigation status reports the same transition.
        override fun onNavigationStatus(navigationStatus: NavigationStatus) {
            if (!current) return
            if (navigationStatus == NavigationStatus.ROUTE_DRIVE) tracker.routeResumed() else tracker.routeEnded(clock())
        }

        override fun onDestinationChanged() {
            if (!current) return
            tracker.destinationChanged()
            runCatching { owner.helper.getDestinationInfo() }
        }

        override fun onCurrentLocationInfo(currentLocationInfo: CurrentLocationInfo) {
            if (current) positionProbe?.complete(LatLng(currentLocationInfo.latitude, currentLocationInfo.longitude))
        }

        override fun onDestinationArrived(destinationArrivedInfo: DestinationArrivedInfo) {
            if (!current) return
            val at = clock()
            val destination = tracker.claimArrival(at) ?: return
            scope.launch {
                val position = navigationPosition(owner) ?: runCatching { locate() }.getOrNull()
                tracker.arrivalEvent(destination, position, at)?.let(events::tryEmit)
            }
        }
    }

    override suspend fun startRoute(dest: Destination): NavResult = routeLock.withLock {
        if (!dest.location.isValid) return@withLock NavResult.Failed("INVALID_DESTINATION")
        val outcome = try {
            request(dest)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            RouteOutcome.Rejected(failureCode(failure))
        } finally {
            attempt = null
        }
        when (outcome) {
            RouteOutcome.Confirmed -> {
                tracker.track(dest)
                NavResult.Requested
            }
            is RouteOutcome.Mismatch -> {
                // The navigation is guiding somewhere else; opening another map on top would only add a second route.
                tracker.forget(dest.pickupId)
                NavResult.Failed(NAV_DESTINATION_MISMATCH)
            }
            is RouteOutcome.Rejected -> openMap(dest, outcome.code)
            RouteOutcome.NoEvidence -> openMap(dest, "NAVI_TIMEOUT")
        }
    }

    /** Sends the request, rebuilding the connection once when it throws or stays silent. */
    private suspend fun request(dest: Destination): RouteOutcome {
        var failure: RouteOutcome = RouteOutcome.Rejected("NAVI_UNAVAILABLE")
        for (round in 0 until 2) {
            val live = connect() ?: continue
            val pending = RouteAttempt(dest.location)
            attempt = pending
            try {
                live.helper.requestRoute(routeInfo(dest))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                invalidate(live)
                failure = RouteOutcome.Rejected(failureCode(error))
                continue
            }
            val outcome = pending.await(ROUTE_TIMEOUT_MS, DESTINATION_GRACE_MS)
            attempt = null
            if (outcome != RouteOutcome.NoEvidence) return outcome
            // Silence usually means a dead binding. Ask a fresh connection where the navigation is going before resending.
            invalidate(live)
            val fresh = connect() ?: return RouteOutcome.NoEvidence
            val reported = probeDestination(fresh)
            val nearest = reported?.filter(LatLng::isValid)?.minOfOrNull { it.metersTo(dest.location) }
            if (nearest != null && nearest <= ROUTE_TOLERANCE_M) return RouteOutcome.Confirmed
            failure = RouteOutcome.NoEvidence
        }
        return failure
    }

    private suspend fun connect(): Connection? {
        connection.get()?.takeIf { it.alive }?.let { return it }
        if (closed) return null
        val helper = runCatching { NaviHelper(context) }.getOrNull() ?: return null
        val live = Connection(helper)
        val ready = CompletableDeferred<Boolean>()
        val started = runCatching {
            helper.initialize(
                onConnected = { ready.complete(true) },
                // After a successful start this reports a lost service; rebuild on the next use.
                onFailed = { if (!ready.complete(false)) invalidate(live) },
            )
        }.isSuccess
        if (!started || withTimeoutOrNull(CONNECT_TIMEOUT_MS) { ready.await() } != true) {
            live.alive = false
            runCatching { helper.release() }
            return null
        }
        val listener = ConnectionListener(live)
        if (runCatching { helper.addListener(listener) }.isFailure) {
            live.alive = false
            runCatching { helper.release() }
            return null
        }
        live.listener = listener
        val previous = connection.getAndSet(live)
        if (previous != null && previous !== live) release(previous)
        return live
    }

    private fun invalidate(live: Connection) {
        if (!live.alive) return
        live.alive = false
        connection.compareAndSet(live, null)
        release(live)
        if (tracker.watching != null) reconnectInBackground()
    }

    private fun release(live: Connection) {
        live.alive = false
        live.listener?.let { listener -> runCatching { live.helper.removeListener(listener) } }
        runCatching { live.helper.release() }
    }

    /** Keeps a listener attached while an arrival is expected, retrying with backoff. */
    private fun reconnectInBackground() {
        if (closed || keepAlive?.isActive == true) return
        keepAlive = scope.launch {
            var wait = 1_000L
            while (isActive && !closed && tracker.watching != null && connection.get()?.alive != true) {
                if (routeLock.tryLock()) {
                    try {
                        connect()
                    } finally {
                        routeLock.unlock()
                    }
                }
                if (connection.get()?.alive == true) break
                delay(wait)
                wait = (wait * 2).coerceAtMost(30_000L)
            }
        }
    }

    private suspend fun probeDestination(live: Connection): List<LatLng>? {
        val probe = CompletableDeferred<List<LatLng>>()
        destinationProbe = probe
        return try {
            if (runCatching { live.helper.getDestinationInfo() }.isFailure) null
            else withTimeoutOrNull(PROBE_TIMEOUT_MS) { probe.await() }
        } finally {
            destinationProbe = null
        }
    }

    private suspend fun navigationPosition(live: Connection): LatLng? {
        val probe = CompletableDeferred<LatLng>()
        positionProbe = probe
        return try {
            if (runCatching { live.helper.getCurrentLocationInfo() }.isFailure) null
            else withTimeoutOrNull(PROBE_TIMEOUT_MS) { probe.await() }?.takeIf(LatLng::isValid)
        } finally {
            positionProbe = null
        }
    }

    override fun tripClosed(pickupId: String) {
        tracker.forget(pickupId)
    }

    private fun openMap(dest: Destination, failure: String): NavResult {
        val point = "${dest.location.lat},${dest.location.lng}"
        val uri = Uri.parse("geo:$point?q=${Uri.encode("$point(${dest.label})")}")
        return runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            NavResult.MapOpened(failure)
        }.getOrElse { NavResult.Failed(failure) }
    }

    override fun close() {
        closed = true
        keepAlive?.cancel()
        attempt?.cancel()
        tracker.forget()
        connection.getAndSet(null)?.let(::release)
    }

    private fun routeInfo(dest: Destination) = RouteInfo(
        latitude = dest.location.lat, longitude = dest.location.lng,
        displayLatitude = null, displayLongitude = null, poiName = dest.label,
        poiId = "", address = "", poiSubId = "",
    )

    private fun DestinationInfo.points(): List<LatLng> = listOfNotNull(
        LatLng(latitude, longitude),
        displayLatitude?.let { lat -> displayLongitude?.let { lng -> LatLng(lat, lng) } },
    )

    private fun failureCode(error: Exception): String = when (error) {
        is SecurityException -> "NAVI_PERMISSION"
        is IllegalStateException -> "NAVI_SERVICE"
        else -> "NAVI_EXCEPTION"
    }

    companion object {
        private const val CONNECT_TIMEOUT_MS = 2_500L
        private const val ROUTE_TIMEOUT_MS = 6_000L
        private const val DESTINATION_GRACE_MS = 2_000L
        private const val PROBE_TIMEOUT_MS = 2_000L
    }
}
