/**
 * relief.bin — the lie of the land (Japan): the mean slope and elevation of every 1 km square of
 * Japan's standard grid (third-order mesh, 45″ of longitude × 30″ of latitude), from MLIT's
 * 標高・傾斜度3次メッシュ (scripts/build-data-japan.ts). Mountains make surface track dear (cuttings,
 * embankments, tall viaducts), so the high-speed lines tunnel through them as the real ones do.
 *
 *   bytes 0..3    magic "HWRL"
 *   bytes 4..7    uint32 version (1)
 *   bytes 8..15   uint32 cols, rows
 *   bytes 16..47  float64 lon0, lat0 (south-west corner), dLon, dLat (cell size, degrees)
 *   then a raw-deflate stream: cols·rows slope bytes, then cols·rows elevation bytes, row-major
 *   from the south-west.
 * Slope byte: 0 = no data (sea), else 1 + mean slope in degrees × 8. Elevation byte: mean metres ÷ 16.
 */

export const RELIEF_GRID = { lon0: 128, lat0: 30, dLon: 1 / 80, dLat: 1 / 120, cols: 1480, rows: 1920 };

const MAGIC = 0x4c525748; // "HWRL" little-endian
const HEADER = 48;

export function encodeRelief(slope: Uint8Array, elev: Uint8Array, deflateRaw: (b: Uint8Array) => Uint8Array): Uint8Array {
  const g = RELIEF_GRID;
  const n = g.cols * g.rows;
  if (slope.length !== n || elev.length !== n) throw new Error('relief: wrong grid size');
  const body = new Uint8Array(2 * n);
  body.set(slope, 0);
  body.set(elev, n);
  const z = deflateRaw(body);
  const out = new Uint8Array(HEADER + z.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, g.cols, true);
  dv.setUint32(12, g.rows, true);
  dv.setFloat64(16, g.lon0, true);
  dv.setFloat64(24, g.lat0, true);
  dv.setFloat64(32, g.dLon, true);
  dv.setFloat64(40, g.dLat, true);
  out.set(z, HEADER);
  return out;
}

/** Decoded relief grid: lookups by lon/lat. */
export class Relief {
  constructor(
    readonly cols: number,
    readonly rows: number,
    readonly lon0: number,
    readonly lat0: number,
    readonly dLon: number,
    readonly dLat: number,
    /** Slope bytes then elevation bytes (see the file format). */
    readonly data: Uint8Array,
  ) {}

  private index(lon: number, lat: number): number {
    const c = Math.floor((lon - this.lon0) / this.dLon), r = Math.floor((lat - this.lat0) / this.dLat);
    return c < 0 || r < 0 || c >= this.cols || r >= this.rows ? -1 : r * this.cols + c;
  }

  /** Mean slope of the square, degrees (0 at sea or off the grid). */
  slopeAt(lon: number, lat: number): number {
    const i = this.index(lon, lat);
    const b = i < 0 ? 0 : this.data[i];
    return b ? (b - 1) / 8 : 0;
  }

  /** Mean elevation of the square, metres. */
  elevationAt(lon: number, lat: number): number {
    const i = this.index(lon, lat);
    return i < 0 ? 0 : this.data[this.cols * this.rows + i] * 16;
  }
}

function header(buffer: ArrayBuffer): { dv: DataView; cols: number; rows: number } {
  const dv = new DataView(buffer);
  if (buffer.byteLength < HEADER || dv.getUint32(0, true) !== MAGIC) throw new Error('relief.bin: bad magic');
  if (dv.getUint32(4, true) !== 1) throw new Error('relief.bin: unsupported version');
  const cols = dv.getUint32(8, true), rows = dv.getUint32(12, true);
  if (!cols || !rows || cols * rows > 8e6) throw new Error('relief.bin: bad size');
  return { dv, cols, rows };
}

function build(h: { dv: DataView; cols: number; rows: number }, data: Uint8Array): Relief {
  if (data.length !== 2 * h.cols * h.rows) throw new Error('relief.bin: truncated');
  const dv = h.dv;
  return new Relief(h.cols, h.rows, dv.getFloat64(16, true), dv.getFloat64(24, true), dv.getFloat64(32, true), dv.getFloat64(40, true), data);
}

/** Browser and worker: inflate with DecompressionStream. */
export async function decodeRelief(buffer: ArrayBuffer): Promise<Relief> {
  const h = header(buffer);
  const stream = new Blob([new Uint8Array(buffer, HEADER)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return build(h, new Uint8Array(await new Response(stream).arrayBuffer()));
}

/** Node (tests and scripts): inflate with zlib's inflateRawSync. */
export function decodeReliefSync(buffer: ArrayBuffer, inflateRaw: (b: Uint8Array) => Uint8Array): Relief {
  const h = header(buffer);
  return build(h, new Uint8Array(inflateRaw(new Uint8Array(buffer, HEADER))));
}
