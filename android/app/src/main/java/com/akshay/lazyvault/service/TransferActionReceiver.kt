package com.akshay.lazyvault.service

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PersistableBundle
import android.util.Log
import androidx.core.content.ContextCompat
import com.akshay.lazyvault.data.AuditLogEntry
import com.akshay.lazyvault.net.FirebaseVaultManager
import com.akshay.lazyvault.net.VaultApiClient
import com.akshay.lazyvault.storage.VaultPreferences
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class TransferActionReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_ALLOW = "com.akshay.lazyvault.ACTION_ALLOW"
        const val ACTION_DENY = "com.akshay.lazyvault.ACTION_DENY"
        private const val TAG = "TransferReceiver"
    }

    private val scope = CoroutineScope(Dispatchers.IO)
    private val apiClient = VaultApiClient()

    override fun onReceive(context: Context, intent: Intent) {
        val requestId = intent.getStringExtra("request_id") ?: return
        val path = intent.getStringExtra("path") ?: "unknown_file"
        val sha256 = intent.getStringExtra("sha256") ?: ""
        val requesterContext = intent.getStringExtra("requester_context") ?: "External Client"
        val transports = intent.getStringArrayListExtra("supported_transports") ?: arrayListOf("webrtc", "relay")

        val prefs = VaultPreferences(context)
        val backendUrl = prefs.backendUrl

        VaultNotificationManager.dismissNotification(context, requestId)

        when (intent.action) {
            ACTION_DENY -> {
                Log.d(TAG, "Transfer DENIED by user for $requestId")
                prefs.addAuditEntry(
                    AuditLogEntry(
                        requestId = requestId,
                        path = path,
                        status = "REJECTED",
                        requester = requesterContext,
                        transport = transports.firstOrNull() ?: "none",
                        timestamp = System.currentTimeMillis(),
                        details = "User tapped DENY on device notification"
                    )
                )

                VaultNotificationManager.dismissNotification(context, requestId)
                FirebaseVaultManager(context).updateRequestStatus(requestId, status = "REJECTED", decision = "DENY")

                scope.launch {
                    if (backendUrl.isNotEmpty() && !backendUrl.contains("192.168.10.15")) {
                        try {
                            apiClient.sendDecision(
                                backendUrl = backendUrl,
                                requestId = requestId,
                                decision = "DENY",
                                reason = "User explicitly denied request on Android node"
                            )
                        } catch (ignored: Exception) {}
                    }
                }
            }

            ACTION_ALLOW -> {
                Log.d(TAG, "Transfer ALLOWED by user for $requestId. Determining transport...")
                VaultNotificationManager.dismissNotification(context, requestId)
                val selectedTransport = if (transports.contains("webrtc")) "webrtc" else "relay"

                prefs.addAuditEntry(
                    AuditLogEntry(
                        requestId = requestId,
                        path = path,
                        status = "APPROVED",
                        requester = requesterContext,
                        transport = selectedTransport,
                        timestamp = System.currentTimeMillis(),
                        details = "User tapped ALLOW. Starting $selectedTransport transfer pipeline"
                    )
                )

                FirebaseVaultManager(context).updateRequestStatus(requestId, status = "APPROVED", decision = "ALLOW")

                scope.launch {
                    if (backendUrl.isNotEmpty() && !backendUrl.contains("192.168.10.15")) {
                        try {
                            apiClient.sendDecision(
                                backendUrl = backendUrl,
                                requestId = requestId,
                                decision = "ALLOW",
                                selectedTransport = selectedTransport
                            )
                        } catch (ignored: Exception) {}
                    }
                }

                // Android 14+ (API 34+): Enqueue User-Initiated Data Transfer (UIDT) Job via JobScheduler
                // Android 13 and below: Start Foreground Service
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    try {
                        Log.d(TAG, "Scheduling UserInitiatedDataTransfer (UIDT) via JobScheduler (API 34+)")
                        scheduleUserInitiatedJob(context, requestId, path, sha256, transports)
                    } catch (e: Exception) {
                        Log.w(TAG, "UIDT scheduling failed, falling back to ForegroundService: ${e.message}")
                        startForegroundService(context, requestId, path, sha256, transports)
                    }
                } else {
                    Log.d(TAG, "Starting ForegroundDataTransferService fallback (API < 34)")
                    startForegroundService(context, requestId, path, sha256, transports)
                }
            }
        }
    }

    private fun scheduleUserInitiatedJob(
        context: Context,
        requestId: String,
        path: String,
        sha256: String,
        transports: List<String>
    ) {
        val jobScheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
        val componentName = ComponentName(context, DataTransferJobService::class.java)

        val extras = PersistableBundle().apply {
            putString("request_id", requestId)
            putString("path", path)
            putString("sha256", sha256)
            putString("transports", transports.joinToString(","))
        }

        val jobId = (requestId.hashCode() and 0x7FFFFFFF)
        val builder = JobInfo.Builder(jobId, componentName)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setExtras(extras)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            builder.setUserInitiated(true)
        }

        val result = jobScheduler.schedule(builder.build())
        Log.d(TAG, "UIDT Job scheduled for $requestId. Result code: $result")
    }

    private fun startForegroundService(
        context: Context,
        requestId: String,
        path: String,
        sha256: String,
        transports: List<String>
    ) {
        val serviceIntent = Intent(context, ForegroundDataTransferService::class.java).apply {
            putExtra("request_id", requestId)
            putExtra("path", path)
            putExtra("sha256", sha256)
            putStringArrayListExtra("supported_transports", ArrayList(transports))
        }
        ContextCompat.startForegroundService(context, serviceIntent)
    }
}
