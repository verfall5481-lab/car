package kr.deriro.car.data.vehicle

import java.time.Instant
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import kotlinx.coroutines.flow.Flow

data class LatLng(val lat: Double, val lng: Double) {
    val isValid: Boolean get() = lat in -90.0..90.0 && lng in -180.0..180.0
}

/** Great-circle distance in meters. Both points must be valid. */
fun LatLng.metersTo(other: LatLng): Double {
    val latStep = Math.toRadians(other.lat - lat) / 2
    val lngStep = Math.toRadians(other.lng - lng) / 2
    val a = sin(latStep) * sin(latStep) +
        cos(Math.toRadians(lat)) * cos(Math.toRadians(other.lat)) * sin(lngStep) * sin(lngStep)
    return 2 * 6_371_000 * asin(sqrt(a.coerceIn(0.0, 1.0)))
}

enum class EnergyType { FUEL, ELECTRIC, HYBRID, UNKNOWN }
enum class Ignition { OFF, ACC, ON, UNKNOWN }
enum class Gear { PARK, REVERSE, NEUTRAL, DRIVE, UNKNOWN }
enum class VehicleCapability { RANGE, FUEL, SOC, IGNITION, GEAR, SPEED, LOCATION }

data class VehicleSnapshot(
    val rangeKm: Double?,
    val fuelPct: Double?,
    val socPct: Double?,
    val energyType: EnergyType,
    val ignition: Ignition,
    val gear: Gear,
    val speedKmh: Double?,
    val location: LatLng?,
    val collectedAt: Instant,
    val isDemoValue: Boolean,
    val observedAt: Map<VehicleCapability, Instant> = emptyMap(),
) {
    val locationAt: Instant? get() = observedAt[VehicleCapability.LOCATION]
}

interface VehicleStateSource {
    val snapshots: Flow<VehicleSnapshot>
    suspend fun current(): VehicleSnapshot
    fun capabilities(): Set<VehicleCapability>
}
