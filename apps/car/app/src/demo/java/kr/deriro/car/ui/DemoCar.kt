package kr.deriro.car.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.time.Instant
import kotlinx.coroutines.delay
import kr.deriro.car.demo.CallbackOutcome
import kr.deriro.car.demo.DemoCarState
import kr.deriro.car.demo.DemoCarViewModel
import kr.deriro.car.demo.Panel
import kr.deriro.car.domain.Guidance
import kr.deriro.car.domain.Pickup
import kr.deriro.car.domain.PickupPhase
import kr.deriro.car.ux.DrivingMode

@Composable
internal fun DemoCar(model: DemoCarViewModel) {
    val state by model.state.collectAsStateWithLifecycle()
    val parked = state.mode.allowsParkedControls
    val panel = if (parked) state.panel else Panel.HOME
    BackHandler(enabled = parked && panel != Panel.HOME) { model.open(Panel.HOME) }

    BoxWithConstraints(
        Modifier.fillMaxSize().background(Charcoal).windowInsetsPadding(WindowInsets.safeDrawing),
        contentAlignment = Alignment.TopCenter,
    ) {
        val wide = maxWidth >= 740.dp
        val compact = maxWidth < 740.dp || maxHeight < 480.dp
        val margin = if (compact) 16.dp else 32.dp
        CarTheme(compact) {
            Column(
                Modifier.widthIn(max = 1400.dp).fillMaxSize().padding(horizontal = margin),
                verticalArrangement = Arrangement.spacedBy(if (compact) 8.dp else 16.dp),
            ) {
                Header(state, model)
                val body = if (parked) Modifier.verticalScroll(rememberScrollState()) else Modifier
                Column(body.fillMaxWidth().weight(1f).padding(bottom = margin)) {
                    VehicleContent(compact) {
                        when {
                            !state.paired -> Pairing(state, model, wide)
                            panel == Panel.LOCATION -> ConfirmLocation(state, model, wide)
                            panel == Panel.SETTINGS -> Settings(state, model)
                            panel == Panel.TODAY -> Today(state, model)
                            panel == Panel.RANGE_WARNING -> RangeWarning(state, model)
                            panel == Panel.UNPAIR -> Unpair(model)
                            else -> Home(state, model, wide)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Header(state: DemoCarState, model: DemoCarViewModel) {
    Row(
        Modifier.fillMaxWidth().padding(top = 8.dp).heightIn(min = 44.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(CarCopy.appName, style = MaterialTheme.typography.titleLarge, color = Ink)
        Text(CarCopy.demo, style = MaterialTheme.typography.bodyMedium, color = Amber)
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) {
            Info(CarCopy.mode(state.mode), maxLines = 1)
        }
        if (state.mode.allowsParkedControls) {
            if (!state.paired) {
                CarButton(CarCopy.drivingPreview, primary = false) { model.simulateMode(DrivingMode.DRIVING) }
            } else if (state.panel == Panel.HOME) {
                CarButton(CarCopy.settings, primary = false) { model.open(Panel.SETTINGS) }
            }
        }
    }
}

@Composable
private fun Pairing(state: DemoCarState, model: DemoCarViewModel, wide: Boolean) {
    if (!state.mode.allowsParkedControls) {
        Heading(CarCopy.stopToPair)
        return
    }

    val ticket = state.pairCode
    val now by produceState(Instant.now(), ticket) {
        do {
            value = Instant.now()
            delay(1_000)
        } while (value.isBefore(ticket.expiresAt))
    }
    val active = now.isBefore(ticket.expiresAt)
    Split(wide, first = {
        Heading(CarCopy.pairTitle)
        Body(CarCopy.pairDemo)
        Body(CarCopy.localOnly)
        Rule()
        Title(CarCopy.pairingCode(ticket.code))
    }, second = {
        if (active) {
            CarQr("deriro-demo:pair/${ticket.code}", CarCopy.qrDemo)
            Info(CarCopy.qrDemo)
            Info(CarCopy.expires(now, ticket.expiresAt))
        } else {
            Info(CarCopy.expired, color = Error)
        }
    })
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        CarButton(CarCopy.pairLocally, Modifier.weight(1f), enabled = active, onClick = model::pairLocally)
        CarButton(CarCopy.renew, Modifier.weight(1f), primary = !active, onClick = model::renewPairCode)
    }
}

@Composable
private fun Home(state: DemoCarState, model: DemoCarViewModel, wide: Boolean) {
    val pickup = state.pickup?.takeUnless { it.id == state.dismissedRequestId }
    val parked = state.mode.allowsParkedControls
    when (pickup?.phase) {
        PickupPhase.REQUESTED -> Request(pickup, state, model)
        PickupPhase.EN_ROUTE -> EnRoute(pickup, state, model)
        PickupPhase.ARRIVED -> {
            val detail = if (state.callbackOutcome == CallbackOutcome.APPLIED) CarCopy.arrivedByCallback(pickup.rider)
                else CarCopy.arrivalRecorded
            Split(wide && parked, first = {
                Heading(CarCopy.arrived)
                Info(detail, maxLines = 1)
            }, second = {
                if (parked) {
                    Title(CarCopy.status(PickupPhase.ARRIVED), color = Amber)
                    Info(CarCopy.parked)
                }
            })
            if (parked) CarButton(CarCopy.board, Modifier.fillMaxWidth(), onClick = model::board)
            else Info(CarCopy.parkToBoard, maxLines = 1)
        }
        PickupPhase.COMPLETED -> BoardingComplete("${pickup.rider}, ${pickup.location.label}")
        else -> {
            Split(wide && parked, first = {
                if (pickup?.phase == PickupPhase.ASSIGNED) {
                    Info(CarCopy.next)
                    Heading("${pickup.timeLabel}  ${pickup.rider}", maxLines = 1)
                    Body(pickup.location.label, maxLines = 1)
                    if (parked) Info(CarCopy.assigned)
                } else {
                    Heading(CarCopy.noPickups)
                    if (state.dismissedRequestId != null) Info(CarCopy.declined)
                }
            }, second = {
                if (parked) {
                    Title(CarCopy.carName)
                    Rule()
                    Body(CarCopy.energy(state.vehicle))
                    Info(CarCopy.driver)
                    Info(CarCopy.paired, color = Confirmed)
                }
                val short = state.vehicle?.rangeKm?.let { it < DemoCarViewModel.REQUIRED_RANGE_KM } == true
                if (short) Info(CarCopy.rangeShort, color = Amber, maxLines = 1)
            })
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (pickup?.phase == PickupPhase.ASSIGNED) {
                    if (pickup.location.confirmed) {
                        CarButton(CarCopy.depart, Modifier.weight(1f), onClick = model::depart)
                    } else if (parked) {
                        CarButton(CarCopy.location, Modifier.weight(1f)) { model.open(Panel.LOCATION) }
                    } else {
                        Info(CarCopy.locationUnconfirmed, maxLines = 1)
                    }
                }
                if (parked && pickup?.phase == PickupPhase.ASSIGNED) {
                    CarButton(CarCopy.today, Modifier.weight(1f), primary = false) { model.open(Panel.TODAY) }
                }
            }
        }
    }
}

@Composable
private fun Request(pickup: Pickup, state: DemoCarState, model: DemoCarViewModel) {
    val parked = state.mode.allowsParkedControls
    Heading(CarCopy.requestTitle(pickup.rider), maxLines = 1)
    Body(pickup.location.label, maxLines = 1)
    if (!pickup.location.confirmed) {
        Info(if (parked) CarCopy.locationUnconfirmed else CarCopy.parkToConfirm, maxLines = 1)
    } else if (parked) {
        val distance = pickup.roundTripKm?.let(CarCopy::roundTrip)
        Info(listOfNotNull(distance, CarCopy.energy(state.vehicle)).joinToString(", "), maxLines = 1)
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        when {
            pickup.location.confirmed -> CarButton(CarCopy.depart, Modifier.weight(1f), onClick = model::depart)
            parked -> CarButton(CarCopy.location, Modifier.weight(1f)) { model.open(Panel.LOCATION) }
            else -> CarButton(CarCopy.accept, Modifier.weight(1f), onClick = model::acceptUnconfirmed)
        }
        CarButton(CarCopy.decline, Modifier.weight(1f), primary = false, onClick = model::decline)
    }
}

@Composable
private fun ConfirmLocation(state: DemoCarState, model: DemoCarViewModel, wide: Boolean) {
    val pickup = state.pickup ?: return
    Split(wide, divider = false, first = { LocationDiagram() }, second = {
        Heading(CarCopy.locationTitle(pickup.rider))
        Body(pickup.location.label)
        Info(CarCopy.accuracy)
        Rule()
        CarButton(CarCopy.nearSavedPlace, primary = false) { model.confirmLocation(useSavedPlace = true) }
    })
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        CarButton(CarCopy.routeHere, Modifier.weight(1f)) { model.confirmLocation(useSavedPlace = false) }
        CarButton(CarCopy.back, Modifier.weight(1f), primary = false) { model.open(Panel.HOME) }
    }
}

@Composable
private fun LocationDiagram() {
    Box(
        Modifier.fillMaxWidth().height(170.dp).clip(RoundedCornerShape(14.dp)).background(Color(0xFFE1E5E9)),
        contentAlignment = Alignment.BottomStart,
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val road = Color(0xFFF8F9FA)
            for (index in 1..4) {
                val x = size.width * index / 5
                drawLine(road, Offset(x + 12.dp.toPx(), 0f), Offset(x - 24.dp.toPx(), size.height), 9.dp.toPx())
            }
            drawLine(road, Offset(0f, size.height * 0.3f), Offset(size.width, size.height * 0.6f), 11.dp.toPx())
            drawLine(road, Offset(0f, size.height * 0.7f), Offset(size.width, size.height * 0.9f), 8.dp.toPx())
            drawCircle(Amber.copy(alpha = 0.45f), 32.dp.toPx())
            drawCircle(Charcoal, 10.dp.toPx())
            drawCircle(Amber, 6.dp.toPx())
        }
        Text(
            CarCopy.mapDemo, Modifier.background(Charcoal).padding(horizontal = 8.dp, vertical = 4.dp),
            style = MaterialTheme.typography.bodyMedium, color = Ink,
        )
    }
}

@Composable
private fun EnRoute(pickup: Pickup, state: DemoCarState, model: DemoCarViewModel) {
    Heading(CarCopy.enRouteTitle(pickup.rider), maxLines = 1)
    Body(pickup.location.label, maxLines = 1)
    when (pickup.route?.guidance) {
        Guidance.STARTING -> Info(CarCopy.routeStarting, maxLines = 1)
        Guidance.FAILED -> {
            Info(CarCopy.routeFailed, color = Error, maxLines = 1)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                CarButton(CarCopy.retry, Modifier.weight(1f), onClick = model::depart)
                CarButton(CarCopy.continueManually, Modifier.weight(1f), primary = false, onClick = model::continueWithoutNavigation)
            }
        }
        else -> {
            if (state.mode.allowsParkedControls && pickup.route?.guidance == Guidance.REQUESTED) Info(CarCopy.routeRequested)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                CarButton(CarCopy.arrived, Modifier.weight(1f), onClick = model::arrive)
                CarButton(CarCopy.reopen, Modifier.weight(1f), primary = false, onClick = model::depart)
            }
        }
    }
}
