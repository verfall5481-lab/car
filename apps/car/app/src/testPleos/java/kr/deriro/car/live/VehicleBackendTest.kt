package kr.deriro.car.live

import java.util.Base64
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VehicleBackendTest {
    @Test
    fun anonymousSignupRefreshesRejectedAccessAndRestoresRotatedSession() = runBlocking {
        val calls = Collections.synchronizedList(mutableListOf<String>())
        val vault = MemoryVault()
        withServer { request ->
            val method = request.requestUrl?.encodedPath
            val authorization = request.getHeader("Authorization")
            calls.add("$method $authorization")
            assertEquals("sb_publishable_test", request.getHeader("apikey"))
            when (method) {
                "/auth/v1/signup" -> reply(200, session("first", "refresh-first"))
                "/auth/v1/token" -> {
                    assertEquals("grant_type=refresh_token", request.requestUrl?.encodedQuery)
                    assertEquals("refresh-first", request.jsonBody().getString("refresh_token"))
                    reply(200, session("second", "refresh-second"))
                }
                "/rest/v1/rpc/vehicle_pair_status" -> if (authorization == "Bearer first") {
                    reply(401, json("code" to "PGRST301"))
                } else reply(200, ok(json("paired" to true)))
                else -> reply(404, JSONObject())
            }
        }.use { server ->
            assertTrue(VehicleBackend(server.config, vault).rpc("vehicle_pair_status").getBoolean("paired"))
            assertTrue(VehicleBackend(server.config, vault).rpc("vehicle_pair_status").getBoolean("paired"))
        }
        assertEquals(listOf(
            "/auth/v1/signup null", "/rest/v1/rpc/vehicle_pair_status Bearer first", "/auth/v1/token null",
            "/rest/v1/rpc/vehicle_pair_status Bearer second", "/rest/v1/rpc/vehicle_pair_status Bearer second",
        ), calls)
    }

    @Test
    fun retriesOnlyExplicitTransactionConflictWithTheSameActionId() = runBlocking {
        val actionIds = Collections.synchronizedList(mutableListOf<String>())
        withServer { request ->
            if (request.requestUrl?.encodedPath == "/auth/v1/signup") reply(200, session("first", "refresh-first"))
            else {
                val action = request.jsonBody().getString("p_action_id")
                actionIds.add(action)
                val code = if (actionIds.size == 1) "RETRY" else "STALE_VERSION"
                reply(200, json("ok" to false, "error" to json("code" to code, "detail" to json("by" to "엄마"))))
            }
        }.use { server ->
            val failure = runCatching {
                VehicleBackend(server.config, MemoryVault()).rpc("vehicle_start_now", json("p_action_id" to "same-action"))
            }.exceptionOrNull() as BackendFailure
            assertEquals("STALE_VERSION", failure.code)
            assertEquals("엄마", failure.detail?.getString("by"))
        }
        assertEquals(listOf("same-action", "same-action"), actionIds)
    }

    @Test
    fun invalidatedRefreshClearsPrivateCacheBeforeCreatingAnotherIdentity() = runBlocking {
        val signups = AtomicInteger()
        val revoke = AtomicBoolean()
        val vault = MemoryVault()
        withServer { request ->
            when (request.requestUrl?.encodedPath) {
                "/auth/v1/signup" -> reply(200, session("access-${signups.incrementAndGet()}", "refresh"))
                "/auth/v1/token" -> reply(400, json("error_code" to "refresh_token_not_found"))
                else -> if (revoke.get() && request.getHeader("Authorization") == "Bearer access-1") {
                    reply(401, json("code" to "PGRST301"))
                } else reply(200, ok(json("paired" to (signups.get() == 1))))
            }
        }.use { server ->
            val api = VehicleBackend(server.config, vault)
            assertTrue(api.rpc("vehicle_pair_status").getBoolean("paired"))
            val cached = listOf(VehicleBackend.FEED_SLOT, VehicleBackend.TICKET_SLOT, VehicleBackend.NAV_REPORT_SLOT)
            cached.forEach { vault.write(it, "private-data") }
            revoke.set(true)
            val failure = runCatching { api.rpc("vehicle_pair_status") }.exceptionOrNull() as BackendFailure
            assertEquals("SESSION_EXPIRED", failure.code)
            assertEquals(1, signups.get())
            cached.forEach { assertNull(vault.read(it)) }
            assertEquals(false, api.rpc("vehicle_pair_status").getBoolean("paired"))
            assertEquals(2, signups.get())
        }
    }

    @Test
    fun refusesPrivilegedKeysAndRequiresAnExplicitWebOrigin() {
        val origin = "https://project.example"
        val web = "https://family.example"
        val anon = legacy("anon")
        assertNotNull(BackendConfig.create(origin, anon, web, false))
        assertNull(BackendConfig.create(origin, legacy("service_role"), web, false))
        assertNull(BackendConfig.create(origin, "sb_secret_test", web, false))
        assertNull(BackendConfig.create(origin, anon, "", false))
        assertNull(BackendConfig.create("http://project.example", anon, web, true))
        assertNull(BackendConfig.create("http://127.0.0.1", anon, web, false))
        assertEquals("$web/p/vehicles/pair?code=AB2345", BackendConfig.create(origin, anon, web, false)?.pairUrl("AB2345"))
    }

    private fun legacy(role: String): String {
        val payload = Base64.getUrlEncoder().withoutPadding().encodeToString(json("role" to role).toString().toByteArray())
        return "header.$payload.signature"
    }

    private fun session(access: String, refresh: String) = json("access_token" to access, "refresh_token" to refresh, "expires_in" to 3_600)
    private fun ok(value: JSONObject) = json("ok" to true, "data" to value)

    private fun withServer(block: (RecordedRequest) -> MockResponse): FixtureServer {
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = block(request)
        }
        server.start()
        val config = checkNotNull(BackendConfig.create("http://127.0.0.1:${server.port}", "sb_publishable_test", "https://family.example", true))
        return FixtureServer(server, config)
    }

    private fun RecordedRequest.jsonBody(): JSONObject = JSONObject(body.readUtf8())

    private fun reply(status: Int, json: JSONObject): MockResponse = MockResponse().setResponseCode(status)
        .setHeader("Content-Type", "application/json").setBody(json.toString())

    private class FixtureServer(private val server: MockWebServer, val config: BackendConfig) : AutoCloseable {
        override fun close() { server.close() }
    }

    private class MemoryVault : ClientVault {
        private val values = ConcurrentHashMap<String, String>()
        override fun read(slot: String) = values[slot]
        override fun write(slot: String, value: String?) {
            if (value == null) values.remove(slot) else values[slot] = value
        }
    }
}
