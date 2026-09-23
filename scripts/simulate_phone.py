#!/usr/bin/env python3
"""
LazyVault Interactive Mobile Node Simulator (scripts/simulate_phone.py)
Allows you to test the complete LazyVault flow directly from your workstation
even before installing the Android APK on a physical phone.

Simulates:
1. Catalog scanning & synchronization to broker
2. Listening for incoming high-priority trigger messages
3. Interactive terminal prompt with [A]llow / [D]eny buttons
4. On-the-fly AES-256-GCM encryption & upload to Ephemeral Relay
"""

import sys
import os
import time
import json
import base64
import hashlib
import argparse
import urllib.request
import urllib.error
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# Terminal formatting
GREEN = "\033[92m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
RED = "\033[91m"
BOLD = "\033[1m"
RESET = "\033[0m"

SAMPLE_FILES = [
    {
        "name": "financial_audit_2026.pdf",
        "path": "/storage/emulated/0/LazyVault/financial_audit_2026.pdf",
        "content": b"%PDF-1.7\nLazyVault Confidential Audit 2026. Hardware-backed dormant mobile storage node.\nZero persistent cloud blobs.\n" * 50,
    },
    {
        "name": "production_model.onnx",
        "path": "/storage/emulated/0/LazyVault/production_model.onnx",
        "content": b"ONNX-MODEL-WEIGHTS-BINARY-HEADER\n" + (os.urandom(1024 * 256)),
    },
    {
        "name": "infra_secrets_backup.kdbx",
        "path": "/storage/emulated/0/LazyVault/infra_secrets_backup.kdbx",
        "content": b"KDBX4-ENCRYPTED-KEYSTORE-PAYLOAD-SAMPLE\n" + (os.urandom(1024 * 64)),
    },
    {
        "name": "dataset_mini.tar.gz",
        "path": "/storage/emulated/0/LazyVault/dataset_mini.tar.gz",
        "content": b"GZIP-TAR-DATASET-ARCHIVE\n" + (os.urandom(1024 * 512)),
    }
]

def make_req(url, method="GET", data=None):
    headers = {"User-Agent": "LazyVault-Simulated-Android-Node/1.0"}
    body = None
    if data is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req) as resp:
        content = resp.read()
        if resp.headers.get_content_type() == "application/json":
            return json.loads(content.decode("utf-8"))
        return content

def main():
    parser = argparse.ArgumentParser(description="LazyVault Mobile Node Terminal Simulator")
    parser.add_argument("--backend-url", default="http://localhost:4000", help="Broker URL")
    parser.add_argument("--device-name", default="Pixel 9 Pro (Simulated Node)", help="Device name")
    parser.add_argument("--auto-approve", action="store_true", help="Auto approve incoming requests")
    args = parser.parse_args()

    backend_url = args.backend_url.rstrip("/")

    print(f"\n{BOLD}{CYAN}====================================================================")
    print(f"      LazyVault Mobile Node Simulator (Android Emulation Mode)")
    print(f"===================================================================={RESET}\n")

    # 1. Register Device
    print(f"{CYAN}[NODE]{RESET} Registering device '{args.device_name}' with broker at {backend_url}...")
    try:
        reg_resp = make_req(
            f"{backend_url}/api/v1/device/register",
            method="POST",
            data={
                "device_id": "simulated-android-pixel9",
                "device_name": args.device_name,
                "fcm_token": "simulated_fcm_token_local_desktop",
            }
        )
        print(f"{GREEN}[NODE] Device registered successfully!{RESET}\n")
    except Exception as e:
        print(f"{RED}[ERROR] Failed connecting to backend at {backend_url}: {e}{RESET}")
        print(f"Make sure backend is running: `npm run dev:backend`")
        sys.exit(1)

    # 2. Push Initial Catalog
    print(f"{CYAN}[NODE]{RESET} Scanning storage and synchronizing initial catalog snapshot...")
    catalog_files = []
    file_map = {}
    merkle_hasher = hashlib.sha256()

    for item in SAMPLE_FILES:
        sha256 = hashlib.sha256(item["content"]).hexdigest()
        file_map[sha256] = item
        file_map[item["path"]] = item
        merkle_hasher.update(sha256.encode("utf-8"))

        catalog_files.append({
            "path": item["path"],
            "name": item["name"],
            "size": len(item["content"]),
            "sha256": sha256,
            "mtime": int(time.time() * 1000)
        })

    root_hash = merkle_hasher.hexdigest()
    sync_resp = make_req(
        f"{backend_url}/api/v1/catalog/sync",
        method="POST",
        data={
            "device_id": "simulated-android-pixel9",
            "root_hash": root_hash,
            "files": catalog_files
        }
    )
    print(f"{GREEN}[NODE] Catalog synchronized: {len(catalog_files)} files (Root: {root_hash[:12]}...){RESET}")
    for f in catalog_files:
        print(f"  • {BOLD}{f['name']}{RESET} ({f['size'] / 1024:.1f} KB) - SHA: {f['sha256'][:16]}...")

    print(f"\n{YELLOW}{BOLD}[DORMANT] Phone node is now dormant and sleeping.{RESET}")
    print(f"Listening for High-Priority triggers from Web Dashboard or CI Client...\n")

    # 3. Listen to SSE events stream
    sse_url = f"{backend_url}/api/v1/device/events"
    req = urllib.request.Request(sse_url, headers={"Accept": "text/event-stream"})

    try:
        with urllib.request.urlopen(req) as resp:
            for line in resp:
                decoded = line.decode("utf-8").strip()
                if decoded.startswith("data:"):
                    raw_data = decoded[5:].strip()
                    try:
                        event = json.loads(raw_data)
                        if event.get("type") == "REQUEST_TRIGGER":
                            handle_trigger(backend_url, event["payload"], file_map, args.auto_approve)
                    except Exception as err:
                        pass
    except KeyboardInterrupt:
        print(f"\n{CYAN}[NODE] Simulator stopped.{RESET}")
        sys.exit(0)

def handle_trigger(backend_url, payload, file_map, auto_approve):
    request_id = payload["request_id"]
    path = payload["path"]
    target_sha256 = payload["sha256"]
    context_desc = payload.get("requester_context", "External Requester")
    requester_ip = payload.get("requester_ip", "127.0.0.1")
    supported_transports = payload.get("supported_transports", ["relay"])
    if isinstance(supported_transports, str):
        try:
            supported_transports = json.loads(supported_transports)
        except:
            supported_transports = ["relay"]

    filename = path.split("/")[-1]

    print("\n" + "="*65)
    print(f"🔔 {YELLOW}{BOLD}INCOMING VAULT LEASE AUTHORIZATION PROMPT{RESET}")
    print("="*65)
    print(f"  File Requested : {BOLD}{filename}{RESET}")
    print(f"  Storage Path   : {path}")
    print(f"  Target SHA-256 : {target_sha256}")
    print(f"  Requester      : {CYAN}{context_desc}{RESET}")
    print(f"  Requester IP   : {requester_ip}")
    print(f"  Supported      : {supported_transports}")
    print(f"  Strict TTL     : 60 seconds (Replay-Protected)")
    print("="*65)

    decision = None
    if auto_approve:
        print(f"{GREEN}[AUTO-APPROVE] Automatically granting cryptographic lease...{RESET}")
        decision = "ALLOW"
    else:
        while True:
            choice = input(f"\n{BOLD}Authorize this transfer? [{GREEN}a{RESET}]llow / [{RED}d{RESET}]eny: ").strip().lower()
            if choice in ["a", "allow", "y", "yes"]:
                decision = "ALLOW"
                break
            elif choice in ["d", "deny", "n", "no"]:
                decision = "DENY"
                break

    # Send decision to backend
    decision_url = f"{backend_url}/api/v1/request-file/{request_id}/decision"
    chosen_transport = "webrtc" if "webrtc" in supported_transports else "relay"

    try:
        make_req(
            decision_url,
            method="POST",
            data={
                "decision": decision,
                "chosen_transport": chosen_transport,
            }
        )
    except Exception as e:
        print(f"{RED}[ERROR] Failed posting decision: {e}{RESET}")
        return

    if decision == "DENY":
        print(f"{RED}{BOLD}[DECISION] Transfer REJECTED. Phone returning to dormant sleep.{RESET}\n")
        return

    print(f"{GREEN}{BOLD}[DECISION] Transfer ALLOWED! Starting {chosen_transport} transport pipeline...{RESET}")

    # Resolve file content
    file_item = file_map.get(target_sha256) or file_map.get(path)
    if not file_item:
        plaintext = f"Sample LazyVault blob content for {path}\nTimestamp: {time.time()}".encode("utf-8")
    else:
        plaintext = file_item["content"]

    # Execute Relay or WebRTC Transfer
    # For CI and general headless testing, relay with AES-256-GCM is standard
    print(f"{CYAN}[CRYPTO]{RESET} Generating ephemeral 256-bit AES symmetric key + 12-byte IV...")
    key = os.urandom(32)
    iv = os.urandom(12)

    aesgcm = AESGCM(key)
    ciphertext = aesgcm.encrypt(iv, plaintext, None)

    print(f"{CYAN}[RELAY]{RESET} Streaming encrypted ciphertext ({len(ciphertext)} bytes) to broker...")
    upload_url = f"{backend_url}/api/v1/relay/upload/{request_id}"
    req = urllib.request.Request(
        upload_url,
        data=ciphertext,
        headers={"Content-Type": "application/octet-stream"},
        method="PUT"
    )
    with urllib.request.urlopen(req) as resp:
        if resp.status != 200:
            print(f"{RED}[ERROR] Relay upload failed: {resp.status}{RESET}")
            return

    print(f"{CYAN}[RELAY]{RESET} Notifying broker of completion with ephemeral decryption key...")
    complete_url = f"{backend_url}/api/v1/relay-complete/{request_id}"
    make_req(
        complete_url,
        method="POST",
        data={
            "encryption_key_b64": base64.b64encode(key).decode(),
            "iv_b64": base64.b64encode(iv).decode(),
            "file_size_bytes": len(ciphertext)
        }
    )

    print(f"{GREEN}{BOLD}[SUCCESS] Transfer pipeline complete! Ciphertext delivered.{RESET}")
    print(f"{YELLOW}[DORMANT] Phone returning to low-power sleep state.\n{RESET}")

if __name__ == "__main__":
    main()
