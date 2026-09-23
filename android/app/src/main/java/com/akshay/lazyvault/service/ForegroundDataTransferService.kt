package com.akshay.lazyvault.service

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import com.akshay.lazyvault.engine.TransferEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

class ForegroundDataTransferService : Service() {
    private val TAG = "ForegroundDataService"
    private val scope = CoroutineScope(Dispatchers.IO)
    private var transferJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        val requestId = intent.getStringExtra("request_id") ?: run {
            stopSelf()
            return START_NOT_STICKY
        }
        val path = intent.getStringExtra("path") ?: "unknown_file"
        val sha256 = intent.getStringExtra("sha256") ?: ""
        val transports = intent.getStringArrayListExtra("supported_transports") ?: arrayListOf("webrtc", "relay")

        val filename = path.substringAfterLast('/')

        val initialNotification = VaultNotificationManager.buildProgressNotification(
            this,
            filename,
            progressPercent = 0,
            statusText = "Initializing transfer pipeline..."
        )

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                VaultNotificationManager.NOTIFICATION_ID_PROGRESS,
                initialNotification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            startForeground(VaultNotificationManager.NOTIFICATION_ID_PROGRESS, initialNotification)
        }

        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val transferEngine = TransferEngine(applicationContext)

        transferJob = scope.launch {
            Log.d(TAG, "Starting Foreground Service transfer for $requestId")
            val success = transferEngine.executeTransfer(
                requestId = requestId,
                path = path,
                targetSha256 = sha256,
                supportedTransports = transports
            ) { percent, status ->
                val updatedNotif = VaultNotificationManager.buildProgressNotification(
                    this@ForegroundDataTransferService,
                    filename,
                    progressPercent = percent,
                    statusText = status
                )
                notificationManager.notify(VaultNotificationManager.NOTIFICATION_ID_PROGRESS, updatedNotif)
            }

            Log.d(TAG, "Foreground transfer finished for $requestId. Success: $success")
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }

        return START_NOT_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        transferJob?.cancel()
    }
}
