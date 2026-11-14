package com.akshay.lazyvault.worker

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.akshay.lazyvault.net.FirebaseVaultManager
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
    private val firebaseVaultManager = FirebaseVaultManager(appContext)

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        Log.d(TAG, "Starting periodic/on-demand catalog indexing job")

        try {
            val (snapshot, indexedFiles) = storageManager.indexCatalog()

            Log.d(TAG, "Built catalog generation ${snapshot.generation} with ${indexedFiles.size} items. Merkle: ${snapshot.rootMerkle}")

            // 1. Sync to Cloud Firestore (Serverless)
            val firestoreSynced = firebaseVaultManager.syncVaultToFirestore(snapshot, indexedFiles)

            // 2. Also sync to local/custom broker if configured
            var backendSynced = false
            val broker = prefs.backendUrl
            if (broker.isNotEmpty() && !broker.contains("192.168.10.15")) {
                try {
                    backendSynced = apiClient.syncCatalog(
                        backendUrl = broker,
                        snapshot = snapshot
                    )
                } catch (e: Exception) {
                    Log.w(TAG, "Broker sync failed: ${e.message}")
                }
            }

            if (firestoreSynced || backendSynced) {
                Log.d(TAG, "Catalog sync completed successfully (firestore=$firestoreSynced, broker=$backendSynced)")
                Result.success()
            } else {
                Log.w(TAG, "Failed pushing catalog sync. Will retry.")
                Result.retry()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Catalog index worker error", e)
            Result.failure()
        }
    }
}
