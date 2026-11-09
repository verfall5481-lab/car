package kr.deriro.car.platform

import ai.pleos.playground.navi.constants.NaviErrorCode
import ai.pleos.playground.navi.data.DestinationInfo
import ai.pleos.playground.navi.data.RouteInfo
import ai.pleos.playground.navi.helper.NaviHelper
import ai.pleos.playground.navi.helper.listener.NaviHelperEventListener
import android.content.Context
import android.content.Intent
import android.net.Uri
import kotlin.math.abs
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kr.deriro.car.nav.ArrivalEvent
import kr.deriro.car.nav.Destination
import kr.deriro.car.nav.NavResult
import kr.deriro.car.nav.NavigationGateway

internal class PleosNavigationGateway(private val context: Context) : NavigationGateway, AutoCloseable {
    private val routeLock = Mutex()
    private var service: NaviHelper? = null
    @Volatile private var attempt: Attempt? = null

    // SDK 3.0.5 DestinationArrivedInfo has neither request identity nor coordinates.
    override val arrivals = emptyFlow<ArrivalEvent>()
    override fun supportsArrivalCallback() = false

    private class Attempt(val destination: Destination) {
        val result = CompletableDeferred<NavResult>()
        @Volatile var routeCompleted = false
    }

    private val listener = object : NaviHelperEventListener {
        override fun onRoutingCompleted() {
            val pending = attempt ?: return
            pending.routeCompleted = true
            runCatching { service?.getDestinationInfo() }.onFailure {
                pending.result.complete(NavResult.Failed("NAVI_DESTINATION_CHECK_FAILED"))
            }
        }

        override fun onDestinationInfo(destinationInfo: DestinationInfo) {
            val pending = attempt ?: return
            val target = pending.destination.location
            if (pending.routeCompleted && abs(destinationInfo.latitude - target.lat) < 0.0002 &&
                abs(destinationInfo.longitude - target.lng) < 0.0002
            ) pending.result.complete(NavResult.Requested)
        }

        override fun onError(errorCode: NaviErrorCode) {
            attempt?.result?.complete(NavResult.Failed(errorCode.name))
        }
    }

    override suspend fun startRoute(dest: Destination): NavResult = routeLock.withLock {
        if (!dest.location.isValid) return@withLock NavResult.Failed("INVALID_DESTINATION")
        val navi = connect() ?: return@withLock openMap(dest, "NAVI_UNAVAILABLE")
        val pending = Attempt(dest)
        attempt = pending
        val result = try {
            navi.requestRoute(RouteInfo(
                latitude = dest.location.lat, longitude = dest.location.lng,
                displayLatitude = null, displayLongitude = null, poiName = dest.label,
                poiId = "", address = "", poiSubId = "",
            ))
            withTimeoutOrNull(6_000) { pending.result.await() } ?: NavResult.Failed("NAVI_TIMEOUT")
        } catch (_: SecurityException) {
            NavResult.Failed("NAVI_PERMISSION")
        } catch (_: IllegalStateException) {
            NavResult.Failed("NAVI_SERVICE")
        } finally {
            attempt = null
        }
        if (result is NavResult.Failed) openMap(dest, result.code) else result
    }

    private suspend fun connect(): NaviHelper? {
        service?.let { return it }
        val navi = runCatching { NaviHelper(context) }.getOrNull() ?: return null
        val connected = CompletableDeferred<Boolean>()
        val started = runCatching {
            navi.initialize(onConnected = { connected.complete(true) }, onFailed = { connected.complete(false) })
        }.isSuccess
        if (!started || withTimeoutOrNull(2_500) { connected.await() } != true) {
            runCatching { navi.release() }
            return null
        }
        if (runCatching { navi.addListener(listener) }.isFailure) {
            runCatching { navi.release() }
            return null
        }
        service = navi
        return navi
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
        attempt?.result?.cancel()
        service?.let { navi ->
            runCatching { navi.removeListener(listener) }
            runCatching { navi.release() }
        }
        service = null
    }
}
