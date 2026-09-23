package com.akshay.lazyvault.service

import android.app.job.JobParameters
import android.app.job.JobService
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
            }

            Log.d(TAG, "UIDT Job completed for $requestId. Success: $success")
            jobFinished(params, !success)
        }

        return true
    }

    override fun onStopJob(params: JobParameters?): Boolean {
        Log.w(TAG, "UIDT Job stopped prematurely by OS")
        transferJob?.cancel()
        return true
    }
}
