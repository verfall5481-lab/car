package kr.deriro.car.ux

import kotlinx.coroutines.flow.StateFlow

enum class DrivingMode {
    PARKED, DRIVING, UNKNOWN;

    val allowsParkedControls: Boolean get() = this == PARKED
}

interface DrivingStateMonitor {
    val mode: StateFlow<DrivingMode>
}
