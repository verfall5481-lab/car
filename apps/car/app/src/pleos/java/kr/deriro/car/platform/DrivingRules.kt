package kr.deriro.car.platform

import kotlin.math.abs
import kr.deriro.car.data.vehicle.Gear
import kr.deriro.car.ux.DrivingMode

/** Pure driving-lock rules, kept apart from the Car API so they can be unit tested. */
internal object DrivingRules {
    /**
     * The platform restriction wins. Without it, parked needs gear P and a known speed under 1 km/h.
     * Anything not proven parked is DRIVING or UNKNOWN, and both lock parked-only controls.
     */
    fun mode(platformRestricted: Boolean?, gear: Gear, speedKmh: Double?): DrivingMode = when {
        platformRestricted == true || (speedKmh?.let { abs(it) >= 1 } == true) -> DrivingMode.DRIVING
        gear == Gear.PARK && speedKmh != null -> DrivingMode.PARKED
        gear != Gear.UNKNOWN && gear != Gear.PARK -> DrivingMode.DRIVING
        else -> DrivingMode.UNKNOWN
    }

    /** The permission dialog may appear only when the platform itself reports no distraction restriction. */
    fun permissionSetupAllowed(platformRestricted: Boolean?, mode: DrivingMode): Boolean =
        platformRestricted == false && mode != DrivingMode.DRIVING
}
