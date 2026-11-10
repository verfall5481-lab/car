package kr.deriro.car.live

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

internal data class QueuedNavReport(val id: String, val payload: JSONObject)

/**
 * Navigation results waiting for `report_nav_result`, oldest first, persisted in the vault.
 * A new report never replaces an unsent one. The in-memory copy stays authoritative if a vault write fails,
 * and the next change retries the write.
 */
internal class NavReportQueue(private val vault: ClientVault?) {
    private val lock = Mutex()
    private var loaded = false
    private val items = mutableListOf<QueuedNavReport>()

    suspend fun enqueue(payload: JSONObject) = lock.withLock {
        load()
        val id = payload.string("p_nav_session_id") ?: "${payload.string("p_pickup_id")}/${items.size}/${System.nanoTime()}"
        if (items.none { it.id == id }) items += QueuedNavReport(id, JSONObject(payload.toString()))
        persist()
    }

    suspend fun peek(): QueuedNavReport? = lock.withLock {
        load()
        items.firstOrNull()
    }

    suspend fun remove(id: String) = lock.withLock {
        load()
        if (items.removeAll { it.id == id }) persist()
    }

    suspend fun snapshot(): List<QueuedNavReport> = lock.withLock {
        load()
        items.toList()
    }

    suspend fun clear() = lock.withLock {
        loaded = true
        items.clear()
        withContext(Dispatchers.IO) {
            runCatching { vault?.write(SLOT, null) }
            runCatching { vault?.write(LEGACY_SLOT, null) }
        }
    }

    private suspend fun load() {
        if (loaded) return
        loaded = true
        val stored = withContext(Dispatchers.IO) {
            val queue = runCatching { vault?.read(SLOT) }.getOrNull()
            val legacy = runCatching { vault?.read(LEGACY_SLOT) }.getOrNull()
            queue to legacy
        }
        stored.first?.let { text ->
            runCatching {
                val array = JSONArray(text)
                for (index in 0 until array.length()) {
                    val item = array.optJSONObject(index) ?: continue
                    val id = item.string("id") ?: continue
                    val payload = item.optJSONObject("payload") ?: continue
                    items += QueuedNavReport(id, payload)
                }
            }
        }
        // Reports written by the single-slot version are carried over instead of dropped.
        stored.second?.let { text ->
            runCatching {
                val payload = JSONObject(text)
                val id = payload.string("p_nav_session_id") ?: "legacy"
                if (items.none { it.id == id }) items.add(0, QueuedNavReport(id, payload))
            }
            persist()
            withContext(Dispatchers.IO) { runCatching { vault?.write(LEGACY_SLOT, null) } }
        }
    }

    private suspend fun persist() {
        val array = JSONArray()
        for (item in items) array.put(json("id" to item.id, "payload" to item.payload))
        withContext(Dispatchers.IO) {
            runCatching { vault?.write(SLOT, if (items.isEmpty()) null else array.toString()) }
        }
    }

    companion object {
        const val SLOT = "nav_reports"
        const val LEGACY_SLOT = "nav_report"
    }
}
