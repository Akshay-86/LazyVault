import { Router, Request, Response } from 'express';
import { store } from '../store.js';
import { CatalogGeneration } from '../types.js';

const router = Router();

// GET /api/v1/catalog - Returns latest indexed catalog
router.get('/', (_req: Request, res: Response) => {
  const catalog = store.getCatalog();
  if (!catalog) {
    return res.status(200).json({
      status: 'empty',
      message: 'No catalog has been synchronized yet from the dormant device.',
      root_hash: null,
      updated_at: null,
      item_count: 0,
      total_size_bytes: 0,
      files: [],
    });
  }

  return res.status(200).json({
    status: 'ok',
    device_id: catalog.deviceId,
    root_hash: catalog.rootHash,
    updated_at: catalog.timestamp,
    item_count: catalog.itemCount,
    total_size_bytes: catalog.totalSize,
    files: catalog.files,
  });
});

// POST /api/v1/catalog/sync - Android device pushes updated catalog snapshot
router.post('/sync', (req: Request, res: Response) => {
  const deviceId = req.body.device_id || req.body.deviceId;
  const rootHash = req.body.root_hash || req.body.rootMerkle;
  const files = req.body.files;

  if (!deviceId || !rootHash || !Array.isArray(files)) {
    return res.status(400).json({
      error: 'Invalid catalog payload. Required fields: device_id/deviceId, root_hash/rootMerkle, files[]',
    });
  }

  const totalSize = files.reduce((acc: number, f: any) => acc + (Number(f.size) || 0), 0);

  const generation: CatalogGeneration = {
    deviceId: deviceId,
    rootHash: rootHash,
    timestamp: Date.now(),
    itemCount: files.length,
    totalSize,
    files: files.map((f: any) => ({
      path: f.path,
      name: f.name || f.path.split('/').pop() || 'unknown',
      size: Number(f.size) || 0,
      sha256: f.sha256,
      mtime: Number(f.mtime) || Date.now(),
      mimeType: f.mime_type || f.mimeType || 'application/octet-stream',
    })),
  };

  store.setCatalog(generation);
  console.log(`[Catalog] Synchronized catalog generation from device ${deviceId} (${files.length} items, root: ${rootHash.slice(0, 12)}...)`);

  return res.status(201).json({
    status: 'success',
    item_count: generation.itemCount,
    root_hash: generation.rootHash,
    received_at: generation.timestamp,
  });
});

export default router;
