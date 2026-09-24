package com.akshay.lazyvault.service

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
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
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

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

        // Acquire WakeLock & WifiLock to keep CPU & network hardware alive through deep sleep / screen off
        try {
            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LazyVault:TransferWakeLock").apply {
                setReferenceCounted(false)
                acquire(30 * 60 * 1000L) // 30 mins max safety limit
            }
            val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            wifiLock = wifiManager?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "LazyVault:TransferWifiLock")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed acquiring WakeLock/WifiLock: ${e.message}")
        }

        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val transferEngine = TransferEngine(applicationContext)

        transferJob = scope.launch {
            Log.d(TAG, "Starting Foreground Service transfer for $requestId")
            try {
                var lastNotifyTime = 0L
                var lastPercent = -1

                val success = transferEngine.executeTransfer(
                    requestId = requestId,
                    path = path,
                    targetSha256 = sha256,
                    supportedTransports = transports
                ) { percent, status ->
                    val now = System.currentTimeMillis()
                    if (now - lastNotifyTime >= 300L || percent != lastPercent || percent >= 100) {
                        lastNotifyTime = now
                        lastPercent = percent
                        val updatedNotif = VaultNotificationManager.buildProgressNotification(
                            this@ForegroundDataTransferService,
                            filename,
                            progressPercent = percent,
                            statusText = status
                        )
                        notificationManager.notify(VaultNotificationManager.NOTIFICATION_ID_PROGRESS, updatedNotif)
                    }
                }

                Log.d(TAG, "Foreground transfer finished for $requestId. Success: $success")
            } finally {
                try {
                    if (wakeLock?.isHeld == true) wakeLock?.release()
                    if (wifiLock?.isHeld == true) wifiLock?.release()
                } catch (ignored: Exception) {}
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }

        return START_NOT_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        transferJob?.cancel()
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
            if (wifiLock?.isHeld == true) wifiLock?.release()
        } catch (ignored: Exception) {}
    }
}
