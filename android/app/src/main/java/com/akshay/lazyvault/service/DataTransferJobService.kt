package com.akshay.lazyvault.service

import android.app.NotificationManager
import android.app.job.JobParameters
import android.app.job.JobService
import android.content.Context
import android.os.Build
import android.util.Log
import com.akshay.lazyvault.engine.TransferEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

class DataTransferJobService : JobService() {
    private val TAG = "DataTransferJobService"
    private val scope = CoroutineScope(Dispatchers.IO)
    private var transferJob: Job? = null

    override fun onStartJob(params: JobParameters?): Boolean {
        if (params == null) return false
        val extras = params.extras

        val requestId = extras.getString("request_id") ?: return false
        val path = extras.getString("path") ?: "unknown_file"
        val sha256 = extras.getString("sha256") ?: ""
        val transportsStr = extras.getString("transports") ?: "webrtc,relay"
        val transports = transportsStr.split(",").map { it.trim() }
        val filename = path.substringAfterLast('/')

        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        // Android 14+ (API 34+) User-Initiated Data Transfer (UIDT) requires providing initial notification
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val initialNotification = VaultNotificationManager.buildProgressNotification(
                this,
                filename,
                progressPercent = 0,
                statusText = "Initializing secure transfer pipeline..."
            )
            setNotification(
                params,
                VaultNotificationManager.NOTIFICATION_ID_PROGRESS,
                initialNotification,
                JOB_END_NOTIFICATION_POLICY_REMOVE
            )
        }

        Log.d(TAG, "Executing Android 14+ UIDT Job for $requestId (path: $path)")
        val transferEngine = TransferEngine(applicationContext)

        transferJob = scope.launch {
            val success = transferEngine.executeTransfer(
                requestId = requestId,
                path = path,
                targetSha256 = sha256,
                supportedTransports = transports
            ) { percent, status ->
                Log.d(TAG, "UIDT Progress ($requestId): $percent% - $status")
                val progressNotif = VaultNotificationManager.buildProgressNotification(
                    this@DataTransferJobService,
                    filename,
                    progressPercent = percent,
                    statusText = status
                )
                notificationManager.notify(VaultNotificationManager.NOTIFICATION_ID_PROGRESS, progressNotif)
            }

            Log.d(TAG, "UIDT Job completed for $requestId. Success: $success")
            notificationManager.cancel(VaultNotificationManager.NOTIFICATION_ID_PROGRESS)
            jobFinished(params, !success)
        }

        return true
    }

    override fun onStopJob(params: JobParameters?): Boolean {
        Log.w(TAG, "UIDT Job stopped prematurely by OS")
        transferJob?.cancel()
        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.cancel(VaultNotificationManager.NOTIFICATION_ID_PROGRESS)
        return true
    }
}
