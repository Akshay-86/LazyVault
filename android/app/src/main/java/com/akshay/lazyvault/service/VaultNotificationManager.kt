package com.akshay.lazyvault.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.akshay.lazyvault.MainActivity
import com.akshay.lazyvault.R
import com.akshay.lazyvault.data.TransferRequest

object VaultNotificationManager {
    const val CHANNEL_ID_REQUESTS = "lazyvault_requests_channel"
    const val CHANNEL_ID_TRANSFERS = "lazyvault_transfers_channel"
    const val CHANNEL_ID_DAEMON = "lazyvault_daemon_channel"
    const val NOTIFICATION_ID_PROGRESS = 9999
    const val NOTIFICATION_ID_DAEMON = 8888

    fun createNotificationChannels(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

            val daemonChannel = NotificationChannel(
                CHANNEL_ID_DAEMON,
                "Vault Background Node Status",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows persistent status that the mobile node is active and listening for secure requests"
                setShowBadge(false)
            }
            notificationManager.createNotificationChannel(daemonChannel)

            val requestChannel = NotificationChannel(
                CHANNEL_ID_REQUESTS,
                "Vault Transfer Authorization Requests",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Urgent high-priority prompts requiring cryptographic user approval for data lease release"
                enableVibration(true)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            notificationManager.createNotificationChannel(requestChannel)

            val transferChannel = NotificationChannel(
                CHANNEL_ID_TRANSFERS,
                "Active Data Transfers",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows real-time chunked transfer progress during approved sessions"
            }
            notificationManager.createNotificationChannel(transferChannel)
        }
    }

    fun showTransferRequestNotification(context: Context, request: TransferRequest) {
        createNotificationChannels(context)
        val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        val filename = request.path.substringAfterLast('/')

        val contentIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            putExtra("request_id", request.requestId)
        }
        val contentPendingIntent = PendingIntent.getActivity(
            context,
            request.requestId.hashCode(),
            contentIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val allowIntent = Intent(context, TransferActionReceiver::class.java).apply {
            action = TransferActionReceiver.ACTION_ALLOW
            putExtra("request_id", request.requestId)
            putExtra("path", request.path)
            putExtra("sha256", request.sha256)
            putExtra("requester_context", request.requesterContext)
            putExtra("requester_ip", request.requesterIp)
            putStringArrayListExtra("supported_transports", ArrayList(request.supportedTransports))
            putExtra("expires_at", request.expiresAt)
        }
        val allowPendingIntent = PendingIntent.getBroadcast(
            context,
            (request.requestId + "_allow").hashCode(),
            allowIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val denyIntent = Intent(context, TransferActionReceiver::class.java).apply {
            action = TransferActionReceiver.ACTION_DENY
            putExtra("request_id", request.requestId)
            putExtra("path", request.path)
            putExtra("requester_context", request.requesterContext)
        }
        val denyPendingIntent = PendingIntent.getBroadcast(
            context,
            (request.requestId + "_deny").hashCode(),
            denyIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(context, CHANNEL_ID_REQUESTS)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("Vault Request: $filename")
            .setContentText("Requester: ${request.requesterContext} (IP: ${request.requesterIp})")
            .setStyle(
                NotificationCompat.BigTextStyle()
                    .bigText(
                        "Incoming lease request for file: ${request.path}\n" +
                        "Requester: ${request.requesterContext}\n" +
                        "IP Address: ${request.requesterIp}\n" +
                        "Target SHA-256: ${request.sha256.take(16)}...\n" +
                        "Transports: ${request.supportedTransports.joinToString(", ")}\n" +
                        "Action strictly required: Zero-Trust gate."
                    )
            )
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setContentIntent(contentPendingIntent)
            .addAction(0, "ALLOW", allowPendingIntent)
            .addAction(0, "DENY", denyPendingIntent)

        val notificationId = request.requestId.hashCode()
        notificationManager.notify(notificationId, builder.build())
    }

    fun buildProgressNotification(context: Context, filename: String, progressPercent: Int, statusText: String): Notification {
        createNotificationChannels(context)

        return NotificationCompat.Builder(context, CHANNEL_ID_TRANSFERS)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("LazyVault: Streaming $filename")
            .setContentText(statusText)
            .setProgress(100, progressPercent, progressPercent == 0)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    fun buildDaemonNotification(context: Context, vaultId: String, deviceName: String): Notification {
        createNotificationChannels(context)
        val contentIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            0,
            contentIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(context, CHANNEL_ID_DAEMON)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("LazyVault Active · $deviceName")
            .setContentText("Listening for zero-trust requests ($vaultId)")
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    fun dismissNotification(context: Context, requestId: String) {
        val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.cancel(requestId.hashCode())
    }
}
