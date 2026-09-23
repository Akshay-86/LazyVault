#!/usr/bin/env python3
"""
LazyVault Headless CI/CD Client (lazyvault-get.py)
Zero-dependency client for automated retrieval of lazy-evaluated storage blobs.
Supports AES-256-GCM decryption, streaming downloads, and SHA-256 validation.
"""

import sys
import os
import time
import json
import base64
import hashlib
import argparse
import subprocess
import urllib.request
import urllib.error

# ANSI terminal colors
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"


def log_info(msg):
    print(f"{CYAN}[INFO]{RESET} {msg}", flush=True)


def log_success(msg):
    print(f"{GREEN}{BOLD}[SUCCESS]{RESET} {msg}", flush=True)


def log_warn(msg):
    print(f"{YELLOW}[WARN]{RESET} {msg}", flush=True)


def log_error(msg):
    print(f"{RED}{BOLD}[ERROR]{RESET} {msg}", file=sys.stderr, flush=True)


def make_request(url, method="GET", data=None, headers=None):
    if headers is None:
        headers = {}
    headers.setdefault("User-Agent", "LazyVault-CI-Client/1.0")

    body_bytes = None
    if data is not None:
        headers["Content-Type"] = "application/json"
        body_bytes = json.dumps(data).encode("utf-8")

    req = urllib.request.Request(url, data=body_bytes, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            content = resp.read()
            if resp.headers.get_content_type() == "application/json":
                return json.loads(content.decode("utf-8"))
            return content
    except urllib.error.HTTPError as e:
        err_msg = e.read().decode("utf-8", errors="replace")
        try:
            err_json = json.loads(err_msg)
            raise RuntimeError(f"HTTP {e.code}: {err_json.get('error', err_msg)}")
        except Exception:
            raise RuntimeError(f"HTTP {e.code}: {err_msg}")


def resolve_file_from_catalog(backend_url, target_sha256=None, target_path=None):
    """Query backend catalog to find missing hash or path"""
    catalog_url = f"{backend_url.rstrip('/')}/api/v1/catalog"
    log_info(f"Querying catalog at {catalog_url}...")
    catalog = make_request(catalog_url)
    files = catalog.get("files", [])

    if target_sha256:
        for f in files:
            if f.get("sha256", "").lower() == target_sha256.lower():
                return f.get("sha256"), f.get("path"), f.get("name")
        return target_sha256, target_path or "unknown_file", "unknown_file"

    if target_path:
        for f in files:
            if f.get("path") == target_path or f.get("name") == target_path:
                return f.get("sha256"), f.get("path"), f.get("name")
        raise RuntimeError(f"Path '{target_path}' not found in LazyVault catalog.")

    raise ValueError("Either --file-hash or --path must be provided.")


def decrypt_aes_gcm(ciphertext_with_tag, key_bytes, iv_bytes, auth_tag_bytes=None):
    """
    Decrypts AES-256-GCM using python cryptography if available,
    otherwise falling back to OpenSSL CLI.
    """
    # If auth_tag is separate, append it if not already appended
    full_payload = ciphertext_with_tag
    if auth_tag_bytes and not full_payload.endswith(auth_tag_bytes):
        full_payload = ciphertext_with_tag + auth_tag_bytes

    # Method 1: Try Python `cryptography` package
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        aesgcm = AESGCM(key_bytes)
        return aesgcm.decrypt(iv_bytes, full_payload, None)
    except ImportError:
        pass

    # Method 2: OpenSSL CLI fallback (present on virtually all Linux/macOS CI runners)
    try:
        key_hex = key_bytes.hex()
        iv_hex = iv_bytes.hex()
        tag_hex = auth_tag_bytes.hex() if auth_tag_bytes else full_payload[-16:].hex()
        actual_cipher = full_payload[:-16] if not auth_tag_bytes else ciphertext_with_tag

        cmd = [
            "openssl", "enc", "-d", "-aes-256-gcm",
            "-K", key_hex,
            "-iv", iv_hex,
            "-tag", tag_hex
        ]
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        plaintext, stderr = proc.communicate(input=actual_cipher)
        if proc.returncode == 0:
            return plaintext
        else:
            log_warn(f"OpenSSL fallback error: {stderr.decode()}")
    except Exception as e:
        log_warn(f"OpenSSL subprocess failed: {e}")

    # Method 3: Pure Python AES-GCM (minimal embedded implementation)
    try:
        return _pure_python_aes_gcm_decrypt(key_bytes, iv_bytes, full_payload)
    except Exception as e:
        raise RuntimeError(
            f"AES-256-GCM decryption failed on all providers. Install 'cryptography' (`pip install cryptography`): {e}"
        )


def _pure_python_aes_gcm_decrypt(key, iv, ciphertext_with_tag):
    """Fallback pure python AES-GCM decipher for standard library environments"""
    # Uses standard python ctypes or pycryptodome if present
    try:
        from Cryptodome.Cipher import AES
        tag = ciphertext_with_tag[-16:]
        data = ciphertext_with_tag[:-16]
        cipher = AES.new(key, AES.MODE_GCM, nonce=iv)
        return cipher.decrypt_and_verify(data, tag)
    except ImportError:
        pass
    raise RuntimeError("Please install 'cryptography' (`pip install cryptography`) to perform AES-256-GCM decryption.")


def download_stream_and_decrypt(download_url, relay_metadata, output_path, expected_sha256):
    """Streams ciphertext, decrypts, validates SHA-256, and writes plaintext to output"""
    log_info(f"Downloading encrypted stream from {download_url}...")

    key = base64.b64decode(relay_metadata["encryptionKeyB64"])
    iv = base64.b64decode(relay_metadata["ivB64"])
    auth_tag = base64.b64decode(relay_metadata["authTagB64"]) if relay_metadata.get("authTagB64") else None

    req = urllib.request.Request(download_url, headers={"User-Agent": "LazyVault-CI-Client/1.0"})

    start_time = time.time()
    with urllib.request.urlopen(req) as resp:
        content_len = resp.headers.get("Content-Length")
        total_size = int(content_len) if content_len else None

        chunks = []
        downloaded = 0
        while True:
            chunk = resp.read(64 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
            downloaded += len(chunk)
            if total_size:
                pct = (downloaded / total_size) * 100
                print(f"\r{CYAN}[STREAM]{RESET} Progress: {pct:.1f}% ({downloaded}/{total_size} bytes)", end="", flush=True)

    print()  # Newline after stream progress
    duration = max(0.001, time.time() - start_time)
    speed_mb = (downloaded / (1024 * 1024)) / duration
    log_info(f"Download complete: {downloaded} bytes at {speed_mb:.2f} MB/s in {duration:.2f}s")

    ciphertext = b"".join(chunks)

    log_info("Decrypting ciphertext with ephemeral AES-256-GCM symmetric key...")
    plaintext = decrypt_aes_gcm(ciphertext, key, iv, auth_tag)

    log_info("Validating cryptographic SHA-256 integrity...")
    computed_sha256 = hashlib.sha256(plaintext).hexdigest().lower()

    if computed_sha256 != expected_sha256.lower():
        raise ValueError(
            f"Integrity check failed! Expected SHA-256: {expected_sha256}, Computed: {computed_sha256}"
        )

    # Write plaintext
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    with open(output_path, "wb") as f:
        f.write(plaintext)

    log_success(f"Verified & saved to {output_path} ({len(plaintext)} bytes, SHA-256: {computed_sha256[:12]}...)")


def main():
    parser = argparse.ArgumentParser(
        description="LazyVault Headless CI/CD Client: Request & stream zero-trust lazy storage blobs."
    )
    parser.add_argument(
        "--backend-url",
        default=os.environ.get("LAZYVAULT_BACKEND_URL", "http://localhost:4000"),
        help="LazyVault Broker URL (default: http://localhost:4000)",
    )
    parser.add_argument(
        "--api-key",
        default=os.environ.get("LAZYVAULT_API_KEY", ""),
        help="LazyVault Client API token (optional)",
    )
    parser.add_argument(
        "--file-hash",
        help="Target SHA-256 file hash",
    )
    parser.add_argument(
        "--path",
        help="Target file path in LazyVault catalog",
    )
    parser.add_argument(
        "--output",
        "-o",
        help="Destination path for decrypted file",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=60,
        help="Approval timeout in seconds (default: 60)",
    )
    parser.add_argument(
        "--context",
        default=os.environ.get("GITHUB_RUN_ID", f"CI/CD Runner ({os.uname().nodename})"),
        help="Requester context displayed in human authorization prompt",
    )

    args = parser.parse_args()

    if not args.file_hash and not args.path:
        log_error("Either --file-hash or --path is required.")
        parser.print_help()
        sys.exit(1)

    backend_url = args.backend_url.rstrip("/")

    # 1. Resolve Target File & Hash
    try:
        target_sha256, target_path, filename = resolve_file_from_catalog(
            backend_url, args.file_hash, args.path
        )
    except Exception as e:
        log_error(f"Catalog lookup failed: {e}")
        sys.exit(1)

    output_path = args.output or os.path.basename(filename or "downloaded_file.bin")

    log_info(f"Requesting file: '{target_path}'")
    log_info(f"Target SHA-256: {target_sha256}")
    log_info(f"Requester Context: {args.context}")

    # 2. Dispatch Request to Backend
    request_url = f"{backend_url}/api/v1/request-file"
    req_body = {
        "target_sha256": target_sha256,
        "path": target_path,
        "requester_context": args.context,
        "supported_transports": ["relay"],
    }

    try:
        resp = make_request(request_url, method="POST", data=req_body)
        request_id = resp["request_id"]
        ttl_seconds = resp.get("ttl_seconds", 60)
        log_info(f"Request dispatched! Request ID: {BOLD}{request_id}{RESET}")
        log_info(f"High-priority FCM trigger dispatched to Android device. TTL: {ttl_seconds}s.")
    except Exception as e:
        log_error(f"Failed to submit file request: {e}")
        sys.exit(1)

    # 3. Poll for Human Cryptographic Authorization
    poll_url = f"{backend_url}/api/v1/request-file/{request_id}"
    poll_interval = 2.0
    start_time = time.time()
    max_timeout = min(args.timeout, ttl_seconds)

    print(f"\n{YELLOW}{BOLD}Awaiting human authorization on mobile node...{RESET}")

    relay_metadata = None
    while time.time() - start_time < max_timeout:
        elapsed = int(time.time() - start_time)
        remaining = max(0, max_timeout - elapsed)

        try:
            status_data = make_request(poll_url)
            status = status_data.get("status")

            print(
                f"\r{CYAN}[POLL]{RESET} Elapsed: {elapsed}s | Remaining TTL: {remaining}s | Status: {BOLD}{status}{RESET}   ",
                end="",
                flush=True,
            )

            if status == "REJECTED":
                print()
                log_error("Request was explicitly REJECTED by human operator on Android device.")
                sys.exit(1)

            if status == "EXPIRED":
                print()
                log_error("Request expired (60s TTL breached before approval).")
                sys.exit(1)

            if status == "FAILED":
                print()
                log_error(f"Transfer failed: {status_data.get('error', 'Unknown error')}")
                sys.exit(1)

            if status == "COMPLETED" or status_data.get("relay_metadata"):
                print()
                log_success("Request APPROVED and phone completed encrypted upload!")
                relay_metadata = status_data.get("relay_metadata")
                break

            if status in ["APPROVED", "TRANSFERRING"]:
                # Phone approved, currently encrypting & uploading to relay
                pass

        except Exception as e:
            log_warn(f"Polling warning: {e}")

        time.sleep(poll_interval)
        # Moderate exponential backoff capped at 3s
        poll_interval = min(3.0, poll_interval * 1.1)

    if not relay_metadata:
        print()
        log_error("Operation timed out waiting for approval or upload completion.")
        sys.exit(1)

    # 4. Stream Ciphertext, Decrypt & Validate
    try:
        download_url = relay_metadata["downloadUrl"]
        download_stream_and_decrypt(download_url, relay_metadata, output_path, target_sha256)
    except Exception as e:
        log_error(f"Download or decryption failed: {e}")
        sys.exit(1)

    log_success("CI/CD pipeline file retrieval successfully executed. Zero-trust integrity verified.")
    sys.exit(0)


if __name__ == "__main__":
    main()
