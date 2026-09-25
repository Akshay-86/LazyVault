package com.akshay.lazyvault.net

import android.content.Context
import android.util.Log
import com.akshay.lazyvault.data.CatalogItem
import com.akshay.lazyvault.data.CatalogSnapshot
import com.akshay.lazyvault.service.VaultNotificationManager
import com.akshay.lazyvault.storage.VaultPreferences
import com.google.firebase.firestore.DocumentChange
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.firestore.SetOptions
import kotlinx.coroutines.delay
import kotlinx.coroutines.tasks.await
import java.security.MessageDigest
import android.util.Base64

class FirebaseVaultManager(private val context: Context) {
    private val TAG = "FirebaseVaultManager"
    private val firestore = FirebaseFirestore.getInstance()
    private val prefs = VaultPreferences(context)
    companion object {
        private val handledRequestIds = java.util.Collections.synchronizedSet(mutableSetOf<String>())
    }
    private var requestListener: ListenerRegistration? = null
    private var clientsListener: ListenerRegistration? = null

    suspend fun syncVaultToFirestore(
        snapshot: CatalogSnapshot,
        files: List<CatalogItem>
    ): Boolean {
        return try {
            val vaultId = prefs.vaultId
            val password = prefs.vaultPassword
            val expSeconds = prefs.vaultExpirationSeconds
            val expiresAt = if (expSeconds > 0) System.currentTimeMillis() + (expSeconds * 1000L) else 0L

            val fileMaps = files.map { file ->
                mapOf(
                    "path" to file.path,
                    "name" to file.name,
                    "size" to file.size,
                    "sha256" to file.sha256,
                    "mtime" to file.mtime
                )
            }

            val vaultDoc = hashMapOf(
                "vaultId" to vaultId,
                "deviceId" to prefs.deviceId,
                "deviceName" to prefs.deviceName,
                "requiresPassword" to password.isNotEmpty(),
                "passwordHash" to hashPassword(password),
                "expiresAt" to expiresAt,
                "expiresInSeconds" to expSeconds,
                "merkleRoot" to snapshot.rootMerkle,
                "fileCount" to files.size,
                "updatedAt" to System.currentTimeMillis(),
                "files" to fileMaps
            )

            firestore.collection("vaults").document(vaultId).set(vaultDoc, SetOptions.merge()).await()
            Log.d(TAG, "Vault $vaultId (${files.size} files) synced to Cloud Firestore successfully!")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Error syncing vault to Firestore", e)
            false
        }
    }

    suspend fun syncVaultSecurity(password: String, expiresInSeconds: Long): Boolean {
        val vaultId = prefs.vaultId
        val expAt = if (expiresInSeconds > 0) System.currentTimeMillis() + (expiresInSeconds * 1000L) else 0L
        return try {
            val map = mapOf(
                "requiresPassword" to password.isNotEmpty(),
                "passwordHash" to hashPassword(password),
                "expiresAt" to expAt,
                "expiresInSeconds" to expiresInSeconds,
                "updatedAt" to System.currentTimeMillis()
            )
            firestore.collection("vaults").document(vaultId).set(map, SetOptions.merge()).await()
            Log.d(TAG, "Vault security updated in Firestore: requiresPassword=${password.isNotEmpty()}")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to update vault security in Firestore", e)
            false
        }
    }

    fun startListeningForRequests(onRequestReceived: (com.akshay.lazyvault.data.TransferRequest) -> Unit) {
        val vaultId = prefs.vaultId
        requestListener?.remove()

        requestListener = firestore.collection("vaults").document(vaultId)
            .collection("requests")
            .whereEqualTo("status", "WAITING_FOR_APPROVAL")
            .addSnapshotListener { snapshots, error ->
                if (error != null) {
                    Log.e(TAG, "Listen failed on requests", error)
                    return@addSnapshotListener
                }

                val now = System.currentTimeMillis()
                snapshots?.documents?.forEach { doc ->
                    val reqId = doc.id
                    val expiresAt = doc.getLong("expiresAt") ?: (now + 60000L)
                    val createdAt = doc.getLong("createdAt") ?: (expiresAt - 60000L)

                    // 1. Stale / Expired request filter: silently mark EXPIRED and ignore!
                    if (now > expiresAt || (now - createdAt) > 60000L) {
                        Log.d(TAG, "Silently ignoring stale/expired request $reqId (now=$now, expiresAt=$expiresAt)")
                        updateRequestStatus(reqId, "EXPIRED")
                        return@forEach
                    }

                    if (!handledRequestIds.contains(reqId)) {
                        handledRequestIds.add(reqId)
                        val path = doc.getString("path") ?: "file"
                        val sha256 = doc.getString("sha256") ?: ""
                        val requesterContext = doc.getString("requesterContext") ?: "Web User"
                        val requesterIp = doc.getString("requesterIp") ?: "Remote Client"
                        val transports = (doc.get("supportedTransports") as? List<*>)?.mapNotNull { it?.toString() }
                            ?: listOf("webrtc", "relay")

                        Log.d(TAG, "Incoming valid real-time request: $reqId for $path")
                        val req = com.akshay.lazyvault.data.TransferRequest(
                            requestId = reqId,
                            path = path,
                            sha256 = sha256,
                            requesterContext = requesterContext,
                            requesterIp = requesterIp,
                            supportedTransports = transports,
                            expiresAt = expiresAt
                        )
                        VaultNotificationManager.showTransferRequestNotification(
                            context = context,
                            request = req
                        )

                        onRequestReceived(req)
                    }
                }
            }
    }

    fun stopListening() {
        requestListener?.remove()
        requestListener = null
        stopListeningForClients()
    }

    fun startListeningForClients(onClientsUpdated: (List<com.akshay.lazyvault.data.ConnectedClient>) -> Unit) {
        val vaultId = prefs.vaultId
        clientsListener?.remove()

        clientsListener = firestore.collection("vaults").document(vaultId)
            .collection("clients")
            .addSnapshotListener { snapshots, error ->
                if (error != null) {
                    Log.w(TAG, "Listen failed on clients", error)
                    return@addSnapshotListener
                }

                val now = System.currentTimeMillis()
                val list = mutableListOf<com.akshay.lazyvault.data.ConnectedClient>()
                snapshots?.documents?.forEach { doc ->
                    val lastSeen = doc.getLong("lastSeen") ?: 0L
                    if (now - lastSeen < 45000L) {
                        val clientId = doc.getString("clientId") ?: doc.id
                        val deviceName = doc.getString("deviceName") ?: "Web Client"
                        val ip = doc.getString("ip") ?: "Remote Client"
                        val connectedAt = doc.getLong("connectedAt") ?: lastSeen
                        list.add(
                            com.akshay.lazyvault.data.ConnectedClient(
                                clientId = clientId,
                                ip = ip,
                                deviceName = deviceName,
                                connectedAt = connectedAt,
                                lastSeen = lastSeen,
                                activeSecondsAgo = (now - lastSeen) / 1000L
                            )
                        )
                    }
                }
                onClientsUpdated(list)
            }
    }

    fun stopListeningForClients() {
        clientsListener?.remove()
        clientsListener = null
    }

    fun updateRequestStatus(requestId: String, status: String, decision: String? = null, error: String? = null) {
        val vaultId = prefs.vaultId
        val updateMap = mutableMapOf<String, Any>(
            "status" to status,
            "updatedAt" to System.currentTimeMillis()
        )
        if (decision != null) updateMap["decision"] = decision
        if (error != null) updateMap["error"] = error

        firestore.collection("vaults").document(vaultId)
            .collection("requests").document(requestId)
            .set(updateMap, SetOptions.merge())
            .addOnSuccessListener {
                Log.d(TAG, "Request $requestId status updated to $status")
            }
            .addOnFailureListener { e ->
                Log.e(TAG, "Failed to update request $requestId in Firestore", e)
            }
    }

    suspend fun getRequestOffer(requestId: String): Pair<String, String>? {
        val vaultId = prefs.vaultId
        return try {
            val doc = firestore.collection("vaults").document(vaultId)
                .collection("requests").document(requestId)
                .get().await()
            val offerMap = doc.get("offer") as? Map<*, *> ?: return null
            val sdp = offerMap["sdp"] as? String ?: return null
            val type = offerMap["type"] as? String ?: "offer"
            Pair(sdp, type)
        } catch (e: Exception) {
            Log.e(TAG, "Error fetching offer for $requestId", e)
            null
        }
    }

    suspend fun waitForOffer(requestId: String, timeoutMs: Long = 15000L): Pair<String, String>? {
        val start = System.currentTimeMillis()
        while (System.currentTimeMillis() - start < timeoutMs) {
            val offer = getRequestOffer(requestId)
            if (offer != null) return offer
            delay(500)
        }
        return null
    }

    suspend fun saveAnswer(requestId: String, sdp: String, type: String = "answer"): Boolean {
        val vaultId = prefs.vaultId
        return try {
            val answerMap = mapOf(
                "answer" to mapOf(
                    "sdp" to sdp,
                    "type" to type
                ),
                "status" to "TRANSFERRING",
                "chosenTransport" to "webrtc",
                "updatedAt" to System.currentTimeMillis()
            )
            firestore.collection("vaults").document(vaultId)
                .collection("requests").document(requestId)
                .set(answerMap, SetOptions.merge())
                .await()
            Log.d(TAG, "Saved WebRTC answer to Firestore for $requestId")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Error saving answer for $requestId", e)
            false
        }
    }

    suspend fun addCalleeCandidate(requestId: String, sdp: String, sdpMid: String?, sdpMLineIndex: Int) {
        val vaultId = prefs.vaultId
        try {
            val candidateMap = hashMapOf(
                "candidate" to sdp,
                "sdpMid" to sdpMid,
                "sdpMLineIndex" to sdpMLineIndex,
                "createdAt" to System.currentTimeMillis()
            )
            firestore.collection("vaults").document(vaultId)
                .collection("requests").document(requestId)
                .collection("calleeCandidates")
                .add(candidateMap)
                .await()
        } catch (e: Exception) {
            Log.w(TAG, "Error adding callee candidate for $requestId", e)
        }
    }

    fun listenToCallerCandidates(
        requestId: String,
        onCandidate: (sdp: String, sdpMid: String?, sdpMLineIndex: Int) -> Unit
    ): ListenerRegistration {
        val vaultId = prefs.vaultId
        return firestore.collection("vaults").document(vaultId)
            .collection("requests").document(requestId)
            .collection("callerCandidates")
            .addSnapshotListener { snapshot, error ->
                if (error != null) {
                    Log.e(TAG, "Listen error for callerCandidates", error)
                    return@addSnapshotListener
                }
                snapshot?.documentChanges?.forEach { change ->
                    if (change.type == DocumentChange.Type.ADDED) {
                        val data = change.document.data
                        val candidate = data["candidate"] as? String ?: return@forEach
                        val sdpMid = data["sdpMid"] as? String
                        val sdpMLineIndex = (data["sdpMLineIndex"] as? Number)?.toInt() ?: 0
                        onCandidate(candidate, sdpMid, sdpMLineIndex)
                    }
                }
            }
    }

    suspend fun uploadEncryptedChunks(
        requestId: String,
        ciphertext: ByteArray,
        keyB64: String,
        ivB64: String,
        targetSha256: String,
        onProgress: (percent: Int, status: String) -> Unit
    ): Boolean {
        val vaultId = prefs.vaultId
        return try {
            val chunkSize = 512 * 1024 // 512 KB raw -> ~683 KB Base64 (well under 1MB Firestore doc limit)
            val totalBytes = ciphertext.size
            val chunkCount = if (totalBytes == 0) 1 else ((totalBytes + chunkSize - 1) / chunkSize)

            val chunksCol = firestore.collection("vaults").document(vaultId)
                .collection("requests").document(requestId)
                .collection("chunks")

            for (i in 0 until chunkCount) {
                val start = i * chunkSize
                val end = minOf(start + chunkSize, totalBytes)
                val chunkBytes = ciphertext.copyOfRange(start, end)
                val b64Chunk = Base64.encodeToString(chunkBytes, Base64.NO_WRAP)

                val chunkDoc = mapOf(
                    "index" to i,
                    "data" to b64Chunk,
                    "chunkBytes" to chunkBytes.size,
                    "totalBytes" to totalBytes
                )
                chunksCol.document(i.toString()).set(chunkDoc).await()

                val percent = 40 + (((i + 1).toDouble() / chunkCount) * 55).toInt()
                onProgress(percent, "Uploading encrypted chunk ${i + 1}/$chunkCount...")
            }

            // Update request document with relay metadata
            val relayMeta = mapOf(
                "encryptionKeyB64" to keyB64,
                "ivB64" to ivB64,
                "chunkCount" to chunkCount,
                "sizeBytes" to totalBytes.toLong(),
                "sha256" to targetSha256
            )

            val updateMap = mapOf(
                "status" to "COMPLETED",
                "chosenTransport" to "relay",
                "relayMetadata" to relayMeta,
                "sha256" to targetSha256,
                "updatedAt" to System.currentTimeMillis()
            )

            firestore.collection("vaults").document(vaultId)
                .collection("requests").document(requestId)
                .set(updateMap, SetOptions.merge())
                .await()

            Log.d(TAG, "Uploaded $chunkCount encrypted chunks to Firestore for $requestId")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed uploading encrypted chunks for $requestId", e)
            false
        }
    }

    private fun hashPassword(password: String): String {
        if (password.isEmpty()) return ""
        val bytes = MessageDigest.getInstance("SHA-256").digest(password.toByteArray(Charsets.UTF_8))
        return bytes.joinToString("") { "%02x".format(it) }
    }
}
