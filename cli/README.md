# LazyVault Headless CI/CD Client

The LazyVault CLI allows automated CI/CD runners (GitHub Actions, GitLab CI, Buildkite, Jenkins) to securely pull lazy-evaluated storage blobs from an Android phone node via encrypted zero-trust cloud relay.

## Core Security Features
- **Zero-Trust**: The cloud never sees or stores plaintext file blobs.
- **Dynamic Ephemeral Symmetric Encryption**: Each transfer uses a single-use 256-bit AES-GCM key and IV generated on-device.
- **Explicit Human Authorization**: Every transfer requires approval on the mobile device within a strict 60-second TTL.
- **Cryptographic Integrity Validation**: The CLI verifies the SHA-256 hash of the decrypted file against the catalog before exiting.

## Usage

### Direct by Vault ID
```bash
python3 cli/lazyvault-get.py \
  --vault-id "vlt_95bed4ef8c" \
  --path "img.jpg" \
  --output ./downloaded_asset.raw \
  --timeout 60
```

### Direct by Shareable Web URL
```bash
python3 cli/lazyvault-get.py \
  --backend-url "https://lazyvault.web.app/v/vlt_95bed4ef8c" \
  --path "img.jpg" \
  --output ./downloaded_asset.raw
```

### GitHub Actions Workflow Example
```yaml
name: Build and Bundle Secret Asset
on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Fetch Asset from Mobile LazyVault Node
        run: |
          python3 -m pip install cryptography --quiet
          curl -fsSL https://raw.githubusercontent.com/Akshay-86/LazyVault/main/cli/lazyvault-get.py -o /tmp/lazyvault-get.py
          
          python3 /tmp/lazyvault-get.py \
            --vault-id "${{ secrets.LAZYVAULT_ID }}" \
            --path "img.jpg" \
            --output /tmp/vault_asset.raw
```
