package com.akshay.lazyvault.service

import android.util.Log
import com.akshay.lazyvault.data.TransferRequest
import com.akshay.lazyvault.net.VaultApiClient
import com.akshay.lazyvault.storage.VaultPreferences
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class LazyVaultFirebaseMessagingService : FirebaseMessagingService() {

    private val TAG = "LazyVaultFCM"
    private val scope = CoroutineScope(Dispatchers.IO)
    private val apiClient = VaultApiClient()

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.d(TAG, "New FCM Registration Token: $token")
        val prefs = VaultPreferences(applicationContext)
        prefs.fcmToken = token

        val backend = prefs.backendUrl
        if (backend.isNotEmpty() && !backend.contains("192.168.10.15")) {
            scope.launch {
                try {
                    apiClient.registerDevice(
                        backendUrl = backend,
                        deviceId = prefs.deviceId,
                        deviceName = prefs.deviceName,
                        fcmToken = token
                    )
                } catch (e: Exception) {
                    Log.w(TAG, "Failed to register new FCM token with broker", e)
                }
            }
        }
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)
        Log.d(TAG, "FCM Message Received from: ${remoteMessage.from}")

        val data = remoteMessage.data
        val action = data["action"]

        if (action == "REQUEST_APPROVAL") {
            val requestId = data["request_id"] ?: return
            val path = data["path"] ?: "unknown_file"
            val sha256 = data["sha256"] ?: ""
            val requesterContext = data["requester_context"] ?: "External Requester"
            val requesterIp = data["requester_ip"] ?: "Unknown IP"
            val transportsStr = data["supported_transports"] ?: "webrtc,relay"
            val expiresAtStr = data["expires_at"]
            val expiresAt = expiresAtStr?.toLongOrNull() ?: (System.currentTimeMillis() + 60000L)

            val supportedTransports = transportsStr.split(",").map { it.trim() }

            val transferRequest = TransferRequest(
                requestId = requestId,
                path = path,
                sha256 = sha256,
                requesterContext = requesterContext,
                requesterIp = requesterIp,
                supportedTransports = supportedTransports,
                expiresAt = expiresAt
            )

            // STRICT: Do NOT stream in background. Post immediate heads-up notification.
            VaultNotificationManager.showTransferRequestNotification(applicationContext, transferRequest)
        }
    }
}
