package com.akshay.lazyvault.worker

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.akshay.lazyvault.net.VaultApiClient
import com.akshay.lazyvault.storage.VaultPreferences
import com.akshay.lazyvault.storage.VaultStorageManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class CatalogIndexWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    private val TAG = "CatalogIndexWorker"
    private val apiClient = VaultApiClient()
    private val prefs = VaultPreferences(appContext)
    private val storageManager = VaultStorageManager(appContext)

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        Log.d(TAG, "Starting periodic/on-demand catalog indexing job")

        try {
            val (snapshot, indexedFiles) = storageManager.indexCatalog()

            Log.d(TAG, "Built catalog generation ${snapshot.generation} with ${indexedFiles.size} items. Merkle: ${snapshot.rootMerkle}")

            val synced = apiClient.syncCatalog(
                backendUrl = prefs.backendUrl,
                snapshot = snapshot
            )

            if (synced) {
                Log.d(TAG, "Successfully synced catalog to broker at ${prefs.backendUrl}")
                Result.success()
            } else {
                Log.w(TAG, "Failed pushing catalog sync to ${prefs.backendUrl}. Will retry.")
                Result.retry()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Catalog index worker error", e)
            Result.failure()
        }
    }
}
