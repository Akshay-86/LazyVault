package com.akshay.lazyvault.storage

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import com.akshay.lazyvault.data.AuditLogEntry
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

class VaultPreferences(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("lazyvault_prefs", Context.MODE_PRIVATE)

    var backendUrl: String
        get() {
            val saved = prefs.getString("backend_url", null)
            if (saved == null || saved.contains("10.0.2.2")) {
                return "http://192.168.10.15:4000"
            }
            return saved
        }
        set(value) = prefs.edit().putString("backend_url", value.trimEnd('/')).apply()

    var vaultId: String
        get() {
            var id = prefs.getString("vault_id", null)
            if (id == null) {
                id = "vlt_" + UUID.randomUUID().toString().replace("-", "").take(10)
                prefs.edit().putString("vault_id", id).apply()
            }
            return id
        }
        set(value) = prefs.edit().putString("vault_id", value).apply()

    var vaultPassword: String
        get() = prefs.getString("vault_password", "vault123") ?: "vault123"
        set(value) = prefs.edit().putString("vault_password", value).apply()

    var vaultExpirationSeconds: Long
        get() = prefs.getLong("vault_exp_seconds", 86400L) // default 24h (0 = permanent)
        set(value) = prefs.edit().putLong("vault_exp_seconds", value).apply()

    var shareableUrl: String?
        get() {
            val url = prefs.getString("shareable_url", null)
            return if (url != null && url.contains("lazyvault-node.web.app")) {
                val updated = url.replace("lazyvault-node.web.app", "lazyvault.web.app")
                prefs.edit().putString("shareable_url", updated).apply()
                updated
            } else {
                url
            }
        }
        set(value) = prefs.edit().putString("shareable_url", value).apply()

    var deviceId: String
        get() {
            var id = prefs.getString("device_id", null)
            if (id == null) {
                id = UUID.randomUUID().toString()
                prefs.edit().putString("device_id", id).apply()
            }
            return id
        }
        set(value) = prefs.edit().putString("device_id", value).apply()

    var deviceName: String
        get() = prefs.getString("device_name", "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL} Node")
            ?: "${Build.MANUFACTURER} ${Build.MODEL} Node"
        set(value) = prefs.edit().putString("device_name", value).apply()

    var fcmToken: String?
        get() = prefs.getString("fcm_token", null)
        set(value) = prefs.edit().putString("fcm_token", value).apply()

    var lastCatalogGeneration: Long
        get() = prefs.getLong("catalog_generation", 0L)
        set(value) = prefs.edit().putLong("catalog_generation", value).apply()

    var rootMerkleHash: String
        get() = prefs.getString("root_merkle_hash", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
            ?: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        set(value) = prefs.edit().putString("root_merkle_hash", value).apply()

    var selectedFolderUri: String?
        get() = prefs.getString("selected_folder_uri", null)
        set(value) = prefs.edit().putString("selected_folder_uri", value).apply()

    var selectedFolderName: String?
        get() = prefs.getString("selected_folder_name", null)
        set(value) = prefs.edit().putString("selected_folder_name", value).apply()

    fun saveFileMappings(uriMap: Map<String, String>, sizeMap: Map<String, Long>) {
        val uriObj = JSONObject()
        for ((k, v) in uriMap) {
            uriObj.put(k, v)
        }
        val sizeObj = JSONObject()
        for ((k, v) in sizeMap) {
            sizeObj.put(k, v)
        }
        prefs.edit()
            .putString("file_uri_mappings", uriObj.toString())
            .putString("file_size_mappings", sizeObj.toString())
            .apply()
    }

    fun getFileUri(key: String): String? {
        val raw = prefs.getString("file_uri_mappings", null) ?: return null
        return try {
            val obj = JSONObject(raw)
            if (obj.has(key)) obj.getString(key) else null
        } catch (e: Exception) {
            null
        }
    }

    fun getFileSize(key: String): Long {
        val raw = prefs.getString("file_size_mappings", null) ?: return 0L
        return try {
            val obj = JSONObject(raw)
            if (obj.has(key)) obj.getLong(key) else 0L
        } catch (e: Exception) {
            0L
        }
    }

    fun clearFileMappings() {
        prefs.edit()
            .remove("file_uri_mappings")
            .remove("file_size_mappings")
            .apply()
    }

    fun regenerateVaultId(): String {
        val newId = "vlt_" + UUID.randomUUID().toString().replace("-", "").take(10)
        vaultId = newId
        return newId
    }

    fun addAuditEntry(entry: AuditLogEntry) {
        val entries = getAuditEntries().toMutableList()
        entries.add(0, entry)
        if (entries.size > 50) {
            entries.removeAt(entries.size - 1)
        }

        val array = JSONArray()
        for (item in entries) {
            val obj = JSONObject()
            obj.put("requestId", item.requestId)
            obj.put("path", item.path)
            obj.put("status", item.status)
            obj.put("requester", item.requester)
            obj.put("transport", item.transport)
            obj.put("timestamp", item.timestamp)
            obj.put("details", item.details)
            array.put(obj)
        }
        prefs.edit().putString("audit_log", array.toString()).apply()
    }

    fun getAuditEntries(): List<AuditLogEntry> {
        val raw = prefs.getString("audit_log", null) ?: return emptyList()
        val list = mutableListOf<AuditLogEntry>()
        try {
            val array = JSONArray(raw)
            for (i in 0 until array.length()) {
                val obj = array.getJSONObject(i)
                list.add(
                    AuditLogEntry(
                        requestId = obj.optString("requestId"),
                        path = obj.optString("path"),
                        status = obj.optString("status"),
                        requester = obj.optString("requester"),
                        transport = obj.optString("transport"),
                        timestamp = obj.optLong("timestamp"),
                        details = obj.optString("details")
                    )
                )
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
        return list
    }
}
