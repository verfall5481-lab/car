package kr.deriro.car.demo

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kr.deriro.car.data.vehicle.Ignition
import kr.deriro.car.data.vehicle.VehicleSnapshot
import kr.deriro.car.domain.Guidance
import kr.deriro.car.domain.Pickup
import kr.deriro.car.domain.PickupPhase
import kr.deriro.car.nav.Destination
import kr.deriro.car.ux.DrivingMode

internal enum class Panel { HOME, LOCATION, TODAY, SETTINGS, RANGE_WARNING, UNPAIR }
internal enum class CallbackOutcome { IGNORED, APPLIED }

internal data class PairCode(val code: String, val expiresAt: Instant) {
    companion object {
        fun generate(): PairCode {
            val alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
            val code = List(6) { alphabet.random() }.joinToString("").chunked(3).joinToString("-")
            return PairCode(code, Instant.now().plusSeconds(600))
        }
    }
}

internal data class DemoCarState(
    val pairCode: PairCode = PairCode.generate(),
    val paired: Boolean = false,
    val panel: Panel = Panel.HOME,
    val mode: DrivingMode = DrivingMode.PARKED,
    val vehicle: VehicleSnapshot? = null,
    val pickup: Pickup? = null,
    val dismissedRequestId: String? = null,
    val previousDestination: Destination? = null,
    val callbackOutcome: CallbackOutcome? = null,
    val failNextRoute: Boolean = false,
)

internal class DemoCarViewModel : ViewModel() {
    private val vehicle = DemoVehicleStateSource()
    private val driving = DemoDrivingStateMonitor()
    private val navigation = DemoNavigationGateway()
    private val current = MutableStateFlow(DemoCarState())
    val state = current.asStateFlow()
    private var simulation: Job? = null

    init {
        viewModelScope.launch {
            vehicle.snapshots.collect { snapshot -> current.update { it.copy(vehicle = snapshot) } }
        }
        viewModelScope.launch {
            driving.mode.collect { mode ->
                current.update { it.copy(mode = mode, panel = if (mode.allowsParkedControls) it.panel else Panel.HOME) }
            }
        }
        viewModelScope.launch {
            navigation.arrivals.collect { event ->
                val pickup = current.value.pickup ?: return@collect
                val arrived = pickup.arrive(event)
                current.update {
                    if (arrived == pickup) it.copy(callbackOutcome = CallbackOutcome.IGNORED)
                    else it.copy(pickup = arrived, panel = Panel.HOME, callbackOutcome = CallbackOutcome.APPLIED)
                }
            }
        }
    }

    fun renewPairCode() {
        if (driving.mode.value.allowsParkedControls && !current.value.paired) {
            current.update { it.copy(pairCode = PairCode.generate()) }
        }
    }

    fun pairLocally() {
        if (!driving.mode.value.allowsParkedControls || current.value.paired ||
            !Instant.now().isBefore(current.value.pairCode.expiresAt)
        ) return
        current.update { it.copy(paired = true, pickup = DemoFixtures.scheduled()) }
    }

    fun open(panel: Panel) {
        val now = current.value
        if (!now.paired || (panel != Panel.HOME && !driving.mode.value.allowsParkedControls)) return
        if (panel == Panel.LOCATION) {
            val pickup = now.pickup ?: return
            if (pickup.id == now.dismissedRequestId || pickup.location.confirmed || pickup.phase !in unstarted) return
        }
        current.update { it.copy(panel = panel) }
    }

    fun unpair() {
        if (!driving.mode.value.allowsParkedControls || current.value.panel != Panel.UNPAIR) return
        navigation.failNextRoute = false
        current.update { DemoCarState(mode = it.mode, vehicle = it.vehicle) }
    }

    fun acceptUnconfirmed() {
        current.update {
            val pickup = it.pickup ?: return@update it
            if (pickup.id == it.dismissedRequestId || pickup.phase != PickupPhase.REQUESTED || pickup.location.confirmed) {
                return@update it
            }
            it.copy(pickup = pickup.copy(phase = PickupPhase.ASSIGNED))
        }
    }

    fun decline() {
        current.update {
            val pickup = it.pickup ?: return@update it
            if (pickup.phase != PickupPhase.REQUESTED) return@update it
            it.copy(dismissedRequestId = pickup.id)
        }
    }

    fun confirmLocation(useSavedPlace: Boolean) {
        val state = current.value
        val pickup = state.pickup ?: return
        if (!driving.mode.value.allowsParkedControls || state.panel != Panel.LOCATION || pickup.id == state.dismissedRequestId ||
            pickup.phase !in unstarted || pickup.location.confirmed
        ) return

        val location = if (useSavedPlace) DemoFixtures.academy else pickup.location
        current.update {
            it.copy(pickup = pickup.copy(location = location.copy(confirmed = true, revision = pickup.location.revision + 1)))
        }
        depart()
    }

    fun depart() {
        val state = current.value
        val pickup = state.pickup ?: return
        if (!state.paired || state.dismissedRequestId == pickup.id) return
        val id = UUID.randomUUID().toString()
        val departed = pickup.beginRoute(id, Instant.now())
        if (departed == pickup) return

        current.update {
            it.copy(
                pickup = departed, panel = Panel.HOME, previousDestination = pickup.route?.destination,
                callbackOutcome = null, failNextRoute = false,
            )
        }
        val destination = checkNotNull(departed.route).destination
        viewModelScope.launch {
            val result = navigation.startRoute(destination)
            current.update { now -> now.copy(pickup = now.pickup?.recordNavResult(id, result)) }
        }
    }

    fun continueWithoutNavigation() {
        current.update { it.copy(pickup = it.pickup?.continueWithoutNavigation()) }
    }

    fun arrive() {
        current.update { it.copy(pickup = it.pickup?.arrive()) }
    }

    fun board() {
        val pickup = current.value.pickup ?: return
        val completed = pickup.board(driving.mode.value)
        if (completed == pickup) return
        current.update { it.copy(pickup = completed) }
        viewModelScope.launch {
            delay(2_000)
            current.update { if (it.pickup == completed) it.copy(pickup = null) else it }
        }
    }

    fun simulateRequest(confirmed: Boolean) = replacePickup(DemoFixtures.request(confirmed))

    fun resetScheduled() = replacePickup(DemoFixtures.scheduled())

    fun setRange(rangeKm: Double?) {
        if (canUseDemoTools()) vehicle.setRange(rangeKm)
    }

    fun setIgnition(ignition: Ignition) {
        if (!canUseDemoTools()) return
        vehicle.setIgnition(ignition)
        if (ignition in setOf(Ignition.OFF, Ignition.ACC) && needsRangeWarning()) open(Panel.RANGE_WARNING)
    }

    fun simulateMode(mode: DrivingMode) {
        if (!canUseDemoTools() && (current.value.paired || !driving.mode.value.allowsParkedControls)) return
        simulation?.cancel()
        setMode(mode)
        simulation = viewModelScope.launch {
            delay(MODE_SIMULATION_MS)
            setMode(DrivingMode.PARKED)
            if (current.value.paired && needsRangeWarning()) open(Panel.RANGE_WARNING)
        }
    }

    fun toggleNavigationFailure() {
        if (!canUseDemoTools()) return
        navigation.failNextRoute = !navigation.failNextRoute
        current.update { it.copy(failNextRoute = navigation.failNextRoute) }
    }

    fun simulateArrival(previous: Boolean) {
        if (!canUseDemoTools() || !navigation.supportsArrivalCallback()) return
        val state = current.value
        val route = state.pickup?.route ?: return
        if (state.pickup.phase != PickupPhase.EN_ROUTE) return
        val destination = if (previous) state.previousDestination
            else route.destination.takeIf { route.guidance == Guidance.REQUESTED }
        if (destination != null) navigation.simulateArrival(destination)
    }

    private fun setMode(mode: DrivingMode) {
        driving.set(mode)
        vehicle.setDrivingMode(mode)
    }

    private fun replacePickup(pickup: Pickup) {
        if (!canUseDemoTools() || current.value.pickup?.phase in setOf(PickupPhase.EN_ROUTE, PickupPhase.ARRIVED)) return
        current.update {
            it.copy(pickup = pickup, panel = Panel.HOME, dismissedRequestId = null, previousDestination = null, callbackOutcome = null)
        }
    }

    private fun needsRangeWarning() = current.value.vehicle?.rangeKm?.let { it < REQUIRED_RANGE_KM } == true

    private fun canUseDemoTools() = driving.mode.value.allowsParkedControls && current.value.panel == Panel.SETTINGS

    companion object {
        const val MODE_SIMULATION_MS = 20_000L
        const val REQUIRED_RANGE_KM = 62
        private val unstarted = setOf(PickupPhase.REQUESTED, PickupPhase.ASSIGNED)
    }
}
