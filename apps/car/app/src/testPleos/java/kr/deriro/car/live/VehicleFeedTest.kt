package kr.deriro.car.live

import java.time.Instant
import kr.deriro.car.data.vehicle.LatLng
import kr.deriro.car.nav.Destination
import kr.deriro.car.nav.NavResult
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VehicleFeedTest {
    @Test
    fun parsesTheActualSqlGeneratedFeed() {
        val text = checkNotNull(javaClass.getResourceAsStream("/vehicle_get_feed.json"))
            .bufferedReader(Charsets.UTF_8).use { it.readText() }
        val feed = VehicleFeed.from(VehicleBackend.unwrap(JSONObject(text)))
        assertEquals("테스트 가족", feed.vehicle.family)
        assertEquals("아빠", feed.vehicle.driver?.name)
        val scheduled = feed.today.single { it.status == "assigned" }
        assertEquals("아빠", scheduled.assignee)
        assertEquals("17:30", scheduled.timeLabel)
        val card = feed.cards.single()
        assertEquals("child_request", card.kind)
        assertEquals("start_now", card.primary)
        assertEquals("decline", card.secondary)
        assertEquals("할머니", card.pickup?.rider)
        assertEquals("후문, ‘후문 벤치’", card.pickup?.placeLine)
        assertEquals("수학학원", feed.nearby(checkNotNull(card.pickup)).single().label)
        val serverTime = checkNotNull(feed.serverTime)
        assertTrue(checkNotNull(card.pickup).canStartInWindow(serverTime))
        assertFalse(card.pickup.copy(wantedAt = serverTime.plusSeconds(901)).canStartInWindow(serverTime))
        assertEquals(5.0, checkNotNull(feed.telemetry?.rangeKm), 0.0)
        assertEquals("check_required", feed.rangeVerdict)
        assertTrue(feed.alerts.isEmpty())
    }

    @Test
    fun readsFamilyMemberPinsOffersAndParkedSavedPlaces() {
        val request = json("id" to "p", "rider_name" to "할머니", "dest_label" to "정형외과 후문", "pin_note" to "후문 벤치",
            "dest_lat" to 37.5, "dest_lng" to 127.0, "location_confirmed" to true, "status" to "assigned", "version" to 3,
            "destination_revision" to 2, "assignee_display_name" to "엄마", "assignee_member_id" to "m", "vehicle_id" to "v",
            "wanted_at" to "2026-11-09T08:30:00+00:00")
        val card = JSONObject(request.toString()).put("pickup_id", "p").put("kind", "offer_to_me")
            .put("offer_id", "offer-1").put("primary_action", "start_now").put("secondary_action", "decline")
        val root = json("vehicle" to json("id" to "v", "nickname" to "우리 차", "family_name" to "우리 가족",
            "current_driver" to json("id" to "m", "display_name" to "엄마")), "today" to JSONArray().put(request),
            "drivers" to JSONArray().put(json("id" to "m", "display_name" to "엄마")), "cards" to JSONArray().put(card),
            "nearby_places" to JSONArray().put(json("id" to "place", "name" to "학교 정문", "lat" to 37.501, "lng" to 127.0)),
            "server_time" to "2026-11-09T08:25:00+00:00")
        val feed = VehicleFeed.from(root)
        val pickup = feed.today.single()
        assertEquals("우리 가족", feed.vehicle.family)
        assertEquals("엄마", pickup.assignee)
        assertEquals("17:30", pickup.timeLabel)
        assertEquals("정형외과 후문, ‘후문 벤치’", pickup.placeLine)
        assertEquals("offer-1", feed.cards.single().offerId)
        assertEquals("학교 정문", feed.nearby(pickup).single().label)
        assertEquals(Instant.parse("2026-11-09T08:25:00Z"), feed.serverTime)
    }

    @Test
    fun rejectsWrongPickupAndRevisionForNavigation() {
        val row = json("id" to "p", "dest_label" to "후문", "status" to "assigned", "version" to 1, "destination_revision" to 2)
        val current = checkNotNull(LivePickup.from(row))
        val response = json("pickup" to JSONObject(row.toString()).put("status", "en_route").put("version", 2),
            "nav_session_id" to "session", "destination_revision" to 2,
            "dest" to json("lat" to 37.5, "lng" to 127.0, "label" to "후문"))
        assertEquals("session", StartPayload.from(response, current).destination.navSessionId)
        assertTrue(runCatching { StartPayload.from(response, current.copy(id = "other")) }.isFailure)
        response.put("destination_revision", 3)
        assertTrue(runCatching { StartPayload.from(response, current) }.isFailure)
        val empty = VehicleFeed.from(json("vehicle" to json("id" to "v", "current_driver" to json("id" to null))))
        assertNull(empty.vehicle.driver)
        assertFalse(empty.today.any())
    }

    @Test
    fun reportsProviderFailuresAndDistinguishesMapFallbackFromGuidance() {
        val destination = Destination(LatLng(37.5, 127.0), "후문", "pickup", "session", 1)
        val mapped = NavResult.MapOpened("NAVI_TIMEOUT").reportArguments(destination)
        assertEquals("pickup", mapped.getString("p_pickup_id"))
        assertEquals("session", mapped.getString("p_nav_session_id"))
        assertEquals("failed", mapped.getString("p_result"))
        assertEquals("NAVI_TIMEOUT", mapped.getString("p_error_code"))
        assertEquals("ok", NavResult.Requested.reportArguments(destination).getString("p_result"))
        assertTrue(NavResult.Failed("invalid raw error").reportArguments(destination).isNull("p_error_code"))
    }
}
