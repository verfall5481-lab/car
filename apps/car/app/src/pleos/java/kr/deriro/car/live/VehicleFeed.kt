package kr.deriro.car.live

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt
import kr.deriro.car.data.vehicle.Gear
import kr.deriro.car.data.vehicle.LatLng
import kr.deriro.car.data.vehicle.VehicleSnapshot
import kr.deriro.car.nav.Destination
import kr.deriro.car.nav.NavResult
import org.json.JSONObject

internal data class PairTicket(val code: String, val url: String?, val expiresAt: Instant) {
    fun encode() = json("code" to code, "url" to url, "expires_at" to expiresAt.toString())

    companion object {
        fun from(value: JSONObject): PairTicket {
            val code = value.string("code")?.replace("-", "")?.takeIf { it.matches(Regex("[A-Z2-9]{6}")) }
                ?: throw BackendFailure("INVALID_RESPONSE")
            val expiration = value.instant("expires_at") ?: throw BackendFailure("INVALID_RESPONSE")
            return PairTicket(code, value.string("url"), expiration)
        }
    }
}

internal data class LiveDriver(val id: String, val name: String) {
    companion object {
        fun from(value: JSONObject?): LiveDriver? = value?.let {
            val id = it.string("id") ?: return null
            LiveDriver(id, it.string("display_name") ?: "")
        }
    }
}

internal data class LiveVehicle(val id: String, val name: String?, val family: String?, val driver: LiveDriver?) {
    companion object {
        fun from(value: JSONObject): LiveVehicle = LiveVehicle(
            value.getString("id"), value.string("nickname"), value.string("family_name"),
            LiveDriver.from(value.optJSONObject("current_driver")),
        )
    }
}

internal data class SavedPlace(val id: String, val label: String, val location: LatLng, val distanceM: Int?) {
    companion object {
        fun from(value: JSONObject): SavedPlace? {
            val id = value.string("id") ?: return null
            val label = value.string("label") ?: value.string("name") ?: return null
            val location = value.point() ?: return null
            return SavedPlace(id, label, location, value.number("distance_m")?.toInt())
        }
    }
}

internal data class LivePickup(
    val id: String,
    val version: Int,
    val rider: String?,
    val label: String?,
    val note: String?,
    val location: LatLng?,
    val locationConfirmed: Boolean,
    val wantedAt: Instant?,
    val status: String,
    val assignee: String?,
    val assigneeId: String?,
    val vehicleId: String?,
    val navStatus: String?,
    val destinationRevision: Int?,
    val accuracyM: Int?,
) {
    val placeLine: String? get() = label?.let { if (note.isNullOrBlank()) it else "$it, ‘$note’" }
    val timeLabel: String? get() = wantedAt?.let(TIME_FORMAT::format)
    fun canStartInWindow(at: Instant) = status != "open" || wantedAt?.isAfter(at.plusSeconds(900)) != true

    companion object {
        private val TIME_FORMAT = DateTimeFormatter.ofPattern("HH:mm", Locale.KOREA).withZone(ZoneId.of("Asia/Seoul"))

        fun from(value: JSONObject, base: LivePickup? = null): LivePickup? {
            val id = value.string("pickup_id") ?: value.string("id") ?: return null
            val version = value.optInt("version", base?.version ?: 0).takeIf { it > 0 } ?: return null
            val dest = value.optJSONObject("dest")
            return LivePickup(
                id, version, value.string("rider_name") ?: value.string("child_name") ?: base?.rider,
                value.string("dest_label") ?: dest?.string("label") ?: base?.label,
                value.string("pin_note") ?: dest?.string("note") ?: base?.note,
                dest?.point() ?: value.point("dest_lat", "dest_lng") ?: base?.location,
                value.optBoolean("location_confirmed", base?.locationConfirmed ?: false),
                value.instant("wanted_at") ?: base?.wantedAt,
                value.string("status") ?: base?.status ?: "open",
                value.string("assignee_display_name") ?: value.string("assignee_name")
                    ?: value.optJSONObject("assignee")?.string("display_name") ?: base?.assignee,
                value.string("assignee_member_id") ?: base?.assigneeId,
                value.string("vehicle_id") ?: base?.vehicleId,
                value.string("nav_status") ?: base?.navStatus,
                value.optInt("destination_revision", base?.destinationRevision ?: 0).takeIf { it > 0 },
                value.number("accuracy_m")?.toInt() ?: base?.accuracyM,
            )
        }
    }
}

internal data class FeedCard(
    val kind: String,
    val pickup: LivePickup?,
    val offerId: String?,
    val offerFrom: String?,
    val offerNote: String?,
    val primary: String?,
    val secondary: String?,
    val requiredKm: Double?,
    val alertId: String?,
    val nearby: List<SavedPlace>,
    val version: Int?,
) {
    val key: String get() = "${kind}/${pickup?.id.orEmpty()}/${offerId.orEmpty()}/${alertId.orEmpty()}/${version ?: 0}"
    val parkedOnly: Boolean get() = kind in setOf("boarding_check", "low_range")
}

internal data class RangeAlert(val id: String, val rangeKm: Double?, val requiredKm: Double?, val pickupCount: Int?)
internal data class LiveTrip(val pickup: LivePickup, val sessionId: String, val destinationRevision: Int)
internal data class FeedTelemetry(
    val rangeKm: Double?, val fuelPct: Double?, val socPct: Double?, val collectedAt: Instant, val isDemoValue: Boolean,
)

internal data class VehicleFeed(
    val vehicle: LiveVehicle,
    val drivers: List<LiveDriver>,
    val cards: List<FeedCard>,
    val today: List<LivePickup>,
    val activeTrip: LiveTrip?,
    val alerts: List<RangeAlert>,
    val places: List<SavedPlace>,
    val serverTime: Instant?,
    val telemetry: FeedTelemetry?,
    val rangeVerdict: String?,
) {
    fun nearby(pickup: LivePickup): List<SavedPlace> {
        val position = pickup.location ?: return emptyList()
        val choices = cards.firstOrNull { it.pickup?.id == pickup.id }?.nearby.orEmpty().ifEmpty { places }
        return choices.map { place -> place.copy(distanceM = position.metersTo(place.location)) }
            .filter { (it.distanceM ?: Int.MAX_VALUE) <= 1_000 }
            .sortedBy(SavedPlace::distanceM).take(3)
    }

    companion object {
        fun from(value: JSONObject): VehicleFeed {
            val vehicle = LiveVehicle.from(value.getJSONObject("vehicle"))
            val today = value.optJSONArray("today").objects().mapNotNull { LivePickup.from(it) }
            val byId = today.associateBy(LivePickup::id)
            val cards = value.optJSONArray("cards").objects().mapNotNull { item ->
                val kind = item.string("kind") ?: return@mapNotNull null
                val pickup = LivePickup.from(item, byId[item.string("pickup_id")])
                FeedCard(kind, pickup, item.string("offer_id"), item.string("from_name") ?: item.string("offer_from_name"),
                    item.string("note") ?: item.string("offer_note"), item.string("primary_action"), item.string("secondary_action"),
                    item.number("required_km"), item.string("alert_id"), item.optJSONArray("nearby_places").objects().mapNotNull(SavedPlace::from),
                    item.optInt("version").takeIf { it > 0 })
            }
            val trip = value.optJSONObject("active_trip")?.let { item ->
                val id = item.string("pickup_id") ?: item.string("active_pickup_id")
                val base = byId[id]
                val pickup = item.optJSONObject("pickup")?.let { LivePickup.from(it, base) } ?: LivePickup.from(item, base)
                val session = item.string("nav_session_id") ?: item.string("active_nav_session_id")
                val revision = item.optInt("destination_revision", item.optInt("active_destination_revision"))
                if (pickup != null && session != null && revision > 0) LiveTrip(pickup, session, revision) else null
            }
            val alerts = value.optJSONArray("alerts").objects().mapNotNull { item ->
                val id = item.string("id") ?: return@mapNotNull null
                if (item.string("type")?.let { it != "low_range" } == true) return@mapNotNull null
                RangeAlert(id, item.number("range_km"), item.number("required_km"), item.number("pickup_count")?.toInt())
            }
            val telemetry = value.optJSONObject("state")?.let { item ->
                item.instant("collected_at")?.let { collected ->
                    FeedTelemetry(item.number("range_km"), item.number("fuel_pct"), item.number("soc_pct"), collected, item.optBoolean("is_demo_value"))
                }
            }
            return VehicleFeed(vehicle, value.optJSONArray("drivers").objects().mapNotNull(LiveDriver::from), cards,
                today, trip, alerts, value.optJSONArray("nearby_places").objects().mapNotNull(SavedPlace::from),
                value.instant("server_time"), telemetry, value.optJSONObject("range")?.string("verdict"))
        }
    }
}

internal data class StartPayload(val pickup: LivePickup, val destination: Destination) {
    companion object {
        fun from(value: JSONObject, base: LivePickup): StartPayload {
            val pickup = value.optJSONObject("pickup")?.let { LivePickup.from(it, base) }
            val dest = value.optJSONObject("dest")
            val point = dest?.point()
            val session = value.string("nav_session_id")
            val revision = value.optInt("destination_revision")
            if (pickup == null || pickup.id != base.id || pickup.status != "en_route" || point == null || session == null ||
                revision < 1 || pickup.destinationRevision != revision
            ) throw BackendFailure("INVALID_ROUTE_RESPONSE")
            val label = dest.string("label") ?: pickup.label ?: throw BackendFailure("INVALID_ROUTE_RESPONSE")
            return StartPayload(pickup, Destination(point, label, pickup.id, session, revision))
        }
    }
}

internal fun VehicleSnapshot.uploadArguments() = json(
    "p_range_km" to rangeKm, "p_fuel_pct" to fuelPct, "p_soc_pct" to socPct,
    "p_energy_type" to if (energyType.name == "FUEL") "ice" else energyType.name.lowercase(Locale.ROOT),
    "p_ignition" to ignition.name.lowercase(Locale.ROOT),
    "p_gear" to when (gear) {
        Gear.PARK -> "P"
        Gear.REVERSE -> "R"
        Gear.NEUTRAL -> "N"
        Gear.DRIVE -> "D"
        Gear.UNKNOWN -> "unknown"
    },
    "p_lat" to location?.lat, "p_lng" to location?.lng, "p_location_at" to locationAt?.toString(),
    "p_collected_at" to collectedAt.toString(), "p_is_demo_value" to isDemoValue,
)

internal fun NavResult.reportArguments(destination: Destination): JSONObject {
    val error = when (this) {
        is NavResult.Failed -> code
        is NavResult.MapOpened -> sdkError
        NavResult.Requested -> null
    }
    return json("p_pickup_id" to destination.pickupId, "p_nav_session_id" to destination.navSessionId,
        "p_result" to if (this == NavResult.Requested) "ok" else "failed",
        "p_error_code" to error?.takeIf { it.matches(Regex("[A-Za-z0-9_-]{1,64}")) })
}

private fun JSONObject.point(latKey: String = "lat", lngKey: String = "lng"): LatLng? {
    val lat = number(latKey) ?: return null
    val lng = number(lngKey) ?: return null
    return LatLng(lat, lng).takeIf(LatLng::isValid)
}

private fun LatLng.metersTo(other: LatLng): Int {
    val latStep = Math.toRadians(other.lat - lat) / 2
    val lngStep = Math.toRadians(other.lng - lng) / 2
    val a = sin(latStep) * sin(latStep) + cos(Math.toRadians(lat)) * cos(Math.toRadians(other.lat)) * sin(lngStep) * sin(lngStep)
    return (2 * 6_371_000 * asin(sqrt(a.coerceIn(0.0, 1.0)))).roundToInt()
}
