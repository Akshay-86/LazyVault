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

### 📱 Android 14+ (API 34+) Compliance
* **User-Initiated Data Transfer (UIDT)**: Uses Android 14's `JobScheduler` UIDT pipeline (`jobInfo.setUserInitiated(true)`) to prevent the OS from killing transfers when the phone's screen locks.
* **Storage Access Framework (SAF)**: Select any directory on device internal storage or SD card (`ACTION_OPEN_DOCUMENT_TREE`) without requesting invasive root or legacy broad storage permissions.
* **Instant 0ms App Launch (Catalog Caching)**: Directory trees and hashes are cached locally (`catalog_cache.json`). The app loads immediately without re-hashing hundreds of files on every activity change. Re-indexing only runs when files change or when explicitly requested.
* **Zombie Request Auto-Purge**: All transfer requests feature a strict 60-second time-to-live (TTL). If a request expires or the browser modal is closed, it is automatically marked `EXPIRED` or `CANCELLED` and silently suppressed.

### 🌐 High-Performance WebRTC Binary Pipeline
* **Chunked Streaming**: Files are sliced into 64KB binary frames and streamed over an SCTP `RTCDataChannel`.
* **Flow Control & Backpressure**: Leverages `bufferedAmountLowThreshold` events to prevent memory bloating and buffer overflow when transmitting gigabyte-sized files.
* **Automated Client Integrity Verification**: Files are piped through browser `crypto.subtle.digest('SHA-256')` as they arrive, guaranteeing bit-perfect authenticity before initiating download.

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
│   │   ├── App.tsx                # Main catalog browser and status indicators
│   │   ├── firebase.ts            # Cloud Firestore web initialization
│   │   ├── webrtc.ts              # WebRTC DataChannel receiver and SHA-256 validator
│   │   └── components/            # PasswordGate, TransferModal, Audit modals
│   ├── firebase.json              # Firebase Hosting configuration
│   └── firestore.rules            # Firestore security rules
├── backend/                       # Optional: Local/Relay Node.js Broker (Express, WebSockets)
├── cli/                           # Headless CI/CD Client (Python 3 zero-dependency script)
├── .gitignore                     # Monorepo git hygiene rules
└── README.md                      # Comprehensive documentation
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
2. Tap **"Select Folder"** to grant access to your storage directory (Photos, Documents, etc.) via the Android Storage Access Framework.
3. Set an optional **Passcode** and **Expiration Lifetime**.
4. Tap **"Sync Catalog"** to publish the metadata tree and cryptographic hashes to Cloud Firestore.
5. Tap **"Share Vault"** or scan the on-screen QR code.

#### 3. Access Files from Any Browser
1. Navigate to: **`https://lazyvault-node.web.app/v/<YOUR_VAULT_ID>`**
2. Enter your passcode if prompted.
3. Browse your phone's catalog and click **"Download"** on any file.
4. An immediate heads-up notification will appear on your phone:  
   👉 **Tap `[ALLOW]`**
5. Watch the real-time P2P WebRTC progress bar fill up as the file streams directly to your browser!

---

### Option B: Local Build & Development

#### Prerequisites
* **Node.js** >= 18 (Tested on v20+)
* **Android Studio** / **Android SDK** (API 34+)
* **JDK 17** (Temurin or OpenJDK)

#### 1. Compile the Android App Locally
```bash
# Clone the repository
git clone https://github.com/akshay/LazyVault.git
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
npx --package=firebase-tools firebase deploy --only hosting
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
| **Memory Exhaustion (OOM)** | Large files are never read fully into RAM. Android streams through memory-mapped I/O in 64KB chunks with flow control (`bufferedAmountLowThreshold`), and client reassembles progressively. |

---

## 8. Headless CI/CD Client (`cli/`)

For headless automation pipelines (e.g., pulling a secure build artifact or database backup from your phone in a GitHub Actions runner):

```bash
# Request a file via CLI (Python 3, zero third-party dependencies):
python3 cli/lazyvault-get.py \
  --backend-url https://lazyvault-node.web.app \
  --path "/storage/vault/database_backup.sqlite.enc" \
  --output ./database_backup.sqlite.enc \
  --timeout 60
```
1. The script requests the file and waits with exponential backoff.
2. Your phone pops an approval notification.
3. You tap **[ALLOW]**.
4. The CLI downloads the stream, verifies SHA-256 integrity, and exits `0`.

---

## 9. License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
