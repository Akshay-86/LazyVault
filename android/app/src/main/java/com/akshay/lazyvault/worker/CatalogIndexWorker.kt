package com.akshay.lazyvault.worker

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.akshay.lazyvault.data.CatalogItem
import com.akshay.lazyvault.data.CatalogSnapshot
import com.akshay.lazyvault.net.VaultApiClient
import com.akshay.lazyvault.storage.VaultPreferences
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

class CatalogIndexWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    private val TAG = "CatalogIndexWorker"
    private val apiClient = VaultApiClient()
    private val prefs = VaultPreferences(appContext)

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        Log.d(TAG, "Starting periodic/on-demand catalog indexing job (charging/idle constraints)")

        try {
            val vaultDir = File(applicationContext.filesDir, "vault")
            if (!vaultDir.exists()) {
                vaultDir.mkdirs()
                seedInitialVault(vaultDir)
            }

            val indexedFiles = mutableListOf<CatalogItem>()
            val merkleDigest = MessageDigest.getInstance("SHA-256")

            vaultDir.walkTopDown().forEach { file ->
                if (file.isFile && !file.name.startsWith(".")) {
                    val sha256 = calculateFileSha256(file)
                    val relPath = "/storage/vault/${file.name}"
                    indexedFiles.add(
                        CatalogItem(
                            path = relPath,
                            size = file.length(),
                            sha256 = sha256,
                            mtime = file.lastModified()
                        )
                    )
                    merkleDigest.update(sha256.toByteArray(Charsets.UTF_8))
                }
            }

            val rootMerkle = bytesToHex(merkleDigest.digest())
            val generation = System.currentTimeMillis()

            val snapshot = CatalogSnapshot(
                generation = generation,
                rootMerkle = rootMerkle,
                updatedAt = generation,
                deviceId = prefs.deviceId,
                files = indexedFiles
            )

            Log.d(TAG, "Built catalog generation $generation with ${indexedFiles.size} items. Merkle: $rootMerkle")

            val synced = apiClient.syncCatalog(
                backendUrl = prefs.backendUrl,
                snapshot = snapshot
            )

            if (synced) {
                prefs.lastCatalogGeneration = generation
                prefs.rootMerkleHash = rootMerkle
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

    private fun calculateFileSha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(64 * 1024)
        FileInputStream(file).use { fis ->
            var read: Int
            while (fis.read(buffer).also { read = it } != -1) {
                digest.update(buffer, 0, read)
            }
        }
        return bytesToHex(digest.digest())
    }

    private fun seedInitialVault(vaultDir: File) {
        File(vaultDir, "financial_report_2026.pdf").writeText(
            "%PDF-1.7\nLazyVault Confidential Financial Audit Report 2026\nZero-Trust Dormant Edge Node\n"
        )
        File(vaultDir, "infra_secrets_backup.kdbx").writeText(
            "KDBX-V4-ENCRYPTED-HEADER-SAMPLE-SECRET-KEYSTORE\n"
        )
        File(vaultDir, "release_artifacts_v2.0.tar.gz").writeText(
            "GZIP-COMPRESSED-TAR-RELEASE-ARTIFACT-V2.0\n"
        )
    }

    private fun bytesToHex(bytes: ByteArray): String {
        val sb = StringBuilder()
        for (b in bytes) {
            sb.append(String.format("%02x", b))
        }
        return sb.toString()
    }
}
