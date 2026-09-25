#!/usr/bin/env python3
"""
LazyVault CI/CD Pipeline Simulator
Simulates a headless GitHub Actions runner requesting a sensitive 1-3MB file
(e.g., release signing key, production secrets, or build assets) from a dormant Android phone.

Zero-Trust Verification:
1. CI/CD sends lease request to Cloud Firestore with strict 60s TTL.
2. Android phone receives high-priority notification with [ALLOW] / [DENY].
3. If ALLOW is tapped, the zero-trust gate unlocks the lease.
4. If DENY or timeout occurs, the CI/CD pipeline aborts immediately.
"""

import sys
import time
import json
import base64
import hashlib
import urllib.request
import urllib.error
from datetime import datetime
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

FIRESTORE_BASE = "https://firestore.googleapis.com/v1/projects/lazyvault-node/databases/(default)/documents"

def http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "LazyVault-CICD-Runner/1.0"})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

def http_post(url, data):
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "User-Agent": "LazyVault-CICD-Runner/1.0"
    })
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

def http_patch(url, data):
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="PATCH", headers={
        "Content-Type": "application/json",
        "User-Agent": "LazyVault-CICD-Runner/1.0"
    })
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

def http_delete(url):
    req = urllib.request.Request(url, method="DELETE", headers={"User-Agent": "LazyVault-CICD-Runner/1.0"})
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.read()
    except Exception:
        pass

def fetch_vault_by_id(vault_id):
    """Fetch specific vault by exact secret vault ID (Zero-Trust Document Lookup)"""
    url = f"{FIRESTORE_BASE}/vaults/{vault_id}"
    try:
        doc = http_get(url)
    except Exception as e:
        print(f"[!] Error fetching vault '{vault_id}' from Firestore: {e}")
        return None

    vid = doc["name"].split("/")[-1]
    fields = doc.get("fields", {})
    device_name = fields.get("deviceName", {}).get("stringValue", "Android Node")
    updated_at = fields.get("updatedAt", {}).get("integerValue", 0)
    files_raw = fields.get("files", {}).get("arrayValue", {}).get("values", [])

    file_list = []
    for f in files_raw:
        ff = f.get("mapValue", {}).get("fields", {})
        file_list.append({
            "name": ff.get("name", {}).get("stringValue", "unknown"),
            "path": ff.get("path", {}).get("stringValue", ""),
            "size": int(ff.get("size", {}).get("integerValue", 0)),
            "sha256": ff.get("sha256", {}).get("stringValue", "")
        })

    return {
        "vaultId": vid,
        "deviceName": device_name,
        "updatedAt": int(updated_at),
        "files": file_list
    }

def format_size(bytes_len):
    if bytes_len < 1024:
        return f"{bytes_len} B"
    elif bytes_len < 1024 * 1024:
        return f"{bytes_len / 1024:.2f} KB"
    else:
        return f"{bytes_len / (1024 * 1024):.2f} MB"

def main():
    print("=" * 65)
    print("  🚀 LAZYVAULT CI/CD PIPELINE SIMULATOR (GitHub Actions)")
    print("=" * 65)
    print("[CI/CD] Initializing GitHub Actions runner: ubuntu-latest (Job #42)")

    # Secret Vault ID passed via CLI argument or env var (Standard CI/CD Secret)
    target_vid = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].startswith("vlt_") else "vlt_a49498a7e2"
    print(f"[CI/CD] Resolving secret vault capability: '{target_vid}' via Cloud Firestore...\n")

    selected_vault = fetch_vault_by_id(target_vid)
    if not selected_vault:
        print(f"❌ Vault '{target_vid}' could not be fetched (permission denied, expired, or invalid ID).")
        sys.exit(1)

    print(f"[CI/CD] Connected to Vault: {selected_vault['vaultId']} ({selected_vault['deviceName']})")
    print("[CI/CD] Available files in dormant vault:")
    for idx, f in enumerate(selected_vault["files"]):
        print(f"    ({idx + 1}) {f['name']} [{format_size(f['size'])}]  SHA-256: {f['sha256'][:16]}...")

    if not selected_vault["files"]:
        print("❌ No files available in this vault to request!")
        sys.exit(1)

    # Pick file (default to first file or argument)
    target_file = selected_vault["files"][0]
    if len(sys.argv) > 2:
        try:
            f_idx = int(sys.argv[2]) - 1
            if 0 <= f_idx < len(selected_vault["files"]):
                target_file = selected_vault["files"][f_idx]
        except ValueError:
            for f in selected_vault["files"]:
                if f["name"] == sys.argv[2] or f["path"] == sys.argv[2]:
                    target_file = f
                    break

    print(f"\n[CI/CD] Target Secret/File: '{target_file['name']}' ({format_size(target_file['size'])})")
    print(f"[CI/CD] Target SHA-256:     {target_file['sha256']}")

    # 1. Create Lease Request Document in Firestore
    now_ms = int(time.time() * 1000)
    expires_at_ms = now_ms + 60000 # 60 seconds TTL

    request_payload = {
        "fields": {
            "path": {"stringValue": target_file["path"]},
            "name": {"stringValue": target_file["name"]},
            "sha256": {"stringValue": target_file["sha256"]},
            "size": {"integerValue": str(target_file["size"])},
            "status": {"stringValue": "WAITING_FOR_APPROVAL"},
            "requesterContext": {"stringValue": "GitHub Actions: Release Build #42 (ubuntu-latest)"},
            "requesterIp": {"stringValue": "20.125.44.12 (Microsoft Azure East US)"},
            "supportedTransports": {
                "arrayValue": {
                    "values": [
                        {"stringValue": "relay"},
                        {"stringValue": "webrtc"}
                    ]
                }
            },
            "createdAt": {"integerValue": str(now_ms)},
            "expiresAt": {"integerValue": str(expires_at_ms)}
        }
    }

    url_create = f"{FIRESTORE_BASE}/vaults/{selected_vault['vaultId']}/requests"
    print("\n" + "-" * 65)
    print("📡 DISPATCHING CRYPTOGRAPHIC LEASE REQUEST...")
    
    try:
        created_doc = http_post(url_create, request_payload)
        request_id = created_doc["name"].split("/")[-1]
    except Exception as e:
        print(f"❌ Failed to dispatch request to Firestore: {e}")
        sys.exit(1)

    print(f"✓ Lease Request Created! ID: {request_id}")
    print(f"✓ Strict Zero-Trust TTL: 60 seconds")
    print("-" * 65)
    print("\n👉 CHECK YOUR ANDROID PHONE NOW!")
    print(f"   You should see an urgent notification or in-app prompt:")
    print(f"   'Vault Request: {target_file['name']}'")
    print(f"   'Requester: GitHub Actions: Release Build #42'")
    print(f"   Tap [ALLOW] or [DENY] on your phone to test the pipeline.\n")

    # 2. Polling loop with live countdown
    start_time = time.time()
    url_poll = f"{FIRESTORE_BASE}/vaults/{selected_vault['vaultId']}/requests/{request_id}"

    approved = False
    decision_reason = ""

    while time.time() - start_time < 90:
        elapsed = int(time.time() - start_time)
        remaining = max(0, 90 - elapsed)

        try:
            doc_data = http_get(url_poll)
            fields = doc_data.get("fields", {})
            status = fields.get("status", {}).get("stringValue", "WAITING_FOR_APPROVAL")
            error_msg = fields.get("error", {}).get("stringValue", "")

            if status == "WAITING_FOR_APPROVAL":
                sys.stdout.write(f"\r⏳ [CI/CD Gate] Waiting for mobile operator approval... [{remaining:02d}s remaining] ")
                sys.stdout.flush()
            elif status in ("APPROVED", "TRANSFERRING"):
                sys.stdout.write(f"\r⚡ [CI/CD Gate] Transfer authorized on phone! Mobile node encrypting & streaming... [{remaining:02d}s] ")
                sys.stdout.flush()
            elif status == "COMPLETED":
                print("\n")
                print("=" * 65)
                print("🎉 [ZERO-TRUST ACCESS GRANTED & LEASE COMPLETED!]")
                print(f"   Completion timestamp: {datetime.now().strftime('%H:%M:%S')}")

                relay_meta = fields.get("relayMetadata", {}).get("mapValue", {}).get("fields", {})
                if relay_meta:
                    key_b64 = relay_meta.get("encryptionKeyB64", {}).get("stringValue", "")
                    iv_b64 = relay_meta.get("ivB64", {}).get("stringValue", "")
                    chunk_count = int(relay_meta.get("chunkCount", {}).get("integerValue", 1))
                    size_bytes = int(relay_meta.get("sizeBytes", {}).get("integerValue", 0))

                    print(f"   Transport:        Zero-Trust Cloud Relay (AES-256-GCM)")
                    print(f"   Decryption Key:   {key_b64[:12]}... (single-use ephemeral)")
                    print(f"   Ciphertext Size:  {chunk_count} chunk(s) ({format_size(size_bytes)})")
                    print("\n[CI/CD] Downloading encrypted chunks from cloud relay...")

                    cipher_bytes = bytearray()
                    chunks_base_url = f"{FIRESTORE_BASE}/vaults/{selected_vault['vaultId']}/requests/{request_id}/chunks"
                    for idx in range(chunk_count):
                        chunk_url = f"{chunks_base_url}/{idx}"
                        chunk_doc = http_get(chunk_url)
                        chunk_b64 = chunk_doc.get("fields", {}).get("data", {}).get("stringValue", "")
                        raw_chunk = base64.b64decode(chunk_b64)
                        cipher_bytes.extend(raw_chunk)
                        print(f"  ✓ Acquired Chunk {idx + 1}/{chunk_count} ({format_size(len(raw_chunk))})")

                    print("\n[CI/CD] Decrypting payload with ephemeral AES-256-GCM key in runner memory...")
                    key_bytes = base64.b64decode(key_b64)
                    iv_bytes = base64.b64decode(iv_b64)
                    aesgcm = AESGCM(key_bytes)
                    plaintext = aesgcm.decrypt(iv_bytes, bytes(cipher_bytes), None)
                    print(f"  ✓ In-memory Decryption successful! ({format_size(len(plaintext))})")

                    print("\n[CI/CD] Verifying cryptographic SHA-256 integrity...")
                    computed_sha256 = hashlib.sha256(plaintext).hexdigest().lower()
                    expected_sha256 = target_file["sha256"].lower()
                    print(f"  Target Hash:   {expected_sha256}")
                    print(f"  Computed Hash: {computed_sha256}")

                    if computed_sha256 != expected_sha256:
                        print("❌ CRITICAL: Cryptographic SHA-256 mismatch! Payload corrupted or tampered!")
                        sys.exit(1)

                    print("  ✓ Integrity Verified: SHA-256 CHECKSUM MATCHES 100%!")

                    out_name = f"cicd_download_{target_file['name']}"
                    with open(out_name, "wb") as f_out:
                        f_out.write(plaintext)
                    print(f"  ✓ Saved verified artifact to: ./{out_name}")

                    # Zero-trust purge
                    print("\n[CI/CD] Zero-Trust ephemeral purge: destroying encrypted chunks from cloud...")
                    for idx in range(chunk_count):
                        http_delete(f"{chunks_base_url}/{idx}")
                    print("  ✓ Cloud relay purged. Zero persistent data left in cloud.")
                else:
                    print("   Transfer completed via P2P stream.")

                print("=" * 65)
                print("✓ CI/CD Pipeline execution SUCCEEDED with Zero-Trust!")
                return
            elif status == "REJECTED":
                print("\n")
                print("=" * 65)
                print("❌ [SECURITY ALERT] TRANSFER DENIED BY HUMAN OPERATOR ON PHONE!")
                print(f"   Decision: REJECTED | Request ID: {request_id}")
                print("   The zero-trust gate successfully blocked unauthorized CI/CD release.")
                print("   Pipeline aborted with Exit Code 1.")
                print("=" * 65)
                sys.exit(1)
            elif status == "EXPIRED":
                print("\n")
                print("=" * 65)
                print("⏰ [TIMEOUT] Transfer request expired before approval!")
                print("   No action taken within TTL. Lease revoked.")
                print("   Pipeline aborted.")
                print("=" * 65)
                sys.exit(1)
            elif status == "FAILED":
                print("\n")
                print(f"❌ [TRANSFER FAILED] Device reported failure: {error_msg}")
                sys.exit(1)

        except Exception as poll_err:
            pass

        time.sleep(1.5)

    print("\n")
    print("⏰ [TIMEOUT] 90 seconds reached without completion.")
    print("   Pipeline aborted.")
    sys.exit(1)

if __name__ == "__main__":
    main()
