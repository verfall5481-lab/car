package kr.deriro.car.ui

import android.media.RingtoneManager
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.delay
import kr.deriro.car.BuildConfig
import kr.deriro.car.domain.PickupPhase
import kr.deriro.car.live.FeedCard
import kr.deriro.car.live.LiveCarState
import kr.deriro.car.live.LiveCarViewModel
import kr.deriro.car.live.LivePanel
import kr.deriro.car.live.LivePickup
import kr.deriro.car.live.LiveTrip
import kr.deriro.car.live.VehicleConnection
import kr.deriro.car.live.VehicleFeed

@Composable
internal fun LiveCar(model: LiveCarViewModel, onVehiclePermissions: () -> Unit, onLocationPermission: () -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    val panel = if (state.parked) state.panel else LivePanel.HOME
    BackHandler(enabled = panel != LivePanel.HOME) { model.open(LivePanel.HOME) }
    val context = LocalContext.current
    var sounded by rememberSaveable { mutableStateOf(emptyList<String>()) }
    val newCard = state.visibleCard?.key?.takeIf { panel == LivePanel.HOME && state.connection == VehicleConnection.ONLINE }
    LaunchedEffect(newCard) {
        if (newCard != null && newCard !in sounded) {
            sounded = (sounded + newCard).takeLast(20)
            runCatching { RingtoneManager.getRingtone(context, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION))?.play() }
        }
    }

    BoxWithConstraints(Modifier.fillMaxSize().background(Charcoal).windowInsetsPadding(WindowInsets.safeDrawing),
        contentAlignment = Alignment.TopCenter) {
        val wide = maxWidth >= 740.dp
        val compact = !wide || maxHeight < 480.dp
        val margin = if (compact) 16.dp else 32.dp
        CarTheme(compact) {
            Column(Modifier.widthIn(max = 1400.dp).fillMaxSize().padding(horizontal = margin),
                verticalArrangement = Arrangement.spacedBy(if (compact) 8.dp else 16.dp)) {
                Header(state, model)
                val body = if (state.parked) Modifier.verticalScroll(rememberScrollState()) else Modifier
                Column(body.fillMaxWidth().weight(1f).padding(bottom = margin)) {
                    VehicleContent(compact) {
                        when {
                            !state.configured -> {
                                Heading(LiveCopy.setup)
                                Body(LiveCopy.setupDetail, maxLines = 2)
                            }
                            state.vehicle == null -> Pairing(state, model, wide, onVehiclePermissions)
                            panel == LivePanel.TODAY -> Today(state, model)
                            panel == LivePanel.PICKUP -> PickupDetail(state, model)
                            panel == LivePanel.SETTINGS -> Settings(state, model, onVehiclePermissions, onLocationPermission)
                            panel == LivePanel.LOCATION -> Location(state, model)
                            panel == LivePanel.SWITCH -> Switch(state, model)
                            panel == LivePanel.RANGE -> Range(state, model)
                            panel == LivePanel.UNPAIR -> Unpair(state, model)
                            panel == LivePanel.ABOUT -> About(model)
                            else -> Home(state, model, wide)
                        }
                        if (state.parked) {
                            state.error?.let { Info(LiveCopy.failure(it, state.errorDetail), color = Error, maxLines = 2) }
                            if (state.pending) Info(LiveCopy.working, maxLines = 1)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Header(state: LiveCarState, model: LiveCarViewModel) {
    Row(Modifier.fillMaxWidth().padding(top = 8.dp).heightIn(min = 44.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(CarCopy.appName, style = MaterialTheme.typography.titleLarge, color = Ink)
        if (state.configured && state.connection != VehicleConnection.ONLINE && !state.parked) {
            Info(LiveCopy.link(state.connection, null), color = Amber, maxLines = 1)
        } else if (state.pending && !state.parked) {
            Info(LiveCopy.working, color = Amber, maxLines = 1)
        }
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) {
            Info(LiveCopy.status(state.mode), maxLines = 1)
        }
        if (state.parked && state.vehicle != null && state.panel == LivePanel.HOME) {
            CarButton(CarCopy.settings, primary = false) { model.open(LivePanel.SETTINGS) }
        }
    }
}

@Composable
private fun Pairing(state: LiveCarState, model: LiveCarViewModel, wide: Boolean, onVehiclePermissions: () -> Unit) {
    if (!state.parked) {
        Heading(if (state.permissionSetupAllowed) LiveCopy.permissionsNeeded else CarCopy.stopToPair)
        if (state.permissionSetupAllowed) CarButton(LiveCopy.permissions, onClick = onVehiclePermissions)
        return
    }
    val ticket = state.ticket
    val now by produceState(Instant.now(), ticket) {
        while (true) {
            value = Instant.now()
            delay(1_000)
        }
    }
    val active = ticket != null && now.isBefore(ticket.expiresAt)
    Split(wide, first = {
        Heading(CarCopy.pairTitle)
        Body(LiveCopy.pairScan)
        Body(LiveCopy.pairConfirm)
        if (ticket != null) {
            Rule()
            Title(LiveCopy.code(ticket.code))
        }
        else Info(LiveCopy.pairWaiting)
    }, second = {
        if (active) {
            val code = checkNotNull(ticket)
            model.pairUrl(code)?.let { CarQr(it, LiveCopy.qr) }
            Info(CarCopy.expires(now, code.expiresAt))
        } else if (ticket != null) Info(CarCopy.expired, color = Error)
        if (state.connection != VehicleConnection.ONLINE) Info(LiveCopy.link(state.connection, state.lastContact), color = Amber)
    })
    CarButton(if (ticket == null) LiveCopy.createPair else CarCopy.renew, Modifier.fillMaxWidth(), enabled = !state.pending) {
        model.renewTicket()
    }
}

@Composable
private fun Home(state: LiveCarState, model: LiveCarViewModel, wide: Boolean) {
    val feed = state.feed
    val completed = state.completed
    val card = state.visibleCard
    val active = feed?.activeTrip
    val assigned = feed?.today.orEmpty().filter { it.belongsTo(feed) }
    val arrived = assigned.firstOrNull { it.status == "arrived" }
    val inProgress = assigned.firstOrNull { it.status == "en_route" }
    val next = assigned.filter { it.status == "assigned" }.minByOrNull { it.wantedAt ?: Instant.MAX }
    when {
        card?.kind == "cancelled_urgent" -> NotificationCard(card, state, model)
        completed != null -> BoardingComplete(LiveCopy.pickupLine(completed))
        card != null -> NotificationCard(card, state, model)
        arrived != null && active == null -> Arrived(arrived, state, model, wide)
        active?.pickup?.status == "arrived" -> Arrived(active.pickup, state, model, wide)
        active != null -> EnRoute(active.pickup, active, state, model)
        inProgress != null -> EnRoute(inProgress, null, state, model)
        else -> {
            Split(wide && state.parked, first = {
                if (next == null) Heading(CarCopy.noPickups)
                else {
                    Info(CarCopy.next, maxLines = 1)
                    Heading(listOfNotNull(next.timeLabel, next.rider).joinToString("  "), maxLines = 1)
                    Body(LiveCopy.place(next), maxLines = 1)
                    if (state.parked) next.assignee?.let { Info(LiveCopy.driver(it)) }
                }
            }, second = { VehicleStatus(state) })
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                if (next != null && (next.locationConfirmed || state.parked)) {
                    CarButton(if (next.locationConfirmed) CarCopy.depart else CarCopy.location, Modifier.weight(1f), enabled = state.canPickupAct) {
                        model.requestRoute(next)
                    }
                }
                if (state.parked) CarButton(CarCopy.today, Modifier.weight(1f), primary = false) { model.open(LivePanel.TODAY) }
            }
        }
    }
}

@Composable
private fun VehicleStatus(state: LiveCarState) {
    val snapshot = state.snapshot?.takeIf { it.rangeKm != null || it.fuelPct != null || it.socPct != null }
    val stored = state.feed?.telemetry
    val recordedAt = snapshot?.collectedAt ?: stored?.collectedAt
    val age = recordedAt?.let { Instant.now().epochSecond - it.epochSecond }
    if (state.parked) {
        Title(state.vehicle?.name ?: CarCopy.carName)
        Rule()
        val energy = if (snapshot != null) LiveCopy.energy(snapshot.rangeKm, snapshot.fuelPct, snapshot.socPct)
            else LiveCopy.energy(stored?.rangeKm, stored?.fuelPct, stored?.socPct)
        Body(if (age == null || age >= 24 * 3_600) LiveCopy.unavailable else energy)
        if (snapshot == null && stored?.isDemoValue == true) Info(CarCopy.demo, color = Amber)
        if (age != null && age in 6 * 3_600L until 24 * 3_600L) Info(LiveCopy.stale)
        Info(state.vehicle?.driver?.name?.let(LiveCopy::driver) ?: LiveCopy.noDriver)
        Info(LiveCopy.link(state.connection, state.lastContact), color = if (state.connection == VehicleConnection.ONLINE) Confirmed else Amber)
    }
    if (state.feed?.rangeVerdict == "low" || state.feed?.alerts?.isNotEmpty() == true) {
        Info(CarCopy.rangeShort, color = Amber, maxLines = 1)
    }
}

@Composable
private fun NotificationCard(card: FeedCard, state: LiveCarState, model: LiveCarViewModel) {
    if (card.kind == "low_range") {
        Range(state, model)
        return
    }
    val pickup = card.pickup
    val rider = pickup?.let(LiveCopy::rider) ?: LiveCopy.unknownRider
    val urgent = card.kind in setOf("cancelled_urgent", "not_met")
    Heading(LiveCopy.cardTitle(card.kind, rider, card.offerFrom), color = if (urgent) Error else Ink,
        maxLines = if (state.parked) 2 else 1)
    pickup?.placeLine?.let { Body(it, maxLines = 1) }
    val detail = LiveCopy.cardDetail(card.kind) ?: card.offerNote ?: card.requiredKm?.let(LiveCopy::approxTrip)
    detail?.let { Info(it, maxLines = 1) }
    if (state.parked) {
        val others = state.feed?.cards.orEmpty().count { it.key !in state.dismissed } - 1
        if (others > 0) Info(LiveCopy.otherAlerts(others), maxLines = 1)
    }
    val differentTrip = state.feed?.activeTrip?.pickup?.id?.let { pickup != null && it != pickup.id } == true
    val primary = when {
        pickup != null && !pickup.locationConfirmed && state.parked && card.kind in setOf("child_request", "rider_request") -> "location"
        card.primary == "confirm_location" -> if (state.parked) "location" else "accept"
        card.primary == "start_now" && !state.parked && differentTrip -> "accept"
        card.primary == "start_now" && pickup?.locationConfirmed == false -> if (state.parked) "location" else "accept"
        card.primary != null -> card.primary
        urgent -> "dismiss"
        else -> null
    }
    val actions = listOfNotNull(primary, card.secondary).distinct().filter { state.parked || it !in setOf("boarded", "board", "location") }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        for ((index, action) in actions.withIndex()) {
            val label = LiveCopy.action(action, card.offerId != null) ?: continue
            CarButton(label, Modifier.weight(1f), primary = index == 0, enabled = state.canPickupAct) {
                if (action == "location" && pickup != null) {
                    model.open(LivePanel.LOCATION, pickup.id, card.offerId.takeIf { card.kind == "offer_to_me" })
                } else model.runCard(card, action)
            }
        }
    }
}

@Composable
private fun EnRoute(pickup: LivePickup, trip: LiveTrip?, state: LiveCarState, model: LiveCarViewModel) {
    Heading(CarCopy.enRouteTitle(LiveCopy.rider(pickup)), maxLines = 1)
    Body(LiveCopy.place(pickup), maxLines = 1)
    val mapOpened = trip != null && state.mapSession == trip.sessionId
    val manual = trip != null && state.manualSession == trip.sessionId
    if (mapOpened) Info(if (state.parked) LiveCopy.routeMapDetail else LiveCopy.routeMap, maxLines = 1)
    if (pickup.navStatus == "failed" && !manual && !mapOpened) {
        Info(CarCopy.routeFailed, color = Error, maxLines = 1)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            CarButton(CarCopy.retry, Modifier.weight(1f), enabled = state.canPickupAct) { model.requestRoute(pickup) }
            if (trip != null) CarButton(CarCopy.continueManually, Modifier.weight(1f), primary = false, enabled = state.canPickupAct) {
                model.continueManually(trip)
            } else CarButton(CarCopy.arrived, Modifier.weight(1f), primary = false, enabled = state.canPickupAct) { model.arrive(pickup) }
        }
    } else {
        if (state.parked && !mapOpened && !manual && pickup.navStatus == "ok") Info(LiveCopy.routeRequested, maxLines = 1)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            CarButton(CarCopy.arrived, Modifier.weight(1f), enabled = state.canPickupAct) { model.arrive(pickup) }
            CarButton(CarCopy.reopen, Modifier.weight(1f), primary = false, enabled = state.canPickupAct) { model.requestRoute(pickup) }
        }
    }
}

@Composable
private fun Arrived(pickup: LivePickup, state: LiveCarState, model: LiveCarViewModel, wide: Boolean) {
    Split(wide && state.parked, first = {
        Heading(CarCopy.arrived)
        Info(LiveCopy.arrivedShared, maxLines = 1)
    }, second = {
        if (state.parked) {
            Title(CarCopy.status(PickupPhase.ARRIVED), color = Amber)
            Info(CarCopy.parked)
        }
    })
    if (state.parked) CarButton(CarCopy.board, Modifier.fillMaxWidth(), enabled = state.canPickupAct) { model.board(pickup) }
    else Info(LiveCopy.parkToBoard, maxLines = 1)
}

@Composable
private fun Location(state: LiveCarState, model: LiveCarViewModel) {
    val pickup = state.selected
    if (pickup == null) Info(LiveCopy.staleAction) else {
        Heading(CarCopy.locationTitle(LiveCopy.rider(pickup)))
        Body(LiveCopy.place(pickup))
        pickup.accuracyM?.let { Info(LiveCopy.accuracy(it)) }
        pickup.location?.let { Info("${LiveCopy.locationCoordinates} ${it.lat}, ${it.lng}") }
        val nearby = state.feed?.nearby(pickup).orEmpty()
        if (nearby.isNotEmpty()) Title(LiveCopy.nearPlace)
        for (place in nearby) {
            val label = listOfNotNull(place.label, place.distanceM?.let(LiveCopy::distance)).joinToString(" ")
            CarButton(label, Modifier.fillMaxWidth(), primary = false, enabled = state.canPickupAct) { model.confirmLocation(place) }
        }
        val action = if (pickup.canStartInWindow(state.feed?.serverTime ?: Instant.now())) CarCopy.routeHere
            else LiveCopy.confirmLocationOnly
        CarButton(action, Modifier.fillMaxWidth(), enabled = state.canPickupAct && pickup.location != null) { model.confirmLocation() }
    }
    CarButton(CarCopy.back, Modifier.fillMaxWidth(), primary = false) { model.open(LivePanel.HOME) }
}

@Composable
private fun Switch(state: LiveCarState, model: LiveCarViewModel) {
    val active = state.feed?.activeTrip?.pickup
    val selected = state.selected
    Heading(if (active != null && selected != null) LiveCopy.switch(LiveCopy.rider(active), LiveCopy.rider(selected)) else LiveCopy.routeChange)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        CarButton(LiveCopy.routeChange, Modifier.weight(1f), enabled = state.canPickupAct && selected != null, onClick = model::confirmSwitch)
        CarButton(LiveCopy.keepRoute, Modifier.weight(1f), primary = false) { model.open(LivePanel.HOME) }
    }
}

@Composable
private fun Range(state: LiveCarState, model: LiveCarViewModel) {
    val alert = state.feed?.alerts?.firstOrNull()
    if (alert == null) Heading(LiveCopy.cardTitle("low_range", "", null)) else {
        Heading(alert.requiredKm?.let(LiveCopy::requiredRange) ?: LiveCopy.cardTitle("low_range", "", null))
        alert.rangeKm?.let { Body(LiveCopy.currentRange(it)) }
        Info(LiveCopy.rangeDetail(alert))
        CarButton(CarCopy.ok, Modifier.fillMaxWidth(), enabled = state.canAct) { model.ackAlert(alert.id) }
    }
    if (state.panel == LivePanel.RANGE) CarButton(CarCopy.back, Modifier.fillMaxWidth(), primary = false) { model.open(LivePanel.HOME) }
}

@Composable
private fun Today(state: LiveCarState, model: LiveCarViewModel) {
    Heading(CarCopy.today)
    val feed = state.feed
    val zone = ZoneId.of("Asia/Seoul")
    val today = LocalDate.now(zone)
    val groups = feed?.today.orEmpty().groupBy { it.wantedAt?.atZone(zone)?.toLocalDate() ?: today }
    if (groups.isEmpty()) Body(CarCopy.noPickups)
    for ((date, pickups) in groups.toSortedMap()) {
        Title(when (date) {
            today -> LiveCopy.today
            today.plusDays(1) -> LiveCopy.tomorrow
            else -> date.toString()
        })
        for (pickup in pickups.sortedWith(compareBy({ !it.belongsTo(feed) }, { it.wantedAt }))) {
            CarButton(LiveCopy.pickupLine(pickup).ifBlank { LiveCopy.place(pickup) }, Modifier.fillMaxWidth(), primary = false) {
                model.open(LivePanel.PICKUP, pickup.id)
            }
            Info(LiveCopy.pickupMeta(pickup))
        }
    }
    CarButton(CarCopy.back, Modifier.fillMaxWidth(), primary = false) { model.open(LivePanel.HOME) }
}

@Composable
private fun PickupDetail(state: LiveCarState, model: LiveCarViewModel) {
    val pickup = state.selected
    if (pickup == null) Info(LiveCopy.staleAction) else {
        Heading(LiveCopy.rider(pickup))
        Body(LiveCopy.place(pickup))
        Info(LiveCopy.pickupMeta(pickup))
        if (pickup.belongsTo(state.feed)) {
            when (pickup.status) {
                "assigned" -> CarButton(if (pickup.locationConfirmed) CarCopy.depart else CarCopy.location,
                    Modifier.fillMaxWidth(), enabled = state.canPickupAct) { model.requestRoute(pickup) }
                "en_route" -> CarButton(CarCopy.arrived, Modifier.fillMaxWidth(), enabled = state.canPickupAct) { model.arrive(pickup) }
                "arrived" -> CarButton(CarCopy.board, Modifier.fillMaxWidth(), enabled = state.canPickupAct) { model.board(pickup) }
            }
        } else {
            val card = state.feed?.cards?.firstOrNull { it.pickup?.id == pickup.id && it.primary == "accept" }
            if (card != null) CarButton(CarCopy.accept, Modifier.fillMaxWidth(), enabled = state.canPickupAct) { model.runCard(card, "accept") }
        }
    }
    CarButton(CarCopy.back, Modifier.fillMaxWidth(), primary = false) { model.open(LivePanel.TODAY) }
}

@Composable
private fun Settings(state: LiveCarState, model: LiveCarViewModel, onVehiclePermissions: () -> Unit, onLocationPermission: () -> Unit) {
    Heading(CarCopy.settings)
    VehicleStatus(state)
    state.vehicle?.family?.let { Info(it) }
    Rule()
    Title(LiveCopy.driveSettings)
    for (driver in state.feed?.drivers.orEmpty()) {
        val selected = driver.id == state.vehicle?.driver?.id
        CarButton(driver.name, Modifier.fillMaxWidth(), primary = selected, enabled = state.canAct && !selected) { model.setDriver(driver) }
    }
    Rule()
    CarButton(LiveCopy.permissions, Modifier.fillMaxWidth(), primary = false, onClick = onVehiclePermissions)
    Info(LiveCopy.locationPrivacy)
    CarButton(LiveCopy.locationPermission, Modifier.fillMaxWidth(), primary = false, onClick = onLocationPermission)
    CarButton(LiveCopy.refresh, Modifier.fillMaxWidth(), primary = false, onClick = model::refresh)
    CarButton(LiveCopy.appInformation, Modifier.fillMaxWidth(), primary = false) { model.open(LivePanel.ABOUT) }
    CarButton(CarCopy.unpair, Modifier.fillMaxWidth(), primary = false, enabled = state.canAct) { model.open(LivePanel.UNPAIR) }
    CarButton(CarCopy.back, Modifier.fillMaxWidth(), primary = false) { model.open(LivePanel.HOME) }
}

@Composable
private fun Unpair(state: LiveCarState, model: LiveCarViewModel) {
    Heading(LiveCopy.unpair)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        CarButton(CarCopy.unpair, Modifier.weight(1f), enabled = state.canAct, onClick = model::unpair)
        CarButton(CarCopy.back, Modifier.weight(1f), primary = false) { model.open(LivePanel.SETTINGS) }
    }
}

@Composable
private fun About(model: LiveCarViewModel) {
    Heading(LiveCopy.appInformation)
    Body(LiveCopy.appVersion(BuildConfig.VERSION_NAME))
    Info(LiveCopy.openSource)
    CarButton(CarCopy.back, Modifier.fillMaxWidth(), primary = false) { model.open(LivePanel.SETTINGS) }
}

private fun LivePickup.belongsTo(feed: VehicleFeed?) = feed != null && vehicleId == feed.vehicle.id &&
    assigneeId != null && assigneeId == feed.vehicle.driver?.id
