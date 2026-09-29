# 🌐 LazyVault Web Client

The zero-trust browser portal for LazyVault. Built with React 18, TypeScript, Tailwind CSS, and Vite. Hosted 100% serverless on Firebase Hosting.

## Live Production URLs
- Primary: **[https://lazyvault.web.app](https://lazyvault.web.app)**
- Secondary: **[https://lazyvault-node.web.app](https://lazyvault-node.web.app)** (Automatic 301 redirect to primary)

## Core Capabilities

- **100% Serverless via Cloud Firestore**: Real-time subscriptions listen for device catalog syncs, client presence heartbeats, and WebRTC signaling (offers, answers, ICE candidates) without any dedicated server compute.
- **Multi-GB Memory-Optimized WebRTC Receiver**:
  - Implements 32MB native `Blob` batching to prevent V8 JavaScript heap allocation of thousands of raw `ArrayBuffer` objects, eliminating GC freezes on 3 GB+ files.
  - Web Crypto SHA-256 verification validates bit-perfect authenticity before writing the payload to disk.
- **Constraints & Existence Validation**:
  - Validates Vault ID format on the connect form.
  - Performs real-time Firestore existence pre-checks before redirecting.
  - Dedicated **Vault Not Found** screen when an ID is mistyped, revoked, or non-existent.
  - Dedicated **Vault Link Expired** screen when a lease lifetime is exceeded.
  - Password Gate only displays when a vault actually exists and requires authorization (includes a direct "Back to Connect" escape action).
- **1-Click Direct Links**:
  - **File Link**: Click "Copy Link" on any catalog item to copy `https://lazyvault.web.app/v/<vaultId>?file=<filename>`. Visiting this link automatically opens the transfer modal for that file.
  - **Vault Link**: Click the Vault badge in the header to copy the full shareable URL.

## Development & Deployment

```bash
# Install dependencies
npm install

# Start local development server
npm run dev

# Build for production
npm run build

# Deploy to Firebase Hosting
firebase deploy --only hosting
```
