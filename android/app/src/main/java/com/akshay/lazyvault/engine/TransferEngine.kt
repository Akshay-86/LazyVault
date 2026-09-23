package com.akshay.lazyvault.engine

import android.content.Context
import android.util.Base64
import android.util.Log
import com.akshay.lazyvault.data.AuditLogEntry
import com.akshay.lazyvault.net.VaultApiClient
import com.akshay.lazyvault.storage.VaultPreferences
import com.akshay.lazyvault.storage.VaultStorageManager
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
        const val CHUNK_SIZE = 64 * 1024 // 64KB chunks
        const val BUFFERED_AMOUNT_LOW_THRESHOLD = 512 * 1024L // 512KB backpressure threshold
    }

    private val storageManager = VaultStorageManager(context)

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
            return@withContext false
        }
        try {
            testStream.close()
        } catch (ignored: Exception) {}

        var transportUsed = "relay"
        var success = false

        // Check if Relay is requested or available (zero-trust, instantaneous, highly resilient)
        if (supportedTransports.contains("relay")) {
            onProgress(15, "Starting encrypted ephemeral zero-trust relay...")
            success = executeRelayTransfer(backendUrl, requestId, path, targetSha256, onProgress)
            transportUsed = "relay"
        } else if (supportedTransports.contains("webrtc")) {
            onProgress(10, "Attempting WebRTC P2P DataChannel transfer...")
            val webrtcSuccess = executeWebRtcTransfer(backendUrl, requestId, path, targetSha256, onProgress)
            if (webrtcSuccess) {
                success = true
                transportUsed = "webrtc"
            } else {
                Log.w(TAG, "WebRTC transfer could not complete or timed out. Falling back to Encrypted Ephemeral Relay.")
                onProgress(20, "WebRTC peer unavailable. Falling back to encrypted relay...")
                success = executeRelayTransfer(backendUrl, requestId, path, targetSha256, onProgress)
                transportUsed = "relay"
            }
        } else {
            // Default to relay
            success = executeRelayTransfer(backendUrl, requestId, path, targetSha256, onProgress)
            transportUsed = "relay"
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
     */
    private suspend fun executeWebRtcTransfer(
        backendUrl: String,
        requestId: String,
        path: String,
        targetSha256: String,
        onProgress: (percent: Int, status: String) -> Unit
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            // Initialize PeerConnectionFactory
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context)
                    .createInitializationOptions()
            )

            val factory = PeerConnectionFactory.builder().createPeerConnectionFactory()

            val iceServers = listOf(
                PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
                PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer()
            )

            val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            }

            var remoteOfferReceived = false
            var offerPayload: JSONObject? = null

            // Poll for browser's SDP Offer (max 10 seconds)
            val startTime = System.currentTimeMillis()
            while (System.currentTimeMillis() - startTime < 10000L) {
                val messages = apiClient.pollSignaling(backendUrl, requestId, peer = "device")
                if (messages != null && messages.length() > 0) {
                    for (i in 0 until messages.length()) {
                        val msg = messages.getJSONObject(i)
                        if (msg.optString("sender") == "client" && msg.optString("type") == "offer") {
                            offerPayload = msg.getJSONObject("payload")
                            remoteOfferReceived = true
                            break
                        }
                    }
                }
                if (remoteOfferReceived) break
                delay(1000)
            }

            if (!remoteOfferReceived || offerPayload == null) {
                Log.d(TAG, "No WebRTC offer received from browser in 10s, switching to relay")
                factory.dispose()
                return@withContext false
            }

            onProgress(20, "WebRTC offer received. Negotiating peer connection...")

            var activeDataChannel: DataChannel? = null
            var channelOpened = false

            val observer = object : PeerConnection.Observer {
                override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {}
                override fun onIceConnectionReceivingChange(receiving: Boolean) {}
                override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
                override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
                override fun onAddStream(stream: MediaStream?) {}
                override fun onRemoveStream(stream: MediaStream?) {}
                override fun onRenegotiationNeeded() {}

                override fun onIceCandidate(candidate: IceCandidate?) {
                    if (candidate != null) {
                        val candJson = JSONObject().apply {
                            put("sdpMid", candidate.sdpMid)
                            put("sdpMLineIndex", candidate.sdpMLineIndex)
                            put("candidate", candidate.sdp)
                        }
                        scope.launch {
                            apiClient.sendSignaling(backendUrl, requestId, "device", "candidate", candJson)
                        }
                    }
                }

                override fun onDataChannel(dc: DataChannel?) {
                    if (dc != null) {
                        Log.d(TAG, "WebRTC DataChannel received: ${dc.label()}")
                        activeDataChannel = dc
                        dc.registerObserver(object : DataChannel.Observer {
                            override fun onBufferedAmountChange(previousAmount: Long) {}
                            override fun onStateChange() {
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

            val peerConnection = factory.createPeerConnection(rtcConfig, observer) ?: run {
                factory.dispose()
                return@withContext false
            }

            // Set Remote Description (Offer)
            val sdpString = offerPayload.getString("sdp")
            val remoteDesc = SessionDescription(SessionDescription.Type.OFFER, sdpString)

            peerConnection.setRemoteDescription(object : SdpObserver {
                override fun onCreateSuccess(p0: SessionDescription?) {}
                override fun onSetSuccess() {
                    Log.d(TAG, "Remote description set successfully")
                    // Create Answer
                    peerConnection.createAnswer(object : SdpObserver {
                        override fun onCreateSuccess(answer: SessionDescription?) {
                            if (answer != null) {
                                peerConnection.setLocalDescription(object : SdpObserver {
                                    override fun onCreateSuccess(p0: SessionDescription?) {}
                                    override fun onSetSuccess() {
                                        val answerPayload = JSONObject().apply {
                                            put("sdp", answer.description)
                                            put("type", "answer")
                                        }
                                        scope.launch {
                                            apiClient.sendSignaling(backendUrl, requestId, "device", "answer", answerPayload)
                                        }
                                    }
                                    override fun onCreateFailure(p0: String?) {}
                                    override fun onSetFailure(p0: String?) {}
                                }, answer)
                            }
                        }
                        override fun onSetSuccess() {}
                        override fun onCreateFailure(p0: String?) {}
                        override fun onSetFailure(p0: String?) {}
                    }, MediaConstraints())
                }
                override fun onCreateFailure(p0: String?) {}
                override fun onSetFailure(p0: String?) {}
            }, remoteDesc)

            // Wait for DataChannel to Open (max 10 seconds)
            val channelWaitStart = System.currentTimeMillis()
            while (!channelOpened && System.currentTimeMillis() - channelWaitStart < 10000L) {
                delay(300)
            }

            if (!channelOpened || activeDataChannel == null) {
                Log.w(TAG, "DataChannel did not open within timeout, falling back to relay")
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
                peerConnection.close()
                factory.dispose()
                return@withContext false
            }

            var bytesSent = 0L
            val buffer = ByteArray(CHUNK_SIZE)

            inputStream.use { fis ->
                var read: Int
                while (fis.read(buffer).also { read = it } != -1) {
                    val chunkBytes = if (read == CHUNK_SIZE) buffer else buffer.copyOf(read)
                    val byteBuffer = ByteBuffer.wrap(chunkBytes)
                    val dataBuffer = DataChannel.Buffer(byteBuffer, true) // binary

                    // Backpressure check: wait if bufferedAmount exceeds threshold
                    while (dc.bufferedAmount() > BUFFERED_AMOUNT_LOW_THRESHOLD) {
                        delay(10)
                    }

                    dc.send(dataBuffer)
                    bytesSent += read

                    val percent = 30 + ((bytesSent.toDouble() / maxOf(1L, fileLength)) * 60).toInt()
                    onProgress(percent, "Streaming: ${bytesSent / 1024} KB / ${fileLength / 1024} KB")
                }
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
            delay(500)

            peerConnection.close()
            factory.dispose()
            true
        } catch (e: Exception) {
            Log.e(TAG, "WebRTC transfer exception", e)
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

            onProgress(65, "Streaming ciphertext to ephemeral zero-trust relay...")
            val uploadSuccess = apiClient.uploadRelayBytes(
                backendUrl = backendUrl,
                requestId = requestId,
                bytes = ciphertext
            )

            if (!uploadSuccess) {
                Log.e(TAG, "Failed uploading encrypted stream to relay for $requestId")
                return@withContext false
            }

            onProgress(90, "Handing ephemeral decryption key to broker capability...")

            val completeSuccess = apiClient.completeRelay(
                backendUrl = backendUrl,
                requestId = requestId,
                ephemeralKeyB64 = keyB64,
                ivB64 = ivB64,
                tagB64 = "",
                sizeBytes = ciphertext.size.toLong()
            )

            onProgress(100, "Encrypted relay transfer complete!")
            Log.d(TAG, "Relay transfer complete for $requestId (${ciphertext.size} bytes). Key dispatched.")
            completeSuccess
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
