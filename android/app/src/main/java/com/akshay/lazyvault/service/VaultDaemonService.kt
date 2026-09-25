package com.akshay.lazyvault.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import com.akshay.lazyvault.net.FirebaseVaultManager
import com.akshay.lazyvault.storage.VaultPreferences

class VaultDaemonService : Service() {

    private val TAG = "VaultDaemonService"
    private var wakeLock: PowerManager.WakeLock? = null
    private var firebaseVaultManager: FirebaseVaultManager? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "VaultDaemonService created")
        firebaseVaultManager = FirebaseVaultManager(this)
        acquireWakeLock()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val prefs = VaultPreferences(this)
        val vaultId = prefs.vaultId
        val deviceName = prefs.deviceName

        Log.d(TAG, "VaultDaemonService onStartCommand for vault: $vaultId")

        val notification = VaultNotificationManager.buildDaemonNotification(
            this,
            vaultId = vaultId,
            deviceName = deviceName
        )

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                VaultNotificationManager.NOTIFICATION_ID_DAEMON,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            startForeground(VaultNotificationManager.NOTIFICATION_ID_DAEMON, notification)
        }

        // 24/7 background listener: receives Firestore request events even when app is minimized / screen off
        firebaseVaultManager?.startListeningForRequests { request ->
            Log.d(TAG, "Background daemon received request: ${request.requestId} for ${request.path}")
            VaultNotificationManager.showTransferRequestNotification(this, request)
        }

        return START_STICKY
    }

    private fun acquireWakeLock() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "LazyVault::DaemonListenerWakeLock"
            ).apply {
                setReferenceCounted(false)
                acquire(24 * 60 * 60 * 1000L) // 24h safety limit
            }
            Log.d(TAG, "Acquired partial wake lock for background daemon")
        } catch (e: Exception) {
            Log.w(TAG, "Failed acquiring wake lock", e)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        Log.d(TAG, "VaultDaemonService destroyed")
        firebaseVaultManager?.stopListening()
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Error releasing wake lock", e)
        }
    }
}
