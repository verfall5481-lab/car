package kr.deriro.car.platform

import ai.pleos.playground.vehicle.Vehicle
import ai.pleos.playground.vehicle.api.model.capability.AccessType
import ai.pleos.playground.vehicle.api.model.capability.CapabilityConfig
import android.annotation.SuppressLint
import android.car.Car
import android.car.VehicleGear
import android.car.VehicleIgnitionState
import android.car.VehiclePropertyIds
import android.car.drivingstate.CarUxRestrictionsManager
import android.car.hardware.CarPropertyValue
import android.car.hardware.property.CarPropertyManager
import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.math.abs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kr.deriro.car.data.vehicle.EnergyType
import kr.deriro.car.data.vehicle.Gear
import kr.deriro.car.data.vehicle.Ignition
import kr.deriro.car.data.vehicle.LatLng
import kr.deriro.car.data.vehicle.VehicleCapability
import kr.deriro.car.data.vehicle.VehicleSnapshot
import kr.deriro.car.data.vehicle.VehicleStateSource
import kr.deriro.car.ux.DrivingMode
import kr.deriro.car.ux.DrivingStateMonitor

@Suppress("DEPRECATION")
internal class PleosVehicleSignals(private val context: Context, scope: CoroutineScope) :
    VehicleStateSource, DrivingStateMonitor, AutoCloseable {
    private val values = MutableStateFlow(emptySnapshot())
    private val driving = MutableStateFlow(DrivingMode.UNKNOWN)
    private val permissionSetup = MutableStateFlow(false)
    override val snapshots = values.asStateFlow()
    override val mode = driving.asStateFlow()
    val setupAllowed = permissionSetup.asStateFlow()

    private var car: Car? = null
    @Volatile private var properties: CarPropertyManager? = null
    private var ux: CarUxRestrictionsManager? = null
    private var platformRestricted: Boolean? = null
    private var recentGear = Gear.UNKNOWN
    private var recentSpeed: Double? = null
    private var safetySequence = 0L

    private val sdk = runCatching { Vehicle(context).apply { initialize() } }.getOrNull()
    private var sdkEnergy = EnergyReading(null, null, Instant.EPOCH)

    private val safetyCallback = object : CarPropertyManager.CarPropertyEventCallback {
        override fun onChangeEvent(value: CarPropertyValue<*>) {
            val usable = value.status == CarPropertyValue.STATUS_AVAILABLE
            when (value.propertyId) {
                VehiclePropertyIds.GEAR_SELECTION -> {
                    val next = gear((value.value as? Int).takeIf { usable })
                    if (next != recentGear) safetySequence++
                    recentGear = next
                }
                VehiclePropertyIds.PERF_VEHICLE_SPEED -> {
                    val next = speed((value.value as? Float).takeIf { usable })
                    if (next != recentSpeed) safetySequence++
                    recentSpeed = next
                }
            }
            updateMode()
        }

        override fun onErrorEvent(propertyId: Int, areaId: Int) {
            safetySequence++
            if (propertyId == VehiclePropertyIds.GEAR_SELECTION) recentGear = Gear.UNKNOWN
            if (propertyId == VehiclePropertyIds.PERF_VEHICLE_SPEED) recentSpeed = null
            updateMode()
        }
    }

    init {
        if (context.packageManager.hasSystemFeature(PackageManager.FEATURE_AUTOMOTIVE)) {
            car = runCatching {
                if (Build.VERSION.SDK_INT >= 29) {
                    Car.createCar(context, Handler(Looper.getMainLooper()), Car.CAR_WAIT_TIMEOUT_DO_NOT_WAIT) { connected, ready ->
                        attach(connected.takeIf { ready })
                    }
                } else {
                    Car.createCar(context, object : ServiceConnection {
                        override fun onServiceConnected(name: ComponentName, service: IBinder) { attach(car) }
                        override fun onServiceDisconnected(name: ComponentName) { attach(null) }
                    }).also { legacy -> car = legacy; legacy.connect() }
                }
            }.getOrNull()
        }
    }

    private val carPolling = scope.launch {
        while (isActive) {
            val manager = properties
            val sequence = safetySequence
            val reading = readCurrent(manager)
            if (properties === manager) {
                if (sequence == safetySequence) {
                    recentGear = reading.gear
                    recentSpeed = reading.speedKmh
                }
                updateMode()
                values.value = reading
            }
            delay(2_000)
        }
    }

    private val sdkPolling = scope.launch {
        val vehicle = sdk ?: return@launch
        val fuel = vehicle.getFuel()
        val battery = vehicle.getEvBattery()
        while (isActive) {
            val fuelPct = readPercent(fuel::checkFuelPercentCapabilities, fuel::getFuelPercent)
            val socPct = readPercent(battery::checkEvBatteryStateOfChargeCapabilities, battery::getEvBatteryStateOfCharge)
            sdkEnergy = EnergyReading(fuelPct, socPct, Instant.now())
            delay(15_000)
        }
    }

    override suspend fun current(): VehicleSnapshot {
        val manager = properties
        val sequence = safetySequence
        val reading = readCurrent(manager)
        return if (properties === manager && safetySequence == sequence) reading else emptySnapshot()
    }

    private suspend fun readCurrent(manager: CarPropertyManager?): VehicleSnapshot {
        val fallback = sdkEnergy.takeIf { it.at.isAfter(Instant.now().minusSeconds(20)) }
        return withContext(Dispatchers.IO) { readSnapshot(manager, fallback) }
    }
    override fun capabilities(): Set<VehicleCapability> = values.value.observedAt.keys

    private fun attach(connected: Car?) {
        safetySequence++
        runCatching { properties?.unregisterCallback(safetyCallback) }
        runCatching { ux?.unregisterListener() }
        recentGear = Gear.UNKNOWN
        recentSpeed = null
        platformRestricted = null
        properties = runCatching { connected?.getCarManager(Car.PROPERTY_SERVICE) as? CarPropertyManager }.getOrNull()
        ux = runCatching { connected?.getCarManager(Car.CAR_UX_RESTRICTION_SERVICE) as? CarUxRestrictionsManager }.getOrNull()
        ux?.let { monitor ->
            platformRestricted = runCatching { monitor.currentCarUxRestrictions?.isRequiresDistractionOptimization }.getOrNull()
            runCatching {
                monitor.registerListener {
                    platformRestricted = it.isRequiresDistractionOptimization
                    updateMode()
                }
            }
        }
        properties?.let { manager ->
            for (id in listOf(VehiclePropertyIds.GEAR_SELECTION, VehiclePropertyIds.PERF_VEHICLE_SPEED)) {
                runCatching { manager.registerCallback(safetyCallback, id, CarPropertyManager.SENSOR_RATE_NORMAL) }
            }
        }
        if (connected == null) values.value = emptySnapshot()
        updateMode()
    }

    private fun updateMode() {
        driving.value = when {
            platformRestricted == true || (recentSpeed?.let { abs(it) >= 1 } == true) -> DrivingMode.DRIVING
            recentGear == Gear.PARK && recentSpeed != null -> DrivingMode.PARKED
            recentGear != Gear.UNKNOWN && recentGear != Gear.PARK -> DrivingMode.DRIVING
            else -> DrivingMode.UNKNOWN
        }
        permissionSetup.value = platformRestricted == false && driving.value != DrivingMode.DRIVING
    }

    private fun readSnapshot(manager: CarPropertyManager?, cached: EnergyReading?): VehicleSnapshot {
        val range = manager.value<Float>(VehiclePropertyIds.RANGE_REMAINING)?.toDouble()?.takeIf { it.isFinite() && it >= 0 }?.div(1_000)
        val fuel = cached?.fuel ?: percent(manager.value<Float>(VehiclePropertyIds.FUEL_LEVEL), manager.value<Float>(VehiclePropertyIds.INFO_FUEL_CAPACITY))
        val soc = cached?.soc ?: percent(manager.value<Float>(VehiclePropertyIds.EV_BATTERY_LEVEL), manager.value<Float>(VehiclePropertyIds.EV_CURRENT_BATTERY_CAPACITY))
        val ignition = when (manager.value<Int>(VehiclePropertyIds.IGNITION_STATE)) {
            VehicleIgnitionState.LOCK, VehicleIgnitionState.OFF -> Ignition.OFF
            VehicleIgnitionState.ACC -> Ignition.ACC
            VehicleIgnitionState.ON, VehicleIgnitionState.START -> Ignition.ON
            else -> Ignition.UNKNOWN
        }
        val gear = gear(manager.value<Int>(VehiclePropertyIds.GEAR_SELECTION))
        val speed = speed(manager.value<Float>(VehiclePropertyIds.PERF_VEHICLE_SPEED))
        val location = lastLocation()
        val now = Instant.now()
        val energyType = when {
            fuel != null && soc != null -> EnergyType.HYBRID
            fuel != null -> EnergyType.FUEL
            soc != null -> EnergyType.ELECTRIC
            else -> EnergyType.UNKNOWN
        }
        val observed = buildMap {
            if (range != null) put(VehicleCapability.RANGE, now)
            if (fuel != null) put(VehicleCapability.FUEL, if (cached?.fuel != null) cached.at else now)
            if (soc != null) put(VehicleCapability.SOC, if (cached?.soc != null) cached.at else now)
            if (ignition != Ignition.UNKNOWN) put(VehicleCapability.IGNITION, now)
            if (gear != Gear.UNKNOWN) put(VehicleCapability.GEAR, now)
            if (speed != null) put(VehicleCapability.SPEED, now)
            if (location != null) put(VehicleCapability.LOCATION, Instant.ofEpochMilli(location.time))
        }
        val collected = observed[VehicleCapability.RANGE] ?: observed[VehicleCapability.GEAR]
            ?: listOfNotNull(observed[VehicleCapability.FUEL], observed[VehicleCapability.SOC]).minOrNull() ?: now
        return VehicleSnapshot(range, fuel, soc, energyType, ignition, gear, speed,
            location?.let { LatLng(it.latitude, it.longitude) }, collected, false, observed)
    }

    @SuppressLint("MissingPermission")
    private fun lastLocation(): Location? {
        if (context.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return null
        val manager = context.getSystemService(LocationManager::class.java) ?: return null
        return listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).mapNotNull { provider ->
            runCatching { manager.getLastKnownLocation(provider) }.getOrNull()
        }.filter {
            it.hasAccuracy() && it.accuracy <= 100 &&
                SystemClock.elapsedRealtimeNanos() - it.elapsedRealtimeNanos in 0L..120_000_000_000L &&
                LatLng(it.latitude, it.longitude).isValid
        }.maxByOrNull(Location::getElapsedRealtimeNanos)
    }

    private inline fun <reified T : Any> CarPropertyManager?.value(id: Int): T? = runCatching {
        this?.getProperty<T>(id, 0)?.takeIf { it.status == CarPropertyValue.STATUS_AVAILABLE }?.value as? T
    }.getOrNull()

    private suspend fun readPercent(
        support: ((CapabilityConfig) -> Unit, (Exception) -> Unit) -> Unit,
        read: ((Int?) -> Unit, (Exception) -> Unit) -> Unit,
    ): Double? {
        val access = sdkValue(support)?.accessType
        if (access != AccessType.READ && access != AccessType.READ_WRITE) return null
        return sdkValue(read)?.takeIf { it in 0..100 }?.toDouble()
    }

    private suspend fun <T> sdkValue(read: ((T) -> Unit, (Exception) -> Unit) -> Unit): T? = withTimeoutOrNull(1_500) {
        suspendCancellableCoroutine<T?> { continuation ->
            val settled = AtomicBoolean()
            fun finish(value: T?) {
                if (settled.compareAndSet(false, true) && continuation.isActive) continuation.resume(value)
            }
            try { read({ finish(it) }, { finish(null) }) } catch (_: Exception) { finish(null) }
        }
    }

    override fun close() {
        carPolling.cancel()
        sdkPolling.cancel()
        attach(null)
        runCatching { car?.disconnect() }
        runCatching { sdk?.release() }
    }

    private data class EnergyReading(val fuel: Double?, val soc: Double?, val at: Instant)

    companion object {
        private fun emptySnapshot() = VehicleSnapshot(null, null, null, EnergyType.UNKNOWN, Ignition.UNKNOWN,
            Gear.UNKNOWN, null, null, Instant.EPOCH, false)

        private fun gear(value: Int?) = when (value) {
            VehicleGear.GEAR_PARK -> Gear.PARK
            VehicleGear.GEAR_REVERSE -> Gear.REVERSE
            VehicleGear.GEAR_NEUTRAL -> Gear.NEUTRAL
            null, VehicleGear.GEAR_UNKNOWN -> Gear.UNKNOWN
            else -> Gear.DRIVE
        }

        private fun speed(value: Float?) = value?.takeIf(Float::isFinite)?.toDouble()?.times(3.6)

        private fun percent(value: Float?, capacity: Float?): Double? {
            if (value == null || capacity == null || !value.isFinite() || !capacity.isFinite() || capacity <= 0) return null
            return (100.0 * value / capacity).takeIf { it in 0.0..100.0 }
        }
    }
}
