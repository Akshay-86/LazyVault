package com.akshay.lazyvault.net

import com.akshay.lazyvault.data.CatalogSnapshot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.util.concurrent.TimeUnit

class VaultApiClient {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    suspend fun fetchNetworkInfo(backendUrl: String): JSONObject? = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder()
                .url("$backendUrl/api/v1/network-info")
                .get()
                .build()

            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@withContext null
                val body = response.body?.string() ?: return@withContext null
                JSONObject(body)
            }
        } catch (e: Exception) {
            null
        }
    }

    suspend fun syncVaultLink(
        backendUrl: String,
        vaultId: String,
        deviceId: String,
        password: String,
        expiresInSeconds: Long?,
        snapshot: CatalogSnapshot? = null
    ): JSONObject? = withContext(Dispatchers.IO) {
        try {
            val json = JSONObject().apply {
                put("vaultId", vaultId)
                put("deviceId", deviceId)
                put("password", password)
                if (expiresInSeconds != null && expiresInSeconds > 0) {
                    put("expiresInSeconds", expiresInSeconds)
                }

                if (snapshot != null) {
                    val root = JSONObject().apply {
                        put("generation", snapshot.generation)
                        put("rootMerkle", snapshot.rootMerkle)
                        put("deviceId", snapshot.deviceId)
                        val filesArray = JSONArray()
                        for (file in snapshot.files) {
                            val fObj = JSONObject().apply {
                                put("path", file.path)
                                put("size", file.size)
                                put("sha256", file.sha256)
                                put("mtime", file.mtime)
                                put("name", if (file.name.isNotEmpty()) file.name else file.path.substringAfterLast('/'))
                            }
                            filesArray.put(fObj)
                        }
                        put("files", filesArray)
                    }
                    put("catalog", root)
                }
            }

            val request = Request.Builder()
                .url("$backendUrl/api/v1/vault/sync")
                .post(json.toString().toRequestBody(jsonMediaType))
                .build()

            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@withContext null
                val body = response.body?.string() ?: return@withContext null
                JSONObject(body)
            }
        } catch (e: Exception) {
            e.printStackTrace()
            null
        }
    }

    suspend fun revokeVault(backendUrl: String, vaultId: String): Boolean = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder()
                .url("$backendUrl/api/v1/vault/$vaultId/revoke")
                .post("{}".toRequestBody(jsonMediaType))
                .build()

            client.newCall(request).execute().use { response ->
                response.isSuccessful
            }
        } catch (e: Exception) {
            false
        }
    }

    suspend fun registerDevice(
        backendUrl: String,
        deviceId: String,
        deviceName: String,
        fcmToken: String?,
        appVersion: String = "1.0.0"
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            val json = JSONObject().apply {
                put("deviceId", deviceId)
                put("deviceName", deviceName)
                put("fcmToken", fcmToken ?: "")
                put("appVersion", appVersion)
            }
            val request = Request.Builder()
                .url("$backendUrl/api/v1/device/register")
                .post(json.toString().toRequestBody(jsonMediaType))
                .build()

            client.newCall(request).execute().use { response ->
                response.isSuccessful
            }
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    suspend fun syncCatalog(
        backendUrl: String,
        snapshot: CatalogSnapshot
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            val root = JSONObject().apply {
                put("generation", snapshot.generation)
                put("rootMerkle", snapshot.rootMerkle)
                put("deviceId", snapshot.deviceId)
                val filesArray = JSONArray()
                for (file in snapshot.files) {
                    val fObj = JSONObject().apply {
                        put("path", file.path)
                        put("size", file.size)
                        put("sha256", file.sha256)
                        put("mtime", file.mtime)
                        put("name", if (file.name.isNotEmpty()) file.name else file.path.substringAfterLast('/'))
                    }
                    filesArray.put(fObj)
                }
                put("files", filesArray)
            }

            val request = Request.Builder()
                .url("$backendUrl/api/v1/catalog/sync")
                .post(root.toString().toRequestBody(jsonMediaType))
                .build()

            client.newCall(request).execute().use { response ->
                response.isSuccessful
            }
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    suspend fun sendDecision(
        backendUrl: String,
        requestId: String,
        decision: String,
        selectedTransport: String? = null,
        reason: String? = null
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            val json = JSONObject().apply {
                put("decision", decision)
                if (selectedTransport != null) put("selected_transport", selectedTransport)
                if (reason != null) put("reason", reason)
            }
            val request = Request.Builder()
                .url("$backendUrl/api/v1/request-file/$requestId/decision")
                .post(json.toString().toRequestBody(jsonMediaType))
                .build()

            client.newCall(request).execute().use { response ->
                response.isSuccessful
            }
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    suspend fun uploadRelayStream(
        backendUrl: String,
        requestId: String,
        inputStream: InputStream,
        contentLength: Long
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            val customRequestBody = object : RequestBody() {
                override fun contentType(): MediaType = "application/octet-stream".toMediaType()

                override fun contentLength(): Long = contentLength

                override fun writeTo(sink: BufferedSink) {
                    val buffer = ByteArray(64 * 1024)
                    var read: Int
                    while (inputStream.read(buffer).also { read = it } != -1) {
                        sink.write(buffer, 0, read)
                    }
                }
            }

            val request = Request.Builder()
                .url("$backendUrl/api/v1/relay/$requestId/upload")
                .put(customRequestBody)
                .build()

            client.newCall(request).execute().use { response ->
                response.isSuccessful
            }
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    suspend fun uploadRelayBytes(
        backendUrl: String,
        requestId: String,
        bytes: ByteArray
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            val requestBody = bytes.toRequestBody("application/octet-stream".toMediaType())
            val request = Request.Builder()
                .url("$backendUrl/api/v1/relay/$requestId/upload")
                .put(requestBody)
                .build()

            client.newCall(request).execute().use { response ->
                response.isSuccessful
            }
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    suspend fun completeRelay(
        backendUrl: String,
        requestId: String,
        ephemeralKeyB64: String,
        ivB64: String,
        tagB64: String,
        sizeBytes: Long
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            val json = JSONObject().apply {
                put("ephemeral_key", ephemeralKeyB64)
                put("encryption_key_b64", ephemeralKeyB64)
                put("iv", ivB64)
                put("iv_b64", ivB64)
                put("tag", tagB64)
                put("auth_tag_b64", tagB64)
                put("size_bytes", sizeBytes)
                put("file_size_bytes", sizeBytes)
            }

            val request = Request.Builder()
                .url("$backendUrl/api/v1/relay-complete/$requestId")
                .post(json.toString().toRequestBody(jsonMediaType))
                .build()

            client.newCall(request).execute().use { response ->
                response.isSuccessful
            }
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    suspend fun sendSignaling(
        backendUrl: String,
        requestId: String,
        sender: String,
        type: String,
        payload: Any
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            val root = JSONObject().apply {
                put("sender", sender)
                put("type", type)
                put("payload", payload)
            }

            val request = Request.Builder()
                .url("$backendUrl/api/v1/signaling/$requestId")
                .post(root.toString().toRequestBody(jsonMediaType))
                .build()

            client.newCall(request).execute().use { response ->
                response.isSuccessful
            }
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    suspend fun pollSignaling(
        backendUrl: String,
        requestId: String,
        peer: String = "device"
    ): JSONArray? = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder()
                .url("$backendUrl/api/v1/signaling/$requestId?peer=$peer")
                .get()
                .build()

            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@withContext null
                val bodyStr = response.body?.string() ?: return@withContext null
                val obj = JSONObject(bodyStr)
                obj.optJSONArray("messages")
            }
        } catch (e: Exception) {
            null
        }
    }

    suspend fun fetchPendingRequests(backendUrl: String, vaultId: String): List<com.akshay.lazyvault.data.TransferRequest> = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder()
                .url("$backendUrl/api/v1/vault/$vaultId/pending-requests")
                .get()
                .build()

            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@withContext emptyList()
                val bodyStr = response.body?.string() ?: return@withContext emptyList()
                val obj = JSONObject(bodyStr)
                val array = obj.optJSONArray("requests") ?: return@withContext emptyList()
                val list = mutableListOf<com.akshay.lazyvault.data.TransferRequest>()
                for (i in 0 until array.length()) {
                    val r = array.getJSONObject(i)
                    val transportsArray = r.optJSONArray("supportedTransports")
                    val transports = mutableListOf<String>()
                    if (transportsArray != null) {
                        for (j in 0 until transportsArray.length()) {
                            transports.add(transportsArray.getString(j))
                        }
                    } else {
                        transports.add("relay")
                    }
                    list.add(
                        com.akshay.lazyvault.data.TransferRequest(
                            requestId = r.getString("requestId"),
                            path = r.getString("path"),
                            sha256 = r.optString("sha256"),
                            requesterContext = r.optString("requesterContext", "Web Client"),
                            requesterIp = r.optString("requesterIp", "127.0.0.1"),
                            supportedTransports = transports,
                            expiresAt = r.optLong("expiresAt", System.currentTimeMillis() + 60000L)
                        )
                    )
                }
                list
            }
        } catch (e: Exception) {
            emptyList()
        }
    }

    suspend fun fetchConnectedClients(backendUrl: String, vaultId: String): List<com.akshay.lazyvault.data.ConnectedClient> = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder()
                .url("$backendUrl/api/v1/vault/$vaultId/clients")
                .get()
                .build()

            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@withContext emptyList()
                val bodyStr = response.body?.string() ?: return@withContext emptyList()
                val obj = JSONObject(bodyStr)
                val array = obj.optJSONArray("clients") ?: return@withContext emptyList()
                val list = mutableListOf<com.akshay.lazyvault.data.ConnectedClient>()
                for (i in 0 until array.length()) {
                    val c = array.getJSONObject(i)
                    list.add(
                        com.akshay.lazyvault.data.ConnectedClient(
                            clientId = c.getString("clientId"),
                            ip = c.getString("ip"),
                            deviceName = c.getString("deviceName"),
                            connectedAt = c.optLong("connectedAt"),
                            lastSeen = c.optLong("lastSeen"),
                            activeSecondsAgo = c.optLong("activeSecondsAgo")
                        )
                    )
                }
                list
            }
        } catch (e: Exception) {
            emptyList()
        }
    }
}
