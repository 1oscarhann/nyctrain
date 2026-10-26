import 'maplibre-gl/dist/maplibre-gl.css';
import '@fontsource/overpass/400.css';
import '@fontsource/overpass/600.css';
import '@fontsource/overpass/700.css';
import '@fontsource/overpass/800.css';
// London style (data-theme="tfl"): Cabin, a humanist sans in the Johnston/Gill tradition (SIL OFL).
import '@fontsource/cabin/400.css';
import '@fontsource/cabin/600.css';
import '@fontsource/cabin/700.css';
// Title screen: a tall condensed display face (Big Shoulders) and a monospace (Overpass Mono), both SIL OFL.
import '@fontsource/big-shoulders-display/800';
import '@fontsource/big-shoulders-display/900';
import '@fontsource/overpass-mono/400';
import '@fontsource/overpass-mono/600';
import './ui/styles.css';
import { bootstrap } from './ui/boot';

bootstrap(document.getElementById('app')!).catch((err) => {
  console.error(err);
  let el = document.getElementById('loading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loading';
    document.getElementById('app')!.append(el);
  }
  el.textContent = 'Failed to start: ' + (err as Error).message;
});
