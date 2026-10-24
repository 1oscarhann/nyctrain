/**
 * Hubs (intertown): stations a new game starts with, built and free. The South East begins with a
 * terminal at Victoria and a short stub of track the player extends (CITY_BALANCE[city].hubs).
 */
import { cityBalance } from '../cities';
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
