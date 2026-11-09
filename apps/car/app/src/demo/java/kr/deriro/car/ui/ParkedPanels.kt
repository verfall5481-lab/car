package kr.deriro.car.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Slider
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kr.deriro.car.data.vehicle.Ignition
import kr.deriro.car.demo.CallbackOutcome
import kr.deriro.car.demo.DemoCarState
import kr.deriro.car.demo.DemoCarViewModel
import kr.deriro.car.demo.Panel
import kr.deriro.car.domain.Guidance
import kr.deriro.car.domain.PickupPhase
import kr.deriro.car.ux.DrivingMode

@Composable
internal fun Settings(state: DemoCarState, model: DemoCarViewModel) {
    Heading(CarCopy.settings)
    Body("${CarCopy.carName}, ${CarCopy.driver}")
    Info(CarCopy.paired, color = Confirmed)
    Rule()
    Title(CarCopy.demoPanel, color = Amber)
    Info(CarCopy.localOnly)

    val range = state.vehicle?.rangeKm
    Body(CarCopy.rangeOverride)
    Info("${CarCopy.energy(state.vehicle)} (${CarCopy.rangeLimits})")
    if (range != null) {
        Slider(value = range.toFloat(), onValueChange = { model.setRange(it.toDouble()) }, valueRange = 0f..600f)
    }
    CarButton(if (range != null) CarCopy.hideRange else CarCopy.restoreRange, primary = false) {
        model.setRange(if (range == null) 48.0 else null)
    }

    Body(CarCopy.ignition)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        for (ignition in listOf(Ignition.OFF, Ignition.ACC, Ignition.ON)) {
            CarButton(ignition.name, Modifier.weight(1f), primary = state.vehicle?.ignition == ignition) {
                model.setIgnition(ignition)
            }
        }
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        CarButton(CarCopy.simulateDriving, Modifier.weight(1f), primary = false) { model.simulateMode(DrivingMode.DRIVING) }
        CarButton(CarCopy.simulateUnknown, Modifier.weight(1f), primary = false) { model.simulateMode(DrivingMode.UNKNOWN) }
    }
    Rule()

    val canReplace = state.pickup?.phase !in setOf(PickupPhase.EN_ROUTE, PickupPhase.ARRIVED)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        CarButton(CarCopy.savedPinRequest, Modifier.weight(1f), enabled = canReplace) { model.simulateRequest(confirmed = true) }
        CarButton(CarCopy.gpsRequest, Modifier.weight(1f), enabled = canReplace) { model.simulateRequest(confirmed = false) }
    }
    CarButton(CarCopy.resetScheduled, Modifier.fillMaxWidth(), primary = false, enabled = canReplace, onClick = model::resetScheduled)
    CarButton(
        if (state.failNextRoute) CarCopy.cancelFailure else CarCopy.failNext,
        Modifier.fillMaxWidth(), primary = state.failNextRoute, onClick = model::toggleNavigationFailure,
    )

    if (state.pickup?.phase == PickupPhase.EN_ROUTE) {
        Body(CarCopy.callback)
        if (state.callbackOutcome == CallbackOutcome.IGNORED) Info(CarCopy.ignoredCallback, color = Amber)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            CarButton(CarCopy.currentCallback, Modifier.weight(1f), enabled = state.pickup.route?.guidance == Guidance.REQUESTED) {
                model.simulateArrival(previous = false)
            }
            CarButton(CarCopy.oldCallback, Modifier.weight(1f), primary = false, enabled = state.previousDestination != null) {
                model.simulateArrival(previous = true)
            }
        }
    }

    Rule()
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
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
        Info("${CarCopy.assigned}, ${CarCopy.status(pickup.phase)}")
        Rule()
    }
    CarButton(CarCopy.back, Modifier.fillMaxWidth(), primary = false) { model.open(Panel.HOME) }
}

@Composable
internal fun RangeWarning(state: DemoCarState, model: DemoCarViewModel) {
    Heading(CarCopy.rangeAlert)
    Body(CarCopy.energy(state.vehicle))
    Info(CarCopy.rangeEstimate)
    CarButton(CarCopy.ok, Modifier.fillMaxWidth()) { model.open(Panel.HOME) }
}

@Composable
internal fun Unpair(model: DemoCarViewModel) {
    Heading(CarCopy.unpairTitle)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        CarButton(CarCopy.unpair, Modifier.weight(1f), onClick = model::unpair)
        CarButton(CarCopy.back, Modifier.weight(1f), primary = false) { model.open(Panel.SETTINGS) }
    }
}
