import { TRACK } from '../balance';
import { toLonLat } from '../core/geo';
import type { LandMask } from '../data/landMask';
import type { Relief } from '../data/relief';
import type { TractIndex } from '../data/world';
import type { Terrain } from './validate';

/** Terrain backed by the raster land mask, nearest-tract density and (Japan) the relief grid. */
export class WorldTerrain implements Terrain {
  readonly mountain?: (x: number, y: number) => number;
  constructor(
    private mask: LandMask,
    private tracts: TractIndex,
    readonly relief: Relief | null = null,
  ) {
    if (relief) {
      const [s0, s1] = TRACK.mountainSlope;
      this.mountain = (x, y) => {
        const [lon, lat] = toLonLat(x, y);
        return Math.max(0, Math.min(1, (relief.slopeAt(lon, lat) - s0) / (s1 - s0)));
      };
    }
  }
  isWater(x: number, y: number): boolean {
    return this.mask.isWater(x, y);
  }
  borough(x: number, y: number): number {
    return this.mask.codeAt(x, y);
  }
  density(x: number, y: number): number {
    return this.tracts.nearest(x, y)?.density ?? 0;
  }
}
