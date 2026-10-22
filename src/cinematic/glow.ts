/**
 * Night glow for deck.gl layers (docs/v2/cinematic.md §1): additive blending, drawn over the map
 * like the layers they halo. A layer's `opacity` prop carries the night factor, so a change is a
 * uniform (no attribute rebuild); at 0 the layers are left out.
 */

/** Additive blending, depth ignored (as every overlay layer here). */
export const ADDITIVE = {
  depthCompare: 'always',
  depthWriteEnabled: false,
  blend: true,
  blendColorOperation: 'add',
  blendColorSrcFactor: 'src-alpha',
  blendColorDstFactor: 'one',
  blendAlphaOperation: 'add',
  blendAlphaSrcFactor: 'one',
  blendAlphaDstFactor: 'one-minus-src-alpha',
} as const;

/** Glow halos of express trains: white, so an express sliding past a local still reads at night. */
export const EXPRESS_GLOW: [number, number, number, number] = [235, 242, 255, 150];
/** Station glow: warm platform light. */
export const STATION_GLOW: [number, number, number, number] = [255, 226, 170, 255];
/** Today's event venues: stadium floodlights (lavender-white). */
export const VENUE_GLOW: [number, number, number, number] = [232, 214, 255, 255];

/** Night factor below which the glow layers are not drawn at all. */
export const GLOW_MIN = 0.02;
