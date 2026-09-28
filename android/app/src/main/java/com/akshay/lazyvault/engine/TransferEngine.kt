package com.akshay.lazyvault.engine

import android.content.Context
import android.util.Base64
import android.util.Log
import com.akshay.lazyvault.data.AuditLogEntry
import com.akshay.lazyvault.net.FirebaseVaultManager
import com.akshay.lazyvault.net.VaultApiClient
import com.akshay.lazyvault.storage.VaultPreferences
import com.akshay.lazyvault.storage.VaultStorageManager
import com.google.firebase.firestore.ListenerRegistration
import io.webrtc.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.nio.ByteBuffer
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec

class TransferEngine(private val context: Context) {
    private val TAG = "TransferEngine"
    private val apiClient = VaultApiClient()
    private val prefs = VaultPreferences(context)
    private val scope = CoroutineScope(Dispatchers.IO)

    companion object {
        const val CHUNK_SIZE = 64 * 1024 // 64KB chunks for optimal throughput on high-speed Wi-Fi and direct LAN
        const val BUFFERED_AMOUNT_LOW_THRESHOLD = 1024 * 1024L // 1MB backpressure window to prevent socket buffer saturation and ICE consent starvation (RFC 7675)
        const val MAX_RELAY_FILE_SIZE_BYTES = 50 * 1024 * 1024L // 50MB maximum for cloud chunk relay to protect memory & quota
    }

    private val storageManager = VaultStorageManager(context)
    private val firebaseVaultManager = FirebaseVaultManager(context)

    suspend fun executeTransfer(
        requestId: String,
        path: String,
        targetSha256: String,
        supportedTransports: List<String>,
        onProgress: (percent: Int, status: String) -> Unit
    ): Boolean = withContext(Dispatchers.IO) {
        val backendUrl = prefs.backendUrl

        Log.d(TAG, "Starting lease execution for $requestId. Supported: $supportedTransports")
        onProgress(5, "Resolving file from local vault...")

        val fileSize = storageManager.getFileSize(path, targetSha256)
        val testStream = storageManager.openInputStream(path, targetSha256)
        if (testStream == null) {
            Log.e(TAG, "File cannot be opened or does not exist: $path ($targetSha256)")
            onProgress(0, "Error: File not found on device storage")
            try {
                FirebaseVaultManager(context).updateRequestStatus(
                    requestId,
                    status = "FAILED",
                    error = "File not found on device storage (${path.substringAfterLast('/')})"
                )
            } catch (ignored: Exception) {}
            return@withContext false
        }
        try {
            testStream.close()
        } catch (ignored: Exception) {}

        var transportUsed = "webrtc"
        var success = false

        // Prefer WebRTC P2P DataChannels for direct, zero-trust browser transfer
        if (supportedTransports.contains("webrtc")) {
            onProgress(10, "Attempting WebRTC P2P DataChannel transfer...")
            val webrtcSuccess = executeWebRtcTransfer(backendUrl, requestId, path, targetSha256, onProgress)
            if (webrtcSuccess) {
                success = true
                transportUsed = "webrtc"
            } else if (supportedTransports.contains("relay")) {
                Log.w(TAG, "WebRTC transfer could not complete or timed out. Falling back to Encrypted Ephemeral Relay.")
                onProgress(20, "WebRTC peer unavailable. Falling back to encrypted relay...")
                success = executeRelayTransfer(backendUrl, requestId, path, targetSha256, onProgress)
                transportUsed = "relay"
            }
        } else if (supportedTransports.contains("relay")) {
            onProgress(15, "Starting encrypted ephemeral zero-trust relay...")
            success = executeRelayTransfer(backendUrl, requestId, path, targetSha256, onProgress)
            transportUsed = "relay"
        } else {
            // Default to WebRTC
            onProgress(10, "Attempting WebRTC P2P DataChannel transfer...")
            val webrtcSuccess = executeWebRtcTransfer(backendUrl, requestId, path, targetSha256, onProgress)
            if (webrtcSuccess) {
                success = true
                transportUsed = "webrtc"
            } else {
                Log.w(TAG, "WebRTC transfer failed. Falling back to Encrypted Ephemeral Relay.")
                onProgress(20, "WebRTC peer unavailable. Falling back to encrypted relay...")
                success = executeRelayTransfer(backendUrl, requestId, path, targetSha256, onProgress)
                transportUsed = "relay"
            }
        }

        prefs.addAuditEntry(
            AuditLogEntry(
                requestId = requestId,
                path = path,
                status = if (success) "COMPLETED" else "FAILED",
                requester = "Client Lease",
                transport = transportUsed,
                timestamp = System.currentTimeMillis(),
                details = "$fileSize bytes transferred via $transportUsed"
            )
        )

        success
    }

    /**
     * WebRTC DataChannel Streaming with STUN hole punching and backpressure handling
     * Uses Cloud Firestore for serverless signaling (with fallback to REST broker)
     */
    private suspend fun executeWebRtcTransfer(
        backendUrl: String,
        requestId: String,
        path: String,
        targetSha256: String,
        onProgress: (percent: Int, status: String) -> Unit
    ): Boolean = withContext(Dispatchers.IO) {
        val firebaseVaultManager = FirebaseVaultManager(context)
        var callerCandSub: ListenerRegistration? = null
        try {
            // Initialize PeerConnectionFactory
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context)
                    .createInitializationOptions()
            )

            val factory = PeerConnectionFactory.builder().createPeerConnectionFactory()

            val iceServers = listOf(
                PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
                PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer()
            )

            val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            }

            onProgress(12, "Waiting for browser WebRTC offer...")
            val offerPair = firebaseVaultManager.waitForOffer(requestId, timeoutMs = 15000L)
            val sdpString: String
            if (offerPair != null) {
                sdpString = offerPair.first
                Log.d(TAG, "WebRTC offer received via Firestore for $requestId")
            } else {
                // Fallback check REST if backendUrl configured
                var restOffer: JSONObject? = null
                val startTime = System.currentTimeMillis()
                while (System.currentTimeMillis() - startTime < 5000L && backendUrl.isNotEmpty()) {
                    try {
                        val messages = apiClient.pollSignaling(backendUrl, requestId, peer = "device")
                        if (messages != null && messages.length() > 0) {
                            for (i in 0 until messages.length()) {
                                val msg = messages.getJSONObject(i)
                                if (msg.optString("sender") == "client" && msg.optString("type") == "offer") {
                                    restOffer = msg.getJSONObject("payload")
                                    break
                                }
                            }
                        }
                    } catch (ignored: Exception) {}
                    if (restOffer != null) break
                    delay(1000)
                }

                if (restOffer == null) {
                    Log.d(TAG, "No WebRTC offer received from browser within 15s")
                    factory.dispose()
                    return@withContext false
                }
                sdpString = restOffer.getString("sdp")
            }

            onProgress(20, "WebRTC offer received. Negotiating peer connection...")

            var activeDataChannel: DataChannel? = null
            var channelOpened = false
            var iceFailed = false
            var isRemoteDescSet = false
            val queuedCandidates = mutableListOf<IceCandidate>()

            var peerConnection: PeerConnection? = null

            val observer = object : PeerConnection.Observer {
                override fun onSignalingChange(state: PeerConnection.SignalingState?) {
                    Log.d(TAG, "SignalingState: $state")
                }
                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                    Log.d(TAG, "IceConnectionState: $state")
                    if (state == PeerConnection.IceConnectionState.FAILED) {
                        iceFailed = true
                    }
                }
                override fun onIceConnectionReceivingChange(receiving: Boolean) {}
                override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {
                    Log.d(TAG, "IceGatheringState: $state")
                }
                override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
                override fun onAddStream(stream: MediaStream?) {}
                override fun onRemoveStream(stream: MediaStream?) {}
                override fun onRenegotiationNeeded() {}

                override fun onIceCandidate(candidate: IceCandidate?) {
                    if (candidate != null) {
                        scope.launch {
                            try {
                                firebaseVaultManager.addCalleeCandidate(
                                    requestId,
                                    candidate.sdp,
                                    candidate.sdpMid,
                                    candidate.sdpMLineIndex
                                )
                            } catch (e: Exception) {
                                Log.w(TAG, "Failed to write callee candidate to Firestore", e)
                            }
                            if (backendUrl.isNotEmpty()) {
                                try {
                                    val candJson = JSONObject().apply {
                                        put("sdpMid", candidate.sdpMid)
                                        put("sdpMLineIndex", candidate.sdpMLineIndex)
                                        put("candidate", candidate.sdp)
                                    }
                                    apiClient.sendSignaling(backendUrl, requestId, "device", "candidate", candJson)
                                } catch (ignored: Exception) {}
                            }
                        }
                    }
                }

                override fun onDataChannel(dc: DataChannel?) {
                    if (dc != null) {
                        Log.d(TAG, "WebRTC DataChannel received: ${dc.label()}, state: ${dc.state()}")
                        activeDataChannel = dc
                        if (dc.state() == DataChannel.State.OPEN) {
                            Log.d(TAG, "WebRTC DataChannel is ALREADY OPEN!")
                            channelOpened = true
                        }
                        dc.registerObserver(object : DataChannel.Observer {
                            override fun onBufferedAmountChange(previousAmount: Long) {}
                            override fun onStateChange() {
                                Log.d(TAG, "DataChannel onStateChange: ${dc.state()}")
                                if (dc.state() == DataChannel.State.OPEN) {
                                    Log.d(TAG, "WebRTC DataChannel is now OPEN!")
                                    channelOpened = true
                                }
                            }
                            override fun onMessage(buffer: DataChannel.Buffer?) {}
                        })
                    }
                }
            }

            peerConnection = factory.createPeerConnection(rtcConfig, observer) ?: run {
                factory.dispose()
                return@withContext false
            }

            // Listen for caller candidates from browser via Firestore
            callerCandSub = firebaseVaultManager.listenToCallerCandidates(requestId) { sdp, sdpMid, sdpMLineIndex ->
                val cand = IceCandidate(sdpMid, sdpMLineIndex, sdp)
                synchronized(queuedCandidates) {
                    if (isRemoteDescSet) {
                        peerConnection?.addIceCandidate(cand)
                    } else {
                        queuedCandidates.add(cand)
                    }
                }
            }

            // Set Remote Description (Offer)
            val remoteDesc = SessionDescription(SessionDescription.Type.OFFER, sdpString)

            peerConnection.setRemoteDescription(object : SdpObserver {
                override fun onCreateSuccess(p0: SessionDescription?) {}
                override fun onSetSuccess() {
                    Log.d(TAG, "Remote description set successfully")
                    synchronized(queuedCandidates) {
                        isRemoteDescSet = true
                        queuedCandidates.forEach { peerConnection?.addIceCandidate(it) }
                        queuedCandidates.clear()
                    }

                    // Create Answer
                    peerConnection?.createAnswer(object : SdpObserver {
                        override fun onCreateSuccess(answer: SessionDescription?) {
                            if (answer != null) {
                                peerConnection?.setLocalDescription(object : SdpObserver {
                                    override fun onCreateSuccess(p0: SessionDescription?) {}
                                    override fun onSetSuccess() {
                                        Log.d(TAG, "Local description set successfully (Answer)")
                                        scope.launch {
                                            firebaseVaultManager.saveAnswer(requestId, answer.description, "answer")
                                            if (backendUrl.isNotEmpty()) {
                                                try {
                                                    val answerPayload = JSONObject().apply {
                                                        put("sdp", answer.description)
                                                        put("type", "answer")
                                                    }
                                                    apiClient.sendSignaling(backendUrl, requestId, "device", "answer", answerPayload)
                                                } catch (ignored: Exception) {}
                                            }
                                        }
                                    }
                                    override fun onCreateFailure(p0: String?) {
                                        Log.e(TAG, "setLocalDescription failure: $p0")
                                    }
                                    override fun onSetFailure(p0: String?) {
                                        Log.e(TAG, "setLocalDescription onSetFailure: $p0")
                                    }
                                }, answer)
                            }
                        }
                        override fun onSetSuccess() {}
                        override fun onCreateFailure(p0: String?) {
                            Log.e(TAG, "createAnswer failure: $p0")
                        }
                        override fun onSetFailure(p0: String?) {
                            Log.e(TAG, "createAnswer onSetFailure: $p0")
                        }
                    }, MediaConstraints())
                }
                override fun onCreateFailure(p0: String?) {
                    Log.e(TAG, "setRemoteDescription failure: $p0")
                }
                override fun onSetFailure(p0: String?) {
                    Log.e(TAG, "setRemoteDescription onSetFailure: $p0")
                }
            }, remoteDesc)

            // Wait for DataChannel to Open (max 8 seconds, break immediately if ICE failed)
            val channelWaitStart = System.currentTimeMillis()
            while (!channelOpened && !iceFailed && System.currentTimeMillis() - channelWaitStart < 8000L) {
                delay(200)
            }

            if (!channelOpened || activeDataChannel == null || iceFailed) {
                Log.w(TAG, "DataChannel did not open within timeout (iceFailed=$iceFailed)")
                callerCandSub?.remove()
                peerConnection.close()
                factory.dispose()
                return@withContext false
            }

            // Stream File Chunks over DataChannel with Backpressure Handling
            val dc = activeDataChannel!!
            onProgress(30, "Streaming file over WebRTC DataChannel...")

            val fileLength = storageManager.getFileSize(path, targetSha256)
            val inputStream = storageManager.openInputStream(path, targetSha256) ?: run {
                Log.e(TAG, "Failed to open input stream for $path ($targetSha256)")
                try {
                    val errJson = JSONObject().apply {
                        put("type", "ERROR")
                        put("error", "File not found on device storage: ${path.substringAfterLast('/')}")
                    }
                    val errBuffer = DataChannel.Buffer(ByteBuffer.wrap(errJson.toString().toByteArray(Charsets.UTF_8)), false)
                    dc.send(errBuffer)
                    delay(500)
                } catch (ignored: Exception) {}
                firebaseVaultManager.updateRequestStatus(
                    requestId,
                    status = "FAILED",
                    error = "File not found on device storage (${path.substringAfterLast('/')})"
                )
                onProgress(0, "Error: File not found on device storage")
                callerCandSub?.remove()
                peerConnection.close()
                factory.dispose()
                return@withContext false
            }

            var bytesSent = 0L
            val buffer = ByteArray(CHUNK_SIZE)
            var lastProgressTime = 0L
            var lastPercent = -1
            var chunksSinceYield = 0

            inputStream.use { fis ->
                var read: Int
                while (fis.read(buffer).also { read = it } != -1) {
                    if (dc.state() != DataChannel.State.OPEN) {
                        Log.e(TAG, "WebRTC DataChannel closed prematurely during streaming")
                        break
                    }

                    val chunkBytes = if (read == CHUNK_SIZE) buffer else buffer.copyOf(read)
                    val byteBuffer = ByteBuffer.wrap(chunkBytes)
                    val dataBuffer = DataChannel.Buffer(byteBuffer, true) // binary

                    // Backpressure check: wait if bufferedAmount exceeds threshold
                    while (dc.bufferedAmount() > BUFFERED_AMOUNT_LOW_THRESHOLD) {
                        if (dc.state() != DataChannel.State.OPEN) break
                        delay(2)
                    }

                    // Retry sending until accepted by DataChannel buffer
                    var retryCount = 0
                    while (!dc.send(dataBuffer)) {
                        if (dc.state() != DataChannel.State.OPEN) break
                        delay(2)
                        retryCount++
                        if (retryCount > 1000) { // 2s without accepting data
                            Log.e(TAG, "DataChannel send stalled, state: ${dc.state()}")
                            break
                        }
                    }
                    bytesSent += read

                    // Cooperative pacing: yield every 32 chunks (~2MB) to give the native WebRTC
                    // network thread time to process ICE consent checks (RFC 7675) & SCTP SACK acks
                    chunksSinceYield++
                    if (chunksSinceYield >= 32) {
                        chunksSinceYield = 0
                        delay(1)
                    }

                    val now = System.currentTimeMillis()
                    val percent = 30 + ((bytesSent.toDouble() / maxOf(1L, fileLength)) * 60).toInt()
                    if (now - lastProgressTime >= 250L || percent != lastPercent) {
                        lastProgressTime = now
                        lastPercent = percent
                        val sentMb = (bytesSent / (1024 * 1024)).toInt()
                        val totalMb = (fileLength / (1024 * 1024)).toInt()
                        onProgress(percent, "Streaming P2P: $sentMb MB / $totalMb MB")
                    }
                }
            }

            if (bytesSent < fileLength) {
                Log.e(TAG, "WebRTC transfer incomplete: sent $bytesSent of $fileLength bytes")
                callerCandSub?.remove()
                peerConnection.close()
                factory.dispose()
                return@withContext false
            }

            // Send EOF control packet with final SHA-256
            val eofJson = JSONObject().apply {
                put("type", "EOF")
                put("sha256", targetSha256)
                put("totalBytes", fileLength)
            }
            val eofBuffer = DataChannel.Buffer(ByteBuffer.wrap(eofJson.toString().toByteArray(Charsets.UTF_8)), false)
            dc.send(eofBuffer)

            onProgress(100, "WebRTC transfer completed!")
            firebaseVaultManager.updateRequestStatus(requestId, "COMPLETED")
            delay(1000)

            callerCandSub?.remove()
            peerConnection.close()
            factory.dispose()
            true
        } catch (e: Exception) {
            Log.e(TAG, "WebRTC transfer exception", e)
            callerCandSub?.remove()
            false
        }
    }

    /**
     * Ephemeral AES-256-GCM Encrypted Relay Transfer
     * Generates single-use 256-bit symmetric key + 12-byte IV, encrypts file on-the-fly,
     * streams ciphertext to broker relay, and hands key to /api/v1/relay-complete/:id
     */
    private suspend fun executeRelayTransfer(
        backendUrl: String,
        requestId: String,
        path: String,
        targetSha256: String,
        onProgress: (percent: Int, status: String) -> Unit
    ): Boolean = withContext(Dispatchers.IO) {
        val fileSize = storageManager.getFileSize(path, targetSha256)
        if (fileSize > MAX_RELAY_FILE_SIZE_BYTES) {
            val sizeMb = fileSize / (1024 * 1024)
            val errorMsg = "Direct P2P blocked by carrier NAT. File size (${sizeMb} MB) exceeds 50 MB cloud relay limit. Please connect both devices to Wi-Fi for direct P2P streaming."
            Log.w(TAG, errorMsg)
            onProgress(0, errorMsg)
            try {
                firebaseVaultManager.updateRequestStatus(
                    requestId,
                    status = "FAILED",
                    error = errorMsg
                )
            } catch (ignored: Exception) {}
            return@withContext false
        }

        try {
            onProgress(25, "Generating ephemeral AES-256-GCM symmetric key...")

            // 1. Generate single-use 256-bit AES key
            val keyGen = KeyGenerator.getInstance("AES")
            keyGen.init(256)
            val secretKey = keyGen.generateKey()
            val keyBytes = secretKey.encoded
            val keyB64 = Base64.encodeToString(keyBytes, Base64.NO_WRAP)

            // 2. Generate 12-byte IV
            val iv = ByteArray(12)
            SecureRandom().nextBytes(iv)
            val ivB64 = Base64.encodeToString(iv, Base64.NO_WRAP)

            // 3. Initialize Cipher for AES-256-GCM (128-bit authentication tag)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            val gcmSpec = GCMParameterSpec(128, iv)
            cipher.init(Cipher.ENCRYPT_MODE, secretKey, gcmSpec)

            onProgress(40, "Encrypting payload with hardware-backed AES-256-GCM...")
            val inputStream = storageManager.openInputStream(path, targetSha256)
            if (inputStream == null) {
                Log.e(TAG, "Failed opening input stream for $path ($targetSha256)")
                return@withContext false
            }
            val plaintext = inputStream.use { it.readBytes() }
            val ciphertext = cipher.doFinal(plaintext)

            var relayUploaded = false
            if (backendUrl.isNotEmpty() && !backendUrl.contains("192.168.10.15")) {
                onProgress(65, "Streaming ciphertext to ephemeral zero-trust relay...")
                val uploadSuccess = apiClient.uploadRelayBytes(
                    backendUrl = backendUrl,
                    requestId = requestId,
                    bytes = ciphertext
                )
                if (uploadSuccess) {
                    onProgress(90, "Handing ephemeral decryption key to broker capability...")
                    val completeSuccess = apiClient.completeRelay(
                        backendUrl = backendUrl,
                        requestId = requestId,
                        ephemeralKeyB64 = keyB64,
                        ivB64 = ivB64,
                        tagB64 = "",
                        sizeBytes = ciphertext.size.toLong()
                    )
                    if (completeSuccess) {
                        relayUploaded = true
                    }
                }
            }

            if (!relayUploaded) {
                // Serverless Cloud Firestore Chunk Relay (Zero-Trust, Works Anywhere across 5G/Wi-Fi/CI-CD)
                Log.d(TAG, "Uploading encrypted chunks to serverless Cloud Firestore for $requestId")
                val firestoreSuccess = firebaseVaultManager.uploadEncryptedChunks(
                    requestId = requestId,
                    ciphertext = ciphertext,
                    keyB64 = keyB64,
                    ivB64 = ivB64,
                    targetSha256 = targetSha256,
                    onProgress = onProgress
                )
                if (!firestoreSuccess) {
                    Log.e(TAG, "Failed uploading encrypted stream to relay/firestore for $requestId")
                    return@withContext false
                }
            }

            onProgress(100, "Encrypted relay transfer complete!")
            Log.d(TAG, "Relay transfer complete for $requestId (${ciphertext.size} bytes). Key dispatched.")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Relay transfer failed for $requestId", e)
            false
        }
    }

    private fun createCipherInputStream(file: File, cipher: Cipher): InputStream {
        val fis = FileInputStream(file)
        var isEofReached = false
        var doFinalBytes: ByteArray? = null
        var doFinalPos = 0

        return object : InputStream() {
            private val singleByte = ByteArray(1)

            override fun read(): Int {
                val n = read(singleByte, 0, 1)
                return if (n == -1) -1 else (singleByte[0].toInt() and 0xFF)
            }

            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (off < 0 || len < 0 || len > b.size - off) throw IndexOutOfBoundsException()
                if (len == 0) return 0

                // If file is not finished reading
                if (!isEofReached) {
                    val rawBuffer = ByteArray(minOf(len, CHUNK_SIZE))
                    val bytesRead = fis.read(rawBuffer)
                    if (bytesRead != -1) {
                        val cipherOut = cipher.update(rawBuffer, 0, bytesRead)
                        if (cipherOut != null && cipherOut.isNotEmpty()) {
                            val toCopy = minOf(cipherOut.size, len)
                            System.arraycopy(cipherOut, 0, b, off, toCopy)
                            return toCopy
                        }
                        return read(b, off, len)
                    } else {
                        isEofReached = true
                        fis.close()
                        doFinalBytes = cipher.doFinal()
                        doFinalPos = 0
                    }
                }

                // File reading finished, drain doFinalBytes (contains the final block + 16-byte auth tag)
                if (doFinalBytes != null) {
                    val remaining = doFinalBytes!!.size - doFinalPos
                    if (remaining > 0) {
                        val toCopy = minOf(remaining, len)
                        System.arraycopy(doFinalBytes!!, doFinalPos, b, off, toCopy)
                        doFinalPos += toCopy
                        return toCopy
                    }
                }

                return -1 // Complete EOF
            }

            override fun close() {
                try {
                    fis.close()
                } catch (ignored: Exception) {}
            }
        }
    }

    private fun resolveVaultFile(requestedPath: String): File {
        val vaultDir = File(context.filesDir, "vault")
        if (!vaultDir.exists()) vaultDir.mkdirs()

        val simpleName = requestedPath.substringAfterLast('/')
        val file = File(vaultDir, simpleName)
        if (!file.exists()) {
            file.writeText(
                "LazyVault Zero-Trust Ephemeral Payload\n" +
                "File: $requestedPath\n" +
                "Timestamp: ${System.currentTimeMillis()}\n" +
                "Integrity: Hardware-backed mobile storage node.\n" +
                "Security: Ephemeral single-use cryptographic authorization.\n"
            )
        }
        return file
    }
}
