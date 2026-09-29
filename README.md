# ⚡ LazyVault: On-Demand, Zero-Trust Mobile Storage Node

[![Android 14+](https://img.shields.io/badge/Android-14%2B%20(API%2034%2B)-brightgreen?logo=android)](android/)
[![Firebase Serverless](https://img.shields.io/badge/Firebase-Spark%20Plan%20(Free%20Tier)-orange?logo=firebase)](https://firebase.google.com/)
[![WebRTC P2P](https://img.shields.io/badge/WebRTC-DataChannel%20P2P-blue?logo=webrtc)](web/)
[![Security](https://img.shields.io/badge/Security-AES--256--GCM%20%7C%20SHA--256-blueviolet)](#7-security-architecture--threat-model)
[![Pre-Builds](https://img.shields.io/badge/Release-Automated%20Pre--Builds-success?logo=githubactions)](.github/workflows/pre_build.yml)

> **Zero-Trust, Hardware-Backed Asynchronous Edge Storage.**  
> Your Android phone is **NOT** an always-on, battery-draining server. It is an asynchronously leased, dormant, lazy node that only wakes up to fulfill human-authorized, end-to-end encrypted file transfers.

---

## 1. Executive Summary & Core Philosophy

Traditional remote storage solutions require running an always-on server, keeping ports forwarded, paying for cloud storage buckets, or draining an Android phone's battery with continuous background servers. 

**LazyVault flips this paradigm:**
1. **100% Serverless on Firebase (Free Tier / Spark Plan)**: Uses Cloud Firestore for real-time signaling and request state machines, and Firebase Hosting for the web client. **Zero dedicated cloud compute or VMs required.**
2. **Cloud Holds Metadata Only**: Cloud Firestore stores only directory structures, file sizes, and cryptographic SHA-256 hashes. **Zero persistent file bytes ever touch the cloud.**
3. **Dormant Edge Node**: The Android device remains asleep until a transfer request is created.
4. **Explicit Human Authorization**: Every transfer request triggers an Android heads-up notification prompt. Files are **NEVER** served without an explicit human tap on `[ALLOW]`.
5. **Direct P2P Data Streaming**: Browser clients connect directly to the phone over **WebRTC DataChannels**. Binary data streams at full local/peer speed directly into browser memory and downloads to disk without consuming intermediate server bandwidth.
6. **Integrity Guaranteed**: Every downloaded payload is streamed through Web Crypto SHA-256 verification and matched against the vault catalog before writing to disk.

---

## 2. System Architecture

```
+---------------------------------------------------------------------------------------------------------+
|                                        LAZYVAULT ARCHITECTURE                                           |
+---------------------------------------------------------------------------------------------------------+

  [Web Dashboard / CI Client]                  [Cloud Firestore]                     [Android Phone Node]
              |                                        |                                        |
              |  1. Request File (status: WAITING)     |                                        |
              |--------------------------------------->|  2. Real-time Snapshot Event           |
              |  (Sets strict 60s TTL)                 |--------------------------------------->| (Phone Wakes)
              |                                        |                                        |
              |                                        |                                 [System Notification]
              |                                        |                                 "Vault Request: <file>"
              |                                        |                                 Actions: [ALLOW] [DENY]
              |                                        |                                        |
              |                                        |  3. User Taps [ALLOW]                  | (Human Approves)
              |                                        |<---------------------------------------|
              |  4. Status update (APPROVED)           |                                        |
              |<---------------------------------------|                                        |
              |                                        |                                        |
   ===========|========================= TRANSPORT NEGOTIATION ================================|==========
   [PATH A: Direct P2P WebRTC DataChannel (Web UI)]                                             |
              |                                        |                                        |
              |  5. WebRTC Offer (SDP)                 |                                        |
              |--------------------------------------->|  5b. Forward Offer                     |
              |                                        |--------------------------------------->|
              |                                        |  6. WebRTC Answer (SDP) + ICE          |
              |  6b. Forward Answer + ICE              |<---------------------------------------|
              |<---------------------------------------|                                        |
              |                                                                                 |
              |<<<<<<<<<<<<<<<<<< 7. Direct P2P Binary Stream (64KB chunks) <<<<<<<<<<<<<<<<<<<<|
              |  (Web Crypto SHA-256 Verification -> Auto Browser Download)                     |
              |                                                                                 |
   [PATH B: Ephemeral Encrypted Relay (Headless CI/CD / Symmetric NAT)]                         |
              |                                        |  8. PUT Ciphertext (AES-256-GCM)       |
              |                                        |<---------------------------------------|
              |                                        |  9. Submit Ephemeral Key + IV          |
              |                                        |<---------------------------------------|
              | 10. GET Ciphertext + Ephemeral Key     |  (Single-Use Immediate Purge)          |
              |<---------------------------------------|                                        |
              | 11. Local Decrypt + SHA-256 Match      X (Zero persistent cloud storage)        |
              |     Exit 0 on success                  |                                        |
```

---

## 3. Key Capabilities

### 🛡️ Zero-Trust Security Controls
* **Passcode Protection**: Vaults can be locked with a custom access passcode. Passcodes are hashed with SHA-256 and verified client-side via a cryptographic password gate before granting access to file listings.
* **Vault Expiration (TTL)**: Configurable lease lifetimes (1 Hour, 24 Hours, 7 Days, or Never). Expired vaults are locked automatically.
* **1-Tap Revocation**: Tapping **"Revoke & Regenerate"** instantly rotates the Vault ID and wipes previous authorization tokens.
* **Live Audit Log**: Every transfer request, whether approved or rejected, is permanently recorded in local device storage with timestamp, requester context, transport type, and decision.

### 📱 Android 14+ (API 34+) Compliance & Background Daemon
* **24/7 Background Daemon Service (`VaultDaemonService`)**: Runs as a low-overhead foreground service (`FOREGROUND_SERVICE_TYPE_DATA_SYNC` with `PARTIAL_WAKE_LOCK`), ensuring instantaneous heads-up approval notifications even when the app is minimized, the screen is locked, or aggressive OEM battery optimizers (ColorOS, Realme UI, MIUI) are active.
* **User-Initiated Data Transfer (UIDT)**: Uses Android 14's `JobScheduler` UIDT pipeline (`jobInfo.setUserInitiated(true)`) to prevent the OS from killing active transfers when the phone's screen locks.
* **Storage Access Framework (SAF)**: Select any directory on device internal storage or SD card (`ACTION_OPEN_DOCUMENT_TREE`) without requesting invasive root or legacy broad storage permissions.
* **Instant 0ms App Launch (Catalog Caching)**: Directory trees and hashes are cached locally (`catalog_cache.json`). The app loads immediately without re-hashing hundreds of files on every activity change. Re-indexing only runs when files change or when explicitly requested.
* **Zombie Request Auto-Purge**: All transfer requests feature a strict 60-second time-to-live (TTL). If a request expires or the browser modal is closed, it is automatically marked `EXPIRED` or `CANCELLED` and silently suppressed.

### 🌐 High-Performance WebRTC Binary Pipeline & Global Discovery
* **Chunked Streaming**: Files are sliced into 64KB binary frames and streamed over an SCTP `RTCDataChannel`.
* **Cooperative Flow Control & Backpressure**: 1MB low-watermark threshold and cooperative 32-chunk pacing (`delay(1)` every 2MB) prevent UDP socket buffer saturation, ensuring WebRTC ICE consent keep-alives survive at speeds exceeding 130 MB/s.
* **Multi-STUN Global Discovery**: Streamlined to Google (`stun.l.google.com:19302`) and Cloudflare (`stun.cloudflare.com:3478`) STUN infrastructure for maximum peer-to-peer NAT traversal without candidate flooding.
* **Automated Client Integrity Verification**: Files are piped through browser `crypto.subtle.digest('SHA-256')` as they arrive, guaranteeing bit-perfect authenticity before initiating download.

### 🛡️ Large File Transfer & Safety Safeguards (1 GB+ Protection)
* **Direct WebRTC P2P for Big Files**: Direct peer-to-peer streaming operates without arbitrary file size limits (from 1 MB to 10+ GB), reading through a continuous 64KB buffer using under 4 MB of device RAM.
* **Memory & Quota Circuit Breaker**: The cloud chunk relay fallback enforces a strict 50 MB limit (`MAX_RELAY_FILE_SIZE_BYTES`). If WebRTC is blocked by cellular carrier NAT on a large file (>50 MB), the transfer fails safely and cleanly rather than attempting to buffer gigabytes into mobile RAM (preventing `OutOfMemoryError`) or exhausting daily Firestore document write quotas.
* **Cellular Data Allowance Warnings**: Android notifications and in-app approval cards highlight `⚠️ Large File (X GB) — Wi-Fi Recommended` for any request $\ge 100\text{ MB}$, ensuring device owners do not inadvertently exhaust cellular mobile data.
* **Web Portal Badges & Advisory**: Files $\ge 100\text{ MB}$ in the catalog display a `Large P2P` pill badge and prompt users in the download modal to verify the host phone is awake and on Wi-Fi for maximum throughput.

---

## 4. Repository Monorepo Structure

```
LazyVault/
├── .github/
│   └── workflows/
│       └── pre_build.yml          # GitHub Actions automated release pipeline
├── android/                       # Native Android Application (Kotlin, Gradle)
│   ├── app/
│   │   ├── build.gradle.kts       # Multi-ABI splits, release signing, dependencies
│   │   └── src/main/java/com/akshay/lazyvault/
│   │       ├── MainActivity.kt    # Main UI, QR code generator, audit log, vault setup
│   │       ├── engine/            # WebRTC and relay transfer execution engine
│   │       ├── net/               # Firebase Firestore manager and API clients
│   │       ├── service/           # UIDT JobService, FCM listener, ActionReceiver
│   │       └── storage/           # SAF file manager, catalog cache, preferences
├── web/                           # Web Dashboard (React, TypeScript, Tailwind CSS, Vite)
│   ├── src/
│   │   ├── App.tsx                # Main catalog browser, validation & status screens
│   │   ├── firebase.ts            # Cloud Firestore web initialization
│   │   ├── webrtc.ts              # WebRTC DataChannel receiver and SHA-256 validator
│   │   └── components/            # PasswordGate, TransferModal, CatalogTable
│   └── README.md                  # Web portal documentation
├── cli/                           # Headless CI/CD Client (Python 3 Firestore relay script)
│   ├── lazyvault-get.py           # Zero-trust serverless CLI client
│   └── README.md                  # CLI documentation
├── firebase.json                  # Firebase Multi-Site Hosting & Firestore configuration
├── firestore.rules                # Cloud Firestore security & access rules
├── .gitignore                     # Monorepo git hygiene rules
└── README.md                      # Comprehensive project documentation
```

---

## 5. Quick Start & Setup Guide

### Option A: Using the 100% Serverless Cloud Mode (Recommended)

No local computer or server needed! Everything runs directly between your Android phone and the web dashboard.

#### 1. Install Android App
* Download the latest signed APK from the **Pre_Builds Releases** page on GitHub:
  * For modern phones (95%+): choose `app-arm64-v8a-release.apk` (~20MB).
  * For universal compatibility: choose `app-universal-release.apk` (~50MB).
* Install the APK onto your device.

#### 2. Configure Your Vault on Mobile
1. Open **LazyVault**.
2. Tap **"Choose Folder"** to grant access to your storage directory (Photos, Documents, etc.) via the Android Storage Access Framework.
3. Set an optional **Passcode** and **Expiration Lifetime**.
4. Tap **"Sync"** to publish the metadata tree and cryptographic hashes to Cloud Firestore.
5. Tap **"Share Link"** or **"Show QR"** to share your vault.

#### 3. Access Files from Any Browser
1. Navigate to: **`https://lazyvault.web.app`**
   * Enter your Vault ID (e.g. `vlt_51f0ba6084`) or paste your shareable link.
   * Direct deep-link: **`https://lazyvault.web.app/v/<YOUR_VAULT_ID>`**
2. **Built-in Constraints & Security**:
   * The web portal validates the Vault ID format and checks Firestore in real time.
   * If an ID does not exist or has been revoked, a clear **"Vault Not Found"** screen is shown.
   * If a vault has expired, a **"Vault Link Expired"** screen is displayed.
   * If protected with a passcode, the secure **Password Gate** prompts for authorization (with a direct option to return to the connect screen).
3. **1-Click Share & Direct File Links**:
   * Click **"Copy Link"** on any file row to generate a direct share link:  
     `https://lazyvault.web.app/v/<VAULT_ID>?file=<filename>`
   * Clicking the Vault ID badge in the header copies the complete vault URL.
4. **Stream & Download**:
   * Click **"Download"** on any file.
   * An immediate heads-up notification will appear on your phone:  
     👉 **Tap `[ALLOW]`**
   * Watch the real-time P2P WebRTC progress bar fill up as the file streams directly to your browser!

---

### Option B: Local Build & Development

#### Prerequisites
* **Node.js** >= 18 (Tested on v20+)
* **Android Studio** / **Android SDK** (API 34+)
* **JDK 17** (Temurin or OpenJDK)

#### 1. Compile the Android App Locally
```bash
# Clone the repository
git clone https://github.com/Akshay-86/LazyVault.git
cd LazyVault

# Build debug APK
./gradlew assembleDebug

# Or build multi-architecture release APKs
./gradlew assembleRelease

# Output APKs will be located in:
# android/app/build/outputs/apk/release/
```

#### 2. Run the Web Dashboard Locally
```bash
cd web
npm install
npm run dev
# Dashboard running locally at http://localhost:3000
```

#### 3. Deploy Web Dashboard to Firebase Hosting
```bash
cd web
npm run build
firebase deploy --only hosting
```

---

## 6. Automated GitHub Actions CI/CD Release Pipeline

LazyVault includes an automated GitHub Actions release workflow ([`.github/workflows/pre_build.yml`](.github/workflows/pre_build.yml)) that triggers on every push to `main` or `master`.

### Automated Multi-ABI Architecture Splits
Instead of building a single bloated 50MB+ universal APK, the build pipeline splits the native WebRTC C++ binaries into streamlined architecture-specific packages:

| Artifact | Architecture | Target Devices | Size |
|---|---|---|---|
| **`app-arm64-v8a-release.apk`** | 64-bit ARM | **Recommended**: 95%+ of all modern smartphones | **~20 MB** |
| **`app-armeabi-v7a-release.apk`** | 32-bit ARM | Legacy/budget 32-bit Android devices | **~17 MB** |
| **`app-x86_64-release.apk`** | 64-bit x86 | Android emulators, ChromeOS, Intel PCs | **~23 MB** |
| **`app-universal-release.apk`** | All-in-one | Fallback containing all CPU architectures | **~50 MB** |

### GitHub Secrets Configuration (Optional)
The workflow works automatically out of the box with zero secrets by falling back to standard Android debug keystore signing. To sign with your own private production release key:

1. Base64-encode your `.jks` or `.keystore` file:
   ```bash
   base64 -w 0 release-key.jks > keystore_base64.txt
   ```
2. In your GitHub repository, navigate to **Settings > Secrets and variables > Actions** and add:
   * `KEYSTORE_BASE64`: The full base64 string from step 1.
   * `KEYSTORE_PASSWORD`: Keystore password.
   * `KEY_ALIAS`: Keystore alias name.
   * `KEY_PASSWORD`: Keystore alias password.

---

## 7. Security Architecture & Threat Model

| Threat Scenario | Mitigation Strategy |
| :--- | :--- |
| **Cloud Compromise / Firestore Breach** | Cloud Firestore holds metadata (names, sizes, hashes) only. **Zero persistent file blobs exist on the cloud.** An attacker who breaches the cloud database cannot retrieve any file content. |
| **Replay Attacks** | Every file transfer capability is single-use, identified by a cryptographically random UUID and protected by a strict **60-second TTL**. Expired tokens are rejected. |
| **Silent Data Leeching / Exfiltration** | The Android node strictly ignores transfer requests unless an explicit human `[ALLOW]` action is registered via the system heads-up notification prompt. |
| **Man-in-the-Middle (MITM)** | WebRTC P2P DataChannels enforce mandatory DTLS-SRTP end-to-end encryption. In relay mode, files are encrypted on-device with AES-256-GCM using ephemeral keys. |
| **Tampered / Corrupted Payloads** | Payloads are streamed into browser memory and checked against the original SHA-256 hash using the Web Crypto API (`crypto.subtle.digest`) before the browser saves the file. |
| **Memory Exhaustion (OOM) & Relay Abuse** | Large files are never buffered into RAM. WebRTC P2P streams continuous 64KB frames with cooperative backpressure pacing. If P2P fails, the cloud relay strictly enforces a **50 MB circuit breaker** (`MAX_RELAY_FILE_SIZE_BYTES`) to prevent mobile heap exhaustion and conserve Firestore write quotas. |
| **Cellular Data Allowance Drain** | Requests $\ge 100\text{ MB}$ trigger prominent `⚠️ Large File (X GB) — Wi-Fi Recommended` alerts in Android heads-up prompts and in-app cards before the user can tap `[ALLOW]`. |

---

## 8. Headless CI/CD Client (`cli/`)

For automated CI/CD runners (GitHub Actions, GitLab CI, Buildkite, Jenkins) to pull files dynamically from your Android phone via serverless encrypted relay:

```bash
# Direct by Vault ID
python3 cli/lazyvault-get.py \
  --vault-id "vlt_51f0ba6084" \
  --path "model_weights.bin" \
  --output ./model_weights.bin \
  --timeout 60

# Or using the shareable web URL
python3 cli/lazyvault-get.py \
  --backend-url "https://lazyvault.web.app/v/vlt_51f0ba6084" \
  --path "img.jpg" \
  --output ./downloaded_image.jpg
```

### GitHub Actions Workflow Example
```yaml
      - name: Fetch Asset from LazyVault Node
        run: |
          python3 -m pip install cryptography --quiet
          curl -fsSL https://raw.githubusercontent.com/Akshay-86/LazyVault/main/cli/lazyvault-get.py -o /tmp/lazyvault-get.py
          
          python3 /tmp/lazyvault-get.py \
            --vault-id "${{ secrets.LAZYVAULT_ID }}" \
            --path "img.jpg" \
            --output /tmp/vault_asset.raw
```

1. The script dispatches a single-use lease request directly to Cloud Firestore.
2. Your phone displays a heads-up approval notification: `[ALLOW]` / `[DENY]`.
3. You tap **[ALLOW]**.
4. The phone encrypts the file on-device with AES-256-GCM and streams chunks through the zero-trust cloud relay.
5. The CLI reassembles, decrypts, validates the SHA-256 checksum against the catalog, purges the relay chunks from Firestore, and exits `0`.

---

## 9. License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
