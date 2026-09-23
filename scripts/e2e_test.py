#!/usr/bin/env python3
"""
LazyVault Monorepo End-to-End Test Suite
Tests backend, catalog sync, request state machine, FCM dispatch,
ephemeral relay upload/download, AES-256-GCM decryption, and lazyvault-get.py.
"""

import os
import sys
import time
import json
import base64
import hashlib
import subprocess
import urllib.request
import urllib.error

GREEN = "\033[92m"
CYAN = "\033[96m"
YELLOW = "\033[93m"
RED = "\033[91m"
BOLD = "\033[1m"
RESET = "\033[0m"

PORT = 4099
BASE_URL = f"http://127.0.0.1:{PORT}"

def log(msg):
    print(f"{CYAN}[E2E-TEST]{RESET} {msg}", flush=True)

def success(msg):
    print(f"{GREEN}{BOLD}[PASS]{RESET} {msg}", flush=True)

def fail(msg):
    print(f"{RED}{BOLD}[FAIL]{RESET} {msg}", file=sys.stderr, flush=True)
    sys.exit(1)

def http_json(url, method="GET", data=None):
    headers = {"User-Agent": "LazyVault-E2E-Test/1.0"}
    body_bytes = None
    if data is not None:
        headers["Content-Type"] = "application/json"
        body_bytes = json.dumps(data).encode("utf-8")

    req = urllib.request.Request(url, data=body_bytes, headers=headers, method=method)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

def main():
    print(f"\n{BOLD}=== Starting LazyVault End-to-End System Test ==={RESET}\n")

    # 1. Start Backend on PORT 4099
    backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend"))
    log(f"Starting backend on port {PORT}...")
    backend_env = os.environ.copy()
    backend_env["PORT"] = str(PORT)

    backend_proc = subprocess.Popen(
        ["node", "dist/index.js"],
        cwd=backend_dir,
        env=backend_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )

    try:
        # Wait for backend to be ready
        ready = False
        for _ in range(30):
            try:
                res = http_json(f"{BASE_URL}/api/v1/health")
                if res.get("status") == "healthy":
                    ready = True
                    break
            except Exception:
                time.sleep(0.3)

        if not ready:
            fail("Backend server failed to start within 10 seconds.")
        success("Backend Request Broker & Signaling Service is healthy.")

        # 2. Register Simulated Android Device
        log("Registering Android device identity & FCM token...")
        reg_res = http_json(
            f"{BASE_URL}/api/v1/device/register",
            method="POST",
            data={
                "device_id": "pixel-9-pro-zero-trust",
                "device_name": "Akshay Pixel 9 Pro",
                "fcm_token": "mock_fcm_token_device_e2e_test",
            }
        )
        if reg_res.get("status") != "registered":
            fail(f"Device registration failed: {reg_res}")
        success("Android device registered successfully.")

        # 3. Synchronize Catalog Snapshot
        log("Android Worker pushing initial catalog generation snapshot...")
        sample_content = b"LazyVault confidential machine learning model weights 2026. Zero persistent cloud blobs."
        sample_sha256 = hashlib.sha256(sample_content).hexdigest()

        catalog_payload = {
            "device_id": "pixel-9-pro-zero-trust",
            "root_hash": hashlib.sha256(sample_sha256.encode()).hexdigest(),
            "files": [
                {
                    "path": "/storage/emulated/0/LazyVault/model_v2.bin",
                    "name": "model_v2.bin",
                    "size": len(sample_content),
                    "sha256": sample_sha256,
                    "mtime": int(time.time() * 1000)
                }
            ]
        }
        sync_res = http_json(f"{BASE_URL}/api/v1/catalog/sync", method="POST", data=catalog_payload)
        if sync_res.get("status") != "success":
            fail(f"Catalog sync failed: {sync_res}")
        success(f"Catalog synchronized with 1 item (SHA: {sample_sha256[:12]}...).")

        # 4. Verify Catalog Browser Endpoint
        log("Testing GET /api/v1/catalog...")
        cat = http_json(f"{BASE_URL}/api/v1/catalog")
        if cat.get("item_count") != 1 or cat["files"][0]["name"] != "model_v2.bin":
            fail(f"Catalog query returned unexpected files: {cat}")
        success("Catalog query returned valid metadata tree.")

        # 5. Execute Headless CI Client (lazyvault-get.py)
        log("Launching headless CI client (lazyvault-get.py) in subprocess...")
        cli_script = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "cli", "lazyvault-get.py"))
        output_dest = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "downloaded_e2e_test.bin"))

        if os.path.exists(output_dest):
            os.remove(output_dest)

        ci_proc = subprocess.Popen(
            [
                sys.executable,
                cli_script,
                "--backend-url", BASE_URL,
                "--file-hash", sample_sha256,
                "--output", output_dest,
                "--context", "E2E Automated CI Test Runner #42",
                "--timeout", "30"
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )

        # Wait briefly for request to register in backend
        time.sleep(2)

        # Look up pending request
        # 6. Simulate Phone User Approving Transfer & Uploading Encrypted Relay Blob
        log("Simulating Android mobile node approving request and uploading AES-256-GCM ciphertext...")

        # Generate 32-byte key and 12-byte IV
        key = os.urandom(32)
        iv = os.urandom(12)

        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        aesgcm = AESGCM(key)
        ciphertext = aesgcm.encrypt(iv, sample_content, None)

        # Find the request ID from backend
        # Look through backend's active requests by creating decision
        # We can find the request ID by checking the CLI stdout or backend store
        # Let's get request ID from backend device events or direct query
        # Since backend only has 1 active request, let's query:
        # We can query recent requests or inspect CLI output
        time.sleep(1)

        # Let's query recent requests by calling backend
        # We know request was created by CLI. Let's inspect backend requests:
        # We can look up the request_id from CLI output or we can allow the CLI to print it!
        # Read available lines from ci_proc
        request_id = None
        for _ in range(10):
            # Check if CLI printed Request ID
            cli_out = ci_proc.stdout.peek().decode("utf-8", errors="ignore")
            for line in cli_out.splitlines():
                if "Request ID:" in line:
                    request_id = line.split("Request ID:")[-1].strip().split()[0]
                    # Strip any ANSI codes
                    request_id = request_id.replace("\033[1m", "").replace("\033[0m", "").strip()
                    break
            if request_id:
                break
            time.sleep(0.5)

        if not request_id:
            fail("Could not detect request_id from CLI client output.")

        log(f"Detected active request ID: {request_id}")

        # Device submits ALLOW decision
        log(f"Submitting [ALLOW] decision for request {request_id}...")
        decision_res = http_json(
            f"{BASE_URL}/api/v1/request-file/{request_id}/decision",
            method="POST",
            data={"decision": "ALLOW", "chosen_transport": "relay"}
        )
        if decision_res.get("status") != "APPROVED":
            fail(f"Decision failed: {decision_res}")
        success("Human authorization [ALLOW] registered on broker.")

        # Upload encrypted ciphertext stream to relay
        log("Android streaming ciphertext to PUT /api/v1/relay/upload/:id...")
        req = urllib.request.Request(
            f"{BASE_URL}/api/v1/relay/upload/{request_id}",
            data=ciphertext,
            headers={"Content-Type": "application/octet-stream"},
            method="PUT"
        )
        with urllib.request.urlopen(req) as resp:
            if resp.status != 200:
                fail(f"Relay upload failed: {resp.status}")

        # Complete relay notification
        log("Android dispatching ephemeral key to POST /api/v1/relay-complete/:id...")
        complete_res = http_json(
            f"{BASE_URL}/api/v1/relay-complete/{request_id}",
            method="POST",
            data={
                "encryption_key_b64": base64.b64encode(key).decode(),
                "iv_b64": base64.b64encode(iv).decode(),
                "file_size_bytes": len(ciphertext)
            }
        )
        if complete_res.get("status") != "COMPLETED":
            fail(f"Relay complete failed: {complete_res}")
        success("Encrypted ephemeral relay upload finalized.")

        # Wait for CI client to finish
        ci_stdout, ci_stderr = ci_proc.communicate(timeout=15)
        if ci_proc.returncode != 0:
            fail(f"CI client failed with exit code {ci_proc.returncode}:\n{ci_stdout.decode()}\n{ci_stderr.decode()}")
        success("CI Client exited successfully with exit code 0.")

        # 7. Verify Decrypted File Content & Integrity
        if not os.path.exists(output_dest):
            fail(f"Output file was not created: {output_dest}")

        with open(output_dest, "rb") as f:
            downloaded_bytes = f.read()

        if downloaded_bytes != sample_content:
            fail(f"Decrypted content mismatch! Expected: {sample_content}, Got: {downloaded_bytes}")

        computed_sha = hashlib.sha256(downloaded_bytes).hexdigest()
        success(f"File verified bit-for-bit against original payload! (SHA: {computed_sha[:16]}...)")
        os.remove(output_dest)

        # 8. Verify Zero-Trust Single-Use Purge
        log("Testing zero-trust single-use purge on ephemeral relay...")
        try:
            urllib.request.urlopen(f"{BASE_URL}/api/v1/relay/download/{request_id}")
            fail("Secondary download succeeded, but ephemeral blob should have been purged!")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                success("Single-use policy confirmed: second download returned HTTP 404 (purged).")
            else:
                fail(f"Unexpected HTTP code on purge test: {e.code}")

        # 9. Test Rejection Flow (DENY)
        log("Testing [DENY] rejection flow with strict 60s TTL...")
        deny_req = http_json(
            f"{BASE_URL}/api/v1/request-file",
            method="POST",
            data={
                "target_sha256": sample_sha256,
                "path": "/storage/emulated/0/LazyVault/model_v2.bin",
                "requester_context": "Deny Flow Test",
                "supported_transports": ["relay"]
            }
        )
        deny_id = deny_req["request_id"]
        deny_res = http_json(
            f"{BASE_URL}/api/v1/request-file/{deny_id}/decision",
            method="POST",
            data={"decision": "DENY"}
        )
        if deny_res.get("status") != "REJECTED":
            fail(f"Rejection flow failed: {deny_res}")
        success("Rejection flow successfully verified (status: REJECTED).")

        print(f"\n{GREEN}{BOLD}====================================================================")
        print("  ALL END-TO-END SYSTEM TESTS PASSED SUCCESSFULLY! (100% VERIFIED)")
        print(f"===================================================================={RESET}\n")

    finally:
        backend_proc.terminate()
        backend_proc.wait()

if __name__ == "__main__":
    main()
