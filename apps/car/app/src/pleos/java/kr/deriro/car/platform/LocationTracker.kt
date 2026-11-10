package kr.deriro.car.platform

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Looper
import android.os.SystemClock
import java.util.concurrent.Executor
import kotlin.coroutines.resume
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kr.deriro.car.data.vehicle.LatLng

/**
 * Vehicle position from the platform LocationManager (no Play Services).
 * While location is allowed it keeps a low-rate update subscription so a recent fix exists,
 * and [fresh] asks for a new fix with a timeout when the kept one is too old.
 */
@SuppressLint("MissingPermission")
internal class LocationTracker(private val context: Context) : AutoCloseable {
    private val manager: LocationManager? = context.getSystemService(LocationManager::class.java)
    private val mainExecutor = Executor { command -> android.os.Handler(Looper.getMainLooper()).post(command) }
    @Volatile private var latest: Location? = null
    private var listening = false

    // All four methods are implemented: before API 30 LocationListener has no default methods.
    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) = offer(location)
        override fun onProviderEnabled(provider: String) = Unit
        override fun onProviderDisabled(provider: String) = Unit
        @Deprecated("Deprecated in API 29")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
    }

    val allowed: Boolean
        get() = context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    /** Starts or stops the background subscription to match the current permission. Call on the main thread. */
    fun ensureListening() {
        val locations = manager ?: return
        if (!allowed) {
            if (listening) runCatching { locations.removeUpdates(listener) }
            listening = false
            return
        }
        if (listening) return
        for (provider in providers(locations)) {
            runCatching {
                locations.requestLocationUpdates(provider, UPDATE_INTERVAL_MS, 0f, listener, Looper.getMainLooper())
                listening = true
            }
        }
    }

    data class Fix(val position: LatLng, val timeMs: Long)

    /** Best recent fix: at most [MAX_AGE_MS] old and [MAX_ACCURACY_M] accurate, or null. */
    fun current(): Fix? {
        val locations = manager
        val candidates = buildList {
            latest?.let(::add)
            if (allowed && locations != null) {
                for (provider in providers(locations)) runCatching { locations.getLastKnownLocation(provider) }.getOrNull()?.let(::add)
            }
        }
        val best = candidates.filter(::usable).maxByOrNull(Location::getElapsedRealtimeNanos) ?: return null
        offer(best)
        return Fix(best.toLatLng(), best.time)
    }

    /** Returns a recent fix, or requests a new one and waits up to [timeoutMs]. */
    suspend fun fresh(timeoutMs: Long): LatLng? {
        current()?.let { return it.position }
        val locations = manager ?: return null
        if (!allowed) return null
        val provider = providers(locations).firstOrNull() ?: return null
        val fix = withTimeoutOrNull(timeoutMs) {
            withContext(Dispatchers.Main) {
                if (Build.VERSION.SDK_INT >= 30) currentLocation(locations, provider) else singleUpdate(locations, provider)
            }
        }
        fix?.let(::offer)
        return fix?.takeIf { it.hasAccuracy() && it.accuracy <= MAX_ACCURACY_M }?.toLatLng()
    }

    @SuppressLint("NewApi")
    private suspend fun currentLocation(locations: LocationManager, provider: String): Location? =
        suspendCancellableCoroutine<Location?> { continuation ->
            val signal = CancellationSignal()
            continuation.invokeOnCancellation { signal.cancel() }
            runCatching {
                locations.getCurrentLocation(provider, signal, mainExecutor) { location ->
                    if (continuation.isActive) continuation.resume(location)
                }
            }.onFailure { if (continuation.isActive) continuation.resume(null) }
        }

    private suspend fun singleUpdate(locations: LocationManager, provider: String): Location? {
        val result = CompletableDeferred<Location?>()
        val once = object : LocationListener {
            override fun onLocationChanged(location: Location) {
                result.complete(location)
            }
            override fun onProviderEnabled(provider: String) = Unit
            override fun onProviderDisabled(provider: String) {
                result.complete(null)
            }
            @Deprecated("Deprecated in API 29")
            override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
        }
        return try {
            if (runCatching { locations.requestLocationUpdates(provider, 0L, 0f, once, Looper.getMainLooper()) }.isFailure) {
                return null
            }
            result.await()
        } finally {
            runCatching { locations.removeUpdates(once) }
        }
    }

    private fun offer(location: Location) {
        if (!LatLng(location.latitude, location.longitude).isValid) return
        val previous = latest
        if (previous == null || location.elapsedRealtimeNanos >= previous.elapsedRealtimeNanos) latest = location
    }

    private fun usable(location: Location): Boolean =
        location.hasAccuracy() && location.accuracy <= MAX_ACCURACY_M &&
            SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos in 0L..MAX_AGE_MS * 1_000_000L &&
            LatLng(location.latitude, location.longitude).isValid

    private fun providers(locations: LocationManager): List<String> =
        listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).filter { provider ->
            runCatching { locations.isProviderEnabled(provider) }.getOrDefault(false)
        }

    override fun close() {
        runCatching { manager?.removeUpdates(listener) }
        listening = false
    }

    private fun Location.toLatLng() = LatLng(latitude, longitude)

    companion object {
        private const val UPDATE_INTERVAL_MS = 15_000L
        private const val MAX_AGE_MS = 120_000L
        private const val MAX_ACCURACY_M = 100f
    }
}
