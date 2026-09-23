import assert from 'assert';
import http from 'http';
import { app, server } from '../index.js';

async function testBackend() {
  console.log('--- Starting LazyVault Backend Integration Tests ---');
  const port = 4001;
  const baseUrl = `http://localhost:${port}/api/v1`;

  await new Promise<void>((resolve) => {
    server.close();
    app.listen(port, () => resolve());
  });

  try {
    // 1. Health check
    console.log('[Test 1] Health check');
    const healthRes = await fetch(`${baseUrl}/health`);
    const healthData = await healthRes.json() as any;
    assert.strictEqual(healthData.status, 'healthy');

    // 2. Sync Catalog from simulated Android device
    console.log('[Test 2] Catalog Sync');
    const testCatalog = {
      device_id: 'android-pixel-9-pro',
      root_hash: 'a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e',
      files: [
        {
          path: '/storage/emulated/0/LazyVault/dataset.tar.gz',
          name: 'dataset.tar.gz',
          size: 1048576,
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          mtime: Date.now(),
        },
        {
          path: '/storage/emulated/0/LazyVault/model_weights.bin',
          name: 'model_weights.bin',
          size: 52428800,
          sha256: '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae',
          mtime: Date.now(),
        }
      ]
    };
    const syncRes = await fetch(`${baseUrl}/catalog/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testCatalog),
    });
    assert.strictEqual(syncRes.status, 201);

    // 3. Query Catalog
    console.log('[Test 3] Query Catalog');
    const catRes = await fetch(`${baseUrl}/catalog`);
    const catData = await catRes.json() as any;
    assert.strictEqual(catData.item_count, 2);
    assert.strictEqual(catData.files[0].name, 'dataset.tar.gz');

    // 4. Create File Request
    console.log('[Test 4] Request File');
    const reqRes = await fetch(`${baseUrl}/request-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        path: '/storage/emulated/0/LazyVault/dataset.tar.gz',
        requester_context: 'Test Runner Suite',
        supported_transports: ['webrtc', 'relay'],
      }),
    });
    assert.strictEqual(reqRes.status, 202);
    const reqData = await reqRes.json() as any;
    assert.strictEqual(reqData.status, 'WAITING_FOR_APPROVAL');
    assert.strictEqual(reqData.ttl_seconds, 60);
    const requestId = reqData.request_id;

    // 5. Submit Human Decision (ALLOW)
    console.log('[Test 5] Device Decision: ALLOW');
    const allowRes = await fetch(`${baseUrl}/request-file/${requestId}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'ALLOW',
        chosen_transport: 'webrtc',
      }),
    });
    assert.strictEqual(allowRes.status, 200);
    const allowData = await allowRes.json() as any;
    assert.strictEqual(allowData.status, 'APPROVED');
    assert.strictEqual(allowData.chosen_transport, 'webrtc');

    // 6. Test WebRTC Signaling Exchange
    console.log('[Test 6] WebRTC Signaling Exchange');
    const offerRes = await fetch(`${baseUrl}/signaling/${requestId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: 'client',
        type: 'offer',
        payload: { sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1' },
      }),
    });
    assert.strictEqual(offerRes.status, 201);

    const getSignalingRes = await fetch(`${baseUrl}/signaling/${requestId}?peer=device`);
    const signalingData = await getSignalingRes.json() as any;
    assert.strictEqual(signalingData.messages.length, 1);
    assert.strictEqual(signalingData.messages[0].type, 'offer');

    // 7. Test Relay Upload and Single-Use Purge
    console.log('[Test 7] Ephemeral Relay Upload & Single-Use Zero-Trust Download');
    const ciphertext = Buffer.from('TEST_ENCRYPTED_CIPHERTEXT_BLOB_ZERO_TRUST');
    const uploadRes = await fetch(`${baseUrl}/relay/upload/${requestId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: ciphertext,
    });
    assert.strictEqual(uploadRes.status, 200);

    // Relay complete notification
    const completeRes = await fetch(`${baseUrl}/relay-complete/${requestId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        encryption_key_b64: Buffer.from('AES_KEY_32_BYTES_01234567890123').toString('base64'),
        iv_b64: Buffer.from('IV_12_BYTES!').toString('base64'),
        auth_tag_b64: Buffer.from('AUTH_TAG_16_BYTE').toString('base64'),
        file_size_bytes: ciphertext.length,
      }),
    });
    assert.strictEqual(completeRes.status, 200);

    // First download succeeds
    const downloadRes = await fetch(`${baseUrl}/relay/download/${requestId}`);
    assert.strictEqual(downloadRes.status, 200);
    const downloadedBuf = Buffer.from(await downloadRes.arrayBuffer());
    assert.strictEqual(downloadedBuf.toString(), ciphertext.toString());

    // Give a brief moment for stream close to purge the blob
    await new Promise(r => setTimeout(r, 200));

    // Second download MUST fail (single-use zero-trust policy)
    const secondDownloadRes = await fetch(`${baseUrl}/relay/download/${requestId}`);
    assert.strictEqual(secondDownloadRes.status, 404);
    console.log('[Test 7 Passed] Ephemeral blob was automatically deleted upon download consumption.');

    console.log('\n--- ALL BACKEND INTEGRATION TESTS PASSED SUCCESSFULLY! ---');
    process.exit(0);
  } catch (err) {
    console.error('Test Failed:', err);
    process.exit(1);
  }
}

testBackend();
