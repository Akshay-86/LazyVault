# LazyVault: On-Demand, Lazy-Evaluated Storage Node

> **Zero-Trust, Hardware-Backed Asynchronous Storage.**  
> The Android phone is **NOT** an always-on server. It is an asynchronously leased, dormant, lazy node.

---

## 1. Core Mental Model & Zero-Trust Guarantees

```
+-----------------------------------------------------------------------------------------+
|                                    LAZYVAULT ARCHITECTURE                               |
+-----------------------------------------------------------------------------------------+

  [Headless CI / Web Client]                 [Cloud Request Broker]           [Android Mobile Node]
              |                                        |                                |
              |  1. POST /api/v1/request-file          |                                |
              |--------------------------------------->|                                |
              |  (Sets 60s strict TTL, State=WAITING)  |  2. High-Priority FCM Push     |
              |                                        |------------------------------->| (Phone Wakes)
              |                                        |                                |
              |                                        |                         [Heads-Up Notification]
              |                                        |                         "Vault Request: <file>"
              |                                        |                         Action: [ALLOW] [DENY]
              |                                        |                                |
              |                                        |  3. Decision: [ALLOW]          | (Human Taps ALLOW)
              |                                        |<-------------------------------|
              |                                        |                                |
              |  4. Status update (APPROVED)           |                                |
              |<---------------------------------------|                                |
              |                                        |                                |
   ================================ TRANSPORT NEGOTIATION ==================================
   [PATH A: WebRTC DataChannel (Interactive Web UI)]                                    |
              |  5. SDP / ICE Signaling Exchange       |  5. SDP / ICE Exchange         |
              |<-------------------------------------->|<------------------------------>|
              |                                                                         |
              |<<<<<<<<<<<<<<<<<< 6. Direct P2P Binary Stream (64KB chunks) <<<<<<<<<<<<|
              |  (Verified via Web Crypto SHA-256 -> Auto Browser Download)             |
                                                                                        |
   [PATH B: Ephemeral Encrypted Relay (Headless CI/CD)]                                 |
              |                                        |  7. PUT ciphertext (AES-GCM)   |
              |                                        |<-------------------------------|
              |                                        |  8. POST /relay-complete       |
              |                                        |<-------------------------------|
              |  9. GET ciphertext + Ephemeral Key     |  (Single-Use Purge Triggered)  |
              |<---------------------------------------|                                |
              |                                        X (Zero Cloud Blobs Retained)    |
              | 10. Local AES-GCM Decrypt + SHA-256    |                                |
              |     Exit 0 on Integrity Match          |                                |
```

1. **Cloud Holds Metadata Only**: The cloud broker hosts directory trees, file sizes, and cryptographic SHA-256 hashes, but **NEVER** holds persistent file blobs.
2. **Dormant Edge Node**: The Android device remains in low-power deep sleep until an asynchronous trigger (High-Priority FCM Data Message) delivers a request context.
3. **Explicit Human Authorization**: Every capability token is single-use, bounded by nonce, and protected by a strict **60-second TTL**.
4. **Dynamic Transport Negotiation**:
   - **Interactive Web Clients**: WebRTC DataChannels with STUN/TURN hole punching and binary streaming.
   - **Headless CI/CD Pipelines**: Ephemeral AES-256-GCM symmetric encryption streamed to zero-trust relay and immediately purged after single download.

---

## 2. Monorepo Structure

```
lazyVault/
├── backend/          # Cloud Request Broker & WebRTC Signaling Service (Node.js/TypeScript)
├── android/          # Native Android App (Kotlin, Jetpack Compose, Min SDK 26, Target SDK 34+)
├── web/              # Web Dashboard (React, Vite, Tailwind CSS, WebRTC DataChannel Receiver)
├── cli/              # Headless CI/CD Client (Python 3 & Bash, Zero-Dependency)
├── scripts/          # End-to-end integration and simulation test runner
├── package.json      # Monorepo task orchestration
└── README.md         # Architecture documentation and deployment guide
```

---

## 3. Module Details

### 3.1 Backend (`backend/`)
Implemented with **Node.js, Express, TypeScript, and WebSockets/SSE**:
- **Endpoints**:
  - `GET /api/v1/catalog`: Returns latest synchronized file metadata tree.
  - `POST /api/v1/catalog/sync`: Authenticated endpoint for Android to push catalog snapshots (root Merkle/SHA-256, `{ path, size, sha256, mtime }`).
  - `POST /api/v1/request-file`: Accepts `{ target_sha256, path, requester_context, supported_transports }`. Generates request ID, enforces 60s TTL, and dispatches FCM message.
  - `GET /api/v1/request-file/:id`: Polling and SSE endpoint for real-time status (`APPROVED`, `NEGOTIATING`, `TRANSFERRING`, `COMPLETED`, `EXPIRED`, `REJECTED`).
  - `POST /api/v1/request-file/:id/decision`: Mobile node submits human decision (`ALLOW` or `DENY`).
  - `POST /api/v1/signaling/:id`: Relays WebRTC SDP offers/answers and ICE candidates.
  - `PUT /api/v1/relay/upload/:id`: Ephemeral ciphertext upload stream.
  - `GET /api/v1/relay/download/:id`: Single-use ephemeral download stream (auto-purged on close).
  - `POST /api/v1/relay-complete/:id`: Phone submits ephemeral AES-256 key, IV, and download URL.
  - `POST /api/v1/device/register`: Android node registers FCM token and device identity.

### 3.2 Android App (`android/`)
Native Android application in Kotlin with Jetpack Compose:
- **Background Catalog Indexer (`CatalogIndexWorker`)**:
  - `WorkManager` Periodic Worker running when charging/idle.
  - Scans designated internal storage paths (`files/vault/`).
  - Computes SHA-256 hashes, generates Merkle root, and pushes snapshot to `POST /api/v1/catalog/sync`.
- **FCM Listener & System Notification (`LazyVaultFirebaseMessagingService`)**:
  - Subclasses `FirebaseMessagingService`.
  - On `REQUEST_APPROVAL` data payload: posts an immediate high-priority heads-up notification with action buttons `[ALLOW]` and `[DENY]`.
- **User-Initiated Execution Engine (`TransferEngine`, `TransferActionReceiver`)**:
  - **Android 14+ (API 34+)**: Enqueues a `UserInitiatedDataTransfer` (UIDT) job via `JobScheduler` (`setUserInitiated(true)`).
  - **Android 13 and below**: Falls back to `ForegroundDataTransferService` with `FOREGROUND_SERVICE_TYPE_DATA_SYNC` and ongoing progress bar.
  - **WebRTC Pipeline**: Uses Google WebRTC Android SDK (`io.webrtc`). Connects to broker signaling, exchanges SDP/ICE, opens binary `DataChannel`, streams in 64KB chunks, and handles backpressure (`bufferedAmountLowThreshold`).
  - **Relay Pipeline**: Generates an ephemeral 256-bit AES-GCM symmetric key + 12-byte random IV, streams ciphertext on-the-fly, uploads to relay, and hands key to `POST /api/v1/relay-complete`.

### 3.3 Web Dashboard (`web/`)
Built with **React, Vite, Tailwind CSS, and Lucide icons**:
- **Catalog Browser**: Searchable, filterable file tree showing names, sizes, SHA-256 hashes, and Merkle root.
- **Transfer Trigger**: Modal displaying a 60-second countdown ring while waiting for mobile device authorization.
- **P2P Receiver Pipeline (`web/src/webrtc.ts`)**:
  - Connects to Google STUN servers (`stun:stun.l.google.com:19302`).
  - Exchanges SDP offers/answers and ICE candidates via backend SSE.
  - Accepts `RTCDataChannel` (`binaryType = "arraybuffer"`).
  - Reassembles 64KB binary chunks, computes SHA-256 via Web Crypto API (`crypto.subtle.digest`), verifies integrity, and triggers automatic browser download (`URL.createObjectURL(blob)`).

### 3.4 Headless CI/CD Client (`cli/`)
Zero-dependency client script for automated CI/CD runners (GitHub Actions, GitLab CI):
- **`cli/lazyvault-get.py`**:
  - Arguments: `--backend-url`, `--api-key`, `--file-hash`, `--path`, `--output`, `--timeout`, `--context`.
  - Calls `POST /api/v1/request-file` with `supported_transports: ["relay"]`.
  - Polls status with backpressure/exponential backoff.
  - Downloads ciphertext stream, decrypts via AES-256-GCM, validates SHA-256, and saves file.
  - Exits `0` on verified success, `1` on timeout or rejection.
- **`cli/lazyvault-get.sh`**:
  - Bash/curl/OpenSSL alternative for bare containers.

---

## 4. Setup & Running Instructions

### Prerequisites
- Node.js >= 18 (Tested on v26)
- Python 3 >= 3.8
- Android SDK (API 34+) and JDK 17+ (Tested on Java 26 & Gradle 9.6)

### 4.1 Running the Backend
```bash
cd backend
npm install
npm run dev
# Server running at http://localhost:4000
```

#### Optional: Firebase FCM Configuration
To enable live Firebase Cloud Messaging push notifications to physical Android devices:
1. Create a project in [Firebase Console](https://console.firebase.google.com/).
2. Generate a Service Account private key JSON.
3. Configure `backend/.env`:
   ```env
   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
   ```
*(Note: If omitted, the backend runs in Dev/Hybrid mode with an automatic SSE bridge, allowing full local simulation and development without GCP credentials).*

### 4.2 Running the Web Dashboard
```bash
cd web
npm install
npm run dev
# Dashboard running at http://localhost:3000
```

### 4.3 Building the Android App
```bash
# From the repository root:
./gradlew assembleDebug

# Output APK:
# android/app/build/outputs/apk/debug/app-debug.apk
```

### 4.4 Running Headless CI Client
```bash
./cli/lazyvault-get.py \
  --backend-url http://localhost:4000 \
  --path "/storage/vault/financial_report_2026.pdf" \
  --output ./report.pdf \
  --timeout 60
```

### 4.5 Running End-to-End System Tests
To execute the automated end-to-end simulation across backend, request state machine, ephemeral relay, AES-256-GCM crypto, and CLI:
```bash
python3 scripts/e2e_test.py
```

---

## 5. Security Architecture & Threat Model

| Threat | Mitigation |
| :--- | :--- |
| **Cloud Compromise / Data Breach** | Zero file blobs are persistently stored on the cloud. Cloud stores metadata only. Ephemeral relay blobs are encrypted with single-use device keys and purged immediately upon download. |
| **Replay Attacks** | Every request capability is bound by a unique cryptographically random 16-byte nonce, request ID, and a strict 60-second TTL. Expired or duplicate tokens are rejected. |
| **Silent Device Leeching / Exfiltration** | Mobile node ignores transfers unless explicit human cryptographic authorization (`[ALLOW]`) is confirmed via system notification. |
| **Man-in-the-Middle (MITM)** | WebRTC DataChannels use DTLS-SRTP. Ephemeral relay uses on-device generated AES-256-GCM. All payloads are verified against the catalog's SHA-256 hash before saving. |
| **Memory Exhaustion (OOM)** | Multi-gigabyte files are never loaded into RAM. Android streams in 64KB chunks with backpressure handling (`bufferedAmountLowThreshold`), and client decrypts progressively. |
