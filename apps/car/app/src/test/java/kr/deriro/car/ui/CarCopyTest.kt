package kr.deriro.car.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class CarCopyTest {
    @Test
    fun subjectParticleFollowsTheLastSyllable() {
        assertEquals("민준이", CarCopy.subject("민준"))
        assertEquals("할머니가", CarCopy.subject("할머니"))
        assertEquals("엄마가", CarCopy.subject("엄마"))
        assertEquals("민준이 데리러 와 달래요", CarCopy.requestTitle("민준"))
    }

    @Test
    fun typeFloorsMatchTheVehicleSpec() {
        // V-00: card title 36sp, body 28sp, supporting text 24sp, button gap 24dp, touch 76dp, primary 96dp.
        assertEquals(36, CarType.CARD_TITLE_SP)
        assertEquals(28, CarType.BODY_SP)
        assertEquals(24, CarType.INFO_SP)
        assertEquals(24f, CarSpacing.buttonGap.value)
        assertEquals(76f, CarSpacing.minTouch.value)
        assertEquals(96f, CarSpacing.primaryHeight.value)
    }
}
