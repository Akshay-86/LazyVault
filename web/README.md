# 🌐 LazyVault Web Client

The zero-trust browser portal for LazyVault. Built with React 18, TypeScript, Tailwind CSS, and Vite. Hosted 100% serverless on Firebase Hosting.

## Live Production URLs
- Primary: **[https://lazyvault.web.app](https://lazyvault.web.app)**
- Secondary: **[https://lazyvault-node.web.app](https://lazyvault-node.web.app)** (Automatic 301 redirect to primary)

---

## Architecture & Core Capabilities

- **100% Serverless via Cloud Firestore**: Real-time snapshot listeners subscribe to vault metadata, device catalogs, client presence heartbeats, and WebRTC signaling (SDP offers, answers, caller/callee ICE candidates) without any dedicated server compute or intermediate VM bottlenecks.
- **Streaming Cryptographic SHA-256 Engine (`src/utils/crypto.ts`)**:
  - Implements an RFC 6234 compliant `StreamingSha256` progressive hasher alongside Web Crypto API acceleration.
  - Incoming binary chunks stream directly into the hasher on-the-fly, enabling zero-trust end-to-end verification across multi-GB files without loading entire files into contiguous JavaScript heap memory.
  - Pure TypeScript fallback operates seamlessly in non-secure HTTP LAN contexts (`http://192.168.x.x`) where `window.crypto.subtle` is blocked by modern browsers.
- **Multi-GB Memory-Optimized WebRTC Receiver (`src/webrtc.ts`)**:
  - Batches received 64KB DataChannel chunks into 32MB native browser `Blob` objects, preventing V8 GC freezing on large files.
  - Cooperative pacing yields every 32 chunks (~2MB) to allow SCTP acks and ICE consent checks (RFC 7675) to pass unimpeded.
  - Automatic download trigger with safe object URL revocation and completion race condition guards (`isCompleted` state and debounced completion timeouts).
  - WebRTC connection state monitoring inspects active candidate pairs to classify connection quality (e.g. "Ultra-Fast Direct LAN", "Router NAT Hairpin", or "Direct P2P").
  - Clean resource lifecycle management: properly tears down and unbinds event listeners on DataChannel, PeerConnection, and EventSource subscriptions.
- **Zero-Trust Ephemeral Relay Fallback (`src/components/TransferModal.tsx`)**:
  - If direct P2P hole punching is blocked by symmetric carrier NATs, the client gracefully falls back to encrypted cloud relay.
  - For serverless mode, 512KB encrypted chunks are pulled from Firestore, decrypted client-side with single-use ephemeral AES-256-GCM symmetric keys, verified bit-for-bit against target SHA-256, and immediately purged from cloud storage.

---

## User Interface Screens & Navigation Flows

### 1. Connection Screen (`/`)
- **Vault ID Input**: Accepts standard Vault IDs (`vlt_<alphanumeric>` or 6-32 character IDs) or full share links (e.g., `https://lazyvault.web.app/v/vlt_51f0ba6084`).
- **Real-Time Pre-Check**: Checks vault existence in Cloud Firestore before redirecting to avoid broken states.
- **Browser History Integration**: Supports deep linking (`/v/<vaultId>`) and back/forward browser navigation via `popstate` listeners.

### 2. Password Gate (`PasswordGate.tsx`)
- Displayed when the vault document indicates `requiresPassword: true`.
- Verifies the entered passcode by computing its SHA-256 hash client-side and validating against `passwordHash`.
- Supports both Web Crypto Subtle API and pure-TypeScript fallback for non-secure HTTP LAN environments.
- **Session Persistence**: Once verified, authorization is cached in `sessionStorage` (`vault_auth_<id>`), preventing incoming real-time document updates from re-locking the screen.
- Includes a direct **"Back to Connect"** escape action and passcode visibility toggle.

### 3. Dedicated Error & Lifecycle Screens
- **Vault Not Found (`vaultNotFound`)**: Rendered when a Vault ID does not exist, was mistyped, or was permanently revoked by the owner.
- **Vault Link Expired (`isExpired`)**: Rendered when a vault's `expiresAt` timestamp has passed. Actively checked via real-time listeners and client-side interval timers.
- **React Error Boundary (`ErrorBoundary.tsx`)**: Top-level safety boundary that catches unhandled rendering errors and presents actionable recovery controls ("Reload Application" and "Home").

### 4. Vault Header (`Header.tsx`)
- **Brand & Protocol Badge**: LazyVault Peer-to-Peer indicator.
- **Vault Share Link**: One-click badge that copies `https://lazyvault.web.app/v/<vaultId>` to clipboard (with cross-browser non-secure context fallback).
- **Device Status Beacon**: Real-time pulsing indicator displaying connected host node identifier.
- **Catalog Summary**: Live file count and formatted total aggregate size.
- **Authoritative Expiration Countdown**: Dynamic 10-second ticker showing remaining validity (e.g., `23h 45m left` or `12m 30s left`).
- **Passcode Protection Badge & Lock Action**: Indicator when protected, plus a 1-click **Lock Vault** action to clear session auth and re-engage the password gate.
- **Refresh Action**: Triggers a manual sync by re-querying Cloud Firestore for latest directory additions.

### 5. Catalog Table & Search (`CatalogTable.tsx`)
- **Real-Time Search**: Live sub-millisecond filtering by file name, directory path, or SHA-256 hash.
- **MIME & Extension Icon Classification**: Distinct visual badges for archives, media (images, videos, audio), code, documents, and generic binaries.
- **Large File Badge**: Highlights files $\ge 100\text{ MB}$ with a `Large P2P` badge (WebRTC direct streaming recommended).
- **Truncated Hash & One-Click Copy**: Displays `sha256.slice(0, 8)...sha256.slice(-6)` with copy button and visual confirmation.
- **1-Click Shareable File Link**: Copies `https://lazyvault.web.app/v/<vaultId>?file=<filename>` to clipboard.
- **Download Action**: Initiates the on-demand transfer capability modal.

### 6. Manual Request by Path (`ManualRequestForm.tsx`)
- Collapsible modal to request non-indexed, hidden, or specific storage paths directly (e.g., `/storage/emulated/0/...`).
- Validates 64-hexadecimal SHA-256 checksum format before dispatching.

### 7. Transfer Capability Modal (`TransferModal.tsx`)
- **State 1: `WAITING_FOR_APPROVAL`**:
  - Prompts host mobile phone with a system heads-up notification.
  - Authoritative 60-second countdown synchronized with Firestore `expiresAt`.
  - Smooth SVG animated circular progress countdown ring.
  - Automatic cancellation if the 60-second TTL expires before mobile approval.
  - Explicit user dismissal cancels the pending lease in Cloud Firestore.
- **State 2: `TRANSFERRING` / `APPROVED`**:
  - Live progress bar showing percentage, throughput in MB/s, and transferred bytes vs total bytes.
  - Dynamic status messages detailing connection phase (P2P hole punching, chunk streaming, or relay decryption).
- **State 3: `COMPLETED`**:
  - Displays verification checkmark and exact bit-for-bit verified SHA-256 hash.
  - Automatically triggers browser download with safe object URL cleanup.
- **State 4: `REJECTED` / `EXPIRED` / `CANCELLED` / `FAILED`**:
  - Clear, user-friendly error banners explaining the terminal status.
- **Dismissal & Accessibility**: Supports keyboard `Escape` key and backdrop-click to dismiss.

---

## Client Presence & Real-Time Heartbeats

- Browsers automatically register presence in `/vaults/{vaultId}/clients/{clientId}` on mount.
- Transmits browser name, OS, and timestamp.
- Emits continuous 15-second heartbeat updates (`lastSeen`).
- Unregisters cleanly on tab close or navigation using both `beforeunload` and `pagehide` event handlers.

---

## Local Development & Production Build

```bash
# 1. Install dependencies
npm install

# 2. Run local development server (Vite on port 3000)
npm run dev

# 3. Build for production (TypeScript validation + Vite bundle)
npm run build

# 4. Preview production build
npm run preview

# 5. Deploy to Firebase Hosting (Production)
firebase deploy --only hosting
```
