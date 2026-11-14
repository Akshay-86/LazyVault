# ⚡ LazyVault Headless CI/CD Client (`lazyvault-get.py`)

The **LazyVault CLI** allows automated CI/CD runners (GitHub Actions, GitLab CI, Buildkite, Jenkins, Bitbucket Pipelines) and developer workstations to securely pull lazy-evaluated storage blobs on demand from a dormant Android mobile node.

It supports dual transport engines:
1. **Cloud Firestore Serverless Relay (Primary / Default)**: Operates 100% serverless over Google Cloud Firestore without running dedicated backend infrastructure.
2. **REST Broker & Ephemeral Relay (Self-Hosted / Hybrid Mode)**: Connects to a self-hosted Node.js/Express LazyVault request broker (`backend/`).

---

## 🛡️ Core Security Architecture

* **Zero-Trust**: The cloud relay never sees, buffers, or stores plaintext file blobs.
* **On-the-Fly Symmetric Encryption**: Every transfer dynamically generates a single-use 256-bit AES-GCM key and 12-byte IV on the Android device.
* **Explicit Human Authorization**: Every transfer requires physical human authorization via a system heads-up notification prompt on the phone with a strict **60-second TTL**.
* **Zero Persistent Cloud Storage**: Once the encrypted ciphertext chunks/blobs are downloaded, they are immediately purged from the relay. Replay attempts return HTTP `404`.
* **Bit-for-Bit Cryptographic Integrity**: Decrypted file content is verified against the original SHA-256 hash before saving to disk. If the checksum does not match, the file is rejected and the client exits with a failure code.

---

## 📦 Requirements & Installation

* **Python**: Python 3.8 or higher.
* **Cryptography Support**:
  * **Option A (Recommended)**: `pip install cryptography`
  * **Option B (Zero-Dependency Fallback)**: Built-in `openssl` CLI tool (pre-installed on Ubuntu, macOS, Debian, and GitHub Actions runners).
  * **Option C**: `pip install pycryptodomex`

```bash
# Quick install dependencies
pip install cryptography --quiet
```

---

## 🚀 CLI Arguments & Options

| Flag | Env Var | Description | Default |
| :--- | :--- | :--- | :--- |
| `--vault-id` | `LAZYVAULT_ID` | Secret Vault ID (e.g., `vlt_95bed4ef8c`). | `""` |
| `--backend-url` | `LAZYVAULT_BACKEND_URL` | Web portal deep-link or broker URL (e.g. `https://lazyvault.web.app/v/vlt_95bed4ef8c` or `http://localhost:4000`). | `https://lazyvault.web.app` |
| `--path` | — | Target file name or path in LazyVault (e.g. `model_weights.bin` or `/storage/vault/model.bin`). | Required (or `--file-hash`) |
| `--file-hash` | — | Target file SHA-256 hash. Matches against the catalog if path is omitted. | Optional |
| `--output`, `-o` | — | Destination path for the decrypted plaintext file. | Resolved filename |
| `--password` | `LAZYVAULT_PASSWORD` | Passcode for password-protected vaults. | `""` |
| `--timeout` | — | Human authorization timeout window in seconds. | `60` |
| `--context` | `GITHUB_RUN_ID` | Context description displayed in the mobile heads-up prompt. | `"GitHub Actions CI Runner"` |
| `--project-id` | `LAZYVAULT_PROJECT_ID` | Google Firebase Project ID. | `"lazyvault-node"` |
| `--api-key` | `LAZYVAULT_API_KEY` | Firebase Web API Key for Firestore REST access. | Default Spark key |

---

## 💻 Usage Examples

### 1. Direct Retrieval by Vault ID (Standard Serverless Mode)
```bash
python3 cli/lazyvault-get.py \
  --vault-id "vlt_95bed4ef8c" \
  --path "production_model.onnx" \
  --output ./production_model.onnx \
  --timeout 60
```

### 2. Retrieval with Shareable Web Link
```bash
python3 cli/lazyvault-get.py \
  --backend-url "https://lazyvault.web.app/v/vlt_95bed4ef8c" \
  --path "release_keystore.jks" \
  --output ./release_keystore.jks
```

### 3. Password-Protected Vault
```bash
python3 cli/lazyvault-get.py \
  --vault-id "vlt_95bed4ef8c" \
  --path "database_credentials.env" \
  --password "MySecretPasscode123" \
  --output .env
```

### 4. Target by Cryptographic SHA-256 Hash
```bash
python3 cli/lazyvault-get.py \
  --vault-id "vlt_95bed4ef8c" \
  --file-hash "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" \
  --output ./verified_artifact.bin
```

### 5. Local / Self-Hosted REST Broker Mode
```bash
python3 cli/lazyvault-get.py \
  --backend-url "http://localhost:4000" \
  --path "dataset.tar.gz" \
  --output ./dataset.tar.gz
```

---

## 🤖 CI/CD Pipeline Integration

### GitHub Actions Workflow Example

```yaml
name: Production Release Build
on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"

      - name: Install Decryption Primitives
        run: pip install cryptography --quiet

      - name: Retrieve Signing Keystore from Mobile LazyVault Node
        env:
          LAZYVAULT_ID: ${{ secrets.LAZYVAULT_ID }}
          LAZYVAULT_PASSWORD: ${{ secrets.LAZYVAULT_PASSWORD }}
          GITHUB_RUN_ID: "GitHub Actions: Release Build #${{ github.run_number }}"
        run: |
          python3 cli/lazyvault-get.py \
            --path "release.keystore" \
            --output "/tmp/release.keystore" \
            --timeout 90

      - name: Execute Build with Verified Secret
        run: |
          echo "Building production package with verified signing key..."
          # ./gradlew assembleRelease or docker build
```

### GitLab CI / CD Example

```yaml
fetch_secret_model:
  stage: build
  image: python:3.11-slim
  script:
    - pip install cryptography --quiet
    - python3 cli/lazyvault-get.py --vault-id "$LAZYVAULT_ID" --password "$LAZYVAULT_PASSWORD" --path "model_weights.bin" -o ./model_weights.bin
  artifacts:
    paths:
      - model_weights.bin
    expire_in: 1 hour
```

---

## 🔧 Exit Codes & Error Handling

* **`0`**: Transfer successful, authenticated, decrypted, and verified against SHA-256 hash.
* **`1`**: 
  * Transfer rejected by human operator on phone (`[DENY]`).
  * Transfer request expired before approval (breached 60s TTL).
  * Incorrect vault passcode supplied.
  * SHA-256 cryptographic checksum mismatch.
  * Network or transport error after maximum retries.
