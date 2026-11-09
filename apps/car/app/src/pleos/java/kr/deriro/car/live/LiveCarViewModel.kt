package kr.deriro.car.live

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.time.Instant
import java.util.UUID
import kotlin.math.abs
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kr.deriro.car.BuildConfig
import kr.deriro.car.data.vehicle.Gear
import kr.deriro.car.data.vehicle.Ignition
import kr.deriro.car.data.vehicle.VehicleCapability
import kr.deriro.car.data.vehicle.VehicleSnapshot
import kr.deriro.car.nav.Destination
import kr.deriro.car.nav.NavResult
import kr.deriro.car.nav.matchesArrival
import kr.deriro.car.platform.PleosNavigationGateway
import kr.deriro.car.platform.PleosVehicleSignals
import kr.deriro.car.ux.DrivingMode
import org.json.JSONObject

internal enum class LivePanel { HOME, TODAY, PICKUP, SETTINGS, LOCATION, SWITCH, RANGE, UNPAIR, ABOUT }
internal enum class VehicleConnection { CHECKING, ONLINE, OFFLINE }

internal data class LiveCarState(
    val configured: Boolean,
    val mode: DrivingMode = DrivingMode.UNKNOWN,
    val permissionSetupAllowed: Boolean = false,
    val connection: VehicleConnection = VehicleConnection.CHECKING,
    val lastContact: Instant? = null,
    val vehicle: LiveVehicle? = null,
    val snapshot: VehicleSnapshot? = null,
    val feed: VehicleFeed? = null,
    val ticket: PairTicket? = null,
    val panel: LivePanel = LivePanel.HOME,
    val selectedId: String? = null,
    val selectedOfferId: String? = null,
    val pending: Boolean = false,
    val error: String? = null,
    val errorDetail: String? = null,
    val dismissed: Set<String> = emptySet(),
    val manualSession: String? = null,
    val mapSession: String? = null,
    val completed: LivePickup? = null,
) {
    val parked: Boolean get() = mode.allowsParkedControls
    val canAct: Boolean get() = connection == VehicleConnection.ONLINE && !pending &&
        lastContact?.isAfter(Instant.now().minusSeconds(30)) == true
    val canPickupAct: Boolean get() = canAct && feed?.let { feed -> feed.drivers.any { it.id == feed.vehicle.driver?.id } } == true
    val visibleCard: FeedCard? get() = feed?.cards?.firstOrNull { it.key !in dismissed && (parked || !it.parkedOnly) }
    val selected: LivePickup? get() = feed?.today?.firstOrNull { it.id == selectedId }
        ?: feed?.cards?.firstOrNull { it.pickup?.id == selectedId }?.pickup
}

internal class LiveCarViewModel(app: Application) : AndroidViewModel(app) {
    private val config = BackendConfig.create(BuildConfig.SUPABASE_URL, BuildConfig.SUPABASE_KEY, BuildConfig.WEB_URL, BuildConfig.DEBUG)
    private val vault = config?.let { AndroidVehicleVault(app, it.origin.toString().trimEnd('/')) }
    private val backend = config?.let { VehicleBackend(it, checkNotNull(vault)) }
    private val signals = PleosVehicleSignals(app, viewModelScope)
    private val navigation = PleosNavigationGateway(app)
    private val values = MutableStateFlow(LiveCarState(config != null))
    val state = values.asStateFlow()

    private val syncLock = Mutex()
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private var polling: Job? = null
    private var lastUploaded: VehicleSnapshot? = null
    private var lastUploadAt: Instant? = null
    private var lastRangeShown: String? = null
    private var requestedRoute: Pair<Destination, Instant>? = null

    private val cached = viewModelScope.async {
        val feed = read(VehicleBackend.FEED_SLOT)?.let { stored ->
            runCatching {
                val value = JSONObject(stored)
                VehicleFeed.from(value.getJSONObject("feed")) to value.instant("fetched_at")
            }.getOrNull()
        }
        val ticket = read(VehicleBackend.TICKET_SLOT)?.let { stored -> runCatching { PairTicket.from(JSONObject(stored)) }.getOrNull() }
        values.update { it.copy(vehicle = feed?.first?.vehicle, feed = feed?.first, lastContact = feed?.second, ticket = ticket) }
    }

    init {
        viewModelScope.launch {
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
        viewModelScope.launch {
            signals.mode.collect { mode ->
                val old = values.value.mode
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
        viewModelScope.launch {
            signals.setupAllowed.collect { allowed -> values.update { it.copy(permissionSetupAllowed = allowed) } }
        }
        viewModelScope.launch {
            navigation.arrivals.collect { event ->
                val (destination, at) = requestedRoute ?: return@collect
                val trip = values.value.feed?.activeTrip ?: return@collect
                if (trip.pickup.id != destination.pickupId || trip.sessionId != destination.navSessionId ||
                    trip.destinationRevision != destination.destinationRevision || !destination.matchesArrival(event, at)
                ) return@collect
                action { api ->
                    val current = values.value.feed?.activeTrip
                    if (current?.sessionId != trip.sessionId || current.destinationRevision != trip.destinationRevision) return@action
                    api.rpc("mark_arrived", json("p_pickup_id" to destination.pickupId, "p_source" to "nav_callback",
                        "p_nav_session_id" to destination.navSessionId, "p_destination_revision" to destination.destinationRevision))
                    fetchFeed(api)
                }
            }
        }
    }

    fun setForeground(active: Boolean) {
        if (!active) {
            polling?.cancel()
            polling = null
            return
        }
        val api = backend ?: return
        if (polling?.isActive == true) return
        lastRangeShown = null
        polling = viewModelScope.launch {
            cached.await()
            var failures = 0
            while (isActive) {
                val success = try {
                    syncLock.withLock { synchronize(api) }
                    true
                } catch (failure: BackendFailure) {
                    handleFailure(failure, fromPoll = true)
                    false
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    handleFailure(BackendFailure("INVALID_RESPONSE"), fromPoll = true)
                    false
                }
                failures = if (success) 0 else (failures + 1).coerceAtMost(5)
                val wait = if (failures > 0) minOf(30_000L, 2_000L shl (failures - 1))
                    else if (values.value.vehicle == null) 3_000L else 10_000L
                if (failures > 0) delay(wait) else withTimeoutOrNull(wait) { wake.receive() }
            }
        }
    }

    fun pairUrl(ticket: PairTicket): String? = config?.pairUrl(ticket.code)

    fun refresh() { wake.trySend(Unit) }

    fun renewTicket() = action(parkedOnly = true, requireOnline = false) { api ->
        if (values.value.vehicle == null) newTicket(api)
    }

    fun open(panel: LivePanel, pickupId: String? = null, offerId: String? = null) {
        if (panel != LivePanel.HOME && (!signals.mode.value.allowsParkedControls || values.value.vehicle == null)) return
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
        if (!values.value.canPickupAct) return
        val pickup = card.pickup
        when (name) {
            "start_now" -> if (pickup != null) requestRoute(pickup, card.offerId)
            "accept" -> if (pickup != null) accept(pickup, card.offerId.takeIf { card.kind in setOf("offer_to_me", "routine_open") }, card.version)
            "decline" -> if (pickup != null) decline(pickup, card.offerId.takeIf { card.kind == "offer_to_me" }, card.version)
            "handoff_all" -> if (pickup != null) decline(pickup, null, null)
            "boarded", "board" -> if (pickup != null) board(pickup)
            "ack", "acknowledge", "dismiss" -> if (card.alertId != null) ackAlert(card.alertId) else dismiss(card)
        }
    }

    fun accept(pickup: LivePickup, offerId: String? = null, offerVersion: Int? = null) = action { api ->
        if (offerId == null) api.rpc("accept_pickup", json("p_pickup_id" to pickup.id))
        else api.rpc("respond_offer", offerResponse(offerId, "accept", offerVersion ?: pickup.version))
        fetchFeed(api)
    }

    private fun decline(pickup: LivePickup, offerId: String?, offerVersion: Int?) = action { api ->
        if (offerId == null) api.rpc("vehicle_decline", json("p_pickup_id" to pickup.id, "p_expected_version" to pickup.version))
        else api.rpc("respond_offer", offerResponse(offerId, "decline", offerVersion ?: pickup.version))
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

    fun requestRoute(pickup: LivePickup, offerId: String? = null) {
        if (!values.value.canPickupAct) return
        if (!pickup.locationConfirmed) {
            open(LivePanel.LOCATION, pickup.id, offerId)
            return
        }
        val otherTrip = values.value.feed?.activeTrip?.pickup?.id?.let { it != pickup.id } == true
        if (otherTrip) {
            if (signals.mode.value.allowsParkedControls) {
                open(LivePanel.SWITCH, pickup.id, offerId)
            }
            return
        }
        action { api -> startRoute(api, pickup, offerId) }
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
        if (!signals.mode.value.allowsParkedControls) return@action
        val serverTime = values.value.feed?.serverTime ?: Instant.now()
        if (!confirmed.canStartInWindow(serverTime)) {
            open(LivePanel.HOME)
            return@action
        }
        if (values.value.feed?.activeTrip?.pickup?.id?.let { it != pickup.id } == true) {
            open(LivePanel.SWITCH, pickup.id, current.selectedOfferId)
        } else startRoute(api, confirmed, current.selectedOfferId)
    }

    private suspend fun startRoute(api: VehicleBackend, pickup: LivePickup, offerId: String?, allowSwitch: Boolean = false) {
        val before = values.value.feed?.activeTrip
        if (before != null && before.pickup.id != pickup.id && (!allowSwitch || !signals.mode.value.allowsParkedControls)) return
        val arguments = json("p_pickup_id" to pickup.id, "p_expected_version" to pickup.version,
            "p_action_id" to UUID.randomUUID().toString(), "p_offer_id" to offerId)
        val response = try {
            api.rpc("vehicle_start_now", arguments)
        } catch (failure: BackendFailure) {
            if (!failure.transient) throw failure
            delay(300)
            if (allowSwitch && !signals.mode.value.allowsParkedControls) throw BackendFailure("PARK_REQUIRED")
            api.rpc("vehicle_start_now", arguments)
        }
        val started = StartPayload.from(response, pickup)
        val destination = started.destination
        val trip = LiveTrip(started.pickup, destination.navSessionId, destination.destinationRevision)
        requestedRoute = destination to Instant.now()
        values.update { old ->
            old.copy(panel = LivePanel.HOME, manualSession = null, mapSession = null, selectedOfferId = null,
                feed = old.feed?.copy(activeTrip = trip,
                    today = old.feed.today.map { if (it.id == started.pickup.id) started.pickup else it },
                    cards = old.feed.cards.filterNot { it.pickup?.id == started.pickup.id }))
        }
        val navResult = navigation.startRoute(destination)
        val navStatus = if (navResult == NavResult.Requested) "ok" else "failed"
        val report = navResult.reportArguments(destination)
        values.update { old ->
            val feed = old.feed ?: return@update old
            val current = feed.activeTrip?.takeIf { it.sessionId == destination.navSessionId } ?: return@update old
            old.copy(feed = feed.copy(activeTrip = current.copy(pickup = current.pickup.copy(navStatus = navStatus))),
                mapSession = destination.navSessionId.takeIf { navResult is NavResult.MapOpened })
        }
        // Persist before reporting so an accepted departure survives a connection loss.
        write(VehicleBackend.NAV_REPORT_SLOT, report.toString())
        drainNavReport(api)
        fetchFeed(api)
    }

    fun continueManually(trip: LiveTrip) {
        if (values.value.feed?.activeTrip?.sessionId == trip.sessionId) values.update { it.copy(manualSession = trip.sessionId) }
    }

    fun arrive(pickup: LivePickup) = action { api ->
        api.rpc("mark_arrived", json("p_pickup_id" to pickup.id, "p_source" to "manual", "p_expected_version" to pickup.version))
        fetchFeed(api)
    }

    fun board(pickup: LivePickup) = action(parkedOnly = true) { api ->
        sendParkState(api)
        api.rpc("mark_completed", json("p_pickup_id" to pickup.id, "p_expected_version" to pickup.version))
        values.update { it.copy(completed = pickup, panel = LivePanel.HOME) }
        viewModelScope.launch {
            delay(2_000)
            values.update { if (it.completed?.id == pickup.id) it.copy(completed = null) else it }
        }
        fetchFeed(api)
    }

    private suspend fun synchronize(api: VehicleBackend) {
        val current = values.value
        if (current.vehicle == null) {
            val status = try {
                api.rpc("vehicle_pair_status")
            } catch (failure: BackendFailure) {
                if (failure.code != "VEHICLE_REVOKED" || !signals.mode.value.allowsParkedControls) throw failure
                newTicket(api)
                return
            }
            val linked = status.optJSONObject("vehicle")?.takeIf { status.optBoolean("paired") }?.let(LiveVehicle::from)
            if (linked == null) {
                if (current.ticket == null && signals.mode.value.allowsParkedControls) newTicket(api)
                online()
                return
            }
            values.update { it.copy(vehicle = linked, ticket = null) }
            write(VehicleBackend.TICKET_SLOT, null)
        }
        val snapshot = values.value.snapshot?.forUpload()
        if (snapshot != null && isUploadDue(snapshot)) {
            try { upload(api, snapshot) } catch (failure: BackendFailure) {
                if (failure.code in LINK_ERRORS || failure.transient) throw failure
            }
        }
        drainNavReport(api)
        fetchFeed(api)
    }

    private suspend fun newTicket(api: VehicleBackend) {
        if (!signals.mode.value.allowsParkedControls) throw BackendFailure("PARK_REQUIRED")
        val ticket = PairTicket.from(api.rpc("vehicle_pair_start"))
        write(VehicleBackend.TICKET_SLOT, ticket.encode().toString())
        values.update { it.copy(ticket = ticket, error = null, errorDetail = null) }
        online()
    }

    private suspend fun fetchFeed(api: VehicleBackend) {
        val raw = api.rpc("vehicle_get_feed")
        val feed = VehicleFeed.from(raw)
        val now = Instant.now()
        write(VehicleBackend.FEED_SLOT, json("feed" to raw, "fetched_at" to now.toString()).toString())
        values.update { old -> old.copy(vehicle = feed.vehicle, feed = feed, connection = VehicleConnection.ONLINE,
            lastContact = now, dismissed = old.dismissed.intersect(feed.cards.map(FeedCard::key).toSet()),
            error = old.error?.takeUnless { it in LINK_ERRORS }, errorDetail = old.errorDetail.takeUnless { old.error in LINK_ERRORS }) }
        showRangeAlert()
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
        val previous = lastUploaded ?: return true
        if (snapshot.gear != previous.gear || snapshot.ignition != previous.ignition) return true
        if ((snapshot.rangeKm == null) != (previous.rangeKm == null)) return true
        if (snapshot.rangeKm != null && previous.rangeKm != null && abs(snapshot.rangeKm - previous.rangeKm) >= 5) return true
        if (snapshot.gear == Gear.PARK && previous.collectedAt.isBefore(Instant.now().minusSeconds(20))) return true
        return snapshot.ignition == Ignition.ON && lastUploadAt?.isBefore(Instant.now().minusSeconds(300)) == true
    }

    private fun VehicleSnapshot.forUpload() = if (gear == Gear.PARK && !signals.mode.value.allowsParkedControls) {
        copy(gear = Gear.UNKNOWN)
    } else this

    private suspend fun sendParkState(api: VehicleBackend) {
        if (!signals.mode.value.allowsParkedControls) throw BackendFailure("PARK_REQUIRED")
        val fresh = signals.current()
        val gearAt = fresh.observedAt[VehicleCapability.GEAR]
        if (fresh.gear != Gear.PARK || fresh.speedKmh?.let { abs(it) < 1 } != true ||
            gearAt == null || gearAt.isBefore(Instant.now().minusSeconds(8)) ||
            !signals.mode.value.allowsParkedControls
        ) throw BackendFailure("PARK_REQUIRED")
        upload(api, fresh)
        if (!signals.mode.value.allowsParkedControls) throw BackendFailure("PARK_REQUIRED")
    }

    private suspend fun upload(api: VehicleBackend, snapshot: VehicleSnapshot) {
        api.rpc("upsert_vehicle_state", snapshot.uploadArguments())
        lastUploaded = snapshot
        lastUploadAt = Instant.now()
    }

    private suspend fun drainNavReport(api: VehicleBackend) {
        val report = read(VehicleBackend.NAV_REPORT_SLOT)?.let { JSONObject(it) } ?: return
        try {
            api.rpc("report_nav_result", report)
        } catch (failure: BackendFailure) {
            if (failure.transient || failure.code in LINK_ERRORS) throw failure
        }
        write(VehicleBackend.NAV_REPORT_SLOT, null)
    }

    private fun online() {
        values.update { it.copy(connection = VehicleConnection.ONLINE, lastContact = Instant.now()) }
    }

    private fun action(parkedOnly: Boolean = false, requireOnline: Boolean = true, block: suspend (VehicleBackend) -> Unit) {
        val api = backend ?: return
        if (values.value.pending || (requireOnline && !values.value.canAct) ||
            (parkedOnly && !signals.mode.value.allowsParkedControls)
        ) return
        values.update { it.copy(pending = true, error = null, errorDetail = null) }
        viewModelScope.launch {
            try {
                syncLock.withLock {
                    val current = values.value
                    if (requireOnline && (current.connection != VehicleConnection.ONLINE ||
                            current.lastContact?.isAfter(Instant.now().minusSeconds(30)) != true)
                    ) throw BackendFailure("NETWORK")
                    if (parkedOnly && !signals.mode.value.allowsParkedControls) throw BackendFailure("PARK_REQUIRED")
                    block(api)
                }
            } catch (failure: BackendFailure) {
                handleFailure(failure, fromPoll = false)
                if (!failure.transient) wake.trySend(Unit)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                handleFailure(BackendFailure("INVALID_RESPONSE"), fromPoll = false)
            } finally {
                values.update { it.copy(pending = false) }
            }
        }
    }

    private suspend fun handleFailure(failure: BackendFailure, fromPoll: Boolean) {
        if (failure.code in LINK_ERRORS) clearLink()
        val lost = failure.transient || fromPoll
        values.update { it.copy(
            connection = if (lost) VehicleConnection.OFFLINE else it.connection,
            error = if (fromPoll && failure.transient) it.error else failure.code,
            errorDetail = failure.detail?.string("by"),
        ) }
    }

    private suspend fun clearLink() {
        lastUploaded = null
        lastUploadAt = null
        lastRangeShown = null
        requestedRoute = null
        for (slot in listOf(VehicleBackend.FEED_SLOT, VehicleBackend.TICKET_SLOT, VehicleBackend.NAV_REPORT_SLOT)) write(slot, null)
        values.update { it.copy(vehicle = null, feed = null, ticket = null, panel = LivePanel.HOME, selectedId = null, selectedOfferId = null,
            dismissed = emptySet(), manualSession = null, mapSession = null, completed = null, lastContact = null) }
    }

    private suspend fun read(slot: String): String? = withContext(Dispatchers.IO) { vault?.read(slot) }

    private suspend fun write(slot: String, data: String?) {
        withContext(Dispatchers.IO) { vault?.write(slot, data) }
    }

    override fun onCleared() {
        signals.close()
        navigation.close()
    }

    companion object {
        private val LINK_ERRORS = setOf("SESSION_EXPIRED", "NOT_VEHICLE", "VEHICLE_REVOKED", "NOT_AUTHENTICATED")
    }
}
