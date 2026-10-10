import type { LandMask } from '../data/landMask';
import type { TractIndex } from '../data/world';
import type { Terrain } from './validate';

/** Terrain backed by the raster land mask and nearest-tract density. */
export class WorldTerrain implements Terrain {
  constructor(private mask: LandMask, private tracts: TractIndex) {}
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
