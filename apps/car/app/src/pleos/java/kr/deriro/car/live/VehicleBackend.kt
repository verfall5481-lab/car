package kr.deriro.car.live

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import java.time.Instant
import java.time.OffsetDateTime
import java.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

internal class BackendConfig private constructor(val origin: URI, val key: String, val webOrigin: URI) {
    fun pairUrl(code: String) =
        "${webOrigin.toString().trimEnd('/')}/p/vehicles/pair?code=${URLEncoder.encode(code, Charsets.UTF_8.name())}"

    companion object {
        fun create(url: String, key: String, webUrl: String, debug: Boolean): BackendConfig? {
            val origin = safeOrigin(url, debug) ?: return null
            if (!key.startsWith("sb_publishable_") && !isLegacyAnonKey(key)) return null
            val webOrigin = safeOrigin(webUrl, debug) ?: return null
            return BackendConfig(origin, key, webOrigin)
        }

        private fun isLegacyAnonKey(key: String): Boolean = runCatching {
            val jwt = key.split('.')
            jwt.size == 3 && JSONObject(String(Base64.getUrlDecoder().decode(jwt[1]), Charsets.UTF_8)).string("role") == "anon"
        }.getOrDefault(false)

        private fun safeOrigin(value: String, debug: Boolean): URI? {
            val url = runCatching { URI(value) }.getOrNull() ?: return null
            if (url.host == null || url.userInfo != null || url.fragment != null ||
                url.path !in listOf("", "/") || url.query != null
            ) return null
            return url.takeIf {
                it.scheme == "https" || (debug && it.scheme == "http" && it.host in setOf("localhost", "127.0.0.1", "10.0.2.2"))
            }
        }
    }
}

internal interface ClientVault {
    fun read(slot: String): String?
    fun write(slot: String, value: String?)
}

internal class BackendFailure(
    val code: String,
    val detail: JSONObject? = null,
    val status: Int = 0,
) : IOException(code) {
    val transient: Boolean get() = status == 429 || status >= 500 || code in setOf("NETWORK", "RETRY", "40P01")
}

private data class DeviceSession(val access: String, val refresh: String, val expiresAt: Instant) {
    fun encode() = json("access_token" to access, "refresh_token" to refresh, "expires_at" to expiresAt.epochSecond)

    companion object {
        fun from(response: JSONObject): DeviceSession {
            val expiration = response.optLong("expires_at").takeIf { it > 0 }
                ?: (Instant.now().epochSecond + response.optLong("expires_in", 3600))
            return DeviceSession(response.getString("access_token"), response.getString("refresh_token"), Instant.ofEpochSecond(expiration))
        }
    }
}

internal class VehicleBackend(private val config: BackendConfig, private val vault: ClientVault) {
    private val authLock = Mutex()
    private var restored = false
    private var session: DeviceSession? = null

    suspend fun rpc(name: String, arguments: JSONObject = JSONObject()): JSONObject {
        val access = authenticate().access
        try {
            return invokeRpc(name, arguments, access)
        } catch (failure: BackendFailure) {
            if (failure.status != 401) throw failure
        }
        return invokeRpc(name, arguments, authenticate(rejectedAccess = access).access)
    }

    private suspend fun invokeRpc(name: String, arguments: JSONObject, access: String): JSONObject {
        val request = suspend { unwrap(request("/rest/v1/rpc/$name", arguments, access)) }
        return try {
            request()
        } catch (failure: BackendFailure) {
            if (failure.code !in setOf("RETRY", "40P01")) throw failure
            request()
        }
    }

    private suspend fun authenticate(rejectedAccess: String? = null): DeviceSession = authLock.withLock {
        if (!restored) {
            session = withContext(Dispatchers.IO) {
                vault.read(SESSION)?.let { stored -> runCatching { DeviceSession.from(JSONObject(stored)) }.getOrNull() }
            }
            restored = true
        }
        val old = session
        if (old != null && old.access != rejectedAccess && old.expiresAt.isAfter(Instant.now().plusSeconds(60))) {
            return@withLock old
        }
        withContext(NonCancellable) {
            val next = if (old == null) signUp() else try {
                request("/auth/v1/token?grant_type=refresh_token", json("refresh_token" to old.refresh)).let(DeviceSession::from)
            } catch (failure: BackendFailure) {
                if (failure.status != 401 && failure.code !in setOf("refresh_token_not_found", "refresh_token_already_used", "session_not_found")) {
                    throw failure
                }
                // A revoked anonymous identity cannot recover a pairing.
                withContext(Dispatchers.IO) {
                    vault.write(SESSION, null)
                    vault.write(FEED_SLOT, null)
                    vault.write(TICKET_SLOT, null)
                    vault.write(NAV_REPORT_SLOT, null)
                }
                session = null
                throw BackendFailure("SESSION_EXPIRED")
            }
            withContext(Dispatchers.IO) { vault.write(SESSION, next.encode().toString()) }
            session = next
            next
        }
    }

    private suspend fun signUp(): DeviceSession = request("/auth/v1/signup", JSONObject()).let(DeviceSession::from)

    private suspend fun request(path: String, payload: JSONObject, access: String? = null): JSONObject = withContext(Dispatchers.IO) {
        val endpoint = config.origin.resolve(path).toURL()
        val connection = endpoint.openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 8_000
            connection.readTimeout = 8_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("apikey", config.key)
            if (access != null) connection.setRequestProperty("Authorization", "Bearer $access")
            val body = payload.toString().toByteArray(Charsets.UTF_8)
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { reader ->
                val buffer = CharArray(4096)
                buildString {
                    while (true) {
                        val count = reader.read(buffer)
                        if (count < 0) break
                        if (length + count > 1_000_000) throw BackendFailure("RESPONSE_TOO_LARGE")
                        append(buffer, 0, count)
                    }
                }
            }.orEmpty()
            val response = runCatching { JSONObject(text) }.getOrNull()
            if (status !in 200..299) {
                val code = response?.string("error_code") ?: response?.string("code") ?: "HTTP_$status"
                throw BackendFailure(code, response?.optJSONObject("detail"), status)
            }
            response ?: throw BackendFailure("INVALID_RESPONSE")
        } catch (failure: BackendFailure) {
            throw failure
        } catch (_: IOException) {
            throw BackendFailure("NETWORK")
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        private const val SESSION = "session"
        const val FEED_SLOT = "feed"
        const val TICKET_SLOT = "ticket"
        const val NAV_REPORT_SLOT = "nav_report"

        fun unwrap(response: JSONObject): JSONObject {
            if (response.optBoolean("ok")) return response.optJSONObject("data") ?: throw BackendFailure("INVALID_RESPONSE")
            val error = response.optJSONObject("error") ?: throw BackendFailure("INVALID_RESPONSE")
            throw BackendFailure(error.string("code") ?: "INVALID_RESPONSE", error.optJSONObject("detail"))
        }
    }
}

internal fun json(vararg fields: Pair<String, Any?>) = JSONObject().apply {
    for ((key, value) in fields) put(key, value ?: JSONObject.NULL)
}

internal fun JSONObject.string(key: String): String? = if (isNull(key)) null else optString(key).takeIf(String::isNotBlank)
internal fun JSONObject.number(key: String): Double? = optDouble(key).takeIf(Double::isFinite)
internal fun JSONObject.instant(key: String): Instant? = string(key)?.let { runCatching { OffsetDateTime.parse(it).toInstant() }.getOrNull() }
internal fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull(::optJSONObject)
