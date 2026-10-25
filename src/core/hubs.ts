/**
 * Hubs (intertown): stations a new game starts with, built and free. The South East begins with a
 * terminal at Victoria and a short stub of track the player extends (CITY_BALANCE[city].hubs).
 */
import { city, cityBalance } from '../cities';
import { AIRPORTS } from '../cities/destinations';
import { STATION } from '../balance';
import { platformLength } from '../construction/network';
import { toLocal } from './geo';
import type { Game } from './game';

export function placeHubs(game: Game): void {
  const hubs = cityBalance().hubs;
  if (!hubs?.length) return;
  const net = game.network;
  for (const hub of hubs) {
    const [ax, ay] = toLocal(hub.from[0], hub.from[1]);
    const [bx, by] = toLocal(hub.to[0], hub.to[1]);
    const edges = net.addStroke(
      [
        { x: ax, y: ay, level: hub.level },
        { x: bx, y: by, level: hub.level },
      ],
      hub.cls,
      { kind: 'none' },
      { kind: 'none' },
    );
    if (!edges.length) continue;
    const st = net.addStation(edges[0], hub.at, hub.cars, hub.name, 'built');
    st.nameAuto = false;
    st.cost = 0;
    for (const id of edges) {
      const e = net.edges.get(id)!;
      e.status = 'built';
      e.cost = 0;
    }
  }
  net.touch();
  game.history.clear();
  game.afterNetworkChange();
}

/**
 * Airports start with a built, free station (a stub of track with the platform in the middle):
 * the terminal is there, waiting for a line. Platforms are long enough for the city's main trains.
 */
export function placeAirportStations(game: Game): void {
  const net = game.network;
  const cars = city().intertown ? 12 : STATION.cars.heavy.default;
  let placed = 0;
  for (const ap of AIRPORTS[city().id] ?? []) {
    const s = ap.stub;
    if (!s) continue;
    const [ax, ay] = toLocal(s.a[0], s.a[1]);
    const [bx, by] = toLocal(s.b[0], s.b[1]);
    const edges = net.addStroke([{ x: ax, y: ay, level: s.level }, { x: bx, y: by, level: s.level }], 'heavy', { kind: 'none' }, { kind: 'none' });
    if (!edges.length) continue;
    const L = net.geom(edges[0]).length;
    if (L < platformLength(cars, 'heavy') + 40) continue;
    const st = net.addStation(edges[0], L / 2, cars, s.station, 'built');
    st.nameAuto = false;
    st.cost = 0;
    for (const id of edges) {
      const e = net.edges.get(id)!;
      e.status = 'built';
      e.cost = 0;
    }
    placed++;
  }
  if (!placed) return;
  net.touch();
  game.history.clear();
  game.afterNetworkChange();
}
