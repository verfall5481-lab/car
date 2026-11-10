package kr.deriro.car.live

import java.time.Instant
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kr.deriro.car.data.vehicle.LatLng
import kr.deriro.car.data.vehicle.VehicleStateSource
import kr.deriro.car.nav.NavigationGateway
import kr.deriro.car.ux.DrivingStateMonitor
import org.json.JSONObject

/** Server RPC entry point. [VehicleBackend] is the real implementation. */
internal interface PickupBackend {
    suspend fun rpc(name: String, arguments: JSONObject = JSONObject()): JSONObject
}

/** Vehicle signals plus the driving lock. [kr.deriro.car.platform.PleosVehicleSignals] is the real implementation. */
internal interface VehicleSignals : VehicleStateSource, DrivingStateMonitor, AutoCloseable {
    /** True while the platform reports no distraction restriction, so the permission dialog may be shown. */
    val setupAllowed: StateFlow<Boolean>

    /** A current position fix, or null when none arrives within [timeoutMs] or location is not allowed. */
    suspend fun freshLocation(timeoutMs: Long): LatLng?

    /** Called after a permission dialog closes so newly granted sources start reporting. */
    fun permissionsChanged()
}

/** Failure code for a route the navigation accepted but to a different place. No map fallback is opened for it. */
internal const val NAV_DESTINATION_MISMATCH = "NAVI_DESTINATION_MISMATCH"

internal interface RouteNavigator : NavigationGateway, AutoCloseable {
    /** The pickup no longer needs automatic arrival (arrived, completed, cancelled or replaced). */
    fun tripClosed(pickupId: String) {}
}

/** Sound in the foreground, heads-up notification in the background. */
internal interface CardAlerts {
    fun announce(card: FeedCard, foreground: Boolean, actions: List<String>)

    /** Withdraws posted notifications whose card key is no longer in [alertKeys]. */
    fun retain(alertKeys: Set<String>)
}

/** Keeps the process alive (foreground service) while a pickup trip is in progress. */
internal interface TripKeeper {
    fun update(tripActive: Boolean, foreground: Boolean)
}

internal data class LiveTiming(
    val pairingPollMs: Long = 3_000,
    val foregroundPollMs: Long = 10_000,
    val tripPollMs: Long = 10_000,
    val backgroundPollMs: Long = 30_000,
    val failureBaseMs: Long = 2_000,
    val failureMaxMs: Long = 30_000,
    val contactFreshMs: Long = 30_000,
    val noticeMs: Long = 3_000,
    val completedMs: Long = 2_000,
    val retryPauseMs: Long = 300,
)

internal class LiveCarDependencies(
    val backend: PickupBackend?,
    val vault: ClientVault?,
    val signals: VehicleSignals,
    val navigation: RouteNavigator,
    val alerts: CardAlerts,
    val tripKeeper: TripKeeper,
    val pairUrl: (String) -> String? = { null },
    val commands: Flow<CardCommand> = emptyFlow(),
    val clock: () -> Instant = Instant::now,
    val timing: LiveTiming = LiveTiming(),
) {
    val configured: Boolean get() = backend != null
}
