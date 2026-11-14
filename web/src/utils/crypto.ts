/**
 * Cryptographic utility for LazyVault Web Client
 * Provides SHA-256 hashing with hardware acceleration via Web Crypto Subtle API,
 * and an RFC 6234 compliant streaming pure-TypeScript fallback for non-secure HTTP contexts.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class StreamingSha256 {
  private h0 = 0x6a09e667;
  private h1 = 0xbb67ae85;
  private h2 = 0x3c6ef372;
  private h3 = 0xa54ff53a;
  private h4 = 0x510e527f;
  private h5 = 0x9b05688c;
  private h6 = 0x1f83d9ab;
  private h7 = 0x5be0cd19;

  private buffer = new Uint8Array(64);
  private bufferLength = 0;
  private totalBytes = 0;
  private w = new Uint32Array(64);

  public update(chunk: ArrayBuffer | Uint8Array): void {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    let offset = 0;
    const len = bytes.length;
    this.totalBytes += len;

    if (this.bufferLength > 0) {
      const needed = 64 - this.bufferLength;
      if (len >= needed) {
        this.buffer.set(bytes.subarray(0, needed), this.bufferLength);
        this.processBlock(this.buffer, 0);
        this.bufferLength = 0;
        offset = needed;
      } else {
        this.buffer.set(bytes, this.bufferLength);
        this.bufferLength += len;
        return;
      }
    }

    while (offset + 64 <= len) {
      this.processBlock(bytes, offset);
      offset += 64;
    }

    if (offset < len) {
      const remaining = bytes.subarray(offset);
      this.buffer.set(remaining, 0);
      this.bufferLength = remaining.length;
    }
  }

  private processBlock(data: Uint8Array, offset: number): void {
    const view = new DataView(data.buffer, data.byteOffset + offset, 64);
    for (let i = 0; i < 16; i++) {
      this.w[i] = view.getUint32(i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = this.w[i - 15];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const w2 = this.w[i - 2];
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      this.w[i] = (this.w[i - 16] + s0 + this.w[i - 7] + s1) | 0;
    }

    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;
    let f = this.h5;
    let g = this.h6;
    let h = this.h7;

    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[i] + this.w[i]) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    this.h0 = (this.h0 + a) | 0;
    this.h1 = (this.h1 + b) | 0;
    this.h2 = (this.h2 + c) | 0;
    this.h3 = (this.h3 + d) | 0;
    this.h4 = (this.h4 + e) | 0;
    this.h5 = (this.h5 + f) | 0;
    this.h6 = (this.h6 + g) | 0;
    this.h7 = (this.h7 + h) | 0;
  }

  public digest(): string {
    const totalBits = this.totalBytes * 8;
    // Padding: 0x80 byte, then zeroes, then 64-bit length
    const padLen = this.bufferLength < 56 ? 56 - this.bufferLength : 120 - this.bufferLength;
    const padding = new Uint8Array(padLen + 8);
    padding[0] = 0x80;

    const padView = new DataView(padding.buffer, padding.byteOffset, padding.byteLength);
    // Write 64-bit big-endian length in bits
    padView.setUint32(padLen, Math.floor(totalBits / 0x100000000), false);
    padView.setUint32(padLen + 4, totalBits >>> 0, false);

    this.update(padding);

    const result = [
      (this.h0 >>> 0).toString(16).padStart(8, '0'),
      (this.h1 >>> 0).toString(16).padStart(8, '0'),
      (this.h2 >>> 0).toString(16).padStart(8, '0'),
      (this.h3 >>> 0).toString(16).padStart(8, '0'),
      (this.h4 >>> 0).toString(16).padStart(8, '0'),
      (this.h5 >>> 0).toString(16).padStart(8, '0'),
      (this.h6 >>> 0).toString(16).padStart(8, '0'),
      (this.h7 >>> 0).toString(16).padStart(8, '0'),
    ].join('');

    return result.toLowerCase();
  }
}

/**
 * Compute SHA-256 for a buffer (using Web Crypto Subtle if available, else StreamingSha256)
 */
export async function computeSha256(data: ArrayBuffer | Uint8Array): Promise<string> {
  if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
    try {
      const buffer = (data instanceof Uint8Array ? data : new Uint8Array(data)) as unknown as BufferSource;
      const hashBuffer = await window.crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .toLowerCase();
    } catch {
      // Fallback to pure TS
    }
  }

  const hasher = new StreamingSha256();
  hasher.update(data);
  return hasher.digest();
}

/**
 * Hash UTF-8 string to SHA-256 hex string
 */
export async function hashStringSha256(str: string): Promise<string> {
  const encoder = new TextEncoder();
  return computeSha256(encoder.encode(str));
}
