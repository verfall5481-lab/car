package kr.deriro.car.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Slider
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import kr.deriro.car.data.vehicle.Ignition
import kr.deriro.car.demo.CallbackOutcome
import kr.deriro.car.demo.DemoCarState
import kr.deriro.car.demo.DemoCarViewModel
import kr.deriro.car.demo.DemoFixtures
import kr.deriro.car.demo.canChangeDriver
import kr.deriro.car.demo.Panel
import kr.deriro.car.domain.Guidance
import kr.deriro.car.domain.PickupPhase
import kr.deriro.car.ux.DrivingMode

@Composable
internal fun Settings(state: DemoCarState, model: DemoCarViewModel) {
    Heading(CarCopy.settings)
    Body(CarCopy.carName)
    Info(DemoCopy.paired, color = Confirmed)
    Title(DemoCopy.currentDriver)
    val canChange = canChangeDriver(state)
    ButtonRow {
        for (name in DemoFixtures.drivers) {
            val selected = name == state.driver
            CarButton(name, Modifier.weight(1f), primary = selected, enabled = canChange && !selected) { model.chooseDriver(name) }
        }
    }
    if (!canChange) Info(DemoCopy.driverBusy)
    Rule()
    Title(DemoCopy.demoPanel, color = Amber)
    Info(DemoCopy.localOnly)

    val range = state.vehicle?.rangeKm
    Body(DemoCopy.rangeOverride)
    Info("${DemoCopy.energy(state.vehicle)} (${DemoCopy.rangeLimits})")
    if (range != null) {
        Slider(value = range.toFloat(), onValueChange = { model.setRange(it.toDouble()) }, valueRange = 0f..600f)
    }
    CarButton(if (range != null) DemoCopy.hideRange else DemoCopy.restoreRange, primary = false) {
        model.setRange(if (range == null) 48.0 else null)
    }

    Body(DemoCopy.ignition)
    ButtonRow {
        for (ignition in listOf(Ignition.OFF, Ignition.ACC, Ignition.ON)) {
            CarButton(ignition.name, Modifier.weight(1f), primary = state.vehicle?.ignition == ignition) {
                model.setIgnition(ignition)
            }
        }
    }
    ButtonRow {
        CarButton(DemoCopy.simulateDriving, Modifier.weight(1f), primary = false) { model.simulateMode(DrivingMode.DRIVING) }
        CarButton(DemoCopy.simulateUnknown, Modifier.weight(1f), primary = false) { model.simulateMode(DrivingMode.UNKNOWN) }
    }
    Rule()

    val canReplace = state.pickup?.phase !in setOf(PickupPhase.EN_ROUTE, PickupPhase.ARRIVED)
    ButtonRow {
        CarButton(DemoCopy.savedPinRequest, Modifier.weight(1f), enabled = canReplace) { model.simulateRequest(confirmed = true) }
        CarButton(DemoCopy.gpsRequest, Modifier.weight(1f), enabled = canReplace) { model.simulateRequest(confirmed = false) }
    }
    CarButton(DemoCopy.resetScheduled, Modifier.fillMaxWidth(), primary = false, enabled = canReplace, onClick = model::resetScheduled)
    CarButton(
        if (state.failNextRoute) DemoCopy.cancelFailure else DemoCopy.failNext,
        Modifier.fillMaxWidth(), primary = state.failNextRoute, onClick = model::toggleNavigationFailure,
    )

    if (state.pickup?.phase == PickupPhase.EN_ROUTE) {
        Body(DemoCopy.callback)
        if (state.callbackOutcome == CallbackOutcome.IGNORED) Info(DemoCopy.ignoredCallback, color = Amber)
        ButtonRow {
            CarButton(DemoCopy.currentCallback, Modifier.weight(1f), enabled = state.pickup.route?.guidance == Guidance.REQUESTED) {
                model.simulateArrival(previous = false)
            }
            CarButton(DemoCopy.oldCallback, Modifier.weight(1f), primary = false, enabled = state.previousDestination != null) {
                model.simulateArrival(previous = true)
            }
        }
    }

    Rule()
    ButtonRow {
        CarButton(CarCopy.back, Modifier.weight(1f), primary = false) { model.open(Panel.HOME) }
        CarButton(CarCopy.unpair, Modifier.weight(1f), primary = false) { model.open(Panel.UNPAIR) }
    }
}

@Composable
internal fun Today(state: DemoCarState, model: DemoCarViewModel) {
    Heading(CarCopy.today)
    val pickup = state.pickup
    if (pickup == null) {
        Body(CarCopy.noPickups)
    } else {
        Title("${pickup.timeLabel}  ${pickup.rider}")
        Body(pickup.location.label)
        Info("${DemoCopy.assigned}, ${CarCopy.status(pickup.phase)}")
        Rule()
    }
    CarButton(CarCopy.back, Modifier.fillMaxWidth(), primary = false) { model.open(Panel.HOME) }
}

@Composable
internal fun RangeWarning(state: DemoCarState, model: DemoCarViewModel) {
    Heading(DemoCopy.rangeAlert)
    Body(DemoCopy.energy(state.vehicle))
    Info(DemoCopy.rangeEstimate)
    CarButton(CarCopy.ok, Modifier.fillMaxWidth()) { model.open(Panel.HOME) }
}

@Composable
internal fun Unpair(model: DemoCarViewModel) {
    Heading(DemoCopy.unpairTitle)
    ButtonRow {
        CarButton(CarCopy.unpair, Modifier.weight(1f), onClick = model::unpair)
        CarButton(CarCopy.back, Modifier.weight(1f), primary = false) { model.open(Panel.SETTINGS) }
    }
}
