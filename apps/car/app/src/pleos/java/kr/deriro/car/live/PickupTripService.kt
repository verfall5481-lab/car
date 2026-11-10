package kr.deriro.car.live

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import kr.deriro.car.R
import kr.deriro.car.ui.LiveCopy

/**
 * Foreground service held only while a pickup is in progress (en route). It owns no logic: it keeps the process at
 * foreground priority while the navigation app is in front, so the view model keeps syncing, uploading vehicle state
 * and raising heads-up alerts (spec 13.3). Pleos approval of this service type is still to be verified (VR-07).
 */
class PickupTripService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        LiveNotifications.ensureChannels(this)
        val notification = Notification.Builder(this, LiveNotifications.TRIP_CHANNEL)
            .setSmallIcon(R.drawable.ic_deriro)
            .setContentTitle(LiveCopy.tripServiceTitle)
            .setContentText(LiveCopy.tripServiceDetail)
            .setOngoing(true)
            .setContentIntent(LiveNotifications.openApp(this, null, null))
            .build()
        val started = runCatching {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(LiveNotifications.TRIP_NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(LiveNotifications.TRIP_NOTIFICATION_ID, notification)
            }
        }.isSuccess
        if (!started) stopSelf()
        return START_NOT_STICKY
    }

    /** Android 15 limits data-sync services; stop cleanly when the system asks. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        stopSelf()
    }
}

internal class AndroidTripKeeper(private val context: Context) : TripKeeper {
    private var running = false

    override fun update(tripActive: Boolean, foreground: Boolean) {
        val intent = Intent(context, PickupTripService::class.java)
        if (tripActive && !running) {
            // Starting from the background can be refused; the next foreground update tries again.
            running = runCatching { context.startForegroundService(intent) }.isSuccess
        } else if (!tripActive && running) {
            runCatching { context.stopService(intent) }
            running = false
        }
    }
}
