package kr.deriro.car.live

import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import kr.deriro.car.data.vehicle.EnergyType
import kr.deriro.car.data.vehicle.Gear
import kr.deriro.car.data.vehicle.Ignition
import kr.deriro.car.data.vehicle.LatLng
import kr.deriro.car.data.vehicle.VehicleCapability
import kr.deriro.car.data.vehicle.VehicleSnapshot
import kr.deriro.car.nav.ArrivalEvent
import kr.deriro.car.nav.Destination
import kr.deriro.car.nav.NavResult
import kr.deriro.car.ux.DrivingMode
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class LiveCarViewModelTest {
    private val harnesses = mutableListOf<Harness>()

    @After
    fun closeHarnesses() = harnesses.forEach(Harness::close)

    private fun harness(timing: LiveTiming = TEST_TIMING) = Harness(timing).also(harnesses::add)

    @Test
    fun drivingLockClosesParkedPanelsAndRefusesParkedOnlyActions() {
        val car = harness()
        car.start()
        car.onVm { car.model.open(LivePanel.SETTINGS) }
        car.await("settings open while parked") { car.state.panel == LivePanel.SETTINGS }

        car.signals.modeFlow.value = DrivingMode.DRIVING
        car.await("driving returns home") { car.state.panel == LivePanel.HOME && !car.state.parked }
        car.onVm { car.model.open(LivePanel.SETTINGS) }
        car.onVm { car.model.setDriver(LiveDriver("m", "아빠")) }
        car.settle()
        assertEquals(LivePanel.HOME, car.state.panel)
        assertEquals(0, car.server.count("vehicle_set_driver"))
        assertEquals(NoticeMessage.Failure("PARK_REQUIRED"), car.state.notice?.message)

        // UNKNOWN is treated as driving.
        car.signals.modeFlow.value = DrivingMode.UNKNOWN
        car.await("unknown is not parked") { car.state.mode == DrivingMode.UNKNOWN }
        car.onVm { car.model.board(car.pickup()) }
        car.settle()
        assertEquals(0, car.server.count("mark_completed"))

        // Departure itself is allowed while driving (V-03).
        car.signals.modeFlow.value = DrivingMode.DRIVING
        car.await("driving again") { car.state.mode == DrivingMode.DRIVING }
        car.onVm { car.model.requestRoute(car.pickup()) }
        car.await("departure while driving") { car.server.count("vehicle_start_now") == 1 && !car.state.pending }
    }

    @Test
    fun departureSurvivesNavigationFailureAndReportsIt() {
        val car = harness()
        car.navigator.next = { throw IllegalArgumentException("binder died") }
        car.start()
        car.onVm { car.model.requestRoute(car.pickup()) }
        car.await("route attempted") { car.navigator.started.size == 1 && !car.state.pending }
        car.await("report sent") { car.server.count("report_nav_result") == 1 }

        val trip = checkNotNull(car.state.feed?.activeTrip)
        assertEquals("s1", trip.sessionId)
        assertEquals("en_route", trip.pickup.status)
        val report = car.server.last("report_nav_result")
        assertEquals("failed", report.getString("p_result"))
        assertEquals("NAVI_EXCEPTION", report.getString("p_error_code"))
        assertEquals("s1", report.getString("p_nav_session_id"))
        assertTrue(runBlocking { car.model.queuedNavReports() }.isEmpty())
        // Nothing undid the departure, and the trip keeps the process alive.
        assertEquals(setOf("vehicle_pair_status", "upsert_vehicle_state", "vehicle_get_feed", "vehicle_start_now", "report_nav_result"),
            car.server.names())
        car.await("trip keeper started") { car.keeper.updates.any { it.first } }

        car.navigator.next = { NavResult.Failed("NAVI_TIMEOUT") }
        car.onVm { car.model.requestRoute(car.pickup()) }
        car.await("retry gets a new session") { car.state.feed?.activeTrip?.sessionId == "s2" && car.server.count("report_nav_result") == 2 }
        assertEquals("failed", car.state.feed?.activeTrip?.pickup?.navStatus)
    }

    @Test
    fun arrivalFromAnOlderSessionIsIgnored() {
        val car = harness()
        car.start()
        car.onVm { car.model.requestRoute(car.pickup()) }
        car.await("first session") { car.state.arrivalSession == "s1" && !car.state.pending }
        car.onVm { car.model.requestRoute(car.pickup()) }
        car.await("second session") { car.state.arrivalSession == "s2" && !car.state.pending }

        runBlocking { car.navigator.events.emit(ArrivalEvent("s1", 1, DEST, Instant.now())) }
        runBlocking { car.navigator.events.emit(ArrivalEvent("s2", 1, LatLng(37.52, 127.06), Instant.now())) }
        runBlocking { car.navigator.events.emit(ArrivalEvent("s2", 2, DEST, Instant.now())) }
        car.sync { car.server.count("vehicle_get_feed") >= 4 }
        car.settle()
        assertEquals(0, car.server.count("mark_arrived"))

        runBlocking { car.navigator.events.emit(ArrivalEvent("s2", 1, DEST, Instant.now())) }
        car.await("current session arrival applied") { car.server.count("mark_arrived") == 1 }
        val arrival = car.server.last("mark_arrived")
        assertEquals("nav_callback", arrival.getString("p_source"))
        assertEquals("s2", arrival.getString("p_nav_session_id"))
        assertEquals(1, arrival.getInt("p_destination_revision"))
        car.await("arrived state") { car.state.feed?.today?.single()?.status == "arrived" }
    }

    @Test
    fun navReportsQueueWithoutOverwritingAndRetryAfterServerErrors() {
        val car = harness()
        car.server.override = { name, _ -> if (name == "report_nav_result") throw BackendFailure("HTTP_503", status = 503) else null }
        car.start()
        car.onVm { car.model.requestRoute(car.pickup()) }
        car.await("first queued") { runBlocking { car.model.queuedNavReports() }.size == 1 && !car.state.pending }
        // A server error is not offline: the next action is still possible.
        assertEquals(VehicleConnection.ONLINE, car.state.connection)
        assertTrue(car.state.canAct)
        car.navigator.next = { NavResult.Failed("NAVI_TIMEOUT") }
        car.onVm { car.model.requestRoute(car.pickup()) }
        car.await("second queued") { runBlocking { car.model.queuedNavReports() }.size == 2 && !car.state.pending }
        assertEquals(listOf("s1", "s2"), runBlocking { car.model.queuedNavReports() }.map { it.payload.getString("p_nav_session_id") })
        // The queue is persisted, not only held in memory.
        assertTrue(checkNotNull(car.vault.read(NavReportQueue.SLOT)).contains("s2"))

        car.server.override = null
        car.sync { runBlocking { car.model.queuedNavReports() }.isEmpty() }
        val sent = car.server.calls.filter { it.first == "report_nav_result" }.map { it.second.getString("p_nav_session_id") }
        assertEquals(listOf("s1", "s2"), sent.takeLast(2))
        assertNull(car.vault.read(NavReportQueue.SLOT))
    }

    @Test
    fun alertSoundsOncePerCardNotPerVersion() {
        val car = harness()
        car.server.cards = listOf(card("p2", version = 1))
        car.start()
        car.await("first alert") { car.alerts.announced.size == 1 }
        assertTrue(car.alerts.announced.single().second)

        car.server.cards = listOf(card("p2", version = 2))
        car.sync { car.state.feed?.cards?.single()?.version == 2 }
        car.settle()
        assertEquals(1, car.alerts.announced.size)

        car.server.cards = listOf(card("p3", version = 1), card("p2", version = 3))
        car.sync { car.state.visibleCard?.pickup?.id == "p3" }
        car.await("new card alert") { car.alerts.announced.size == 2 }
        assertEquals("child_request/p3//", car.alerts.announced.last().first)
    }

    @Test
    fun onlyNetworkFailuresMeanOffline() {
        val car = harness()
        car.start()
        assertEquals(VehicleConnection.ONLINE, car.state.connection)

        car.server.override = { name, _ -> if (name == "vehicle_get_feed") json("unexpected" to true) else null }
        car.sync { car.state.syncIssue == SyncIssue.RESPONSE }
        assertEquals(VehicleConnection.ONLINE, car.state.connection)
        assertTrue("parse errors keep buttons enabled", car.state.canAct)
        assertTrue(car.state.canPickupAct)

        car.server.override = { name, _ -> if (name == "vehicle_get_feed") throw BackendFailure("HTTP_500", status = 500) else null }
        car.sync { car.state.syncIssue == SyncIssue.SERVER }
        assertEquals(VehicleConnection.ONLINE, car.state.connection)
        assertTrue("server errors keep buttons enabled", car.state.canAct)

        car.server.override = { _, _ -> throw BackendFailure("NETWORK") }
        car.sync { car.state.connection == VehicleConnection.OFFLINE }
        assertFalse(car.state.canAct)

        car.server.override = null
        car.sync { car.state.connection == VehicleConnection.ONLINE && car.state.syncIssue == null }
        assertTrue(car.state.canAct)
    }

    @Test
    fun backgroundKeepsSyncingAndRaisesHeadsUpForCancellation() {
        val car = harness()
        car.start()
        car.onVm { car.model.setForeground(false) }
        car.server.cards = listOf(card("p1", kind = "cancelled_urgent", primary = null, secondary = null))
        car.sync { car.state.feed?.cards?.isNotEmpty() == true }
        car.await("heads-up raised") { car.alerts.announced.isNotEmpty() }
        val (key, foreground) = car.alerts.announced.single()
        assertEquals("cancelled_urgent/p1//", key)
        assertFalse(foreground)
        assertEquals(listOf("dismiss"), car.alerts.actions.single())
    }

    @Test
    fun alreadyTakenShowsWhileDrivingThenClosesTheCard() {
        val car = harness(TEST_TIMING.copy(noticeMs = 300))
        car.server.cards = listOf(card("p2", version = 1))
        car.server.override = { name, _ ->
            if (name == "vehicle_start_now") throw BackendFailure("ALREADY_TAKEN", json("by" to "엄마")) else null
        }
        car.signals.modeFlow.value = DrivingMode.DRIVING
        car.start()
        val shown = checkNotNull(car.state.visibleCard)
        car.onVm { car.model.runCard(shown, "start_now") }
        car.await("notice while driving") { car.state.notice?.message == NoticeMessage.Failure("ALREADY_TAKEN", "엄마") }
        assertFalse(car.state.parked)
        car.await("notice clears and card closes") { car.state.notice == null && car.state.visibleCard == null }
    }

    @Test
    fun missingDriverBlocksPickupActionsWithAReason() {
        val car = harness()
        car.server.driverId = null
        car.server.cards = listOf(card("p2", version = 1))
        car.start()
        assertFalse(car.state.driverReady)
        assertTrue(car.state.canAct)
        assertFalse(car.state.canPickupAct)
        car.onVm { car.model.runCard(checkNotNull(car.state.visibleCard), "start_now") }
        car.settle()
        assertEquals(0, car.server.count("vehicle_start_now"))
        assertEquals(NoticeMessage.Failure(LiveCarViewModel.NO_DRIVER), car.state.notice?.message)
    }

    private class Harness(timing: LiveTiming) : AutoCloseable {
        private val executor = Executors.newSingleThreadExecutor()
        private val dispatcher = executor.asCoroutineDispatcher()
        private val scope = CoroutineScope(SupervisorJob() + dispatcher)
        val server = FakeServer()
        val signals = FakeSignals()
        val navigator = FakeNavigator()
        val alerts = FakeAlerts()
        val keeper = FakeKeeper()
        val vault = MemoryVault()
        val model: LiveCarViewModel = runBlocking(dispatcher) {
            val backend = object : PickupBackend {
                override suspend fun rpc(name: String, arguments: JSONObject): JSONObject = server.handle(name, arguments)
            }
            LiveCarViewModel(LiveCarDependencies(backend, vault, signals, navigator, alerts, keeper, timing = timing), scope)
        }
        val state: LiveCarState get() = model.state.value

        fun <T> onVm(block: () -> T): T = runBlocking(dispatcher) { block() }

        fun start() {
            onVm { model.setForeground(true) }
            await("first feed") { state.feed != null && state.contactFresh && !state.pending }
        }

        fun sync(condition: () -> Boolean) {
            onVm { model.refresh() }
            await("sync", condition = condition)
        }

        fun pickup(): LivePickup = checkNotNull(state.feed?.today?.single())

        /** Lets queued work finish before asserting that something did not happen. */
        fun settle() {
            Thread.sleep(150)
            onVm { }
        }

        fun await(message: String, timeoutMs: Long = 5_000, condition: () -> Boolean) {
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline) {
                if (condition()) return
                Thread.sleep(10)
            }
            fail("$message: ${server.names()} / $state")
        }

        override fun close() {
            scope.cancel()
            executor.shutdownNow()
        }
    }

    private class FakeServer {
        val calls = CopyOnWriteArrayList<Pair<String, JSONObject>>()
        @Volatile var override: ((String, JSONObject) -> JSONObject?)? = null
        @Volatile var driverId: String? = "m"
        @Volatile var cards: List<JSONObject> = emptyList()
        @Volatile private var status = "assigned"
        @Volatile private var session: String? = null
        @Volatile private var sessions = 0
        @Volatile private var navStatus: String? = null

        fun handle(name: String, arguments: JSONObject): JSONObject {
            calls += name to JSONObject(arguments.toString())
            override?.invoke(name, arguments)?.let { return it }
            return when (name) {
                "vehicle_pair_status" -> json("paired" to true, "vehicle" to vehicle())
                "vehicle_start_now" -> {
                    sessions += 1
                    session = "s$sessions"
                    status = "en_route"
                    navStatus = null
                    json("pickup" to pickup(), "nav_session_id" to session, "destination_revision" to 1,
                        "dest" to json("lat" to DEST.lat, "lng" to DEST.lng, "label" to "수학학원"))
                }
                "mark_arrived" -> {
                    status = "arrived"
                    json("result" to "applied")
                }
                "vehicle_get_feed" -> feed()
                "report_nav_result" -> {
                    if (arguments.optString("p_nav_session_id") == session) navStatus = arguments.optString("p_result")
                    JSONObject()
                }
                else -> JSONObject()
            }
        }

        fun count(name: String) = calls.count { it.first == name }
        fun names() = calls.map { it.first }.toSet()
        fun last(name: String) = calls.last { it.first == name }.second

        private fun vehicle() = json("id" to "v", "nickname" to "우리 차", "family_name" to "우리 가족",
            "current_driver" to driverId?.let { json("id" to it, "display_name" to "아빠") })

        private fun pickup() = pickupJson("p1", status, version = sessions + 1).put("nav_status", navStatus ?: JSONObject.NULL)

        private fun feed() = json(
            "vehicle" to vehicle(),
            "drivers" to JSONArray().put(json("id" to "m", "display_name" to "아빠")),
            "today" to JSONArray().put(pickup()),
            "cards" to JSONArray(cards),
            "server_time" to Instant.now().toString(),
            "active_trip" to session?.takeIf { status == "en_route" }?.let {
                json("pickup_id" to "p1", "nav_session_id" to it, "destination_revision" to 1, "pickup" to pickup())
            },
        )
    }

    private class FakeSignals : VehicleSignals {
        val modeFlow = MutableStateFlow(DrivingMode.PARKED)
        override val mode: StateFlow<DrivingMode> = modeFlow
        override val snapshots = MutableStateFlow(parkedSnapshot())
        override val setupAllowed = MutableStateFlow(false)
        override suspend fun current() = parkedSnapshot()
        override fun capabilities() = setOf(VehicleCapability.GEAR, VehicleCapability.SPEED, VehicleCapability.RANGE)
        override suspend fun freshLocation(timeoutMs: Long): LatLng? = null
        override fun permissionsChanged() = Unit
        override fun close() = Unit

        private fun parkedSnapshot(): VehicleSnapshot {
            val now = Instant.now()
            return VehicleSnapshot(48.0, 30.0, null, EnergyType.FUEL, Ignition.ON, Gear.PARK, 0.0, null, now, false,
                mapOf(VehicleCapability.GEAR to now, VehicleCapability.SPEED to now, VehicleCapability.RANGE to now))
        }
    }

    private class FakeNavigator : RouteNavigator {
        val events = MutableSharedFlow<ArrivalEvent>(extraBufferCapacity = 8)
        override val arrivals = events
        @Volatile var next: suspend (Destination) -> NavResult = { NavResult.Requested }
        val started = CopyOnWriteArrayList<Destination>()
        override suspend fun startRoute(dest: Destination): NavResult {
            started += dest
            return next(dest)
        }
        override fun supportsArrivalCallback() = true
        override fun close() = Unit
    }

    private class FakeAlerts : CardAlerts {
        val announced = CopyOnWriteArrayList<Pair<String, Boolean>>()
        val actions = CopyOnWriteArrayList<List<String>>()
        override fun announce(card: FeedCard, foreground: Boolean, actions: List<String>) {
            announced += card.alertKey to foreground
            this.actions += actions
        }
        override fun retain(alertKeys: Set<String>) = Unit
    }

    private class FakeKeeper : TripKeeper {
        val updates = CopyOnWriteArrayList<Pair<Boolean, Boolean>>()
        override fun update(tripActive: Boolean, foreground: Boolean) {
            updates += tripActive to foreground
        }
    }

    private class MemoryVault : ClientVault {
        private val values = ConcurrentHashMap<String, String>()
        override fun read(slot: String) = values[slot]
        override fun write(slot: String, value: String?) {
            if (value == null) values.remove(slot) else values[slot] = value
        }
    }

    companion object {
        private val DEST = LatLng(37.49979, 127.03561)
        private val TEST_TIMING = LiveTiming(
            pairingPollMs = 60_000, foregroundPollMs = 60_000, tripPollMs = 60_000, backgroundPollMs = 60_000,
            failureBaseMs = 60_000, failureMaxMs = 60_000, contactFreshMs = 60_000, noticeMs = 60_000,
            completedMs = 60_000, retryPauseMs = 1,
        )

        private fun pickupJson(id: String, status: String, version: Int) = json(
            "id" to id, "version" to version, "rider_name" to "민준", "dest_label" to "수학학원",
            "dest_lat" to DEST.lat, "dest_lng" to DEST.lng, "location_confirmed" to true, "status" to status,
            "assignee_member_id" to "m", "assignee_display_name" to "아빠", "vehicle_id" to "v", "destination_revision" to 1,
            "wanted_at" to "2026-11-09T08:30:00+00:00",
        )

        private fun card(
            pickupId: String,
            version: Int = 1,
            kind: String = "child_request",
            primary: String? = "start_now",
            secondary: String? = "decline",
        ) = pickupJson(pickupId, if (kind == "cancelled_urgent") "cancelled" else "open", version)
            .put("pickup_id", pickupId).put("kind", kind)
            .put("primary_action", primary ?: JSONObject.NULL).put("secondary_action", secondary ?: JSONObject.NULL)
    }
}
