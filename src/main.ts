import 'maplibre-gl/dist/maplibre-gl.css';
import '@fontsource/overpass/400.css';
import '@fontsource/overpass/600.css';
import '@fontsource/overpass/700.css';
import '@fontsource/overpass/800.css';
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
