# 📱 LazyVault Android Application

The native Android mobile edge node for LazyVault. Built with Kotlin, ViewBinding / Material Design 3, and hardware-accelerated WebRTC.

---

## Architecture & Core Philosophy

- **Dormant Edge Architecture**: The phone does **not** run a battery-draining HTTP server. It sleeps until signaled via Cloud Firestore real-time snapshot listeners or Firebase Cloud Messaging (FCM).
- **Zero In-App Interruptions (System Heads-Up Notifications Only)**: Authorization requests bypass intrusive in-app dialogs or cards, presenting directly as high-priority Android heads-up system notifications (`lazyvault_requests_channel`) with action buttons `[ALLOW]` and `[DENY]`.
- **Strict 60-Second Auto-Dismissal**: Notification prompts enforce a strict 60s TTL (`NotificationCompat.Builder.setTimeoutAfter` combined with local timers). When a request expires or is cancelled by the client, the notification is immediately dismissed and purged.
- **Storage Access Framework (SAF)**: Select any internal storage directory or SD card folder via `ACTION_OPEN_DOCUMENT_TREE` with persistable URI permissions and zero invasive root or broad storage permissions. Features recursion depth protection (`depth > 15`) against circular symlinks.
- **Instant 0ms App Launch (Catalog Caching)**: Directory trees and hashes are cached locally (`catalog_cache.json`). The app loads instantly without re-hashing files on launch; re-indexing runs periodically via WorkManager or on manual request.
- **In-Memory Mapping Cache**: Fast lookup caching (`cachedUriMap`, `cachedSizeMap`) in `VaultPreferences` prevents UI jank from repeated JSON deserialization during transfer lookups.

---

## Services & Background Execution

### 1. 24/7 Background Daemon (`VaultDaemonService`)
- Runs as a low-power foreground service with `FOREGROUND_SERVICE_TYPE_DATA_SYNC` and `PARTIAL_WAKE_LOCK`.
- Listens continuously to Cloud Firestore request collections (`WAITING_FOR_APPROVAL`), ensuring immediate heads-up alerts even when the device is locked, screen is off, or aggressive OEM battery managers (MIUI, ColorOS, OneUI) are active.

### 2. User-Initiated Data Transfer (Android 14+ UIDT Compliance)
- Integrates with Android 14's User-Initiated Data Transfer (`DataTransferJobService`).
- Configures `JobScheduler.setUserInitiated(true)` with required `builder.setEstimatedNetworkBytes(estimatedBytes, -1L)` to prevent `IllegalArgumentException` on API 34+.
- Provides mandatory user notifications via `setNotification()` with `JOB_END_NOTIFICATION_POLICY_REMOVE`.

### 3. Foreground Data Transfer Service (`ForegroundDataTransferService`)
- Fallback streaming service with `FOREGROUND_SERVICE_TYPE_DATA_SYNC`.
- Manages concurrent transfers via `ConcurrentHashMap<String, Job>` and an `AtomicInteger` active transfer counter.
- Reference-counted `WakeLock` (`PARTIAL_WAKE_LOCK`) and `WifiLock` (`WIFI_MODE_FULL_HIGH_PERF`) acquired on transition `0 -> 1` and released on `0`.
- Safe lifecycle termination via `stopSelf(startId)` once all active transfers complete.

### 4. Broadcast Action Receiver (`TransferActionReceiver`)
- Handles notification action intents: `com.akshay.lazyvault.ACTION_ALLOW` and `com.akshay.lazyvault.ACTION_DENY`.
- Uses `val pendingResult = goAsync()` with `pendingResult.finish()` in `finally` to ensure asynchronous network decision dispatch to the broker completes before the process can be killed by the OS.

### 5. Periodic Catalog Indexer (`CatalogIndexWorker`)
- WorkManager `CoroutineWorker` scheduled every 15 minutes (`PeriodicWorkRequestBuilder<CatalogIndexWorker>`).
- Automatically scans storage, updates root Merkle hashes, and synchronizes the catalog to both Cloud Firestore and any configured REST broker.

---

## High-Throughput WebRTC Engine (`TransferEngine.kt`)

- **Direct P2P DataChannel Streaming**: Uses hardware-accelerated WebRTC DataChannels (`io.dyte:webrtc`) with STUN hole-punching (Google & Cloudflare STUN servers).
- **Cooperative Flow Control**: 1MB low-watermark buffer backpressure threshold and 32-chunk cooperative pacing (`delay(1)` every 2MB) prevent UDP buffer saturation and ICE consent dropouts (RFC 7675) at high LAN speeds (>130 MB/s).
- **Verified Send Byte Tracking**: Ensures `bytesSent` only advances upon confirmed DataChannel acceptance, avoiding premature EOF packets on stalled connections.
- **Leak-Proof Resource Management**: Guaranteed disposal of `PeerConnectionFactory`, `PeerConnection`, `DataChannel`, and Firestore ICE candidate listeners in centralized `finally` blocks across all paths.
- **Thread-Safe Initialization**: `TransferEngine.initWebRtc(context)` singleton guard prevents duplicate JNI initializations.

---

## Ephemeral Zero-Trust Relay Fallback

- **On-the-Fly AES-256-GCM Encryption**: Generates dynamic single-use 256-bit AES keys with 12-byte IVs.
- **16-Byte Auth Tag Propagation**: Automatically extracts the 16-byte authentication tag from ciphertext (`copyOfRange(size - 16, size)`) and populates `authTagB64` across both REST broker and serverless Cloud Firestore chunk uploads.
- **Memory & Quota Circuit Breaker**: Enforces a strict 50MB ceiling (`MAX_RELAY_FILE_SIZE_BYTES`) for cloud chunk relays. If direct WebRTC P2P is blocked by carrier symmetric NAT for files >50MB, the transfer fails safely and cleanly to protect mobile heap memory and Firestore write quotas.
- **Cellular Data Allowance Warnings**: Android system heads-up notifications highlight `⚠️ Large File (X GB) — Wi-Fi Recommended` for any request $\ge 100\text{ MB}$.

---

## Required Permissions (`AndroidManifest.xml`)

| Permission | Purpose |
|---|---|
| `INTERNET` | Cloud Firestore, WebRTC signaling, STUN, and relay streams |
| `ACCESS_NETWORK_STATE` | Network state detection for WorkManager and WebRTC |
| `ACCESS_WIFI_STATE` | Safe Wi-Fi manager queries and high-performance Wi-Fi locks |
| `POST_NOTIFICATIONS` | Android 13+ heads-up transfer request notifications |
| `WAKE_LOCK` | CPU wake locks during active file transfer streaming |
| `FOREGROUND_SERVICE` | Running foreground services on Android 9+ |
| `FOREGROUND_SERVICE_DATA_SYNC` | Android 14+ foreground service data sync type |
| `RUN_USER_INITIATED_JOBS` | Android 14+ User-Initiated Data Transfer (UIDT) |

---

## Building the APK Locally

### Prerequisites
- Android Studio Ladybug / Meerkat or Android SDK (API 34+)
- JDK 17 (Temurin recommended)

```bash
# Debug APK
./gradlew assembleDebug

# Run Unit Tests
./gradlew test

# Multi-Architecture Release APKs
./gradlew assembleRelease
```

Generated APKs are located at `android/app/build/outputs/apk/`:
- `app-arm64-v8a-release.apk` (~20 MB): Modern 64-bit Android devices (Recommended)
- `app-armeabi-v7a-release.apk` (~17 MB): 32-bit legacy devices
- `app-x86_64-release.apk` (~23 MB): Emulators & ChromeOS
- `app-universal-release.apk` (~50 MB): All-in-one fallback
