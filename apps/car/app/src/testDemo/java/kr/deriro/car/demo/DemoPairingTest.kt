package kr.deriro.car.demo

import kr.deriro.car.domain.PickupPhase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DemoPairingTest {
    @Test
    fun pairCodesAvoidConfusableCharacters() {
        // F-05: 6 characters, no 0/O or 1/I/L, shown as XXX-XXX on V-01.
        repeat(500) {
            val code = PairCode.generate().code
            assertTrue(code, Regex("^[A-Z2-9]{3}-[A-Z2-9]{3}$").matches(code))
            assertTrue(code, code.none { it in "01OIL" })
        }
        assertFalse(PairCode.ALPHABET.any { it in "01OIL" })
    }

    @Test
    fun driverCanOnlyChangeBeforeTheTripIsGuided() {
        val scheduled = DemoCarState(paired = true, pickup = DemoFixtures.scheduled())
        assertEquals(DemoFixtures.assignee, scheduled.driver)
        assertTrue(canChangeDriver(scheduled))
        assertTrue(canChangeDriver(DemoCarState(paired = true)))
        for (phase in listOf(PickupPhase.EN_ROUTE, PickupPhase.ARRIVED)) {
            assertFalse(canChangeDriver(scheduled.copy(pickup = DemoFixtures.scheduled().copy(phase = phase))))
        }
    }
}
