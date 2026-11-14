#!/usr/bin/env python3
"""
LazyVault Headless CI/CD Client (lazyvault-get.py)
Automated retrieval of lazy-evaluated storage blobs from a mobile LazyVault node.
Supports Cloud Firestore serverless relay (primary) & REST broker (legacy fallback).
Features AES-256-GCM decryption, dynamic chunk streaming, and SHA-256 integrity validation.
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

DEFAULT_PROJECT_ID = "lazyvault-node"
DEFAULT_API_KEY = "AIzaSyDmmj82oWommWVzUMgabRrAvOTbL790hhE"


def log_info(msg):
    print(f"{CYAN}[INFO]{RESET} {msg}", flush=True)


def log_success(msg):
    print(f"{GREEN}{BOLD}[SUCCESS]{RESET} {msg}", flush=True)


def log_warn(msg):
    print(f"{YELLOW}[WARN]{RESET} {msg}", flush=True)


def log_error(msg):
    print(f"{RED}{BOLD}[ERROR]{RESET} {msg}", file=sys.stderr, flush=True)


def make_request(url, method="GET", data=None, headers=None, retries=3, timeout=30):
    if headers is None:
        headers = {}
    headers.setdefault("User-Agent", "LazyVault-CI-Client/2.0")

    body_bytes = None
    if data is not None:
        headers["Content-Type"] = "application/json"
        body_bytes = json.dumps(data).encode("utf-8")

    last_err = None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=body_bytes, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                content = resp.read()
                content_type = resp.headers.get_content_type()
                if content_type == "application/json" or (content.startswith(b"{") and content.endswith(b"}")):
                    try:
                        return json.loads(content.decode("utf-8"))
                    except Exception:
                        return content
                return content
        except urllib.error.HTTPError as e:
            err_msg = e.read().decode("utf-8", errors="replace")
            # If 400, 401, 403, 404, 409, 410, don't retry - raise directly
            if e.code in (400, 401, 403, 404, 409, 410):
                try:
                    err_json = json.loads(err_msg)
                    raise RuntimeError(f"HTTP {e.code}: {err_json.get('error', err_msg)}")
                except Exception:
                    raise RuntimeError(f"HTTP {e.code}: {err_msg}")
            last_err = RuntimeError(f"HTTP {e.code}: {err_msg}")
        except Exception as e:
            last_err = e

        if attempt < retries - 1:
            time.sleep(0.5 * (attempt + 1))

    raise last_err or RuntimeError(f"Failed request to {url}")


# ==========================================
# Firestore Data Helpers
# ==========================================

def parse_firestore_val(val):
    if not isinstance(val, dict):
        return val
    if "stringValue" in val:
        return val["stringValue"]
    if "integerValue" in val:
        return int(val["integerValue"])
    if "doubleValue" in val:
        return float(val["doubleValue"])
    if "booleanValue" in val:
        return bool(val["booleanValue"])
    if "arrayValue" in val:
        items = val["arrayValue"].get("values", [])
        return [parse_firestore_val(v) for v in items]
    if "mapValue" in val:
        fields = val["mapValue"].get("fields", {})
        return {k: parse_firestore_val(v) for k, v in fields.items()}
    return val


def parse_firestore_doc(doc):
    if not isinstance(doc, dict):
        return {}
    fields = doc.get("fields", {})
    return {k: parse_firestore_val(v) for k, v in fields.items()}


def to_firestore_val(val):
    if isinstance(val, bool):
        return {"booleanValue": val}
    if isinstance(val, int):
        return {"integerValue": str(val)}
    if isinstance(val, float):
        return {"doubleValue": val}
    if isinstance(val, str):
        return {"stringValue": val}
    if isinstance(val, list):
        return {"arrayValue": {"values": [to_firestore_val(v) for v in val]}}
    if isinstance(val, dict):
        return {"mapValue": {"fields": {k: to_firestore_val(v) for k, v in val.items()}}}
    return {"stringValue": str(val)}


def to_firestore_fields(d):
    return {"fields": {k: to_firestore_val(v) for k, v in d.items()}}


# ==========================================
# Cryptography: AES-256-GCM Decryption
# ==========================================

def decrypt_aes_gcm(ciphertext_with_tag, key_bytes, iv_bytes, auth_tag_bytes=None):
    """
    Decrypts AES-256-GCM using python cryptography if available,
    falling back to OpenSSL CLI and PyCryptodome if necessary.
    Handles both standalone auth_tag_bytes and appended 16-byte tag.
    """
    if auth_tag_bytes and len(auth_tag_bytes) == 16:
        tag_bytes = auth_tag_bytes
        if ciphertext_with_tag.endswith(auth_tag_bytes):
            actual_cipher = ciphertext_with_tag[:-16]
        else:
            actual_cipher = ciphertext_with_tag
    else:
        if len(ciphertext_with_tag) < 16:
            raise ValueError("Ciphertext too short to contain AES-GCM 16-byte authentication tag")
        tag_bytes = ciphertext_with_tag[-16:]
        actual_cipher = ciphertext_with_tag[:-16]

    full_payload = actual_cipher + tag_bytes

    # Method 1: Try Python `cryptography` package
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        aesgcm = AESGCM(key_bytes)
        return aesgcm.decrypt(iv_bytes, full_payload, None)
    except ImportError:
        pass

    # Method 2: OpenSSL CLI fallback (present on standard Linux/macOS runners)
    try:
        key_hex = key_bytes.hex()
        iv_hex = iv_bytes.hex()
        tag_hex = tag_bytes.hex()

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
            log_warn(f"OpenSSL fallback warning: {stderr.decode(errors='ignore')}")
    except Exception as e:
        log_warn(f"OpenSSL fallback execution failed: {e}")

    # Method 3: PyCryptodome fallback
    try:
        from Cryptodome.Cipher import AES
        cipher = AES.new(key_bytes, AES.MODE_GCM, nonce=iv_bytes)
        return cipher.decrypt_and_verify(actual_cipher, tag_bytes)
    except ImportError:
        pass

    raise RuntimeError(
        "AES-256-GCM decryption requires 'cryptography'. Install via: pip install cryptography"
    )


# ==========================================
# Transport: Firestore Serverless Engine
# ==========================================

class FirestoreRelayEngine:
    def __init__(self, project_id, api_key, vault_id):
        self.project_id = project_id
        self.api_key = api_key
        self.vault_id = vault_id
        self.base_url = f"https://firestore.googleapis.com/v1/projects/{project_id}/databases/(default)/documents/vaults/{vault_id}"

    def resolve_target(self, target_path, target_sha256, password=None):
        """Attempts to match target in vault catalog doc if accessible"""
        vault_url = f"{self.base_url}?key={self.api_key}"
        try:
            doc = make_request(vault_url)
            parsed = parse_firestore_doc(doc)

            # Check password protection if present
            stored_hash = (parsed.get("passwordHash") or "").strip().lower()
            if stored_hash:
                if not password:
                    log_error(f"Vault '{self.vault_id}' is protected with a passcode. Please supply --password.")
                    sys.exit(1)
                computed_hash = hashlib.sha256(password.encode("utf-8")).hexdigest().lower()
                if computed_hash != stored_hash:
                    log_error("Incorrect vault passcode provided via --password.")
                    sys.exit(1)
                log_success("Vault passcode verified.")

            files = parsed.get("files", [])
            for f in files:
                if not isinstance(f, dict):
                    continue
                name = f.get("name", "")
                path = f.get("path", "")
                sha = f.get("sha256", "")
                if (target_path and (path == target_path or name == target_path or path.endswith("/" + target_path))) or \
                   (target_sha256 and sha.lower() == target_sha256.lower()):
                    log_info(f"Resolved from vault catalog: '{name}' (SHA-256: {sha[:12]}..., Size: {f.get('size', 0)} bytes)")
                    return sha, path or name, name or os.path.basename(path)
        except Exception as e:
            log_warn(f"Direct catalog listing unavailable ({e}). Proceeding with explicit path.")

        # Fallback to direct path/name
        filename = os.path.basename(target_path) if target_path else "downloaded_file.bin"
        return target_sha256 or "", target_path or filename, filename

    def create_request(self, target_path, filename, target_sha256, context, timeout_sec):
        """Dispatches WAITING_FOR_APPROVAL request to Firestore"""
        now_ms = int(time.time() * 1000)
        req_body = to_firestore_fields({
            "path": target_path,
            "name": filename,
            "sha256": target_sha256 or "",
            "status": "WAITING_FOR_APPROVAL",
            "supportedTransports": ["relay"],
            "requesterContext": context,
            "requesterIp": "GitHub Actions CI Runner",
            "createdAt": now_ms,
            "expiresAt": now_ms + (timeout_sec * 1000),
            "updatedAt": now_ms
        })

        url = f"{self.base_url}/requests?key={self.api_key}"
        resp = make_request(url, method="POST", data=req_body)
        doc_name = resp.get("name", "")
        req_id = doc_name.split("/")[-1]
        if not req_id:
            raise RuntimeError(f"Unexpected response creating request: {resp}")
        return req_id

    def poll_for_completion(self, req_id, timeout_sec):
        """Polls Firestore request document until approved and uploaded"""
        req_url = f"{self.base_url}/requests/{req_id}?key={self.api_key}"
        start_time = time.time()
        poll_interval = 1.5

        print(f"\n{YELLOW}{BOLD}Awaiting human authorization on mobile node...{RESET}")
        print(f"{CYAN}Open your Android phone and tap ALLOW on the LazyVault notification.{RESET}\n")

        while time.time() - start_time < timeout_sec:
            elapsed = int(time.time() - start_time)
            remaining = max(0, timeout_sec - elapsed)

            try:
                doc = make_request(req_url)
                data = parse_firestore_doc(doc)
                status = data.get("status", "WAITING_FOR_APPROVAL")

                print(
                    f"\r{CYAN}[POLL]{RESET} Elapsed: {elapsed:02d}s | Remaining TTL: {remaining:02d}s | Status: {BOLD}{status}{RESET}   ",
                    end="",
                    flush=True
                )

                if status == "REJECTED":
                    print()
                    try:
                        make_request(req_url, method="DELETE")
                    except Exception:
                        pass
                    log_error("Request was explicitly REJECTED by human operator on Android device.")
                    sys.exit(1)

                if status == "EXPIRED":
                    print()
                    try:
                        make_request(req_url, method="DELETE")
                    except Exception:
                        pass
                    log_error("Request EXPIRED (mobile notification timed out before approval).")
                    sys.exit(1)

                if status == "FAILED":
                    print()
                    try:
                        make_request(req_url, method="DELETE")
                    except Exception:
                        pass
                    log_error(f"Transfer failed on device: {data.get('error', 'Unknown error')}")
                    sys.exit(1)

                if status == "COMPLETED" or data.get("relayMetadata"):
                    print()
                    log_success("Request APPROVED! Phone encrypted and uploaded chunks to relay.")
                    return data.get("relayMetadata") or {}

            except Exception:
                # Transient read glitch
                pass

            time.sleep(poll_interval)

        # Cleanup on timeout
        try:
            make_request(req_url, method="DELETE")
        except Exception:
            pass

        print()
        log_error(f"Operation timed out after {timeout_sec}s awaiting mobile node response.")
        sys.exit(1)

    def download_chunks(self, req_id, relay_meta):
        """Downloads all encrypted chunk documents from Firestore"""
        chunk_count = relay_meta.get("chunkCount", 1)
        total_size = relay_meta.get("sizeBytes", 0)
        log_info(f"Downloading {chunk_count} encrypted chunks from Cloud Firestore (total payload: ~{total_size} bytes)...")

        ciphertext_parts = []
        for i in range(chunk_count):
            chunk_url = f"{self.base_url}/requests/{req_id}/chunks/{i}?key={self.api_key}"
            chunk_doc = make_request(chunk_url)
            parsed_chunk = parse_firestore_doc(chunk_doc)
            b64_data = parsed_chunk.get("data", "")
            if not b64_data:
                raise RuntimeError(f"Missing data in chunk document {i}")
            chunk_bytes = base64.b64decode(b64_data)
            ciphertext_parts.append(chunk_bytes)
            pct = ((i + 1) / chunk_count) * 100
            print(f"\r{CYAN}[CHUNK]{RESET} Retrieved chunk {i + 1}/{chunk_count} ({pct:.0f}%)", end="", flush=True)

        print()
        return b"".join(ciphertext_parts)

    def cleanup(self, req_id, chunk_count):
        """Deletes ephemeral request and chunk documents from Firestore"""
        for i in range(chunk_count):
            try:
                chunk_url = f"{self.base_url}/requests/{req_id}/chunks/{i}?key={self.api_key}"
                make_request(chunk_url, method="DELETE")
            except Exception:
                pass
        try:
            req_url = f"{self.base_url}/requests/{req_id}?key={self.api_key}"
            make_request(req_url, method="DELETE")
        except Exception:
            pass


# ==========================================
# Transport: REST Broker Engine
# ==========================================

class RestBrokerEngine:
    def __init__(self, backend_url):
        self.backend_url = backend_url.rstrip("/")

    def resolve_target(self, target_path, target_sha256, vault_id=None, password=None):
        """Attempts to match target against REST broker catalog"""
        # If vault_id is given, try authenticated vault catalog retrieval
        if vault_id:
            try:
                auth_resp = make_request(
                    f"{self.backend_url}/api/v1/vault/{vault_id}/auth",
                    method="POST",
                    data={"password": password or ""}
                )
                if isinstance(auth_resp, dict) and auth_resp.get("catalog"):
                    cat = auth_resp.get("catalog")
                    files = cat.get("files", []) if isinstance(cat, dict) else []
                    for f in files:
                        name = f.get("name", "")
                        path = f.get("path", "")
                        sha = f.get("sha256", "")
                        if (target_path and (path == target_path or name == target_path or path.endswith("/" + target_path))) or \
                           (target_sha256 and sha.lower() == target_sha256.lower()):
                            log_info(f"Resolved from authenticated vault catalog: '{name}' (SHA-256: {sha[:12]}..., Size: {f.get('size', 0)} bytes)")
                            return sha, path or name, name or os.path.basename(path)
            except RuntimeError as e:
                if "401" in str(e):
                    log_error(f"Incorrect vault passcode for vault '{vault_id}'. Specify valid passcode via --password.")
                    sys.exit(1)
                elif "410" in str(e):
                    log_error(f"Vault '{vault_id}' share link has expired.")
                    sys.exit(1)
                else:
                    log_warn(f"Vault catalog lookup note: {e}")

        # Fallback to general broker catalog
        try:
            cat = make_request(f"{self.backend_url}/api/v1/catalog")
            files = cat.get("files", []) if isinstance(cat, dict) else []
            for f in files:
                name = f.get("name", "")
                path = f.get("path", "")
                sha = f.get("sha256", "")
                if (target_path and (path == target_path or name == target_path or path.endswith("/" + target_path))) or \
                   (target_sha256 and sha.lower() == target_sha256.lower()):
                    log_info(f"Resolved from broker catalog: '{name}' (SHA-256: {sha[:12]}..., Size: {f.get('size', 0)} bytes)")
                    return sha, path or name, name or os.path.basename(path)
        except Exception as e:
            log_warn(f"Catalog query failed or empty ({e}). Proceeding with explicit path/hash.")

        filename = os.path.basename(target_path) if target_path else "downloaded_file.bin"
        return target_sha256 or "", target_path or filename, filename

    def create_request(self, target_path, filename, target_sha256, context, timeout_sec, vault_id=None, password=None):
        payload = {
            "target_sha256": target_sha256 or "",
            "path": target_path,
            "requester_context": context,
            "supported_transports": ["relay"],
        }
        if vault_id:
            payload["vault_id"] = vault_id
        if password:
            payload["password"] = password

        url = f"{self.backend_url}/api/v1/request-file"
        resp = make_request(url, method="POST", data=payload)
        req_id = resp.get("request_id") or resp.get("requestId")
        if not req_id:
            raise RuntimeError(f"Broker returned unexpected response creating request: {resp}")
        return req_id

    def poll_for_completion(self, req_id, timeout_sec):
        poll_url = f"{self.backend_url}/api/v1/request-file/{req_id}"
        start_time = time.time()
        poll_interval = 1.0

        print(f"\n{YELLOW}{BOLD}Awaiting human authorization on mobile node...{RESET}")
        print(f"{CYAN}Open your Android phone and tap ALLOW on the LazyVault notification.{RESET}\n")

        while time.time() - start_time < timeout_sec:
            elapsed = int(time.time() - start_time)
            remaining = max(0, timeout_sec - elapsed)

            try:
                data = make_request(poll_url)
                status = data.get("status", "WAITING_FOR_APPROVAL")

                print(
                    f"\r{CYAN}[POLL]{RESET} Elapsed: {elapsed:02d}s | Remaining TTL: {remaining:02d}s | Status: {BOLD}{status}{RESET}   ",
                    end="",
                    flush=True
                )

                if status == "REJECTED":
                    print()
                    log_error("Request was explicitly REJECTED by human operator on Android device.")
                    sys.exit(1)

                if status == "EXPIRED":
                    print()
                    log_error("Request EXPIRED (mobile notification timed out before approval).")
                    sys.exit(1)

                if status == "FAILED":
                    print()
                    log_error(f"Transfer failed on device: {data.get('error', 'Unknown error')}")
                    sys.exit(1)

                if status == "COMPLETED" or data.get("relay_metadata") or data.get("relayMetadata"):
                    print()
                    log_success("Request APPROVED! Phone encrypted and uploaded blob to relay.")
                    return data.get("relay_metadata") or data.get("relayMetadata") or {}

            except Exception:
                pass

            time.sleep(poll_interval)

        print()
        log_error(f"Operation timed out after {timeout_sec}s awaiting mobile node response.")
        sys.exit(1)

    def download_ciphertext(self, req_id, relay_meta):
        download_url = relay_meta.get("downloadUrl") or f"{self.backend_url}/api/v1/relay/download/{req_id}"
        log_info(f"Downloading encrypted ciphertext from: {download_url}")
        content = make_request(download_url)
        if isinstance(content, str):
            content = content.encode("utf-8")
        return content


# ==========================================
# Main CLI Entry Point
# ==========================================

def extract_vault_id(args):
    """Extracts vault ID from --vault-id or from a full URL"""
    if args.vault_id:
        return args.vault_id.strip()

    candidate = args.backend_url or ""
    if "/v/" in candidate:
        return candidate.split("/v/")[1].split("/")[0].split("?")[0].strip()
    if "v=" in candidate:
        import urllib.parse
        parsed = urllib.parse.urlparse(candidate)
        qs = urllib.parse.parse_qs(parsed.query)
        if "v" in qs:
            return qs["v"][0].strip()

    if candidate.startswith("vlt_"):
        return candidate.strip()

    return None


def main():
    parser = argparse.ArgumentParser(
        description="LazyVault CI/CD Client: Securely pull lazy storage blobs from Android mobile node."
    )
    parser.add_argument(
        "--vault-id",
        default=os.environ.get("LAZYVAULT_ID", ""),
        help="LazyVault Vault ID (e.g., vlt_95bed4ef8c)",
    )
    parser.add_argument(
        "--backend-url",
        default=os.environ.get("LAZYVAULT_BACKEND_URL", "https://lazyvault.web.app"),
        help="LazyVault URL or Broker (e.g. https://lazyvault.web.app/v/<vaultId> or http://localhost:4000)",
    )
    parser.add_argument(
        "--path",
        help="Target file name or path in LazyVault (e.g., img.jpg or /storage/vault/img.jpg)",
    )
    parser.add_argument(
        "--file-hash",
        help="Target SHA-256 file hash (optional)",
    )
    parser.add_argument(
        "--output",
        "-o",
        help="Destination file path for decrypted plaintext",
    )
    parser.add_argument(
        "--password",
        default=os.environ.get("LAZYVAULT_PASSWORD", ""),
        help="Passcode for password-protected vaults",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=60,
        help="Human approval timeout in seconds (default: 60)",
    )
    parser.add_argument(
        "--context",
        default=os.environ.get("GITHUB_RUN_ID", "GitHub Actions CI Runner"),
        help="Context displayed in mobile push authorization prompt",
    )
    parser.add_argument(
        "--project-id",
        default=os.environ.get("LAZYVAULT_PROJECT_ID", DEFAULT_PROJECT_ID),
        help=f"Firebase project ID (default: {DEFAULT_PROJECT_ID})",
    )
    parser.add_argument(
        "--api-key",
        default=os.environ.get("LAZYVAULT_API_KEY", DEFAULT_API_KEY),
        help="Firebase Web API Key",
    )

    args = parser.parse_args()

    if not args.path and not args.file_hash:
        log_error("Either --path or --file-hash is required.")
        parser.print_help()
        sys.exit(1)

    vault_id = extract_vault_id(args)
    backend_url = args.backend_url.rstrip("/")

    is_firestore = (
        ("lazyvault.web.app" in backend_url or "firebase" in backend_url or "firestore.googleapis.com" in backend_url)
        or (vault_id and not (backend_url.startswith("http://localhost") or backend_url.startswith("http://127.0.0.1")))
    )

    # 1. Firestore Serverless Transport
    if is_firestore:
        if not vault_id:
            log_error("Missing Vault ID. Specify via --vault-id (e.g., --vault-id vlt_95bed4ef8c) or full URL (--backend-url https://lazyvault.web.app/v/vlt_95bed4ef8c).")
            sys.exit(1)

        log_info(f"Target Vault: {BOLD}{vault_id}{RESET}")
        engine = FirestoreRelayEngine(args.project_id, args.api_key, vault_id)

        # Resolve Target File
        expected_sha256, target_path, filename = engine.resolve_target(args.path, args.file_hash, password=args.password)
        output_path = args.output or filename or "downloaded_file.bin"

        log_info(f"Requesting file: '{target_path}'")
        if expected_sha256:
            log_info(f"Expected SHA-256: {expected_sha256}")
        log_info(f"Requester Context: {args.context}")

        # Dispatch Request
        log_info("Submitting lease request to Cloud Firestore...")
        req_id = engine.create_request(target_path, filename, expected_sha256, args.context, args.timeout)
        log_info(f"Request created! Request ID: {BOLD}{req_id}{RESET}")

        # Poll for Approval
        relay_meta = engine.poll_for_completion(req_id, args.timeout)

        # Download Encrypted Chunks
        ciphertext = engine.download_chunks(req_id, relay_meta)

        # Cleanup Firestore request
        chunk_count = relay_meta.get("chunkCount", 1)
        engine.cleanup(req_id, chunk_count)

        # Decrypt
        log_info("Decrypting stream with ephemeral AES-256-GCM symmetric key...")
        key = base64.b64decode(relay_meta["encryptionKeyB64"])
        iv = base64.b64decode(relay_meta["ivB64"])
        auth_tag = base64.b64decode(relay_meta["authTagB64"]) if relay_meta.get("authTagB64") else None
        plaintext = decrypt_aes_gcm(ciphertext, key, iv, auth_tag)

        # Validate Integrity
        computed_sha256 = hashlib.sha256(plaintext).hexdigest().lower()
        target_verify_sha = expected_sha256 or relay_meta.get("sha256", "")
        if target_verify_sha and computed_sha256 != target_verify_sha.lower():
            raise ValueError(
                f"Integrity check failed! Expected SHA-256: {target_verify_sha}, Computed: {computed_sha256}"
            )

        # Save Plaintext
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        with open(output_path, "wb") as f:
            f.write(plaintext)

        log_success(f"Verified & saved to {output_path} ({len(plaintext)} bytes, SHA-256: {computed_sha256[:12]}...)")
        sys.exit(0)

    # 2. REST Broker Transport
    else:
        log_info(f"Connecting to LazyVault REST broker at {BOLD}{backend_url}{RESET}...")
        engine = RestBrokerEngine(backend_url)

        # Resolve Target File
        expected_sha256, target_path, filename = engine.resolve_target(
            args.path,
            args.file_hash,
            vault_id=vault_id,
            password=args.password
        )
        output_path = args.output or filename or "downloaded_file.bin"

        log_info(f"Requesting file: '{target_path}'")
        if expected_sha256:
            log_info(f"Expected SHA-256: {expected_sha256}")
        log_info(f"Requester Context: {args.context}")

        # Dispatch Request
        log_info("Submitting lease request to REST broker...")
        req_id = engine.create_request(
            target_path,
            filename,
            expected_sha256,
            args.context,
            args.timeout,
            vault_id=vault_id,
            password=args.password
        )
        log_info(f"Request created! Request ID: {BOLD}{req_id}{RESET}")

        # Poll for Approval
        relay_meta = engine.poll_for_completion(req_id, args.timeout)

        # Download Encrypted Blob
        ciphertext = engine.download_ciphertext(req_id, relay_meta)

        # Decrypt
        log_info("Decrypting stream with ephemeral AES-256-GCM symmetric key...")
        key = base64.b64decode(relay_meta["encryptionKeyB64"])
        iv = base64.b64decode(relay_meta["ivB64"])
        auth_tag = base64.b64decode(relay_meta["authTagB64"]) if relay_meta.get("authTagB64") else None
        plaintext = decrypt_aes_gcm(ciphertext, key, iv, auth_tag)

        # Validate Integrity
        computed_sha256 = hashlib.sha256(plaintext).hexdigest().lower()
        target_verify_sha = expected_sha256 or relay_meta.get("originalSha256", "") or relay_meta.get("sha256", "")
        if target_verify_sha and computed_sha256 != target_verify_sha.lower():
            raise ValueError(
                f"Integrity check failed! Expected SHA-256: {target_verify_sha}, Computed: {computed_sha256}"
            )

        # Save Plaintext
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        with open(output_path, "wb") as f:
            f.write(plaintext)

        log_success(f"Verified & saved to {output_path} ({len(plaintext)} bytes, SHA-256: {computed_sha256[:12]}...)")
        sys.exit(0)


if __name__ == "__main__":
    main()
