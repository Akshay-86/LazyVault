import urllib.request
import urllib.parse
import json
import time
import hashlib
import sys

BASE_URL = "http://localhost:4000"
VAULT_ID = "vlt_e2e_test"
PASSWORD = "secret_password_123"
DEVICE_ID = "android_node_01"

print("=" * 60)
print("LazyVault End-to-End Automated Integration Verification")
print("=" * 60)

def post_json(path, data):
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

def get_json(path):
    url = f"{BASE_URL}{path}"
    with urllib.request.urlopen(url) as resp:
        return json.loads(resp.read().decode("utf-8"))

# 1. Device Registration
print("[1] Registering Android node...")
reg = post_json("/api/v1/device/register", {
    "deviceId": DEVICE_ID,
    "deviceName": "Google Pixel 8 Pro Node",
    "fcmToken": "mock_fcm_token_12345",
    "appVersion": "1.0.0"
})
assert reg.get("success") is True, "Device registration failed"
print("    ✓ Device registered successfully")

# 2. Sync Catalog
sample_content = b"%PDF-1.7\nLazyVault Confidential Financial Audit Report 2026\nZero-Trust Dormant Edge Node\n"
sample_sha = hashlib.sha256(sample_content).hexdigest()

catalog_data = {
    "generation": int(time.time()),
    "rootMerkle": sample_sha,
    "deviceId": DEVICE_ID,
    "files": [
        {
            "path": "/storage/vault/financial_report_2026.pdf",
            "size": len(sample_content),
            "sha256": sample_sha,
            "mtime": int(time.time() * 1000)
        }
    ]
}

print("[2] Syncing Catalog and Vault Share Link...")
v_sync = post_json("/api/v1/vault/sync", {
    "vaultId": VAULT_ID,
    "deviceId": DEVICE_ID,
    "password": PASSWORD,
    "expiresInSeconds": 86400,
    "catalog": catalog_data
})
assert v_sync.get("success") is True, "Vault sync failed"
print(f"    ✓ Vault link created: {v_sync.get('shareUrl')}")

# 3. Password Gate Verification
print("[3] Testing Password Gate Authentication...")
auth_resp = post_json(f"/api/v1/vault/{VAULT_ID}/auth", {
    "password": PASSWORD
})
assert auth_resp.get("success") is True
assert len(auth_resp["catalog"]["files"]) == 1
print("    ✓ Password verified; catalog unlocked!")

# 4. Initiate On-Demand Transfer Lease
print("[4] Initiating On-Demand File Lease...")
lease_resp = post_json("/api/v1/request-file", {
    "path": "/storage/vault/financial_report_2026.pdf",
    "sha256": sample_sha,
    "vaultId": VAULT_ID,
    "supportedTransports": ["relay"]
})
req_id = lease_resp["requestId"]
assert lease_resp["status"] == "PENDING"
print(f"    ✓ Lease created: {req_id} (TTL: {lease_resp['leaseTtlSeconds']}s)")

# 5. Mobile Node Decision: User taps [ALLOW]
print("[5] Simulating user tapping [ALLOW] on Android phone...")
dec_resp = post_json(f"/api/v1/request-file/{req_id}/decision", {
    "decision": "ALLOW",
    "selected_transport": "relay"
})
assert dec_resp["status"] == "APPROVED"
print("    ✓ Decision recorded: APPROVED")

# 6. Mobile Node uploads encrypted stream to relay
print("[6] Mobile node streaming bytes to relay...")
upload_url = f"{BASE_URL}/api/v1/relay/{req_id}/upload"
up_req = urllib.request.Request(
    upload_url,
    data=sample_content,
    headers={"Content-Type": "application/octet-stream"}
)
up_req.get_method = lambda: "PUT"
with urllib.request.urlopen(up_req) as resp:
    up_data = json.loads(resp.read().decode("utf-8"))
    assert up_data.get("success") is True
print("    ✓ Upload complete")

# 7. Mobile marks relay complete
post_json(f"/api/v1/relay-complete/{req_id}", {
    "ephemeral_key": "mock_key",
    "iv": "mock_iv",
    "tag": "mock_tag",
    "size_bytes": len(sample_content)
})

# 8. Web Client downloads bytes & verifies SHA-256
print("[7] Client downloading from relay and verifying SHA-256...")
download_url = f"{BASE_URL}/api/v1/relay/{req_id}/download"
with urllib.request.urlopen(download_url) as resp:
    downloaded_bytes = resp.read()

downloaded_sha = hashlib.sha256(downloaded_bytes).hexdigest()
assert downloaded_sha == sample_sha, f"SHA mismatch! {downloaded_sha} != {sample_sha}"
assert downloaded_bytes == sample_content, "Content mismatch!"
print(f"    ✓ 100% BYTE-FOR-BYTE MATCH! SHA-256: {downloaded_sha}")

print("=" * 60)
print("ALL PIPELINE VERIFICATIONS PASSED SUCCESSFULLY! (100% OK)")
print("=" * 60)
