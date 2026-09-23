package com.akshay.lazyvault.storage

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.documentfile.provider.DocumentFile
import com.akshay.lazyvault.data.CatalogItem
import com.akshay.lazyvault.data.CatalogSnapshot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.security.MessageDigest

class VaultStorageManager(private val context: Context) {
    private val TAG = "VaultStorageManager"
    private val prefs = VaultPreferences(context)

    data class ScannedDocItem(
        val relativePath: String,
        val displayName: String,
        val uri: Uri,
        val size: Long,
        val lastModified: Long
    )

    fun getSelectedFolderDisplayName(): String {
        return prefs.selectedFolderName ?: "Default App Vault"
    }

    fun isCustomFolderSelected(): Boolean {
        return !prefs.selectedFolderUri.isNullOrEmpty()
    }

    fun setSelectedFolder(uri: Uri) {
        try {
            val takeFlags: Int = Intent.FLAG_GRANT_READ_URI_PERMISSION
            context.contentResolver.takePersistableUriPermission(uri, takeFlags)
        } catch (e: Exception) {
            Log.w(TAG, "Could not take persistable URI permission: ${e.message}")
        }

        val doc = DocumentFile.fromTreeUri(context, uri)
        val folderName = doc?.name ?: uri.lastPathSegment?.substringAfterLast(':') ?: "Selected Folder"
        prefs.selectedFolderUri = uri.toString()
        prefs.selectedFolderName = folderName
        Log.d(TAG, "Selected vault folder: $folderName ($uri)")
    }

    fun resetToDefaultVault() {
        prefs.selectedFolderUri = null
        prefs.selectedFolderName = null
        prefs.clearFileMappings()
        Log.d(TAG, "Reset vault to default internal storage")
    }

    suspend fun indexCatalog(
        onStatus: ((String) -> Unit)? = null
    ): Pair<CatalogSnapshot, List<CatalogItem>> = withContext(Dispatchers.IO) {
        val folderUriStr = prefs.selectedFolderUri
        val indexed = mutableListOf<CatalogItem>()
        val merkleDigest = MessageDigest.getInstance("SHA-256")
        val uriMap = mutableMapOf<String, String>()
        val sizeMap = mutableMapOf<String, Long>()

        var scannedFromSAF = false

        if (!folderUriStr.isNullOrEmpty()) {
            try {
                val treeUri = Uri.parse(folderUriStr)
                val rootDoc = DocumentFile.fromTreeUri(context, treeUri)

                if (rootDoc != null && rootDoc.exists() && rootDoc.isDirectory) {
                    onStatus?.invoke("Scanning folder: ${rootDoc.name ?: "Vault"}...")
                    val scannedItems = mutableListOf<ScannedDocItem>()
                    traverseDocumentTree(rootDoc, "", scannedItems)

                    onStatus?.invoke("Indexing ${scannedItems.size} file(s)...")

                    for ((idx, item) in scannedItems.withIndex()) {
                        onStatus?.invoke("Hashing (${idx + 1}/${scannedItems.size}): ${item.displayName}")
                        val sha = calculateUriSha256(item.uri)
                        if (sha.isNotEmpty()) {
                            val relPath = "/storage/vault/${item.relativePath}"
                            val catalogItem = CatalogItem(
                                path = relPath,
                                size = item.size,
                                sha256 = sha,
                                mtime = item.lastModified,
                                name = item.displayName
                            )
                            indexed.add(catalogItem)
                            merkleDigest.update(sha.toByteArray(Charsets.UTF_8))

                            // Store mappings for fast retrieval
                            val uriStr = item.uri.toString()
                            uriMap[sha] = uriStr
                            uriMap[relPath] = uriStr
                            uriMap[item.displayName] = uriStr
                            uriMap[item.relativePath] = uriStr

                            sizeMap[sha] = item.size
                            sizeMap[relPath] = item.size
                            sizeMap[item.displayName] = item.size
                            sizeMap[item.relativePath] = item.size
                        }
                    }
                    scannedFromSAF = true
                } else {
                    Log.w(TAG, "Tree document for $folderUriStr not found or not a directory. Falling back.")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error traversing SAF tree URI: $folderUriStr", e)
            }
        }

        // Fallback: internal storage vault if no SAF folder chosen or SAF empty/failed
        if (!scannedFromSAF || indexed.isEmpty()) {
            val vaultDir = File(context.filesDir, "vault")
            if (!vaultDir.exists()) {
                vaultDir.mkdirs()
                seedInitialVault(vaultDir)
            }

            vaultDir.walkTopDown().forEach { file ->
                if (file.isFile && !file.name.startsWith(".")) {
                    val sha = calculateFileSha256(file)
                    val relPath = "/storage/vault/${file.name}"
                    val catalogItem = CatalogItem(
                        path = relPath,
                        size = file.length(),
                        sha256 = sha,
                        mtime = file.lastModified(),
                        name = file.name
                    )
                    indexed.add(catalogItem)
                    merkleDigest.update(sha.toByteArray(Charsets.UTF_8))

                    val fileUri = Uri.fromFile(file).toString()
                    uriMap[sha] = fileUri
                    uriMap[relPath] = fileUri
                    uriMap[file.name] = fileUri

                    sizeMap[sha] = file.length()
                    sizeMap[relPath] = file.length()
                    sizeMap[file.name] = file.length()
                }
            }
        }

        // Save fast lookup mappings
        prefs.saveFileMappings(uriMap, sizeMap)

        val rootMerkle = bytesToHex(merkleDigest.digest())
        val gen = System.currentTimeMillis()
        val snapshot = CatalogSnapshot(
            generation = gen,
            rootMerkle = rootMerkle,
            updatedAt = gen,
            deviceId = prefs.deviceId,
            files = indexed
        )

        prefs.lastCatalogGeneration = gen
        prefs.rootMerkleHash = rootMerkle

        Pair(snapshot, indexed)
    }

    private fun traverseDocumentTree(
        dir: DocumentFile,
        currentPath: String,
        outList: MutableList<ScannedDocItem>
    ) {
        val files = try {
            dir.listFiles()
        } catch (e: Exception) {
            emptyArray()
        }

        for (f in files) {
            val name = f.name ?: continue
            if (name.startsWith(".")) continue // Ignore hidden files

            if (f.isDirectory) {
                val nextSub = if (currentPath.isEmpty()) name else "$currentPath/$name"
                traverseDocumentTree(f, nextSub, outList)
            } else if (f.isFile) {
                val relPath = if (currentPath.isEmpty()) name else "$currentPath/$name"
                val length = f.length()
                val lastModified = f.lastModified()
                outList.add(ScannedDocItem(relPath, name, f.uri, length, lastModified))
            }
        }
    }

    private fun calculateUriSha256(uri: Uri): String {
        return try {
            val digest = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(64 * 1024)
            context.contentResolver.openInputStream(uri)?.use { stream ->
                var read: Int
                while (stream.read(buffer).also { read = it } != -1) {
                    digest.update(buffer, 0, read)
                }
            } ?: return ""
            bytesToHex(digest.digest())
        } catch (e: Exception) {
            Log.e(TAG, "Error calculating SHA-256 for $uri", e)
            ""
        }
    }

    private fun calculateFileSha256(file: File): String {
        return try {
            val digest = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(64 * 1024)
            FileInputStream(file).use { fis ->
                var read: Int
                while (fis.read(buffer).also { read = it } != -1) {
                    digest.update(buffer, 0, read)
                }
            }
            bytesToHex(digest.digest())
        } catch (e: Exception) {
            ""
        }
    }

    fun openInputStream(path: String, targetSha256: String): InputStream? {
        // 1. Try URI lookup by sha256 or path or filename
        val candidates = listOf(
            targetSha256,
            path,
            path.substringAfterLast('/'),
            path.removePrefix("/storage/vault/")
        )

        for (key in candidates) {
            if (key.isEmpty()) continue
            val uriStr = prefs.getFileUri(key)
            if (!uriStr.isNullOrEmpty()) {
                try {
                    val uri = Uri.parse(uriStr)
                    val stream = if (uri.scheme == "content") {
                        context.contentResolver.openInputStream(uri)
                    } else if (uri.scheme == "file") {
                        val f = File(uri.path ?: "")
                        if (f.exists()) FileInputStream(f) else null
                    } else {
                        null
                    }
                    if (stream != null) return stream
                } catch (e: Exception) {
                    Log.w(TAG, "Failed opening stream for key $key (uri: $uriStr): ${e.message}")
                }
            }
        }

        // 2. Fallback to local filesDir/vault
        val vaultDir = File(context.filesDir, "vault")
        val simpleName = path.substringAfterLast('/')
        val localFile = File(vaultDir, simpleName)
        if (localFile.exists()) {
            return FileInputStream(localFile)
        }

        // Create ephemeral fallback payload if file cannot be found
        return null
    }

    fun getFileSize(path: String, targetSha256: String): Long {
        val candidates = listOf(
            targetSha256,
            path,
            path.substringAfterLast('/'),
            path.removePrefix("/storage/vault/")
        )

        for (key in candidates) {
            if (key.isEmpty()) continue
            val cachedSize = prefs.getFileSize(key)
            if (cachedSize > 0L) return cachedSize
        }

        for (key in candidates) {
            if (key.isEmpty()) continue
            val uriStr = prefs.getFileUri(key)
            if (!uriStr.isNullOrEmpty()) {
                try {
                    val uri = Uri.parse(uriStr)
                    if (uri.scheme == "content") {
                        context.contentResolver.openFileDescriptor(uri, "r")?.use { pfd ->
                            val s = pfd.statSize
                            if (s > 0L) return s
                        }
                    } else if (uri.scheme == "file") {
                        val f = File(uri.path ?: "")
                        if (f.exists()) return f.length()
                    }
                } catch (ignored: Exception) {}
            }
        }

        val localFile = File(File(context.filesDir, "vault"), path.substringAfterLast('/'))
        if (localFile.exists()) return localFile.length()

        return 0L
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
