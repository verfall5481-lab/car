package kr.deriro.car.demo

import kr.deriro.car.data.vehicle.LatLng
import kr.deriro.car.domain.LocationSource
import kr.deriro.car.domain.Pickup
import kr.deriro.car.domain.PickupLocation
import kr.deriro.car.domain.PickupPhase

internal object DemoFixtures {
    val academy = PickupLocation(
        place = "수학학원",
        coordinates = LatLng(37.49979, 127.03561),
        source = LocationSource.SAVED_PLACE,
    )

    fun scheduled() = Pickup("scheduled", "민준", "17:30", academy, PickupPhase.ASSIGNED, 18)

    fun request(confirmed: Boolean): Pickup = if (confirmed) {
        Pickup(
            id = "pin-request", rider = "할머니", timeLabel = "지금", phase = PickupPhase.REQUESTED, roundTripKm = 14,
            location = PickupLocation(
                place = "정형외과", boardingPoint = "후문", note = "후문 벤치",
                coordinates = LatLng(37.49863, 127.03428), source = LocationSource.MAP_PIN,
            ),
        )
    } else {
        Pickup(
            id = "gps-request", rider = "민준", timeLabel = "지금", phase = PickupPhase.REQUESTED, roundTripKm = null,
            location = PickupLocation(
                place = "역삼동 근처", coordinates = LatLng(37.50081, 127.03194), source = LocationSource.GPS,
            ),
        )
    }
}
