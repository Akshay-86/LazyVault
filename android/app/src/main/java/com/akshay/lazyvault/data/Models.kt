package com.akshay.lazyvault.data

data class CatalogItem(
    val path: String,
    val size: Long,
    val sha256: String,
    val mtime: Long
)

data class CatalogSnapshot(
    val generation: Long,
    val rootMerkle: String,
    val updatedAt: Long,
    val deviceId: String,
    val files: List<CatalogItem>
)

data class TransferRequest(
    val requestId: String,
    val path: String,
    val sha256: String,
    val requesterContext: String,
    val requesterIp: String,
    val supportedTransports: List<String>,
    val expiresAt: Long
)

data class AuditLogEntry(
    val requestId: String,
    val path: String,
    val status: String,
    val requester: String,
    val transport: String,
    val timestamp: Long,
    val details: String
)

data class ConnectedClient(
    val clientId: String,
    val ip: String,
    val deviceName: String,
    val connectedAt: Long,
    val lastSeen: Long,
    val activeSecondsAgo: Long
)
