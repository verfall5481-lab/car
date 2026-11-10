package kr.deriro.car.live

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.media.RingtoneManager
import android.os.Build
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kr.deriro.car.PleosActivity
import kr.deriro.car.R
import kr.deriro.car.ui.LiveCopy

internal data class CardCommand(val alertKey: String, val action: String?)

/** Hands notification button presses to the live view model without opening the app (spec 13.3). */
internal object LiveCarActionBus {
    private val commands = MutableSharedFlow<CardCommand>(extraBufferCapacity = 8)
    val flow: SharedFlow<CardCommand> = commands.asSharedFlow()

    /** False when no view model is listening; the notification then stays so it can still be opened. */
    fun dispatch(command: CardCommand): Boolean = commands.subscriptionCount.value > 0 && commands.tryEmit(command)
}

internal object LiveNotifications {
    const val ALERT_CHANNEL = "pickup_alerts"
    const val TRIP_CHANNEL = "pickup_trip"
    const val CARD_NOTIFICATION_ID = 1
    const val TRIP_NOTIFICATION_ID = 2
    const val EXTRA_CARD = "kr.deriro.car.extra.CARD"
    const val EXTRA_ACTION = "kr.deriro.car.extra.ACTION"
    private const val ACTION_CARD = "kr.deriro.car.action.CARD"

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        runCatching {
            manager.createNotificationChannel(
                NotificationChannel(ALERT_CHANNEL, LiveCopy.alertChannel, NotificationManager.IMPORTANCE_HIGH).apply {
                    description = LiveCopy.alertChannelDetail
                },
            )
            manager.createNotificationChannel(
                NotificationChannel(TRIP_CHANNEL, LiveCopy.tripChannel, NotificationManager.IMPORTANCE_LOW).apply {
                    description = LiveCopy.tripChannelDetail
                    setShowBadge(false)
                },
            )
        }
    }

    fun allowed(context: Context): Boolean {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return false
        val granted = Build.VERSION.SDK_INT < 33 ||
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        return granted && runCatching { manager.areNotificationsEnabled() }.getOrDefault(false)
    }

    /** Opens (or brings forward) the app, optionally running a card action once it is in front. */
    fun openApp(context: Context, alertKey: String?, action: String?): PendingIntent {
        val intent = Intent(context, PleosActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_CARD, alertKey).putExtra(EXTRA_ACTION, action)
        return PendingIntent.getActivity(context, requestCode("open", alertKey, action), intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    fun cardAction(context: Context, alertKey: String, action: String): PendingIntent {
        val intent = Intent(context, CardActionReceiver::class.java).setAction(ACTION_CARD)
            .putExtra(EXTRA_CARD, alertKey).putExtra(EXTRA_ACTION, action)
        return PendingIntent.getBroadcast(context, requestCode("act", alertKey, action), intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun requestCode(kind: String, key: String?, action: String?) = "$kind|$key|$action".hashCode()
}

/** Plays the system notification sound in the foreground and posts a heads-up notification in the background. */
internal class AndroidCardAlerts(private val context: Context) : CardAlerts {
    private val notifications = context.getSystemService(NotificationManager::class.java)
    private val posted = mutableSetOf<String>()

    override fun announce(card: FeedCard, foreground: Boolean, actions: List<String>) {
        if (foreground || !LiveNotifications.allowed(context) || notifications == null) {
            playSound()
            return
        }
        LiveNotifications.ensureChannels(context)
        val builder = Notification.Builder(context, LiveNotifications.ALERT_CHANNEL)
            .setSmallIcon(R.drawable.ic_deriro)
            .setContentTitle(LiveCopy.headsUpTitle(card))
            .setContentText(LiveCopy.headsUpBody(card))
            .setCategory(if (card.urgent) Notification.CATEGORY_STATUS else Notification.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(LiveNotifications.openApp(context, card.alertKey, null))
        for (action in actions) {
            val label = LiveCopy.action(action, card.offerId != null) ?: continue
            // Starting guidance and confirming a location need the app in front; the rest run without opening it.
            val intent = if (action in setOf("start_now", "location")) LiveNotifications.openApp(context, card.alertKey, action)
                else LiveNotifications.cardAction(context, card.alertKey, action)
            builder.addAction(Notification.Action.Builder(Icon.createWithResource(context, R.drawable.ic_deriro), label, intent).build())
        }
        val shown = runCatching { notifications.notify(card.alertKey, LiveNotifications.CARD_NOTIFICATION_ID, builder.build()) }.isSuccess
        if (shown) synchronized(posted) { posted += card.alertKey } else playSound()
    }

    override fun retain(alertKeys: Set<String>) {
        val stale = synchronized(posted) {
            posted.filter { it !in alertKeys }.also { posted.removeAll(it.toSet()) }
        }
        for (key in stale) runCatching { notifications?.cancel(key, LiveNotifications.CARD_NOTIFICATION_ID) }
    }

    private fun playSound() {
        runCatching { RingtoneManager.getRingtone(context, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION))?.play() }
    }
}

/** Receives heads-up button presses. Not exported; only this app's immutable PendingIntents reach it. */
class CardActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val key = intent.getStringExtra(LiveNotifications.EXTRA_CARD) ?: return
        val action = intent.getStringExtra(LiveNotifications.EXTRA_ACTION) ?: return
        if (LiveCarActionBus.dispatch(CardCommand(key, action))) {
            runCatching {
                context.getSystemService(NotificationManager::class.java)?.cancel(key, LiveNotifications.CARD_NOTIFICATION_ID)
            }
        }
    }
}
