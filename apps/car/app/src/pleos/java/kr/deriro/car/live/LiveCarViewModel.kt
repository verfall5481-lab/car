package kr.deriro.car.live

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.time.Instant
import java.util.UUID
import kotlin.math.abs
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kr.deriro.car.data.vehicle.Gear
import kr.deriro.car.data.vehicle.Ignition
import kr.deriro.car.data.vehicle.VehicleCapability
import kr.deriro.car.data.vehicle.VehicleSnapshot
import kr.deriro.car.nav.ArrivalEvent
import kr.deriro.car.nav.Destination
import kr.deriro.car.nav.NavResult
import kr.deriro.car.nav.matchesArrival
import kr.deriro.car.ux.DrivingMode
import org.json.JSONObject

internal enum class LivePanel { HOME, TODAY, PICKUP, SETTINGS, LOCATION, SWITCH, RANGE, UNPAIR, ABOUT }

/** OFFLINE means the server could not be reached. Server and parse errors keep the connection ONLINE. */
internal enum class VehicleConnection { CHECKING, ONLINE, OFFLINE }

/** The server answered, but not usefully. Buttons stay enabled because the server still checks every action. */
internal enum class SyncIssue { SERVER, RESPONSE }

internal sealed interface NoticeMessage {
    data class Failure(val code: String, val by: String? = null) : NoticeMessage
    data object HandedToFamily : NoticeMessage
    data class OfferDeclined(val from: String?) : NoticeMessage
}

/** A short message shown for [LiveTiming.noticeMs] in every driving mode (V-03). */
internal data class LiveNotice(val id: Long, val message: NoticeMessage) {
    val error: Boolean get() = message is NoticeMessage.Failure
}

internal data class LiveCarState(
    val configured: Boolean,
    val mode: DrivingMode = DrivingMode.UNKNOWN,
    val permissionSetupAllowed: Boolean = false,
    val connection: VehicleConnection = VehicleConnection.CHECKING,
    /** The server answered within [LiveTiming.contactFreshMs]. */
    val contactFresh: Boolean = false,
    val syncIssue: SyncIssue? = null,
    val lastContact: Instant? = null,
    val lastFeedAt: Instant? = null,
    val vehicle: LiveVehicle? = null,
    val snapshot: VehicleSnapshot? = null,
    val feed: VehicleFeed? = null,
    val ticket: PairTicket? = null,
    val panel: LivePanel = LivePanel.HOME,
    val selectedId: String? = null,
    val selectedOfferId: String? = null,
    val pending: Boolean = false,
    val notice: LiveNotice? = null,
    val linkError: String? = null,
    val dismissed: Set<String> = emptySet(),
    val manualSession: String? = null,
    val mapSession: String? = null,
    /** Navigation session whose arrival callback is watched; manual arrival becomes secondary (V-05). */
    val arrivalSession: String? = null,
    /** Navigation session whose route ended up at another destination. */
    val mismatchSession: String? = null,
    val completed: LivePickup? = null,
) {
    val parked: Boolean get() = mode.allowsParkedControls
    val canAct: Boolean get() = connection == VehicleConnection.ONLINE && contactFresh && !pending

    /** The selected driver, if the family still lists them. */
    val driver: LiveDriver? get() = feed?.let { feed -> feed.vehicle.driver?.takeIf { driver -> feed.drivers.any { it.id == driver.id } } }
    val driverReady: Boolean get() = driver != null
    val canPickupAct: Boolean get() = canAct && driverReady
    val visibleCard: FeedCard? get() = feed?.cards?.firstOrNull { it.key !in dismissed && (parked || !it.parkedOnly) }
    val selected: LivePickup? get() = feed?.today?.firstOrNull { it.id == selectedId }
        ?: feed?.cards?.firstOrNull { it.pickup?.id == selectedId }?.pickup
    val tripActive: Boolean get() = feed?.let { feed ->
        feed.activeTrip?.pickup?.status == "en_route" || feed.today.any { it.status == "en_route" && it.belongsTo(feed) }
    } == true
}

/**
 * Pleos vehicle screen state and sync loop. All collaborators come from [LiveCarDependencies], so the
 * behaviour runs in plain JVM tests with fakes; [Factory] wires the Android implementations.
 * Sync keeps running while the activity is stopped (navigation in front) and ends only when this view model is cleared.
 */
internal class LiveCarViewModel(private val deps: LiveCarDependencies, private val scope: CoroutineScope) : ViewModel(scope) {
    private val backend = deps.backend
    private val signals = deps.signals
    private val navigation = deps.navigation
    private val timing = deps.timing
    private val values = MutableStateFlow(LiveCarState(deps.configured))
    val state = values.asStateFlow()

    private val reports = NavReportQueue(deps.vault)
    private val syncLock = Mutex()
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private val foreground = MutableStateFlow(false)
    private var polling: Job? = null
    private var contactWatch: Job? = null
    private var noticeJob: Job? = null
    private var noticeSequence = 0L
    private var lastUploaded: VehicleSnapshot? = null
    private var lastUploadAt: Instant? = null
    private var lastRangeShown: String? = null
    private var requestedRoute: Pair<Destination, Instant>? = null
    private var pendingArrival: Destination? = null
    private var pendingCommand: CardCommand? = null
    private var guidedPickup: String? = null
    private val announced = LinkedHashSet<String>()

    private val cached = scope.async {
        val feed = read(VehicleBackend.FEED_SLOT)?.let { stored ->
            runCatching {
                val value = JSONObject(stored)
                VehicleFeed.from(value.getJSONObject("feed")) to value.instant("fetched_at")
            }.getOrNull()
        }
        val ticket = read(VehicleBackend.TICKET_SLOT)?.let { stored -> runCatching { PairTicket.from(JSONObject(stored)) }.getOrNull() }
        // Cards already fetched before a restart were already announced.
        feed?.first?.cards?.forEach { remember(it.alertKey) }
        values.update { it.copy(vehicle = feed?.first?.vehicle, feed = feed?.first, lastFeedAt = feed?.second, ticket = ticket) }
    }

    init {
        scope.launch {
            signals.snapshots.collect { next ->
                val old = values.value.snapshot
                values.update { it.copy(snapshot = next) }
                if (old != null && next.ignition != old.ignition && next.ignition in setOf(Ignition.ACC, Ignition.OFF)) {
                    lastRangeShown = null
                    showRangeAlert()
                }
                if (old == null || old.ignition != next.ignition || old.gear != next.gear || old.rangeKm != next.rangeKm) {
                    if (isUploadDue(next)) wake.trySend(Unit)
                }
            }
        }
        scope.launch {
            signals.mode.collect { mode ->
                val old = values.value.mode
                // Driving closes every parked-only panel (V-00).
                values.update { it.copy(mode = mode, panel = if (mode.allowsParkedControls) it.panel else LivePanel.HOME) }
                if (mode != old) {
                    if (mode.allowsParkedControls) {
                        lastRangeShown = null
                        showRangeAlert()
                    }
                    wake.trySend(Unit)
                }
            }
        }
        scope.launch {
            signals.setupAllowed.collect { allowed -> values.update { it.copy(permissionSetupAllowed = allowed) } }
        }
        scope.launch {
            navigation.arrivals.collect(::onArrival)
        }
        scope.launch {
            deps.commands.collect(::handleCardCommand)
        }
        scope.launch {
            combine(values, foreground) { state, inFront -> state to inFront }.collect { (state, inFront) -> announceCards(state, inFront) }
        }
        scope.launch {
            combine(values.map { it.tripActive }.distinctUntilChanged(), foreground) { active, inFront -> active to inFront }
                .collect { (active, inFront) -> deps.tripKeeper.update(active, inFront) }
        }
        scope.launch {
            values.map { state -> state.feed?.activeTrip?.pickup?.takeIf { it.status == "en_route" }?.id }.distinctUntilChanged()
                .collect { pickupId ->
                    guidedPickup?.takeIf { it != pickupId }?.let(navigation::tripClosed)
                    guidedPickup = pickupId
                }
        }
    }

    /** Foreground only changes the poll interval and how alerts are raised; sync never stops while this view model lives. */
    fun setForeground(active: Boolean) {
        foreground.value = active
        if (active) {
            lastRangeShown = null
            showRangeAlert()
        }
        startSync()
        if (active) wake.trySend(Unit)
    }

    private fun startSync() {
        val api = backend ?: return
        if (polling?.isActive == true) return
        polling = scope.launch {
            cached.await()
            var failures = 0
            while (isActive) {
                val success = try {
                    syncLock.withLock { synchronize(api) }
                    true
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Exception) {
                    handleSyncFailure(failure.asBackendFailure())
                    false
                }
                failures = if (success) 0 else (failures + 1).coerceAtMost(5)
                withTimeoutOrNull(nextWait(failures)) { wake.receive() }
            }
        }
    }

    private fun nextWait(failures: Int): Long {
        if (failures > 0) return minOf(timing.failureMaxMs, timing.failureBaseMs shl (failures - 1))
        val current = values.value
        return when {
            current.vehicle == null -> if (foreground.value) timing.pairingPollMs else timing.foregroundPollMs
            foreground.value -> timing.foregroundPollMs
            current.tripActive -> timing.tripPollMs
            else -> timing.backgroundPollMs
        }
    }

    fun pairUrl(ticket: PairTicket): String? = deps.pairUrl(ticket.code)

    fun refresh() {
        signals.permissionsChanged()
        wake.trySend(Unit)
    }

    fun renewTicket() = action(parkedOnly = true, requireOnline = false) { api ->
        if (values.value.vehicle == null) newTicket(api)
    }

    fun open(panel: LivePanel, pickupId: String? = null, offerId: String? = null) {
        if (panel != LivePanel.HOME && (!parkedNow() || values.value.vehicle == null)) return
        values.update { it.copy(panel = panel, selectedId = pickupId, selectedOfferId = offerId) }
    }

    fun setDriver(driver: LiveDriver) = action(parkedOnly = true) { api ->
        if (values.value.feed?.drivers?.none { it.id == driver.id } != false) return@action
        sendParkState(api)
        api.rpc("vehicle_set_driver", json("p_member_id" to driver.id))
        fetchFeed(api)
    }

    fun unpair() = action(parkedOnly = true) { api ->
        if (values.value.panel != LivePanel.UNPAIR) return@action
        sendParkState(api)
        api.rpc("vehicle_unpair_self")
        clearLink()
        wake.trySend(Unit)
    }

    fun runCard(card: FeedCard, name: String) {
        if (name in DISMISS_ACTIONS) {
            if (card.alertId != null) ackAlert(card.alertId) else dismiss(card)
            return
        }
        val current = values.value
        if (!current.canPickupAct) {
            if (current.canAct && !current.driverReady) showNotice(NoticeMessage.Failure(NO_DRIVER))
            return
        }
        val pickup = card.pickup
        when (name) {
            "start_now" -> if (pickup != null) requestRoute(pickup, card.offerId, card)
            "accept" -> if (pickup != null) accept(pickup, card.offerId.takeIf { card.kind in setOf("offer_to_me", "routine_open") }, card.version, card)
            "decline" -> if (pickup != null) decline(pickup, card.offerId.takeIf { card.kind == "offer_to_me" }, card.version, card)
            "handoff_all" -> if (pickup != null) decline(pickup, null, null, card)
            "boarded", "board" -> if (pickup != null) board(pickup)
            "location" -> if (pickup != null) {
                if (parkedNow()) open(LivePanel.LOCATION, pickup.id, card.offerId.takeIf { card.kind == "offer_to_me" })
                else showNotice(NoticeMessage.Failure(PARK_TO_CONFIRM))
            }
        }
    }

    /** A heads-up button or tap. Runs once the card is known; a card that is gone is ignored. */
    fun handleCardCommand(command: CardCommand) {
        val feed = values.value.feed
        val card = feed?.cards?.firstOrNull { it.alertKey == command.alertKey }
        if (card == null) {
            if (values.value.lastFeedAt == null || values.value.connection != VehicleConnection.ONLINE) pendingCommand = command
            return
        }
        pendingCommand = null
        val action = command.action ?: return
        runCard(card, action)
    }

    fun accept(pickup: LivePickup, offerId: String? = null, offerVersion: Int? = null, card: FeedCard? = null) = action(card = card) { api ->
        if (offerId == null) api.rpc("accept_pickup", json("p_pickup_id" to pickup.id))
        else api.rpc("respond_offer", offerResponse(offerId, "accept", offerVersion ?: pickup.version))
        card?.let(::dismiss)
        fetchFeed(api)
    }

    private fun decline(pickup: LivePickup, offerId: String?, offerVersion: Int?, card: FeedCard?) = action(card = card) { api ->
        if (offerId == null) {
            api.rpc("vehicle_decline", json("p_pickup_id" to pickup.id, "p_expected_version" to pickup.version))
            showNotice(NoticeMessage.HandedToFamily)
        } else {
            api.rpc("respond_offer", offerResponse(offerId, "decline", offerVersion ?: pickup.version))
            showNotice(NoticeMessage.OfferDeclined(card?.offerFrom))
        }
        card?.let(::dismiss)
        fetchFeed(api)
    }

    private fun offerResponse(id: String, response: String, version: Int) =
        json("p_offer_id" to id, "p_response" to response, "p_expected_version" to version)

    fun dismiss(card: FeedCard) {
        values.update { it.copy(dismissed = it.dismissed + card.key) }
    }

    fun ackAlert(id: String) = action(parkedOnly = true) { api ->
        api.rpc("ack_vehicle_alert", json("p_alert_id" to id))
        values.update { it.copy(panel = LivePanel.HOME) }
        fetchFeed(api)
    }

    fun requestRoute(pickup: LivePickup, offerId: String? = null, card: FeedCard? = null) {
        if (!values.value.canPickupAct) return
        if (!pickup.locationConfirmed) {
            if (parkedNow()) open(LivePanel.LOCATION, pickup.id, offerId) else showNotice(NoticeMessage.Failure(PARK_TO_CONFIRM))
            return
        }
        val otherTrip = values.value.feed?.activeTrip?.pickup?.id?.let { it != pickup.id } == true
        if (otherTrip) {
            // Switching guidance to another pickup is a parked-only decision (V-03).
            if (parkedNow()) open(LivePanel.SWITCH, pickup.id, offerId) else showNotice(NoticeMessage.Failure(PARK_TO_SWITCH))
            return
        }
        action(card = card) { api -> startRoute(api, pickup, offerId) }
    }

    fun confirmSwitch() = action(parkedOnly = true) { api ->
        val current = values.value
        val pickup = current.selected ?: return@action
        if (current.panel != LivePanel.SWITCH) return@action
        sendParkState(api)
        startRoute(api, pickup, current.selectedOfferId, allowSwitch = true)
    }

    fun confirmLocation(place: SavedPlace? = null) = action(parkedOnly = true) { api ->
        val current = values.value
        val pickup = current.selected ?: return@action
        val point = place?.location ?: pickup.location ?: return@action
        val label = place?.label ?: pickup.label ?: return@action
        if (current.panel != LivePanel.LOCATION || pickup.locationConfirmed) return@action
        sendParkState(api)
        val result = api.rpc("confirm_location", json("p_pickup_id" to pickup.id, "p_expected_version" to pickup.version,
            "p_lat" to point.lat, "p_lng" to point.lng, "p_label" to label, "p_place_id" to place?.id))
        val confirmed = LivePickup.from(result.getJSONObject("pickup"), pickup) ?: throw BackendFailure("INVALID_RESPONSE")
        fetchFeed(api)
        if (!parkedNow()) return@action
        val serverTime = values.value.feed?.serverTime ?: deps.clock()
        if (!confirmed.canStartInWindow(serverTime)) {
            open(LivePanel.HOME)
            return@action
        }
        if (values.value.feed?.activeTrip?.pickup?.id?.let { it != pickup.id } == true) {
            open(LivePanel.SWITCH, pickup.id, current.selectedOfferId)
        } else startRoute(api, confirmed, current.selectedOfferId)
    }

    /**
     * Departure first, guidance second. Once `vehicle_start_now` succeeds the trip stays en route whatever the
     * navigation does, and the navigation result is queued before it is reported.
     */
    private suspend fun startRoute(api: PickupBackend, pickup: LivePickup, offerId: String?, allowSwitch: Boolean = false) {
        val before = values.value.feed?.activeTrip
        if (before != null && before.pickup.id != pickup.id && (!allowSwitch || !parkedNow())) return
        val arguments = json("p_pickup_id" to pickup.id, "p_expected_version" to pickup.version,
            "p_action_id" to UUID.randomUUID().toString(), "p_offer_id" to offerId)
        val response = try {
            api.rpc("vehicle_start_now", arguments)
        } catch (failure: BackendFailure) {
            if (!failure.transient) throw failure
            delay(timing.retryPauseMs)
            if (allowSwitch && !parkedNow()) throw BackendFailure("PARK_REQUIRED")
            api.rpc("vehicle_start_now", arguments)
        }
        val started = StartPayload.from(response, pickup)
        val destination = started.destination
        val trip = LiveTrip(started.pickup, destination.navSessionId, destination.destinationRevision)
        requestedRoute = destination to deps.clock()
        pendingArrival = null
        values.update { old ->
            old.copy(panel = LivePanel.HOME, manualSession = null, mapSession = null, arrivalSession = null, mismatchSession = null,
                selectedOfferId = null,
                feed = old.feed?.copy(activeTrip = trip,
                    today = old.feed.today.map { if (it.id == started.pickup.id) started.pickup else it },
                    cards = old.feed.cards.filterNot { it.pickup?.id == started.pickup.id }))
        }

        val navResult = try {
            navigation.startRoute(destination)
        } catch (cancelled: CancellationException) {
            withContext(NonCancellable) { reports.enqueue(NavResult.Failed("NAVI_CANCELLED").reportArguments(destination)) }
            throw cancelled
        } catch (_: Exception) {
            NavResult.Failed("NAVI_EXCEPTION")
        }
        val navStatus = if (navResult == NavResult.Requested) "ok" else "failed"
        values.update { old ->
            val feed = old.feed ?: return@update old
            val current = feed.activeTrip?.takeIf { it.sessionId == destination.navSessionId } ?: return@update old
            old.copy(feed = feed.copy(activeTrip = current.copy(pickup = current.pickup.copy(navStatus = navStatus))),
                mapSession = destination.navSessionId.takeIf { navResult is NavResult.MapOpened },
                arrivalSession = destination.navSessionId.takeIf { navResult == NavResult.Requested && navigation.supportsArrivalCallback() },
                mismatchSession = destination.navSessionId.takeIf { (navResult as? NavResult.Failed)?.code == NAV_DESTINATION_MISMATCH })
        }
        // Persist before reporting so the result survives a connection loss or a restart.
        reports.enqueue(navResult.reportArguments(destination))
        // The departure already succeeded: a failed follow-up is a sync problem, not an action error.
        try {
            drainNavReports(api)
            fetchFeed(api)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            val backendFailure = failure.asBackendFailure()
            if (backendFailure.code in LINK_ERRORS) throw backendFailure
            handleSyncFailure(backendFailure)
        }
    }

    fun continueManually(trip: LiveTrip) {
        if (values.value.feed?.activeTrip?.sessionId == trip.sessionId) values.update { it.copy(manualSession = trip.sessionId) }
    }

    fun arrive(pickup: LivePickup) = action { api ->
        api.rpc("mark_arrived", json("p_pickup_id" to pickup.id, "p_source" to "manual", "p_expected_version" to pickup.version))
        pendingArrival = null
        fetchFeed(api)
    }

    fun board(pickup: LivePickup) = action(parkedOnly = true) { api ->
        sendParkState(api)
        api.rpc("mark_completed", json("p_pickup_id" to pickup.id, "p_expected_version" to pickup.version))
        values.update { it.copy(completed = pickup, panel = LivePanel.HOME) }
        scope.launch {
            delay(timing.completedMs)
            values.update { if (it.completed?.id == pickup.id) it.copy(completed = null) else it }
        }
        fetchFeed(api)
    }

    /** Arrival callbacks count only for the current trip, session and destination revision (V-05). */
    private fun onArrival(event: ArrivalEvent) {
        val (destination, requestedAt) = requestedRoute ?: return
        val state = values.value
        val trip = state.feed?.activeTrip ?: return
        if (state.arrivalSession != destination.navSessionId || trip.pickup.status != "en_route") return
        if (trip.pickup.id != destination.pickupId || trip.sessionId != destination.navSessionId ||
            trip.destinationRevision != destination.destinationRevision || !destination.matchesArrival(event, requestedAt)
        ) return
        pendingArrival = destination
        startSync()
        wake.trySend(Unit)
    }

    private suspend fun submitPendingArrival(api: PickupBackend) {
        val destination = pendingArrival ?: return
        val trip = values.value.feed?.activeTrip
        if (trip == null || trip.sessionId != destination.navSessionId || trip.destinationRevision != destination.destinationRevision) {
            pendingArrival = null
            return
        }
        try {
            api.rpc("mark_arrived", json("p_pickup_id" to destination.pickupId, "p_source" to "nav_callback",
                "p_nav_session_id" to destination.navSessionId, "p_destination_revision" to destination.destinationRevision))
        } catch (failure: BackendFailure) {
            // Kept for the next sync when the server was unreachable; a rejection (older session, already arrived) is final.
            if (failure.network || failure.transient || failure.code in LINK_ERRORS) throw failure
        }
        pendingArrival = null
    }

    private suspend fun synchronize(api: PickupBackend) {
        val current = values.value
        if (current.vehicle == null) {
            val status = try {
                api.rpc("vehicle_pair_status")
            } catch (failure: BackendFailure) {
                if (failure.code != "VEHICLE_REVOKED" || !parkedNow()) throw failure
                newTicket(api)
                return
            }
            markContact()
            val linked = status.optJSONObject("vehicle")?.takeIf { status.optBoolean("paired") }?.let(LiveVehicle::from)
            if (linked == null) {
                if (current.ticket == null && parkedNow()) newTicket(api)
                values.update { it.copy(syncIssue = null) }
                return
            }
            values.update { it.copy(vehicle = linked, ticket = null, linkError = null) }
            write(VehicleBackend.TICKET_SLOT, null)
        }
        val snapshot = values.value.snapshot?.forUpload()
        if (snapshot != null && isUploadDue(snapshot)) {
            try {
                upload(api, snapshot)
            } catch (failure: BackendFailure) {
                // A rejected upload keeps the value for the next cycle (F-06); the feed still refreshes.
                if (failure.code in LINK_ERRORS || failure.network) throw failure
            }
        }
        drainNavReports(api)
        submitPendingArrival(api)
        fetchFeed(api)
    }

    private suspend fun newTicket(api: PickupBackend) {
        if (!parkedNow()) throw BackendFailure("PARK_REQUIRED")
        val ticket = PairTicket.from(api.rpc("vehicle_pair_start"))
        write(VehicleBackend.TICKET_SLOT, ticket.encode().toString())
        values.update { it.copy(ticket = ticket, linkError = null) }
        markContact()
    }

    private suspend fun fetchFeed(api: PickupBackend) {
        val raw = api.rpc("vehicle_get_feed")
        markContact()
        val feed = try {
            VehicleFeed.from(raw)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            throw BackendFailure("INVALID_RESPONSE", status = 200)
        }
        val now = deps.clock()
        write(VehicleBackend.FEED_SLOT, json("feed" to raw, "fetched_at" to now.toString()).toString())
        values.update { old ->
            old.copy(vehicle = feed.vehicle, feed = feed, connection = VehicleConnection.ONLINE, syncIssue = null, lastFeedAt = now,
                dismissed = old.dismissed.intersect(feed.cards.map(FeedCard::key).toSet()), linkError = null)
        }
        showRangeAlert()
        pendingCommand?.let { command ->
            pendingCommand = null
            handleCardCommand(command)
            pendingCommand = null
        }
    }

    private fun showRangeAlert() {
        val current = values.value
        val alert = current.feed?.alerts?.firstOrNull() ?: return
        if (!current.parked || current.panel != LivePanel.HOME || current.feed.activeTrip != null ||
            current.visibleCard?.kind?.let { it != "low_range" } == true || lastRangeShown == alert.id
        ) return
        lastRangeShown = alert.id
        values.update { it.copy(panel = LivePanel.RANGE) }
    }

    private fun isUploadDue(snapshot: VehicleSnapshot): Boolean {
        if (values.value.vehicle == null || snapshot.observedAt.isEmpty()) return false
        val now = deps.clock()
        val previous = lastUploaded ?: return true
        if (snapshot.gear != previous.gear || snapshot.ignition != previous.ignition) return true
        if ((snapshot.rangeKm == null) != (previous.rangeKm == null)) return true
        if (snapshot.rangeKm != null && previous.rangeKm != null && abs(snapshot.rangeKm - previous.rangeKm) >= 5) return true
        if (snapshot.gear == Gear.PARK && previous.collectedAt.isBefore(now.minusSeconds(20))) return true
        return snapshot.ignition == Ignition.ON && lastUploadAt?.isBefore(now.minusSeconds(300)) == true
    }

    private fun VehicleSnapshot.forUpload() = if (gear == Gear.PARK && !parkedNow()) copy(gear = Gear.UNKNOWN) else this

    /** Parked-only RPCs re-read gear and speed right before sending, and the server checks the upload again. */
    private suspend fun sendParkState(api: PickupBackend) {
        if (!parkedNow()) throw BackendFailure("PARK_REQUIRED")
        val fresh = signals.current()
        val gearAt = fresh.observedAt[VehicleCapability.GEAR]
        if (fresh.gear != Gear.PARK || fresh.speedKmh?.let { abs(it) < 1 } != true ||
            gearAt == null || gearAt.isBefore(deps.clock().minusSeconds(8)) || !parkedNow()
        ) throw BackendFailure("PARK_REQUIRED")
        upload(api, fresh)
        if (!parkedNow()) throw BackendFailure("PARK_REQUIRED")
    }

    private suspend fun upload(api: PickupBackend, snapshot: VehicleSnapshot) {
        api.rpc("upsert_vehicle_state", snapshot.uploadArguments())
        lastUploaded = snapshot
        lastUploadAt = deps.clock()
    }

    /** Sends queued navigation results oldest first. Unreachable server: keep and retry. Rejected: drop that one. */
    private suspend fun drainNavReports(api: PickupBackend) {
        while (true) {
            val next = reports.peek() ?: return
            try {
                api.rpc("report_nav_result", next.payload)
            } catch (failure: BackendFailure) {
                if (failure.network || failure.transient || failure.code in LINK_ERRORS) throw failure
            }
            reports.remove(next.id)
        }
    }

    internal suspend fun queuedNavReports(): List<QueuedNavReport> = reports.snapshot()

    private fun markContact() {
        values.update { it.copy(connection = VehicleConnection.ONLINE, lastContact = deps.clock(), contactFresh = true) }
        contactWatch?.cancel()
        contactWatch = scope.launch {
            delay(timing.contactFreshMs)
            values.update { it.copy(contactFresh = false) }
        }
    }

    private fun markOffline() {
        contactWatch?.cancel()
        values.update { it.copy(connection = VehicleConnection.OFFLINE, contactFresh = false) }
    }

    private suspend fun handleSyncFailure(failure: BackendFailure) {
        when {
            failure.code in LINK_ERRORS -> {
                clearLink()
                values.update { it.copy(linkError = failure.code) }
            }
            failure.network -> markOffline()
            failure.code == "PARK_REQUIRED" -> Unit
            else -> {
                // The server answered; only the content was unusable. Stay online and say so.
                markContact()
                values.update { it.copy(syncIssue = if (failure.transient) SyncIssue.SERVER else SyncIssue.RESPONSE) }
            }
        }
    }

    private fun action(
        parkedOnly: Boolean = false,
        requireOnline: Boolean = true,
        card: FeedCard? = null,
        block: suspend (PickupBackend) -> Unit,
    ) {
        val api = backend ?: return
        val current = values.value
        if (current.pending) return
        if (requireOnline && !current.canAct) {
            showNotice(NoticeMessage.Failure(if (current.connection == VehicleConnection.OFFLINE) "NETWORK" else "CHECKING"))
            return
        }
        if (parkedOnly && !parkedNow()) {
            showNotice(NoticeMessage.Failure("PARK_REQUIRED"))
            return
        }
        values.update { it.copy(pending = true, notice = null) }
        scope.launch {
            try {
                syncLock.withLock {
                    val now = values.value
                    if (requireOnline && (now.connection != VehicleConnection.ONLINE || !now.contactFresh)) throw BackendFailure("NETWORK")
                    if (parkedOnly && !parkedNow()) throw BackendFailure("PARK_REQUIRED")
                    block(api)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                handleActionFailure(failure.asBackendFailure(), card)
            } finally {
                values.update { it.copy(pending = false) }
            }
        }
    }

    private suspend fun handleActionFailure(failure: BackendFailure, card: FeedCard?) {
        when {
            failure.code in LINK_ERRORS -> {
                clearLink()
                values.update { it.copy(linkError = failure.code) }
            }
            failure.network -> markOffline()
        }
        showNotice(NoticeMessage.Failure(failure.code, failure.detail?.string("by")))
        if (failure.code == "ALREADY_TAKEN" && card != null) {
            // V-03: the message stays three seconds, then the card closes.
            scope.launch {
                delay(timing.noticeMs)
                dismiss(card)
            }
        }
        if (!failure.network) wake.trySend(Unit)
    }

    private fun showNotice(message: NoticeMessage) {
        val id = ++noticeSequence
        values.update { it.copy(notice = LiveNotice(id, message)) }
        noticeJob?.cancel()
        noticeJob = scope.launch {
            delay(timing.noticeMs)
            values.update { if (it.notice?.id == id) it.copy(notice = null) else it }
        }
    }

    /** Foreground: sound once for the visible card. Background: heads-up for new request, offer and cancel cards. */
    private fun announceCards(state: LiveCarState, inForeground: Boolean) {
        val feed = state.feed
        val open = feed?.cards.orEmpty().filter { it.key !in state.dismissed }
        deps.alerts.retain(open.map(FeedCard::alertKey).toSet())
        if (feed == null || state.connection != VehicleConnection.ONLINE || state.lastFeedAt == null) return
        val activePickup = feed.activeTrip?.pickup?.id
        if (inForeground) {
            if (state.panel != LivePanel.HOME) return
            val card = state.visibleCard ?: return
            if (remember(card.alertKey)) deps.alerts.announce(card, true, card.actions(state.parked, activePickup))
        } else {
            for (card in open) {
                if (card.kind !in HEADS_UP_CARD_KINDS || (!state.parked && card.parkedOnly)) continue
                if (remember(card.alertKey)) deps.alerts.announce(card, false, card.actions(state.parked, activePickup))
            }
        }
    }

    private fun remember(alertKey: String): Boolean {
        if (!announced.add(alertKey)) return false
        while (announced.size > MAX_ANNOUNCED) announced.remove(announced.first())
        return true
    }

    private suspend fun clearLink() {
        lastUploaded = null
        lastUploadAt = null
        lastRangeShown = null
        requestedRoute = null
        pendingArrival = null
        pendingCommand = null
        reports.clear()
        for (slot in listOf(VehicleBackend.FEED_SLOT, VehicleBackend.TICKET_SLOT)) write(slot, null)
        values.update {
            it.copy(vehicle = null, feed = null, ticket = null, panel = LivePanel.HOME, selectedId = null, selectedOfferId = null,
                dismissed = emptySet(), manualSession = null, mapSession = null, arrivalSession = null, mismatchSession = null,
                completed = null, lastFeedAt = null, syncIssue = null)
        }
    }

    private fun parkedNow(): Boolean = signals.mode.value.allowsParkedControls

    private suspend fun read(slot: String): String? = withContext(Dispatchers.IO) { runCatching { deps.vault?.read(slot) }.getOrNull() }

    private suspend fun write(slot: String, data: String?) {
        withContext(Dispatchers.IO) { deps.vault?.write(slot, data) }
    }

    override fun onCleared() {
        deps.tripKeeper.update(tripActive = false, foreground = false)
        runCatching { signals.close() }
        runCatching { navigation.close() }
    }

    private fun Exception.asBackendFailure(): BackendFailure = this as? BackendFailure ?: BackendFailure("INVALID_RESPONSE")

    companion object {
        const val PARK_TO_CONFIRM = "PARK_TO_CONFIRM"
        const val PARK_TO_SWITCH = "PARK_TO_SWITCH"
        const val NO_DRIVER = "NO_DRIVER"
        private val DISMISS_ACTIONS = setOf("ack", "acknowledge", "dismiss")
        private const val MAX_ANNOUNCED = 200
        val LINK_ERRORS = setOf("SESSION_EXPIRED", "NOT_VEHICLE", "VEHICLE_REVOKED", "NOT_AUTHENTICATED")

        val Factory: ViewModelProvider.Factory = viewModelFactory {
            initializer {
                val app = checkNotNull(this[ViewModelProvider.AndroidViewModelFactory.APPLICATION_KEY])
                val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
                LiveCarViewModel(androidLiveCarDependencies(app, scope), scope)
            }
        }
    }
}
