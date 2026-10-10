/**
 * od.bin — compact origin–destination table.
 *
 *   bytes 0..3   magic "HWOD"
 *   bytes 4..7   uint32 version (1)
 *   bytes 8..11  uint32 tract count
 *   bytes 12..15 uint32 pair count (n)
 *   then, little-endian Uint16 arrays of length n, back to back:
 *     home tract index, work tract index, SE01 count, SE02 count, SE03 count
 * Pairs are sorted by home then work. Counts above 65,535 are clamped (none occur in practice).
 */

export const OD_BANDS = ['SE01 ≤$1,250/mo', 'SE02 $1,251–3,333/mo', 'SE03 >$3,333/mo'];

export interface ODTable {
  tractCount: number;
  pairCount: number;
  home: Uint16Array;
  work: Uint16Array;
  /** counts[b] for earnings band b = 0, 1, 2 */
  counts: [Uint16Array, Uint16Array, Uint16Array];
}

const MAGIC = 0x444f5748; // "HWOD" little-endian

export function encodeOD(
  tractCount: number,
  rows: { h: number; w: number; se: [number, number, number] }[],
): Uint8Array {
  const n = rows.length;
  const buf = new ArrayBuffer(16 + n * 2 * 5);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, tractCount, true);
  dv.setUint32(12, n, true);
  const arrs = [0, 1, 2, 3, 4].map((k) => new Uint16Array(buf, 16 + k * n * 2, n));
  rows.forEach((r, i) => {
    arrs[0][i] = r.h;
    arrs[1][i] = r.w;
    arrs[2][i] = Math.min(65535, r.se[0]);
    arrs[3][i] = Math.min(65535, r.se[1]);
    arrs[4][i] = Math.min(65535, r.se[2]);
  });
  return new Uint8Array(buf);
}

export function decodeOD(buffer: ArrayBuffer): ODTable {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('od.bin: bad magic');
  const version = dv.getUint32(4, true);
  if (version !== 1) throw new Error('od.bin: unsupported version ' + version);
  const tractCount = dv.getUint32(8, true);
  const n = dv.getUint32(12, true);
  // Copy so the arrays are 2-byte aligned regardless of the source buffer offset.
  const arr = (k: number) => new Uint16Array(buffer.slice(16 + k * n * 2, 16 + (k + 1) * n * 2));
  return { tractCount, pairCount: n, home: arr(0), work: arr(1), counts: [arr(2), arr(3), arr(4)] };
}
