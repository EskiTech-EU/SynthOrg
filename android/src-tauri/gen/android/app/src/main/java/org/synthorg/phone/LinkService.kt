package org.synthorg.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder

// Keeps the app's process running while it is in the background, so the I2P
// router and the link with the computer stay up when the user switches to
// another app for a moment. Android freezes a background process after a few
// seconds; a foreground service, shown by its notification, is how an app
// asks to keep running. It lives as long as the app: removing the app from the
// recent apps, or "Chiudi" in the notification, stops both.
class LinkService : Service() {
  companion object {
    private const val CHANNEL = "link"
    private const val ID = 1
    const val ACTION_CLOSE = "org.synthorg.phone.CLOSE"

    fun start(context: Context) {
      val intent = Intent(context, LinkService::class.java)
      if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, LinkService::class.java))
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_CLOSE) {
      sendBroadcast(Intent(ACTION_CLOSE).setPackage(packageName))
      stopSelf()
      return START_NOT_STICKY
    }
    val notification = notification()
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(ID, notification)
    }
    return START_NOT_STICKY
  }

  // The app was swiped away from the recent apps: the link ends with it.
  override fun onTaskRemoved(rootIntent: Intent?) {
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  private fun notification(): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
      val channel = NotificationChannel(CHANNEL, getString(R.string.link_channel), NotificationManager.IMPORTANCE_LOW)
      channel.setShowBadge(false)
      manager.createNotificationChannel(channel)
    }
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val open = PendingIntent.getActivity(this, 0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), flags)
    val close = PendingIntent.getService(this, 1,
      Intent(this, LinkService::class.java).setAction(ACTION_CLOSE), flags)
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
    return builder
      .setSmallIcon(R.drawable.ic_link)
      .setContentTitle(getString(R.string.link_title))
      .setContentText(getString(R.string.link_text))
      .setContentIntent(open)
      .setOngoing(true)
      .addAction(Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_link), getString(R.string.link_close), close).build())
      .build()
  }
}
