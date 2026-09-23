#!/usr/bin/env bash
# LazyVault Headless CI/CD Client Script (Bash / curl / OpenSSL)
set -eo pipefail

BACKEND_URL="${LAZYVAULT_BACKEND_URL:-http://localhost:4000}"
TIMEOUT=60
CONTEXT="CI Runner (${HOSTNAME:-github-runner})"
TARGET_HASH=""
TARGET_PATH=""
OUTPUT_FILE=""

usage() {
  echo "Usage: $0 [options]"
  echo "  --backend-url <url>   LazyVault Broker URL (default: http://localhost:4000)"
  echo "  --file-hash <sha256>  Target file SHA-256 hash"
  echo "  --path <path>         Target file path"
  echo "  --output <file>       Output file destination"
  echo "  --timeout <seconds>   Timeout in seconds (default: 60)"
  echo "  --context <context>   Requester context description"
  exit 1
}

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --backend-url) BACKEND_URL="$2"; shift ;;
    --file-hash) TARGET_HASH="$2"; shift ;;
    --path) TARGET_PATH="$2"; shift ;;
    --output) OUTPUT_FILE="$2"; shift ;;
    --timeout) TIMEOUT="$2"; shift ;;
    --context) CONTEXT="$2"; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown parameter: $1"; usage ;;
  esac
  shift
done

if [[ -z "$TARGET_HASH" && -z "$TARGET_PATH" ]]; then
  echo "Error: Either --file-hash or --path must be provided."
  usage
fi

# Resolve hash or path from catalog if needed
if [[ -z "$TARGET_HASH" || -z "$TARGET_PATH" ]]; then
  CATALOG_JSON=$(curl -sSL "${BACKEND_URL}/api/v1/catalog")
  if [[ -z "$TARGET_HASH" ]]; then
    TARGET_HASH=$(echo "$CATALOG_JSON" | jq -r ".files[] | select(.path==\"$TARGET_PATH\" or .name==\"$TARGET_PATH\") | .sha256" | head -n 1)
  fi
  if [[ -z "$TARGET_PATH" ]]; then
    TARGET_PATH=$(echo "$CATALOG_JSON" | jq -r ".files[] | select(.sha256==\"$TARGET_HASH\") | .path" | head -n 1)
  fi
fi

if [[ -z "$OUTPUT_FILE" ]]; then
  OUTPUT_FILE=$(basename "${TARGET_PATH:-downloaded_blob.bin}")
fi

echo "[INFO] Dispatching request for: $TARGET_PATH ($TARGET_HASH)"

# Submit request
REQ_RESP=$(curl -sSL -X POST "${BACKEND_URL}/api/v1/request-file" \
  -H "Content-Type: application/json" \
  -d "{
    \"target_sha256\": \"$TARGET_HASH\",
    \"path\": \"$TARGET_PATH\",
    \"requester_context\": \"$CONTEXT\",
    \"supported_transports\": [\"relay\"]
  }")

REQUEST_ID=$(echo "$REQ_RESP" | jq -r '.request_id // empty')
if [[ -z "$REQUEST_ID" ]]; then
  echo "[ERROR] Failed to initiate request: $REQ_RESP"
  exit 1
fi

echo "[INFO] Request ID: $REQUEST_ID. Awaiting human approval on phone..."

# Poll loop
START_TIME=$(date +%s)
while true; do
  NOW=$(date +%s)
  ELAPSED=$((NOW - START_TIME))
  if [[ $ELAPSED -ge $TIMEOUT ]]; then
    echo "[ERROR] Timed out waiting for phone approval."
    exit 1
  fi

  STATUS_RESP=$(curl -sSL "${BACKEND_URL}/api/v1/request-file/${REQUEST_ID}")
  STATUS=$(echo "$STATUS_RESP" | jq -r '.status')

  if [[ "$STATUS" == "REJECTED" ]]; then
    echo "[ERROR] Request was REJECTED by human operator on phone."
    exit 1
  elif [[ "$STATUS" == "EXPIRED" ]]; then
    echo "[ERROR] Request EXPIRED (60s TTL breached)."
    exit 1
  elif [[ "$STATUS" == "COMPLETED" ]]; then
    echo "[SUCCESS] Approved and uploaded! Downloading ciphertext..."
    DOWNLOAD_URL=$(echo "$STATUS_RESP" | jq -r '.relay_metadata.downloadUrl')
    KEY_B64=$(echo "$STATUS_RESP" | jq -r '.relay_metadata.encryptionKeyB64')
    IV_B64=$(echo "$STATUS_RESP" | jq -r '.relay_metadata.ivB64')
    TAG_B64=$(echo "$STATUS_RESP" | jq -r '.relay_metadata.authTagB64 // empty')

    # Convert to hex for OpenSSL
    KEY_HEX=$(echo "$KEY_B64" | base64 -d | xxd -p -c 256)
    IV_HEX=$(echo "$IV_B64" | base64 -d | xxd -p -c 256)

    # Download encrypted blob
    TEMP_ENC=$(mktemp)
    curl -sSL "$DOWNLOAD_URL" -o "$TEMP_ENC"

    # Decrypt AES-256-GCM
    if [[ -n "$TAG_B64" ]]; then
      TAG_HEX=$(echo "$TAG_B64" | base64 -d | xxd -p -c 256)
      openssl enc -d -aes-256-gcm -K "$KEY_HEX" -iv "$IV_HEX" -tag "$TAG_HEX" -in "$TEMP_ENC" -out "$OUTPUT_FILE"
    else
      # Tag appended to ciphertext
      CIPHER_LEN=$(wc -c < "$TEMP_ENC")
      DATA_LEN=$((CIPHER_LEN - 16))
      TAG_HEX=$(tail -c 16 "$TEMP_ENC" | xxd -p -c 256)
      head -c "$DATA_LEN" "$TEMP_ENC" | openssl enc -d -aes-256-gcm -K "$KEY_HEX" -iv "$IV_HEX" -tag "$TAG_HEX" -out "$OUTPUT_FILE"
    fi
    rm -f "$TEMP_ENC"

    # Verify SHA-256
    COMPUTED_HASH=$(sha256sum "$OUTPUT_FILE" | awk '{print $1}')
    if [[ "${COMPUTED_HASH,,}" != "${TARGET_HASH,,}" ]]; then
      echo "[ERROR] SHA-256 integrity verification failed!"
      rm -f "$OUTPUT_FILE"
      exit 1
    fi

    echo "[SUCCESS] Verified & saved to $OUTPUT_FILE (SHA-256: $COMPUTED_HASH)"
    exit 0
  fi

  sleep 2
done
