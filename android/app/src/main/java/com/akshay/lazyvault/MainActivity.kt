package com.akshay.lazyvault

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.text.format.Formatter
import android.view.Gravity
import android.view.ViewGroup
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import android.view.View
import com.akshay.lazyvault.data.AuditLogEntry
import com.akshay.lazyvault.data.CatalogItem
import com.akshay.lazyvault.data.CatalogSnapshot
import com.akshay.lazyvault.data.ConnectedClient
import com.akshay.lazyvault.data.TransferRequest
import com.akshay.lazyvault.databinding.ActivityMainBinding
import com.akshay.lazyvault.net.VaultApiClient
import com.akshay.lazyvault.service.ForegroundDataTransferService
import com.akshay.lazyvault.service.VaultNotificationManager
import com.akshay.lazyvault.storage.VaultPreferences
import com.akshay.lazyvault.worker.CatalogIndexWorker
import com.google.android.material.card.MaterialCardView
import com.google.firebase.messaging.FirebaseMessaging
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileInputStream
import java.net.NetworkInterface
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: VaultPreferences
    private val apiClient = VaultApiClient()
    private val scope = CoroutineScope(Dispatchers.Main + Job())
    private var currentFiles = listOf<CatalogItem>()

    // Live poller for pending requests and connected devices
    private var livePollJob: Job? = null
    private val promptedRequestIds = mutableSetOf<String>()

    private val requestNotificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { isGranted ->
            if (isGranted) {
                Toast.makeText(this, "Notification permission granted", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(this, "Warning: Approval notifications require notification permission", Toast.LENGTH_LONG).show()
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        setSupportActionBar(binding.toolbar)

        prefs = VaultPreferences(this)
        VaultNotificationManager.createNotificationChannels(this)

        // Request POST_NOTIFICATIONS on Android 13+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestNotificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }

        setupUi()
        schedulePeriodicBackgroundIndexing()
        fetchAndRegisterFcmToken()
        performCatalogIndexing()
    }

    override fun onResume() {
        super.onResume()
        refreshAuditLog()
        startLivePolling()
    }

    override fun onPause() {
        super.onPause()
        livePollJob?.cancel()
    }

    private fun setupUi() {
        binding.contentMain.editBackendUrl.setText(prefs.backendUrl)
        binding.contentMain.textCurrentPassword.text = prefs.vaultPassword
        binding.contentMain.textLinkExpiryBadge.text = formatExpiryBadge(prefs.vaultExpirationSeconds)
        binding.contentMain.btnSelectExpiration.text = formatExpiryButton(prefs.vaultExpirationSeconds)

        val cachedUrl = prefs.shareableUrl
        if (cachedUrl != null) {
            binding.contentMain.textShareLink.text = cachedUrl
        }

        binding.contentMain.btnCopyLink.setOnClickListener {
            val link = binding.contentMain.textShareLink.text.toString()
            copyToClipboard("LazyVault Link", link)
            Toast.makeText(this, "Share link copied to clipboard!", Toast.LENGTH_SHORT).show()
        }

        binding.contentMain.btnShareLink.setOnClickListener {
            val link = binding.contentMain.textShareLink.text.toString()
            val sendIntent = Intent().apply {
                action = Intent.ACTION_SEND
                putExtra(Intent.EXTRA_SUBJECT, "LazyVault Access: ${prefs.vaultId}")
                putExtra(
                    Intent.EXTRA_TEXT,
                    "LazyVault On-Demand Storage Node\n" +
                            "Link: $link\n" +
                            "Passcode: ${prefs.vaultPassword}\n" +
                            "Valid For: ${formatExpiryButton(prefs.vaultExpirationSeconds)}"
                )
                type = "text/plain"
            }
            startActivity(Intent.createChooser(sendIntent, "Share Vault Access Link"))
        }

        binding.contentMain.btnShowQr.setOnClickListener {
            val link = binding.contentMain.textShareLink.text.toString()
            showQrDialog(link)
        }

        binding.contentMain.btnChangePassword.setOnClickListener {
            showChangePasswordDialog()
        }

        binding.contentMain.btnSelectExpiration.setOnClickListener {
            showExpirationDialog()
        }

        binding.contentMain.btnRegenerateLink.setOnClickListener {
            showRegenerateLinkDialog()
        }

        binding.contentMain.btnSyncCatalog.setOnClickListener {
            performCatalogIndexing()
        }

        binding.contentMain.btnSaveBroker.setOnClickListener {
            val newBroker = binding.contentMain.editBackendUrl.text.toString().trim()
            if (newBroker.isNotEmpty()) {
                prefs.backendUrl = newBroker
                Toast.makeText(this, "Broker updated. Re-indexing...", Toast.LENGTH_SHORT).show()
                fetchAndRegisterFcmToken()
                performCatalogIndexing()
            }
        }

        binding.contentMain.btnSimulateRequest.setOnClickListener {
            simulateFcmWakeRequest()
        }

        refreshAuditLog()
    }

    private fun performCatalogIndexing() {
        binding.contentMain.cardIndexingState.visibility = LinearLayout.VISIBLE
        binding.contentMain.textIndexingStatus.text = "Indexing files & building Merkle root..."

        scope.launch {
            val (snapshot, files) = withContext(Dispatchers.IO) {
                val vaultDir = File(filesDir, "vault")
                if (!vaultDir.exists()) {
                    vaultDir.mkdirs()
                    seedInitialVault(vaultDir)
                }

                val indexed = mutableListOf<CatalogItem>()
                val merkleDigest = MessageDigest.getInstance("SHA-256")

                vaultDir.walkTopDown().forEach { file ->
                    if (file.isFile && !file.name.startsWith(".")) {
                        val sha = calculateFileSha256(file)
                        val relPath = "/storage/vault/${file.name}"
                        indexed.add(
                            CatalogItem(
                                path = relPath,
                                size = file.length(),
                                sha256 = sha,
                                mtime = file.lastModified()
                            )
                        )
                        merkleDigest.update(sha.toByteArray(Charsets.UTF_8))
                    }
                }

                val rootMerkle = bytesToHex(merkleDigest.digest())
                val gen = System.currentTimeMillis()
                val snap = CatalogSnapshot(
                    generation = gen,
                    rootMerkle = rootMerkle,
                    updatedAt = gen,
                    deviceId = prefs.deviceId,
                    files = indexed
                )
                Pair(snap, indexed)
            }

            currentFiles = files
            renderFileList(files)

            // Resolve shareable link: query backend network info or detect local IP
            val syncOutcome = withContext(Dispatchers.IO) {
                var hostAddress = getDeviceLocalIp() ?: "localhost"
                try {
                    val netInfo = apiClient.fetchNetworkInfo(prefs.backendUrl)
                    if (netInfo != null) {
                        val lanIp = netInfo.optString("lanIp")
                        val publicIp = netInfo.optString("publicIp")
                        if (lanIp.isNotEmpty()) hostAddress = lanIp
                        else if (publicIp.isNotEmpty()) hostAddress = publicIp
                    }
                } catch (e: Exception) {
                    // Fallback to backend URL host
                }

                // If broker backend URL is customized, use its host/port
                val brokerUri = android.net.Uri.parse(prefs.backendUrl)
                val host = if (brokerUri.host != null && brokerUri.host != "10.0.2.2") {
                    if (brokerUri.port != -1 && brokerUri.port != 80 && brokerUri.port != 443) {
                        "${brokerUri.scheme}://${brokerUri.host}:${brokerUri.port}"
                    } else {
                        "${brokerUri.scheme}://${brokerUri.host}"
                    }
                } else {
                    "http://$hostAddress:4000"
                }

                val link = "$host/v/${prefs.vaultId}"
                prefs.shareableUrl = link

                // Sync vault metadata & snapshot to broker
                val syncResult = apiClient.syncVaultLink(
                    backendUrl = prefs.backendUrl,
                    vaultId = prefs.vaultId,
                    deviceId = prefs.deviceId,
                    password = prefs.vaultPassword,
                    expiresInSeconds = prefs.vaultExpirationSeconds,
                    snapshot = snapshot
                )

                Pair(link, syncResult != null)
            }

            val (shareUrl, isSynced) = syncOutcome
            binding.contentMain.cardIndexingState.visibility = LinearLayout.GONE
            binding.contentMain.textShareLink.text = shareUrl
            if (isSynced) {
                Toast.makeText(this@MainActivity, "Vault synced to broker! Ready for access.", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(this@MainActivity, "Warning: Could not reach broker at ${prefs.backendUrl}. Check Wi-Fi.", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun renderFileList(files: List<CatalogItem>) {
        val container = binding.contentMain.containerFilesList
        container.removeAllViews()

        if (files.isEmpty()) {
            val emptyText = TextView(this).apply {
                text = "No files found in vault storage directory."
                setTextColor(Color.parseColor("#94A3B8"))
                textSize = 13f
                setPadding(0, 16, 0, 16)
            }
            container.addView(emptyText)
            return
        }

        for (file in files) {
            val filename = file.path.substringAfterLast('/')
            val formattedSize = formatFileSize(file.size)
            val shortSha = if (file.sha256.length > 12) file.sha256.take(8) + "..." + file.sha256.takeLast(4) else file.sha256

            val card = MaterialCardView(this).apply {
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply {
                    bottomMargin = 16
                }
                setCardBackgroundColor(Color.parseColor("#0F172A"))
                radius = 24f
                strokeWidth = 2
                strokeColor = Color.parseColor("#1E293B")
                cardElevation = 0f
            }

            val cardContent = LinearLayout(this).apply {
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(24, 20, 24, 20)
            }

            val fileDetails = LinearLayout(this).apply {
                layoutParams = LinearLayout.LayoutParams(
                    0,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    1f
                )
                orientation = LinearLayout.VERTICAL
            }

            val nameView = TextView(this).apply {
                text = filename
                setTextColor(Color.parseColor("#F8FAFC"))
                textSize = 14f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
            }

            val metaView = TextView(this).apply {
                text = "$formattedSize  •  SHA: $shortSha"
                setTextColor(Color.parseColor("#64748B"))
                textSize = 11f
                typeface = android.graphics.Typeface.MONOSPACE
            }

            fileDetails.addView(nameView)
            fileDetails.addView(metaView)

            val menuBtn = TextView(this).apply {
                text = "⋮"
                setTextColor(Color.parseColor("#38BDF8"))
                textSize = 24f
                gravity = Gravity.CENTER
                setPadding(24, 0, 12, 0)
                setOnClickListener {
                    showFileActionsDialog(filename, file.sha256)
                }
            }

            cardContent.addView(fileDetails)
            cardContent.addView(menuBtn)
            card.addView(cardContent)

            card.setOnLongClickListener {
                showFileActionsDialog(filename, file.sha256)
                true
            }

            card.setOnClickListener {
                showFileActionsDialog(filename, file.sha256)
            }

            container.addView(card)
        }
    }

    private fun showFileActionsDialog(filename: String, sha256: String) {
        val brokerUrl = prefs.backendUrl
        val vaultId = prefs.vaultId
        val pass = prefs.vaultPassword

        val curlSnippet = """curl -s -f "$brokerUrl/api/v1/vault/$vaultId/ci-download/$sha256?token=$pass" -o "$filename""""
        val directUrl = "$brokerUrl/api/v1/vault/$vaultId/ci-download/$sha256?token=$pass"

        val options = arrayOf(
            "📋 Copy CI/CD cURL Command",
            "🔗 Copy Direct Download URL",
            "🔑 Copy SHA-256 Checksum",
            "📤 Share cURL Command..."
        )

        AlertDialog.Builder(this)
            .setTitle(filename)
            .setItems(options) { _, which ->
                when (which) {
                    0 -> {
                        copyToClipboard("cURL Command", curlSnippet)
                        Toast.makeText(this, "CI/CD cURL command copied to clipboard!", Toast.LENGTH_SHORT).show()
                    }
                    1 -> {
                        copyToClipboard("Download URL", directUrl)
                        Toast.makeText(this, "Download URL copied!", Toast.LENGTH_SHORT).show()
                    }
                    2 -> {
                        copyToClipboard("SHA-256", sha256)
                        Toast.makeText(this, "SHA-256 hash copied!", Toast.LENGTH_SHORT).show()
                    }
                    3 -> {
                        val shareIntent = Intent().apply {
                            action = Intent.ACTION_SEND
                            putExtra(Intent.EXTRA_SUBJECT, "LazyVault CI/CD Command: $filename")
                            putExtra(Intent.EXTRA_TEXT, curlSnippet)
                            type = "text/plain"
                        }
                        startActivity(Intent.createChooser(shareIntent, "Share CI/CD cURL Command"))
                    }
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showQrDialog(url: String) {
        val dialogView = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(32, 24, 32, 16)
        }

        val imageView = ImageView(this).apply {
            layoutParams = LinearLayout.LayoutParams(500, 500).apply {
                bottomMargin = 16
            }
        }

        val urlText = TextView(this).apply {
            text = url
            textSize = 12f
            setTextColor(Color.parseColor("#94A3B8"))
            typeface = android.graphics.Typeface.MONOSPACE
            gravity = Gravity.CENTER_HORIZONTAL
        }

        try {
            val qrBitmap = generateQrBitmap(url, 500, 500)
            imageView.setImageBitmap(qrBitmap)
        } catch (e: Exception) {
            imageView.visibility = ImageView.GONE
        }

        dialogView.addView(imageView)
        dialogView.addView(urlText)

        AlertDialog.Builder(this)
            .setTitle("Scan QR to Access Vault")
            .setView(dialogView)
            .setPositiveButton("Copy Link") { _, _ ->
                copyToClipboard("LazyVault Link", url)
                Toast.makeText(this, "Link copied!", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("Close", null)
            .show()
    }

    private fun generateQrBitmap(content: String, width: Int, height: Int): Bitmap {
        val bitMatrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, width, height)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.RGB_565)
        for (x in 0 until width) {
            for (y in 0 until height) {
                bitmap.setPixel(x, y, if (bitMatrix[x, y]) Color.BLACK else Color.WHITE)
            }
        }
        return bitmap
    }

    private fun showChangePasswordDialog() {
        val input = EditText(this).apply {
            setText(prefs.vaultPassword)
            hint = "Enter new vault passcode"
            typeface = android.graphics.Typeface.MONOSPACE
            setSingleLine()
            setPadding(32, 24, 32, 24)
        }

        AlertDialog.Builder(this)
            .setTitle("Change Vault Passcode")
            .setMessage("Clients must provide this passcode to view the catalog or stream files.")
            .setView(input)
            .setPositiveButton("Save") { _, _ ->
                val newPass = input.text.toString().trim()
                if (newPass.isNotEmpty()) {
                    prefs.vaultPassword = newPass
                    binding.contentMain.textCurrentPassword.text = newPass
                    scope.launch(Dispatchers.IO) {
                        apiClient.syncVaultLink(
                            backendUrl = prefs.backendUrl,
                            vaultId = prefs.vaultId,
                            deviceId = prefs.deviceId,
                            password = newPass,
                            expiresInSeconds = prefs.vaultExpirationSeconds
                        )
                    }
                    Toast.makeText(this, "Passcode updated & synced!", Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showExpirationDialog() {
        val options = arrayOf("1 Hour", "24 Hours (Default)", "7 Days", "Permanent (No Expiration)")
        val values = arrayOf(3600L, 86400L, 604800L, 0L)

        AlertDialog.Builder(this)
            .setTitle("Select Link Expiration")
            .setItems(options) { _, which ->
                val selectedSeconds = values[which]
                prefs.vaultExpirationSeconds = selectedSeconds
                binding.contentMain.textLinkExpiryBadge.text = formatExpiryBadge(selectedSeconds)
                binding.contentMain.btnSelectExpiration.text = formatExpiryButton(selectedSeconds)

                scope.launch(Dispatchers.IO) {
                    apiClient.syncVaultLink(
                        backendUrl = prefs.backendUrl,
                        vaultId = prefs.vaultId,
                        deviceId = prefs.deviceId,
                        password = prefs.vaultPassword,
                        expiresInSeconds = selectedSeconds
                    )
                }
                Toast.makeText(this, "Expiration updated to ${options[which]}", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showRegenerateLinkDialog() {
        AlertDialog.Builder(this)
            .setTitle("Revoke & Regenerate Vault Link?")
            .setMessage("The current link will be immediately invalidated and denied by the broker. A new share link will be created.")
            .setPositiveButton("Revoke & Regenerate") { _, _ ->
                val oldId = prefs.vaultId
                scope.launch {
                    withContext(Dispatchers.IO) {
                        apiClient.revokeVault(prefs.backendUrl, oldId)
                    }
                    prefs.regenerateVaultId()
                    performCatalogIndexing()
                    Toast.makeText(this@MainActivity, "Link revoked. New link generated!", Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun simulateFcmWakeRequest() {
        val sampleFile = currentFiles.firstOrNull() ?: CatalogItem(
            path = "/storage/vault/financial_report_2026.pdf",
            size = 1024,
            sha256 = "sample-sha256",
            mtime = System.currentTimeMillis()
        )

        val simRequest = TransferRequest(
            requestId = "sim_" + System.currentTimeMillis().toString().takeLast(6),
            path = sampleFile.path,
            sha256 = sampleFile.sha256,
            requesterContext = "Web Client (192.168.1.105)",
            requesterIp = "192.168.1.105",
            supportedTransports = listOf("webrtc", "relay"),
            expiresAt = System.currentTimeMillis() + 60000L
        )

        VaultNotificationManager.showTransferRequestNotification(this, simRequest)
        Toast.makeText(this, "Simulated transfer request sent! Pull down notifications.", Toast.LENGTH_LONG).show()
    }

    private fun refreshAuditLog() {
        val entries = prefs.getAuditEntries()
        if (entries.isEmpty()) {
            binding.contentMain.textAuditLog.text = "No recent transfer leases recorded."
            return
        }

        val sdf = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
        val sb = StringBuilder()
        for (e in entries.take(10)) {
            val time = sdf.format(Date(e.timestamp))
            val colorMark = if (e.status == "APPROVED") "✓" else "✗"
            sb.append("[$time] $colorMark ${e.status} - ${e.path.substringAfterLast('/')}\n")
            sb.append("      via ${e.transport.uppercase()} (${e.requester})\n\n")
        }
        binding.contentMain.textAuditLog.text = sb.toString().trimEnd()
    }

    private fun startLivePolling() {
        livePollJob?.cancel()
        livePollJob = scope.launch {
            while (isActive) {
                try {
                    val pending = apiClient.fetchPendingRequests(prefs.backendUrl, prefs.vaultId)
                    handlePendingRequests(pending)

                    val clients = apiClient.fetchConnectedClients(prefs.backendUrl, prefs.vaultId)
                    renderConnectedClients(clients)
                } catch (e: Exception) {
                    // Ignore transient network errors
                }
                delay(1500)
            }
        }
    }

    private fun handlePendingRequests(requests: List<TransferRequest>) {
        if (requests.isEmpty()) {
            binding.contentMain.cardIncomingRequest.visibility = View.GONE
            return
        }

        val request = requests.first()

        // 1. Trigger system heads-up notification prompt if not shown yet
        if (!promptedRequestIds.contains(request.requestId)) {
            promptedRequestIds.add(request.requestId)
            VaultNotificationManager.showTransferRequestNotification(this, request)
        }

        // 2. Display In-App Alert Card
        val filename = request.path.substringAfterLast('/')
        val remainingSecs = Math.max(0, ((request.expiresAt - System.currentTimeMillis()) / 1000).toInt())
        binding.contentMain.cardIncomingRequest.visibility = View.VISIBLE
        binding.contentMain.textIncomingFilename.text = filename
        binding.contentMain.textIncomingRequester.text = "From: ${request.requesterContext} (${request.requesterIp})"
        binding.contentMain.textRequestTimer.text = "${remainingSecs}s"

        binding.contentMain.btnDenyIncoming.setOnClickListener {
            denyRequest(request)
        }

        binding.contentMain.btnAllowIncoming.setOnClickListener {
            allowRequest(request)
        }
    }

    private fun denyRequest(request: TransferRequest) {
        binding.contentMain.cardIncomingRequest.visibility = View.GONE
        VaultNotificationManager.dismissNotification(this, request.requestId)

        prefs.addAuditEntry(
            AuditLogEntry(
                requestId = request.requestId,
                path = request.path,
                status = "REJECTED",
                requester = request.requesterContext,
                transport = request.supportedTransports.firstOrNull() ?: "relay",
                timestamp = System.currentTimeMillis(),
                details = "User tapped DENY on device"
            )
        )
        refreshAuditLog()

        scope.launch(Dispatchers.IO) {
            apiClient.sendDecision(
                backendUrl = prefs.backendUrl,
                requestId = request.requestId,
                decision = "DENY",
                reason = "User tapped DENY on mobile node"
            )
        }
        Toast.makeText(this, "Transfer request DENIED", Toast.LENGTH_SHORT).show()
    }

    private fun allowRequest(request: TransferRequest) {
        binding.contentMain.cardIncomingRequest.visibility = View.GONE
        VaultNotificationManager.dismissNotification(this, request.requestId)

        val selectedTransport = if (request.supportedTransports.contains("webrtc")) "webrtc" else "relay"

        prefs.addAuditEntry(
            AuditLogEntry(
                requestId = request.requestId,
                path = request.path,
                status = "APPROVED",
                requester = request.requesterContext,
                transport = selectedTransport,
                timestamp = System.currentTimeMillis(),
                details = "User tapped ALLOW in-app. Starting $selectedTransport stream"
            )
        )
        refreshAuditLog()

        scope.launch(Dispatchers.IO) {
            apiClient.sendDecision(
                backendUrl = prefs.backendUrl,
                requestId = request.requestId,
                decision = "ALLOW",
                selectedTransport = selectedTransport
            )
        }

        val serviceIntent = Intent(this, ForegroundDataTransferService::class.java).apply {
            putExtra("request_id", request.requestId)
            putExtra("path", request.path)
            putExtra("sha256", request.sha256)
            putStringArrayListExtra("supported_transports", ArrayList(request.supportedTransports))
        }
        ContextCompat.startForegroundService(this, serviceIntent)
        Toast.makeText(this, "Transfer ALLOWED! Streaming ${request.path.substringAfterLast('/')}...", Toast.LENGTH_SHORT).show()
    }

    private fun renderConnectedClients(clients: List<ConnectedClient>) {
        val count = clients.size
        binding.contentMain.textConnectedCountBadge.text = if (count == 1) "1 ONLINE" else "$count ONLINE"

        val container = binding.contentMain.containerConnectedClients
        container.removeAllViews()

        if (clients.isEmpty()) {
            val empty = TextView(this).apply {
                text = "No clients currently connected. Open your share link in a browser to see it appear here live."
                setTextColor(Color.parseColor("#64748B"))
                textSize = 12f
            }
            container.addView(empty)
            return
        }

        for (client in clients) {
            val row = LinearLayout(this).apply {
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply {
                    bottomMargin = 10
                }
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setBackgroundColor(Color.parseColor("#0F172A"))
                setPadding(20, 14, 20, 14)
            }

            val dot = TextView(this).apply {
                text = "●"
                setTextColor(Color.parseColor("#34D399"))
                textSize = 16f
                setPadding(0, 0, 16, 0)
            }

            val details = LinearLayout(this).apply {
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                orientation = LinearLayout.VERTICAL
            }

            val name = TextView(this).apply {
                text = client.deviceName
                setTextColor(Color.parseColor("#F8FAFC"))
                textSize = 13f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
            }

            val sub = TextView(this).apply {
                val agoText = if (client.activeSecondsAgo < 5) "Active now" else "${client.activeSecondsAgo}s ago"
                text = "IP: ${client.ip} • $agoText"
                setTextColor(Color.parseColor("#94A3B8"))
                textSize = 11f
                typeface = android.graphics.Typeface.MONOSPACE
            }

            details.addView(name)
            details.addView(sub)

            row.addView(dot)
            row.addView(details)
            container.addView(row)
        }
    }

    private fun fetchAndRegisterFcmToken() {
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (task.isSuccessful) {
                val token = task.result
                prefs.fcmToken = token
                scope.launch(Dispatchers.IO) {
                    apiClient.registerDevice(
                        backendUrl = prefs.backendUrl,
                        deviceId = prefs.deviceId,
                        deviceName = prefs.deviceName,
                        fcmToken = token
                    )
                }
            }
        }
    }

    private fun schedulePeriodicBackgroundIndexing() {
        val constraints = Constraints.Builder()
            .setRequiresCharging(false)
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val periodicWork = PeriodicWorkRequestBuilder<CatalogIndexWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build()

        WorkManager.getInstance(applicationContext).enqueueUniquePeriodicWork(
            "LazyVaultCatalogSync",
            ExistingPeriodicWorkPolicy.KEEP,
            periodicWork
        )
    }

    private fun copyToClipboard(label: String, text: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText(label, text)
        clipboard.setPrimaryClip(clip)
    }

    private fun formatExpiryBadge(seconds: Long): String {
        return when (seconds) {
            3600L -> "EXP: 1H"
            86400L -> "EXP: 24H"
            604800L -> "EXP: 7D"
            0L -> "EXP: NEVER"
            else -> "EXP: ${seconds / 3600}H"
        }
    }

    private fun formatExpiryButton(seconds: Long): String {
        return when (seconds) {
            3600L -> "1 Hour"
            86400L -> "24 Hours"
            604800L -> "7 Days"
            0L -> "Permanent"
            else -> "${seconds / 3600} Hours"
        }
    }

    private fun formatFileSize(bytes: Long): String {
        return when {
            bytes < 1024 -> "$bytes B"
            bytes < 1024 * 1024 -> String.format(Locale.US, "%.1f KB", bytes / 1024.0)
            bytes < 1024 * 1024 * 1024 -> String.format(Locale.US, "%.2f MB", bytes / (1024.0 * 1024.0))
            else -> String.format(Locale.US, "%.2f GB", bytes / (1024.0 * 1024.0 * 1024.0))
        }
    }

    private fun getDeviceLocalIp(): String? {
        try {
            val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val wifiIp = wifiManager?.connectionInfo?.ipAddress
            if (wifiIp != null && wifiIp != 0) {
                return Formatter.formatIpAddress(wifiIp)
            }

            val interfaces = NetworkInterface.getNetworkInterfaces()
            while (interfaces.hasMoreElements()) {
                val intf = interfaces.nextElement()
                val addrs = intf.inetAddresses
                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (!addr.isLoopbackAddress && addr.hostAddress?.indexOf(':') == -1) {
                        return addr.hostAddress
                    }
                }
            }
        } catch (e: Exception) {
            // Ignore
        }
        return null
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

    private fun bytesToHex(bytes: ByteArray): String {
        val sb = StringBuilder()
        for (b in bytes) {
            sb.append(String.format("%02x", b))
        }
        return sb.toString()
    }
}