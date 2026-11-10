package kr.deriro.car.platform

import java.time.Instant
import kotlinx.coroutines.runBlocking
import kr.deriro.car.data.vehicle.Gear
import kr.deriro.car.data.vehicle.LatLng
import kr.deriro.car.nav.Destination
import kr.deriro.car.ux.DrivingMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NaviRouteLogicTest {
    private val target = LatLng(37.49979, 127.03561)
    private val near = LatLng(37.50079, 127.03561) // about 111 m north
    private val far = LatLng(37.50379, 127.03561) // about 445 m north
    private val now = Instant.parse("2026-11-09T08:30:00Z")

    @Test
    fun routeWithinToleranceIsConfirmedAndFarDestinationIsAMismatch() = runBlocking {
        val snapped = RouteAttempt(target)
        snapped.onRoutingCompleted()
        snapped.onDestination(listOf(near))
        assertEquals(RouteOutcome.Confirmed, snapped.await(500, 100))

        val elsewhere = RouteAttempt(target)
        elsewhere.onRoutingCompleted()
        elsewhere.onDestination(listOf(far))
        assertTrue(elsewhere.await(500, 100) is RouteOutcome.Mismatch)

        // The display coordinate counts too.
        val display = RouteAttempt(target)
        display.onRoutingCompleted()
        display.onDestination(listOf(far, target))
        assertEquals(RouteOutcome.Confirmed, display.await(500, 100))
    }

    @Test
    fun routingCompletedWithoutEchoStillCountsAndLateErrorsDoNotUndoIt() = runBlocking {
        val routed = RouteAttempt(target)
        routed.onRoutingCompleted()
        routed.onError("CAUSE_SEARCH_ROUTE")
        assertEquals(RouteOutcome.Confirmed, routed.await(500, 50))

        val stale = RouteAttempt(target)
        stale.onDestination(listOf(far)) // older route, before routing completed
        stale.onError("CAUSE_SEARCH_ROUTE")
        assertEquals(RouteOutcome.Rejected("CAUSE_SEARCH_ROUTE"), stale.await(500, 50))

        assertEquals(RouteOutcome.NoEvidence, RouteAttempt(target).await(50, 50))
    }

    @Test
    fun arrivalIsAttributedOnlyToTheUnswitchedVerifiedRouteNearTheDestination() {
        val tracker = ArrivalTracker()
        val first = destination("pickup-a", "s1")
        tracker.track(first)
        assertEquals(first, tracker.claimArrival(now))
        assertNull("claimed once", tracker.claimArrival(now))
        assertNotNull(tracker.arrivalEvent(first, near, now))
        assertNull("outside the radius", tracker.arrivalEvent(first, far, now))
        assertNull("no position", tracker.arrivalEvent(first, null, now))

        // Guidance switched from another pickup while it was still active: manual arrival only.
        tracker.track(destination("pickup-a", "s2"))
        tracker.track(destination("pickup-b", "s3"))
        assertNull(tracker.watching)
        assertNull(tracker.claimArrival(now))

        // The previous route ended first, so the next one is not a switch.
        tracker.track(destination("pickup-a", "s4"))
        tracker.routeEnded(now)
        tracker.track(destination("pickup-b", "s5"))
        assertEquals("s5", tracker.claimArrival(now)?.navSessionId)

        // The navigation destination changed away from ours.
        tracker.track(destination("pickup-b", "s6"))
        tracker.destinationChanged()
        tracker.destinationReported(listOf(far))
        assertNull(tracker.claimArrival(now))

        // A change that still points at our destination keeps the route.
        tracker.track(destination("pickup-b", "s7"))
        tracker.destinationChanged()
        tracker.destinationReported(listOf(near))
        assertEquals("s7", tracker.claimArrival(now)?.navSessionId)

        // Changed but never verified: not attributable.
        tracker.track(destination("pickup-b", "s8"))
        tracker.destinationChanged()
        assertNull(tracker.claimArrival(now))

        // Ended long ago, or cancelled: nothing to attribute.
        tracker.track(destination("pickup-b", "s9"))
        tracker.routeEnded(now)
        assertNull(tracker.claimArrival(now.plusSeconds(600)))
        tracker.track(destination("pickup-b", "s10"))
        tracker.routeCancelled()
        assertNull(tracker.claimArrival(now))

        // A status flicker around a reroute does not expire the route.
        tracker.track(destination("pickup-b", "s11"))
        tracker.routeEnded(now)
        tracker.routeResumed()
        assertEquals("s11", tracker.claimArrival(now.plusSeconds(600))?.navSessionId)

        tracker.track(destination("pickup-c", "s12"))
        tracker.forget("pickup-c")
        assertNull(tracker.claimArrival(now))
    }

    @Test
    fun drivingRulesNeverInferParkedWithoutGearAndSpeed() {
        assertEquals(DrivingMode.DRIVING, DrivingRules.mode(true, Gear.PARK, 0.0))
        assertEquals(DrivingMode.PARKED, DrivingRules.mode(false, Gear.PARK, 0.0))
        assertEquals(DrivingMode.PARKED, DrivingRules.mode(null, Gear.PARK, 0.4))
        assertEquals(DrivingMode.DRIVING, DrivingRules.mode(null, Gear.PARK, 3.0))
        assertEquals(DrivingMode.UNKNOWN, DrivingRules.mode(false, Gear.PARK, null))
        assertEquals(DrivingMode.DRIVING, DrivingRules.mode(false, Gear.NEUTRAL, 0.0))
        assertEquals(DrivingMode.UNKNOWN, DrivingRules.mode(null, Gear.UNKNOWN, 0.0))
        assertFalse(DrivingMode.UNKNOWN.allowsParkedControls)
        assertTrue(DrivingRules.permissionSetupAllowed(false, DrivingMode.UNKNOWN))
        assertFalse(DrivingRules.permissionSetupAllowed(null, DrivingMode.UNKNOWN))
        assertFalse(DrivingRules.permissionSetupAllowed(false, DrivingMode.DRIVING))
    }

    private fun destination(pickup: String, session: String) = Destination(target, "수학학원", pickup, session, 1)
}
