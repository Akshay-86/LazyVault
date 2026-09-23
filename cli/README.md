# LazyVault Headless CI/CD Client

The LazyVault CLI allows automated CI/CD runners (GitHub Actions, GitLab CI, Buildkite, Jenkins) to securely pull lazy-evaluated storage blobs from a dormant Android node via ephemeral encrypted relay.

## Core Security Features
- **Zero-Trust**: The cloud never sees or stores plaintext file blobs.
- **Dynamic Ephemeral Symmetric Encryption**: Each transfer uses a single-use 256-bit AES-GCM key and IV generated on-device.
- **Explicit Human Authorization**: Every transfer requires approval on the mobile device within a strict 60-second TTL.
- **Cryptographic Integrity Validation**: The CLI verifies the SHA-256 hash of the decrypted file against the catalog before exiting.

## Usage

### Python 3 Client (`lazyvault-get.py`)
```bash
./lazyvault-get.py \
  --backend-url http://localhost:4000 \
  --path "/storage/emulated/0/LazyVault/model_weights.bin" \
  --output ./model_weights.bin \
  --timeout 60
```

Or query directly by SHA-256:
```bash
./lazyvault-get.py \
  --backend-url http://localhost:4000 \
  --file-hash "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae" \
  --output ./dataset.tar.gz
```

### GitHub Actions Workflow Example
```yaml
name: Pull Lazy Artifact
on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Fetch Artifact from LazyVault Node
        run: |
          python3 cli/lazyvault-get.py \
            --backend-url "${{ secrets.LAZYVAULT_BACKEND_URL }}" \
            --path "dataset.tar.gz" \
            --context "GitHub Actions #${{ github.run_id }} by ${{ github.actor }}" \
            --output ./data/dataset.tar.gz
```
