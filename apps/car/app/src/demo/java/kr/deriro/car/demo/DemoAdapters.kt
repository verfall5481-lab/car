package kr.deriro.car.demo

import java.time.Instant
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kr.deriro.car.data.vehicle.EnergyType
import kr.deriro.car.data.vehicle.Gear
import kr.deriro.car.data.vehicle.Ignition
import kr.deriro.car.data.vehicle.VehicleCapability
import kr.deriro.car.data.vehicle.VehicleSnapshot
import kr.deriro.car.data.vehicle.VehicleStateSource
import kr.deriro.car.nav.ArrivalEvent
import kr.deriro.car.nav.Destination
import kr.deriro.car.nav.NavResult
import kr.deriro.car.nav.NavigationGateway
import kr.deriro.car.ux.DrivingMode
import kr.deriro.car.ux.DrivingStateMonitor

internal class DemoVehicleStateSource : VehicleStateSource {
    private val sampleAt = Instant.now()
    private val available = setOf(
        VehicleCapability.RANGE, VehicleCapability.FUEL, VehicleCapability.IGNITION,
        VehicleCapability.GEAR, VehicleCapability.SPEED,
    )
    private val values = MutableStateFlow(
        VehicleSnapshot(
            rangeKm = 48.0, fuelPct = 32.0, socPct = null, energyType = EnergyType.FUEL,
            ignition = Ignition.ON, gear = Gear.PARK, speedKmh = 0.0, location = null,
            collectedAt = sampleAt, isDemoValue = true, observedAt = available.associateWith { sampleAt },
        ),
    )
    override val snapshots = values.asStateFlow()
    override suspend fun current(): VehicleSnapshot = values.value
    override fun capabilities(): Set<VehicleCapability> = available

    fun setRange(rangeKm: Double?) = update(setOf(VehicleCapability.RANGE)) {
        copy(rangeKm = rangeKm?.coerceIn(0.0, 600.0))
    }

    fun setIgnition(ignition: Ignition) = update(setOf(VehicleCapability.IGNITION)) { copy(ignition = ignition) }

    fun setDrivingMode(mode: DrivingMode) = update(setOf(VehicleCapability.GEAR, VehicleCapability.SPEED)) {
        when (mode) {
            DrivingMode.PARKED -> copy(gear = Gear.PARK, speedKmh = 0.0)
            DrivingMode.DRIVING -> copy(gear = Gear.DRIVE, speedKmh = 45.0)
            DrivingMode.UNKNOWN -> copy(gear = Gear.UNKNOWN, speedKmh = null)
        }
    }

    private fun update(changed: Set<VehicleCapability>, transform: VehicleSnapshot.() -> VehicleSnapshot) {
        val now = Instant.now()
        values.update { current ->
            val updated = current.transform()
            val observed = current.observedAt + changed.associateWith { now }
            val energy = if (updated.rangeKm != null) VehicleCapability.RANGE else VehicleCapability.FUEL
            updated.copy(observedAt = observed, collectedAt = observed.getValue(energy))
        }
    }
}

internal class DemoDrivingStateMonitor : DrivingStateMonitor {
    private val current = MutableStateFlow(DrivingMode.PARKED)
    override val mode = current.asStateFlow()

    fun set(mode: DrivingMode) { current.value = mode }
}

internal class DemoNavigationGateway : NavigationGateway {
    private val events = MutableSharedFlow<ArrivalEvent>(extraBufferCapacity = 1)
    override val arrivals = events.asSharedFlow()

    var failNextRoute = false

    override suspend fun startRoute(dest: Destination): NavResult {
        val shouldFail = failNextRoute
        failNextRoute = false
        delay(250)
        return if (shouldFail) NavResult.Failed("DEMO_ROUTE_FAILURE") else NavResult.Requested
    }

    override fun supportsArrivalCallback(): Boolean = true

    fun simulateArrival(destination: Destination) {
        events.tryEmit(
            ArrivalEvent(destination.navSessionId, destination.destinationRevision, destination.location, Instant.now()),
        )
    }
}
