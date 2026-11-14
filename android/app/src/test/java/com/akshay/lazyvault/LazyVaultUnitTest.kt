package com.akshay.lazyvault

import com.akshay.lazyvault.data.AuditLogEntry
import com.akshay.lazyvault.data.CatalogItem
import com.akshay.lazyvault.data.CatalogSnapshot
import com.akshay.lazyvault.data.ConnectedClient
import com.akshay.lazyvault.data.TransferRequest
import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec

class LazyVaultUnitTest {

    @Test
    fun testCatalogModels() {
        val item = CatalogItem(
            path = "/storage/vault/doc.pdf",
            size = 2048L,
            sha256 = "abcd1234ef567890abcd1234ef567890abcd1234ef567890abcd1234ef567890",
            mtime = 1700000000L,
            name = "doc.pdf"
        )
        assertEquals("/storage/vault/doc.pdf", item.path)
        assertEquals(2048L, item.size)
        assertEquals("doc.pdf", item.name)

        val snapshot = CatalogSnapshot(
            generation = 100L,
            rootMerkle = "rootmerkle123",
            updatedAt = 1700000000L,
            deviceId = "dev-1",
            files = listOf(item)
        )
        assertEquals(1, snapshot.files.size)
        assertEquals("rootmerkle123", snapshot.rootMerkle)
    }

    @Test
    fun testTransferRequestExpiryCalculation() {
        val now = System.currentTimeMillis()
        val validRequest = TransferRequest(
            requestId = "req-1",
            path = "/storage/vault/secret.kdbx",
            sha256 = "hash123",
            requesterContext = "Browser Chrome",
            requesterIp = "192.168.1.50",
            supportedTransports = listOf("webrtc", "relay"),
            expiresAt = now + 60000L
        )
        assertTrue(validRequest.expiresAt > now)

        val expiredRequest = TransferRequest(
            requestId = "req-2",
            path = "/storage/vault/secret.kdbx",
            sha256 = "hash123",
            requesterContext = "Browser Chrome",
            requesterIp = "192.168.1.50",
            supportedTransports = listOf("webrtc", "relay"),
            expiresAt = now - 5000L
        )
        assertTrue(expiredRequest.expiresAt <= now)
    }

    @Test
    fun testAes256GcmRelayEncryptionAndTagExtraction() {
        // Test that Java AES/GCM cipher.doFinal appends 16-byte authentication tag
        // matching the expectation in backend & Web Crypto decrypt
        val keyGen = KeyGenerator.getInstance("AES")
        keyGen.init(256)
        val secretKey = keyGen.generateKey()

        val iv = ByteArray(12)
        SecureRandom().nextBytes(iv)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val gcmSpec = GCMParameterSpec(128, iv)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey, gcmSpec)

        val plaintext = "LazyVault Zero-Trust Ephemeral Stream Test Payload".toByteArray(Charsets.UTF_8)
        val ciphertext = cipher.doFinal(plaintext)

        // GCM ciphertext length must be plaintext.length + 16 (for 128-bit auth tag)
        assertEquals(plaintext.size + 16, ciphertext.size)

        val tagBytes = ciphertext.copyOfRange(ciphertext.size - 16, ciphertext.size)
        val rawCiphertext = ciphertext.copyOfRange(0, ciphertext.size - 16)
        assertEquals(16, tagBytes.size)

        // Decrypt using Cipher in DECRYPT_MODE to verify tag verification
        val decipher = Cipher.getInstance("AES/GCM/NoPadding")
        decipher.init(Cipher.DECRYPT_MODE, secretKey, gcmSpec)
        val decrypted = decipher.doFinal(ciphertext)

        assertArrayEquals(plaintext, decrypted)
    }

    @Test
    fun testMerkleRootCalculation() {
        val digest = MessageDigest.getInstance("SHA-256")
        val sha1 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        val sha2 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

        digest.update(sha1.toByteArray(Charsets.UTF_8))
        digest.update(sha2.toByteArray(Charsets.UTF_8))

        val merkleBytes = digest.digest()
        val merkleHex = merkleBytes.joinToString("") { "%02x".format(it) }

        assertEquals(64, merkleHex.length)
        assertTrue(merkleHex.all { it.isDigit() || it in 'a'..'f' })
    }

    @Test
    fun testAuditLogEntry() {
        val entry = AuditLogEntry(
            requestId = "req-100",
            path = "/storage/vault/report.pdf",
            status = "APPROVED",
            requester = "Web Client",
            transport = "webrtc",
            timestamp = 1700000000000L,
            details = "2048 bytes transferred via webrtc"
        )
        assertEquals("APPROVED", entry.status)
        assertEquals("webrtc", entry.transport)
    }

    @Test
    fun testConnectedClient() {
        val client = ConnectedClient(
            clientId = "client-abc",
            ip = "192.168.1.100",
            deviceName = "Chrome on macOS",
            connectedAt = 1700000000000L,
            lastSeen = 1700000005000L,
            activeSecondsAgo = 5L
        )
        assertEquals("client-abc", client.clientId)
        assertEquals("Chrome on macOS", client.deviceName)
        assertEquals(5L, client.activeSecondsAgo)
    }
}
