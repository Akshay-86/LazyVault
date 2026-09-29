# 📱 LazyVault Android Application

The native Android mobile edge node for LazyVault. Built with Kotlin, Jetpack Compose, and hardware-accelerated WebRTC.

## Core Features

- **Dormant Edge Architecture**: The phone does not run a battery-draining HTTP server. It sleeps until signaled via Cloud Firestore.
- **Storage Access Framework (SAF)**: Select any internal storage directory or SD card folder via `ACTION_OPEN_DOCUMENT_TREE` with zero root or invasive storage permissions.
- **24/7 Background Daemon (`VaultDaemonService`)**: Low-power foreground service with `PARTIAL_WAKE_LOCK` ensuring immediate heads-up notifications even with screen off or under aggressive OEM battery optimizers (ColorOS, MIUI, OneUI).
- **Android 14+ UIDT Compliance**: Integrates with Android 14's User-Initiated Data Transfer (`JobScheduler.setUserInitiated(true)`) to protect long-running multi-gigabyte transfers from OS kills.
- **High-Throughput WebRTC Engine**:
  - Direct P2P SCTP `RTCDataChannel` streaming with cooperative flow control (1MB low-watermark threshold and 32-chunk cooperative pacing) preventing UDP socket buffer saturation and ICE consent drops at speeds exceeding 130 MB/s.
  - Optimized multi-STUN global discovery (Google & Cloudflare).
- **Ephemeral Zero-Trust Cloud Relay**:
  - Automatically encrypts files with dynamic AES-256-GCM symmetric keys if WebRTC is blocked by carrier symmetric NAT.
  - Enforces a 50MB safety circuit breaker (`MAX_RELAY_FILE_SIZE_BYTES`) to protect mobile heap memory and cloud quotas.
- **Cellular Data Allowance Warnings**: Alerts users with `⚠️ Large File (X GB) — Wi-Fi Recommended` before approving files $\ge 100\text{ MB}$.

## Building the APK Locally

### Prerequisites
- Android Studio Ladybug / Meerkat or Android SDK (API 34+)
- JDK 17 (Temurin recommended)

```bash
# Debug APK
./gradlew assembleDebug

# Multi-Architecture Release APKs
./gradlew assembleRelease
```

Generated APKs are located at:
`android/app/build/outputs/apk/release/`
- `app-arm64-v8a-release.apk` (~20 MB): Modern Android devices (Recommended)
- `app-armeabi-v7a-release.apk` (~17 MB): 32-bit legacy devices
- `app-x86_64-release.apk` (~23 MB): Emulators & ChromeOS
- `app-universal-release.apk` (~50 MB): All-in-one fallback
