package kr.deriro.car.live

import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NavReportQueueTest {
    @Test
    fun reportsAreKeptInOrderAcrossRestartsAndNeverOverwritten() = runBlocking {
        val vault = MemoryVault()
        val queue = NavReportQueue(vault)
        queue.enqueue(report("s1", "failed"))
        queue.enqueue(report("s2", "ok"))
        queue.enqueue(report("s1", "ok")) // the same session is not queued twice

        val restored = NavReportQueue(vault)
        assertEquals(listOf("s1", "s2"), restored.snapshot().map { it.id })
        assertEquals("failed", restored.peek()?.payload?.getString("p_result"))
        restored.remove("s1")
        assertEquals("s2", NavReportQueue(vault).peek()?.id)
        restored.remove("s2")
        assertNull(vault.read(NavReportQueue.SLOT))
    }

    @Test
    fun singleSlotReportFromThePreviousVersionIsCarriedOver() = runBlocking {
        val vault = MemoryVault()
        vault.write(NavReportQueue.LEGACY_SLOT, report("old", "failed").toString())
        val queue = NavReportQueue(vault)
        queue.enqueue(report("new", "ok"))
        assertEquals(listOf("old", "new"), queue.snapshot().map { it.id })
        assertNull(vault.read(NavReportQueue.LEGACY_SLOT))
        queue.clear()
        assertTrue(NavReportQueue(vault).snapshot().isEmpty())
    }

    @Test
    fun aFailingVaultKeepsReportsInMemory() = runBlocking {
        val queue = NavReportQueue(object : ClientVault {
            override fun read(slot: String): String? = null
            override fun write(slot: String, value: String?) = throw java.io.IOException("disk full")
        })
        queue.enqueue(report("s1", "failed"))
        assertEquals("s1", queue.peek()?.id)
    }

    private fun report(session: String, result: String) =
        json("p_pickup_id" to "p", "p_nav_session_id" to session, "p_result" to result, "p_error_code" to null)

    private class MemoryVault : ClientVault {
        private val values = ConcurrentHashMap<String, String>()
        override fun read(slot: String) = values[slot]
        override fun write(slot: String, value: String?) {
            if (value == null) values.remove(slot) else values[slot] = value
        }
    }
}
