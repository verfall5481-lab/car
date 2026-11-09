package kr.deriro.car.domain

import java.time.Instant
import kr.deriro.car.data.vehicle.LatLng
import kr.deriro.car.nav.ArrivalEvent
import kr.deriro.car.nav.NavResult
import kr.deriro.car.ux.DrivingMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PickupTest {
    private val startedAt = Instant.parse("2026-11-09T08:30:00Z")
    private val pin = LatLng(37.49863, 127.03428)
    private val pickup = Pickup(
        "family-request", "할머니", "지금",
        PickupLocation("정형외과", "후문", "후문 벤치", pin, LocationSource.MAP_PIN),
        PickupPhase.REQUESTED, 14,
    )

    @Test
    fun departureSurvivesFailureAndRetryCreatesNewSession() {
        val started = pickup.beginRoute("first", startedAt)
        assertEquals(PickupPhase.EN_ROUTE, started.phase)
        assertEquals(started, started.beginRoute("second", startedAt))

        val failed = started.recordNavResult("first", NavResult.Failed("DEMO_ROUTE_FAILURE"))
        assertEquals(PickupPhase.EN_ROUTE, failed.phase)
        assertEquals(Guidance.FAILED, failed.route?.guidance)
        assertEquals(failed, failed.arrive())

        val retried = failed.beginRoute("second", startedAt.plusSeconds(1))
        assertEquals(PickupPhase.EN_ROUTE, retried.phase)
        assertEquals("second", retried.route?.destination?.navSessionId)
        assertEquals(retried, retried.recordNavResult("first", NavResult.Requested))
    }

    @Test
    fun onlyCurrentSessionRevisionAndDestinationCanAutomaticallyArrive() {
        val travelling = pickup.beginRoute("first", startedAt).recordNavResult("first", NavResult.Requested)
            .beginRoute("second", startedAt.plusSeconds(1)).recordNavResult("second", NavResult.Requested)
        val current = ArrivalEvent("second", 1, pin, startedAt.plusSeconds(2))

        assertEquals(travelling, travelling.arrive(current.copy(navSessionId = "first")))
        assertEquals(travelling, travelling.arrive(current.copy(navSessionId = null)))
        assertEquals(travelling, travelling.arrive(current.copy(destinationRevision = 2)))
        assertEquals(travelling, travelling.arrive(current.copy(location = LatLng(37.51, 127.05))))
        assertEquals(travelling, travelling.arrive(current.copy(location = LatLng(Double.NaN, 127.05))))
        assertEquals(travelling, travelling.arrive(current.copy(at = startedAt)))

        val revised = travelling.copy(location = travelling.location.copy(revision = 2))
        assertEquals(revised, revised.arrive(current))
        val arrived = travelling.arrive(current)
        assertEquals(PickupPhase.ARRIVED, arrived.phase)
        assertEquals(arrived, arrived.arrive(current))
    }

    @Test
    fun manualArrivalAndParkedBoardingAreSeparateActions() {
        val failed = pickup.beginRoute("first", startedAt).recordNavResult("first", NavResult.Failed("FAILED"))
        val arrived = failed.continueWithoutNavigation().arrive()
        assertEquals(PickupPhase.ARRIVED, arrived.phase)
        assertEquals(arrived, arrived.board(DrivingMode.DRIVING))
        assertEquals(arrived, arrived.board(DrivingMode.UNKNOWN))
        assertEquals(PickupPhase.COMPLETED, arrived.board(DrivingMode.PARKED).phase)
    }

    @Test
    fun unconfirmedGpsCannotDepartAndConfirmedPinKeepsBoardingDetails() {
        val gps = pickup.copy(location = PickupLocation("역삼동 근처", coordinates = pin, source = LocationSource.GPS))
        assertFalse(gps.location.confirmed)
        assertEquals(gps, gps.beginRoute("first", startedAt))

        assertTrue(pickup.location.confirmed)
        val destination = pickup.beginRoute("first", startedAt).route?.destination
        assertEquals(pin, destination?.location)
        assertEquals("정형외과 후문, ‘후문 벤치’", destination?.label)
    }
}
