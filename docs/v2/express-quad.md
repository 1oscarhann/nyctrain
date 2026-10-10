# v2 design: express services and four-track trunks

Status: implementation-ready design for **Headway: New York v2**. No source code was changed to write it.
Code references are to the v1 tree at commit `a27dbfa` as `file:line`.

> **Short version.** A *four-track* ("quad") section is two parallel double-track edges 9 m apart,
> drawn in one stroke. The drawn line becomes the **local pair**. The tool generates the **express
> pair** as an exact parallel curve: mitred vertices and concentric fillets. Where the stroke
> attaches to ordinary track, the express pair splits off through an S-curve **turnout**. At free
> ends it gets a **scissors crossover**. Every connector is a normal `addStroke` between edge snaps,
> so the existing junction, lead, merge-lock and validation code handles it unchanged.
>
> Stations on a quad become **cross-platform pairs**: two `Station`s linked by `pair`, drawn as one
> wide capsule, with a 15 s transfer and 0.4× the transfer penalty. Route pathfinding adds a cost for
> running through platforms a route does not serve and for using connectors, so expresses stay on the
> express pair and locals stay on the local pair. The moving-block sim then lets expresses overtake
> locals with no new signalling code.
>
> I tested this premise against the **unmodified v1 sim** using a hand-built quad (scratch script, not
> committed). An express on its own pair ran A→E in **280 s**. The same express sharing the locals'
> pair took **462 s**. Mean lateness fell from 47 s to 4 s. There was one merge lock and no deadlocks,
> including at 3-minute headways on each route.

---

## 1. Goals and non-goals

### Goals
1. **Quad drawing mode** in the track tool (`Q`). One stroke lays two parallel double-track edges at
   `QUAD.spacing` = 9 m centre to centre:
   - **automatic turnouts** where the stroke attaches to existing track (fan in and fan out);
   - **automatic scissors crossovers** near free ends;
   - **continuation** of an existing quad's free end pair;
   - the same level, ramp, water, curve and cost rules applied to both pairs (they are ordinary edges).
2. **Manual scissors crossovers** anywhere on a quad (`X` in quad mode).
3. **Cross-platform stations.** A station placed on a quad creates a linked platform on each pair,
   drawn as one wide station, with a near-zero transfer walk and a reduced transfer penalty in the
   commuter model.
4. **Route pathfinding that respects the pairs.** A route pays to run through platforms it does not
   serve and to switch pairs. Expresses therefore keep to the platform-free pair and locals to theirs,
   and overtaking emerges from the existing moving block, because each edge has its own two directed
   tracks.
5. **Express routes as a first-class concept.** Each route has an `express` flag with its own bullet
   (the *express lozenge*, §2.4). The route panel shows every station along the line, served or
   skipped, with a skip/serve toggle per station, plus one-click **Express pattern** and **All stops**
   buttons. Skipped stations show on the map. Express trains get a light outline so overtakes are
   visible.
6. **Rendering.** A quad is drawn as four rails (two per pair) when it carries no routes. Each pair's
   route bundle is pushed apart in pixels, consistent with `line-offset` interlining. Trains sit on
   their pair.
7. **Stats.** Daily **overtakes** per route and **cross-platform transfers** per station.
8. Save v3 with a v2→v3 migration. Every mechanic gets Vitest coverage, including a train-sim
   overtaking test that compares against a shared-pair control.

### Non-goals (v2)
- Physical track-level interlocking: flat crossings inside a scissors and conflicting moves at fans.
  The v1 abstraction stays: an edge is a double-track line, junctions are flying, and only merges
  are locked.
- Directional running. Express and local still each have both directions; there is no "express
  northbound only in the AM peak".
- Skip-stop (A/B) patterns, timed holds at cross-platform stations, timetable recovery. Holding rules
  are still out of scope, as in v1.
- Three-track or six-track sections, and quads where the pairs run at different levels.
- Converting existing double track to a quad in place. This is listed as a **stretch** item (§15)
  because the machinery supports it.
- Map bullets with letters on the route lines. v1 has no on-map bullets, and v2 does not add them.

---

## 2. Player-facing behaviour and UI

### 2.1 Track tool: two tracks or four (`T`, then `Q`)
The track tool's **options card** (`TrackTool.options`, `src/construction/trackTool.ts:346`) gains:

```
Class    [Heavy metro] [Light metro]
Tracks   [2 tracks] [4 tracks]                    title: "Q — two or four tracks"
Express  [◀ Left] [Right ▶]   (4 tracks only)     title: "F — flip which side the express pair runs on"
Level    [Elevated] [At-grade] [Cut-and-cover] [Deep tunnel]
[⨯ Crossover]                 (4 tracks only)     title: "X — place a scissors crossover between the pairs"
hint: "Four tracks: the line you draw is the local pair; the express pair runs alongside and splits
       off where you connect to other track. Inner curves need 9 m more radius."
```

Keys, handled in `TrackTool.key` (`trackTool.ts:228`), which runs before the global shortcuts at
`app.ts:777`. `Q`, `F` and `X` are not global shortcuts.

| Key | Effect |
|---|---|
| `Q` | Toggle 2 and 4 tracks. Works mid-stroke: the preview is rebuilt from the same points. |
| `F` | Flip the express side. Works mid-stroke. |
| `X` | Toggle crossover placement (4-track mode only). `Esc` leaves it. |
| `Enter` / double-click / `Backspace` / `Esc` | As in v1. |

**Ends of a four-track stroke.** These are decided automatically from the start and end snaps:

| Snap at the end | Name | What gets built |
|---|---|---|
| Nothing (open map) | **free** | Both pairs end as free track ends, side by side, with a scissors crossover in the first straight 190 m from that end. |
| A free end of an existing quad pair whose partner end is also free | **continue** | Both pairs continue. No new connectors. The quad keeps its group, roles and side (`F` is ignored). |
| Any other node or edge (ordinary double track, a branch point) | **fan** | The drawn line is the local pair and attaches exactly like a v1 stroke. The express pair starts 150 m further on, joined by an S-curve turnout. |

**Hover tooltips** (via `ctx.tip`, in the v1 style):
- Empty map: `Click to start four-track deep tunnel · express pair on the right (F flips)`.
- Over a quad free-end pair: `<green>Click to extend the four-track section</green>`.
- Over other track: `Click to branch four tracks off here · the express pair splits off 150 m in`.

**Preview** (`TrackTool.buildPreview`, `trackTool.ts:106`). The local pair is green, the express pair
cyan `[92,200,255]`, connectors pale grey `[200,210,220]`, and anything invalid red. The tooltip:

```
Four-track · Deep tunnel · Heavy metro
Local pair        2.1 km · $0.59B
Express pair      2.1 km · $0.44B   (shared works ×0.75)
Turnouts/crossovers   3 · $0.04B
Tightest curve    1,240 m · 90 km/h   (inner pair)
Line so far       $1.07B
<red: first error, e.g. "Curve too tight: 141 m radius (heavy metro needs 150 m)" on the inner pair>
<amber: non-fatal problems, e.g. "No straight 190 m near the start for a crossover — add one with X">
Double-click or Enter to finish · F flips the express side · Q back to two tracks
```

A *fatal* problem shows in red and blocks `finish`. Examples:
- "Needs a straight, level 190 m stretch within 1.5 km of the start to split into four tracks."
- "Too short for four tracks."
- "The two four-track ends are on opposite sides."

**Crossover mode (`X`).** Hovering a quad edge previews a 150 m scissors centred on the nearest valid
position, sliding up to ±300 m along the pair like `edgeSnapNear` (`headless.ts:40`). The tooltip
reads `Scissors crossover · 150 m · $21M · trains can switch pairs in both directions`. If no
position is valid it shows the reason in red: `Crossovers need straight, level track clear of
platforms`. A click places it as one undo step.

**Dragging.** Blueprint quad vertices drag as before (`TrackTool.down` and `drag`). The **twin vertex
on the other pair follows** and stays parallel with concentric curves (§4.4). Lead nodes slide along
their anchors' axes as in v1.

### 2.2 Station tool on four tracks (`S`)
Hovering a quad edge previews **both platforms** and a single catchment circle at the midpoint.
`StationTool.move` is at `src/construction/stationTool.ts:34`. The tooltip:

```
Cross-platform station · Deep tunnel · 8 cars
Platforms      local + express
Cost           $336M  (2 platforms at 80%)
Build time     30 days
<green>Click to place</green> · Shift-click: only this pair
```

- **Shift-click** places a single platform on the hovered pair (v1 behaviour). A local-only stop is
  placed this way. Its tooltip says `Local-only stop: expresses run past on the other pair`.
- If an unpaired platform already exists on the *other* pair within 40 m, hovering offers `Click to
  add the express platform to 72 St (cross-platform)`. The new platform is aligned with the existing
  one and linked to it.
- Spacing (400 m), the curve rule, the ramp rule and the land rule apply to both platforms. The pair
  partner never counts against spacing (§4.5).

The **bulldoze tool** (`bulldozeTool.ts:37,76`) on a paired platform reads `Demolish both platforms
of 72 St · refund $67M · Shift-click: just this platform`. **Rename** in the station panel renames
both platforms.

### 2.3 Route tool and route panel (`R`)
**Route tool** (`src/routes/routeTool.ts`):
- `E` toggles the draft between **Local** and **Express**. There is also a segmented control in the
  route editor (`routeEditor`, `routePanel.ts:206`).
- Clicking a cross-platform station adds the **express platform** if the draft is an express, otherwise
  the local platform. **Alt-click** picks the other one. The tooltip reads `Click to add 72 St
  (express platform) · Alt-click: local platform`.
- Clicking a station the draft path **runs past** inserts it in path order instead of appending it.
  The tooltip reads `Click to stop at 28 St (inserted in order)`.
- The preview draws hollow amber rings on skipped stations along the draft path. The editor shows
  `Skips 5 stations`.

**Route panel** (`routePanel`, `src/ui/panels/routePanel.ts:73`):
- The header bullet is the lozenge for express routes.
- A new **Service** section: `[Local] [Express]` segmented control, plus two buttons. **Express
  pattern** replaces local platforms with their express partners and drops local-only stops on quad
  sections, keeping the terminals. **All stops** serves every station along the line, choosing local
  platforms. Each change is validated by pathfinding and fleet purchase and reverted with a toast on
  failure, using the same pattern as the panel's **Apply** button (`routePanel.ts:112`).
- The **Stops** list becomes a **Line** list built from `stationsAlongPath` (§4.7). It runs top to
  bottom in direction-0 order:
  - Served stops: number, name, other routes' bullets, and a ghost button `Skip`. Terminals have no
    button and the tooltip `Terminals can't be skipped — shorten the route instead`.
  - Skipped stations: muted name, a hollow marker, the tag `passes` (or `on the local pair`), and a
    ghost button `Stop here`. If stopping there needs a crossover that doesn't exist, the toast reads
    `28 St is on the local pair and no crossover reaches it — add crossovers before and after it
    (Track tool, 4 tracks, X)`.
- A new stat card, **Overtakes yesterday**, fed by `DayReport.routeOvertakes`.
- Changing stops on a running route resets its trains, exactly as v1's stop edits do
  (`TrainSim.setNetwork` `samePaths`, `trainSim.ts:499`).

**Map.** While a route is selected, its skipped stations get hollow rings in the route colour. This is
a new deck provider `route-pattern` in `App`. Express trains are drawn with a light casing
`[236,240,244,235]` instead of the dark one at `trainLayer.ts:71`, so an express sliding past a local
is visible.

### 2.4 The express lozenge (our own design)
Local routes keep the v1 circle (`bullet`, `src/ui/dom.ts:48`). Express routes get a **horizontal
lozenge**: an elongated hexagon 1.32× as wide as it is tall, with pointed left and right ends, a
1.5 px white keyline, and the same bold white letter. It is deliberately *not* a square rotated 45°.

```css
.bullet.express { border-radius: 0; background: #fff; position: relative;
  clip-path: polygon(20% 0, 80% 0, 100% 50%, 80% 100%, 20% 100%, 0 50%); }
.bullet.express > span { position: absolute; inset: 1.5px; display: flex; align-items: center;
  justify-content: center; background: var(--c);
  clip-path: polygon(20% 0, 80% 0, 100% 50%, 80% 100%, 20% 100%, 0 50%); }
```

`bullet(color, text, size, express = false)`: when `express` is set it renders an outer span of width
`round(size·1.32)` holding an inner span with `--c: color` and the text. Every call site passes
`r.express`: `routePanel.ts` ×3, `stationPanel.ts:72` and `inspectPanels.ts:27`.

### 2.5 Map rendering of quads
- **Unrouted built quad:** each pair is drawn as two thin rails using MapLibre `line-gap-width`. The
  pairs are offset ±Q px from the trunk centre, so four rails show. Level styling (dashes, opacity)
  matches v1.
- **Routed quad:** each pair's interlined bundle is centred on its pair offset. Routes on the local
  pair sit on one side and express routes on the other. The ordering inside a pair is the v1 ordering
  by route id.
- **Blueprint quads** use the same pair offset, so a planned quad reads as two dashed lines.
- **Cross-platform stations** are drawn as one white capsule with a dark outline, laid across the
  trunk from one pair's bundle centre to the other's. They have one label, pulse amber or red on the
  higher crowding of the two platforms, and are sized by combined boardings.

### 2.6 Controls summary (README additions)

| Where | Input | Action |
|---|---|---|
| Track tool | `Q` | Two or four tracks |
| Track tool (4) | `F` | Flip express side |
| Track tool (4) | `X` | Crossover placement on and off |
| Station tool | Shift-click | Single platform on a four-track section |
| Route tool | `E` | Local or express draft |
| Route tool | Alt-click | Use the other platform of a cross-platform station |
| Bulldoze | Shift-click | Demolish only this platform of a pair |

`Pointer` gains `alt: boolean` (`src/ui/toolTypes.ts:5`), set in `ToolManager.pointer`
(`src/ui/toolManager.ts:92`) from `e.originalEvent.altKey`.

---

## 3. Data model

```ts
// src/construction/types.ts
export type QuadRole = 'local' | 'express' | 'link';
export interface QuadTag {
  /** Quad group id (allocated from Network.nextId; shared by both pairs and their connectors). */
  g: number;
  role: QuadRole;
  /**
   * Side, relative to this edge's own a→b direction, that its route lines are pushed to on the map
   * (+1 right, −1 left): away from the partner pair. 0 for links. The partner lies at −away.
   */
  away: -1 | 0 | 1;
}
export interface TrackNode { /* v1 fields */ twin?: number }   // vertex on the other pair (drag sync)
export interface TrackEdge { /* v1 fields */ quad?: QuadTag }
export interface Station   { /* v1 fields */ pair?: number }   // cross-platform partner station id

// src/routes/types.ts
export interface Route { /* v1 fields */ express?: boolean }    // RouteSet.create/load default false
```

**Invariants**
- Both pairs of a group have co-oriented chains: edge `a→b` follows the stroke for local and express
  edges. `splitEdge` keeps `a→b` order (`network.ts:238-239`), so `away` stays valid after splits.
  `splitEdge` copies `quad` to both halves.
- `twin` is symmetric. It is set only on degree-2, non-anchor vertices created by a quad stroke
  (inner vertices and leads).
- `pair` is symmetric. `removeStation`, `removeEdge` and `load` clear dangling `twin` and `pair`
  references.
- **Nested objects must be deep-copied.** `Network.toData` and `load` (`network.ts:58,73`) shallow-copy
  with `{...e}`. That would share `quad` objects between the live network, the preview clone and the
  undo snapshots. Both must copy `quad: e.quad && { ...e.quad }`, and every mutation of a tag replaces
  the object rather than editing it in place.

---

## 4. Algorithms

### 4.1 Parallel offset with mitred vertices and concentric fillets
Use the v1 convention from `offsetPolyline` (`src/map/polyline.ts:32`): the right normal of a unit
heading `d` is `n(d) = (d.y, −d.x)`, and a positive offset is to the right.

For a vertex `v` with incoming unit `d1` and outgoing unit `d2`, the twin at signed offset `σw` is

```
v' = v + σw · (n(d1) + n(d2)) / (1 + d1·d2)        // mitre; |v' − v| = w / cos(θ/2)
r' = r > 0 ? r + σ·turn·w : 0                       // turn = sign(d1 × d2), +1 = left turn
```

At chain ends there is only one neighbour, so `v' = v + σw·n(d)`. If `1 + d1·d2 < 0.05` (a turn
sharper than about 162°) the stroke fails with "Too sharp a turn for four tracks".

**Why this gives an exact parallel curve.** Take the edge between vertices `i` and `i+1`. Its offset
chord is longer on the outside of each turn by `w·tan(θ/2)` at each end. The concentric tangent
`t' = (r ± w)·tan(θ/2)` is longer by exactly the same amount. So the straight part of every edge is
the same length on both pairs, the fillets overlap on the twin exactly when they overlap on the
local pair, and the arc centres coincide.

The only extra failure is on the inner side: `r − w < minRadius`. `edgeReport` already reports it
(`validate.ts:59`, "Curve too tight"). The preview hint states the rule as "inner curves need 9 m
more radius". Ramps line up because twin vertices copy `level`. On a curved ramp, the inner ramp is
`w·θ` shorter and may need more length. `edgeReport` reports that per edge (`validate.ts:71`).

### 4.2 `addQuadStroke`: the drawn stroke, then the twin, then connectors
New file `src/construction/quad.ts`. All of it runs inside one `game.editBlueprint` call, so it is a
single undo step, and on a `net.clone()` for the preview.

```ts
type EndMode = { kind: 'free' } | { kind: 'fan' } | { kind: 'continue'; partner: number; tag: QuadTag };

export function addQuadStroke(net, points, cls, startSnap, endSnap, opt: QuadOptions): QuadResult {
  const w = opt.spacing ?? QUAD.spacing;
  const sm = endModeOf(net, startSnap), em = endModeOf(net, endSnap);
  // Side and roles: a continued quad dictates them.
  let side = opt.side;                                  // +1: express on the right of the stroke
  if (sm.kind === 'continue') side = sideOfPartner(net, startSnap.node, sm.partner, 'start');
  if (em.kind === 'continue') {
    const s2 = sideOfPartner(net, endSnap.node, em.partner, 'end');
    if (sm.kind === 'continue' && s2 !== side) return fatal('The two four-track ends are on opposite sides');
    side = s2;
  }
  const roleDrawn = sm.kind === 'continue' ? sm.tag.role : em.kind === 'continue' ? em.tag.role : 'local';
  const g = sm.kind === 'continue' ? sm.tag.g : em.kind === 'continue' ? em.tag.g : net.nextId++;

  const drawn = net.addStroke(points, cls, startSnap, endSnap);     // v1, untouched
  if (!drawn.length) return fatal('…');
  const legs = drawn.map((id) => ({ edge: id, dir: 0 as const, u0: 0, u1: net.geom(id).length }));
  return buildTwin(net, legs, cls, { side, w, g, roleDrawn, start: sm, end: em });
}
```

`buildTwin` is shared with the stretch retrofit (§15). It works on any path given as `PathLeg[]` in
travel order.

```ts
function buildTwin(net, legs, cls, spec): QuadResult {
  const nodes = pathNodes(net, legs);                    // [start of leg 0, end of leg 0, end of leg 1, …]
  const sw = spec.side * spec.w;
  // 1. Where the twin starts and ends along the path.
  const sCut = spec.start.kind === 'fan' ? findStraight(net, legs, 'start', QUAD.turnoutLength, cls) : null;
  const eCut = spec.end.kind === 'fan'   ? findStraight(net, legs, 'end',   QUAD.turnoutLength, cls) : null;
  if (spec.start.kind === 'fan' && !sCut) return fatal(`Needs a straight, level ${len(190)} stretch within ${len(1500)} of the start to split into four tracks`);
  if (spec.end.kind === 'fan' && !eCut)   return fatal(/* same, "of the end" */);
  if (pathPos(sCut?.uX at start) >= pathPos(eCut?.uX at end) - 50) return fatal('Too short for four tracks');

  // 2. Twin vertices in travel order.
  const v: ChainVertex[] = [];
  v.push(spec.start.kind === 'continue' ? { existing: spec.start.partner }
       : sCut ? offsetPointOnLeg(net, legs[sCut.leg], sCut.uX, sw)                // X0: new free node
       : offsetEnd(net, nodes[0], nodes[1], sw));
  const first = sCut ? sCut.leg + 1 : 1, last = eCut ? eCut.leg : nodes.length - 2;
  for (let i = first; i <= last; i++) {
    const p = node(nodes[i - 1]), n = node(nodes[i]), q = node(nodes[i + 1]);
    v.push({ ...mitre(p, n, q, sw), level: n.level, r: concentric(n.r, turnSign(p, n, q), sw),
             twin: n.id, leadOf: n.leadOf === nodes[0] && spec.start.kind === 'continue' ? 0
                   : n.leadOf === nodes.at(-1) && spec.end.kind === 'continue' ? LAST : undefined });
  }
  v.push(spec.end.kind === 'continue' ? { existing: spec.end.partner }
       : eCut ? offsetPointOnLeg(net, legs[eCut.leg], eCut.uX, sw)
       : offsetEnd(net, nodes.at(-1), nodes.at(-2), -sw /* reversed direction */));
  const twin = net.addChain(v, cls);                     // §5 network.ts — sets anchors, leads, twins

  // 3. Turnouts (ordinary v1 strokes between snaps).
  const links: number[] = [];
  let jS = nodes[0], jE = nodes.at(-1)!;
  if (sCut) {
    const leg = legs[sCut.leg], J = pointAt(net, leg.edge, sCut.uJ), X0 = net.edges.get(twin[0])!.a;
    const c = net.addStroke([J, nodePt(X0)], cls, { kind: 'edge', edge: leg.edge, u: sCut.uJ }, { kind: 'node', node: X0 });
    links.push(...c); jS = net.edges.get(c[0])!.a;      // the new junction on the drawn chain
  }
  if (eCut) {
    const at = locateOnChain(net, nodes, jS, pointAt(/* original leg geometry */));  // the leg may have been split
    const Xe = net.edges.get(twin.at(-1)!)!.b;
    const c = net.addStroke([nodePt(Xe), at.pt], cls, { kind: 'node', node: Xe }, { kind: 'edge', edge: at.edge, u: at.u });
    links.push(...c); jE = net.edges.get(c.at(-1)!)!.b;
  }
  // 4. Tags (before any crossover, so crossover splits inherit them).
  const localEdges = edgesAlong(net, chainWith(nodes, jS, jE), jS, jE);   // edgeBetween() over consecutive nodes
  tag(localEdges, { g, role: spec.roleDrawn,      away: -spec.side });
  tag(twin,       { g, role: other(spec.roleDrawn), away: +spec.side });
  tag(links,      { g, role: 'link', away: 0 });
  // 5. Scissors near free ends (non-fatal if no room).
  for (const end of ['start', 'end'] as const) if (spec[end].kind === 'free' && QUAD.autoCrossovers) {
    const cut = findStraight(net, taggedLegsFrom(net, g, spec.roleDrawn, end), end, QUAD.crossoverLength, cls);
    const r = cut ? addScissors(net, g, cut.edge, cut.uJ, cut.uX, cls) : { ok: false, reason: 'no straight stretch' };
    if (r.ok) links.push(...r.links); else problems.push(`No straight ${len(190)} near the ${end} for a crossover — add one with X`);
  }
  // 6. Join two existing groups if the stroke continued both.
  if (spec.start.kind === 'continue' && spec.end.kind === 'continue' && spec.end.tag.g !== g) relabel(net, spec.end.tag.g, g);
  return { ok: true, group: g, local/express: …, links, problems };
}
```

**`findStraight(net, legs, from, len, cls)`** finds the first straight, level, splittable span of
length `len` within `connectorMargin` of a straight piece's ends, searching from one end of the path:

```ts
for each leg i in order from `from` (stop once the walked distance exceeds QUAD.connectorSearch):
  if (net.isRamp(leg.edge)) continue;
  for each straight piece p (r = Infinity) of net.geom(leg.edge), nearest-to-`from` first:
    if (p.s1 - p.s0 < len + 2 * QUAD.connectorMargin) continue;
    const nearLow = (from === 'start') === (leg.dir === 0);      // which piece end faces `from`
    const uJ = nearLow ? p.s0 + QUAD.connectorMargin : p.s1 - QUAD.connectorMargin;
    const uX = nearLow ? uJ + len : uJ - len;
    if (net.canSplitAt(leg.edge, uJ, cls).ok) return { leg: i, edge: leg.edge, uJ, uX };
return null;
```

`canSplitAt` (`network.ts:176`) already rejects ramps, curves, spans within 15 m of a node, and
platforms. Turnouts and crossovers are therefore always placed on straight-to-straight geometry.

**Why the turnout is always valid.** For a 2-point stroke from an edge snap to a node or edge snap,
`addStroke` builds `[J, lead, lead, X]`. Each `leadLength` comes out at `leadMinLength` = 40 m. That
leaves a 70 m diagonal with a 9 m offset: θ = 7.33° and r ≈ 551 m (curve speed 23.5 m/s, about
85 km/h). I measured this against the v1 code: three edges of 40.0, 70.5 and 40.0 m, all
`edgeReport.ok`, r = 551.2 m. Junction alignment and the "can't double back" rule pass because the
leads lie on the anchor axes (`validate.ts:81-98`).

**End-mode detection.**

```ts
function endModeOf(net, snap): EndMode {
  if (snap.kind === 'none') return { kind: 'free' };
  if (snap.kind === 'node') { const p = quadEndPartner(net, snap.node); if (p) return { kind: 'continue', ...p }; }
  return { kind: 'fan' };
}
/** A free end of a quad pair whose partner pair also ends freely beside it. */
export function quadEndPartner(net, nodeId): { partner: number; tag: QuadTag } | null {
  if (net.degree(nodeId) !== 1) return null;
  const tag = net.edges.get(net.incident(nodeId)[0])!.quad;
  if (!tag || tag.role === 'link') return null;
  for (const m of net.nodes.values()) {                     // O(N); only on snap and finish
    if (m.id === nodeId || net.degree(m.id) !== 1) continue;
    const d = Math.hypot(m.x - n.x, m.y - n.y);
    if (Math.abs(d - QUAD.spacing) > QUAD.partnerTolerance) continue;
    const t = net.edges.get(net.incident(m.id)[0])!.quad;
    if (t && t.g === tag.g && t.role !== tag.role && t.role !== 'link') return { partner: m.id, tag };
  }
  return null;
}
```

`sideOfPartner` takes the continuing direction at the node: `−h` at a start (a plain end's `h` points
into its own edge, `network.ts:209-221`) or `+h` at an end. It returns
`sign(n(dir) · (partner − node))`.

### 4.3 Scissors crossover
A scissors is two turnouts crossing each other: XO1 goes from local at `uA` to express at `uB`, and
XO2 from express at `uA` to local at `uB`, with `uB = uA + 150`. They cross geometrically with no node
between them (a flying abstraction, consistent with v1 junctions).

```ts
export function addScissors(net, g, edge, uA, uB, cls): { ok: boolean; links: number[]; reason?: string } {
  const role = net.edges.get(edge)!.quad!.role;
  const pA = pointAt(net, edge, uA), pB = pointAt(net, edge, uB);
  const xA = partnerPoint(net, edge, uA), xB = partnerPoint(net, edge, uB);  // {edge,u,x,y}
  if (!xA || !xB) return fail('No parallel pair here');
  for (const [e, u] of [[edge, uA], [edge, uB], [xA.edge, xA.u], [xB.edge, xB.u]])
    if (!net.canSplitAt(e, u, cls).ok) return fail('Crossovers need straight, level track clear of platforms');
  const c1 = net.addStroke([pA, xB], cls, { kind: 'edge', edge, u: uA }, { kind: 'edge', edge: xB.edge, u: xB.u });
  const a2 = locateTagged(net, g, other(role), xA), b2 = locateTagged(net, g, role, pB);   // ids changed by splits
  const c2 = net.addStroke([a2.pt, b2.pt], cls, { kind: 'edge', ...a2 }, { kind: 'edge', ...b2 });
  tag([...c1, ...c2], { g, role: 'link', away: 0 });
  return { ok: true, links: [...c1, ...c2] };
}
/** Point on the other pair opposite (edge, u). */
export function partnerPoint(net, edge, u) {
  const t = net.edges.get(edge)!.quad; if (!t || t.role === 'link') return null;
  const g = net.geom(edge), p = sampleAt(g.xs, g.ys, g.cum, u), s = -t.away;      // partner side
  const x = p.x + s * QUAD.spacing * p.hy, y = p.y - s * QUAD.spacing * p.hx;
  const hit = pickEdge(net, x, y, QUAD.partnerTolerance, (id) => { const q = net.edges.get(id)!.quad; return !!q && q.g === t.g && q.role !== t.role && q.role !== 'link'; });
  return hit ? { edge: hit.edge, u: hit.u, x: hit.x, y: hit.y } : null;
}
```

`locateTagged(net, g, role, pt)` is `pickEdge(net, pt.x, pt.y, 1.0, filter on tag g and role)`. Tags
are inherited through splits, so re-locating after each split is exact and deterministic.

**Verified against v1 code** (scratch script): a hand-built scissors between two parallel lines at
9 m gives 12 valid edges, maximum node degree 3, and exactly **4 merge locks**. That is one per
junction, for the converging direction (`mergeLocks`, `compile.ts:28`). `findRoutePath` succeeds for
all four switching moves (L→X and X→L, both directions). A local route stays on its pair: its path
has 3 legs and 2200.0 m, against 2200.4 m through the crossovers.

### 4.4 Twin drag sync
`Network.moveNode` (`network.ts:398`) refits the moved vertex and its editable neighbours. After that
refit (line 426), call `this.syncTwins(refit)`:

```ts
syncTwins(ids: Iterable<number>): void {
  for (const id of ids) {
    const n = this.nodes.get(id); if (n?.twin === undefined) continue;
    const t = this.nodes.get(n.twin); if (!t || !this.nodeEditable(t.id)) continue;
    const inc = this.incident(id); if (inc.length !== 2) continue;
    const e = this.edges.get(inc[0])!, p = this.nodes.get(otherEnd(e, id))!, q = this.nodes.get(otherEnd(this.edges.get(inc[1])!, id))!;
    // Partner side relative to p→n: −away in e's a→b frame, flipped if e runs n→p.
    const σ = (e.quad ? -e.quad.away : 0) * (e.a === p.id ? 1 : -1); if (!σ) continue;
    Object.assign(t, mitre(p, n, q, σ * QUAD.spacing));
    t.r = concentric(n.r, turnSign(p, n, q), σ * QUAD.spacing);
  }
  this.touch();
}
```

The side comes from the edge tags rather than the old twin position, so it is correct however far
the vertex is dragged. A twin that is not a blueprint is never moved. Once one pair has been built the
other is effectively frozen, and validation still reports any resulting geometry problem.

### 4.5 Cross-platform stations: placement, validation, cost
- `Network.addStationPair(e1, u1, e2, u2, cars, name, status = 'blueprint')` creates two stations with
  the same name and links them through `pair`. `Network.linkPair(a, b)` links an existing platform to
  a new one.
- The partner position is `partnerPoint(net, hit.edge, hit.u)` (§4.3).
- `stationReport(net, edgeId, u, cars, terrain, ignoreStation = null, opts: { paired?: boolean; partner?: number } = {})`
  (`validate.ts:169`) changes in three ways:
  - `partner = opts.partner ?? stations.get(ignoreStation)?.pair ?? null`;
  - `nearestStationAlongTrack(…, ignore, partner)` (`validate.ts:214`) skips both ids. This matters
    because the partner is reachable along track through any crossover;
  - `cost = stationCost(…) × (paired ? QUAD.pairPlatformCostShare : 1)`.

  The `blueprintSummary` and `commitBlueprints` calls (`blueprint.ts:33,60`) pass `s.id`, so their
  pricing picks up the pair automatically.
- Removal: `removeStation` clears the partner's `pair`. `Game.bulldozeStation(id, { withPartner = true })`
  (`game.ts:153`) checks routes on both platforms and removes and refunds both, or just one.

### 4.6 Route pathfinding cost model (`src/routes/pathfind.ts`)
Search state and successors are unchanged (`successors`, `pathfind.ts:24`). Only the costs change:

```ts
export interface PathCostOptions { passPenalty?: number; linkPenalty?: number }   // tests set 0 to compare with v1

function costModel(net: Network, stops: number[], o: PathCostOptions) {
  const pass = o.passPenalty ?? QUAD.passPenalty, link = o.linkPenalty ?? QUAD.linkPenalty;
  const served = new Set(stops);
  const plat = new Map<number, number[]>();                       // edge → u of platforms not served
  for (const s of net.stations.values()) if (!served.has(s.id)) push(plat, s.edge, s.u);
  const part = (edge: number, a: number, b: number) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    let c = hi - lo;
    for (const u of plat.get(edge) ?? EMPTY) if (u > lo + 1 && u < hi - 1) c += pass;
    return c;
  };
  const memo = new Map<number, number>();
  const full = (edge: number) => memo.get(edge) ?? memo.set(edge,
      part(edge, 0, net.geom(edge).length) + (net.edges.get(edge)!.quad?.role === 'link' ? link : 0)).get(edge)!;
  return { part, full };
}
```

`legSearch` (`pathfind.ts:47`):
- the direct same-edge case costs `cm.part(A.edge, A.u, B.u)`;
- `startCost = cm.part(A.edge, A.u, d === 0 ? LA : 0)` (line 61);
- arrival costs `c + cm.part(B.edge, s.dir === 0 ? 0 : LB, B.u)` (line 83);
- relaxation is `nc = c + cm.full(s.edge)` (line 89).

`Leg` becomes `{ cost, dist, legs }`, where `dist = Σ|u1 − u0|` is computed in `reconstruct`. In
`findRoutePath` (`pathfind.ts:135`), `stopS` accumulates **`dist`** at line 168 and the result uses
`length: win.dist` at line 185. `RoutePath.length` and `stopS` therefore stay distances.

The signature is `findRoutePath(net, cls, stops, usable = ANY, costs: PathCostOptions = {})`. All
penalties are non-negative, so Dijkstra stays correct. The `RouteSet.path` cache key (`routeSet.ts:51`)
already includes `stops` and `net.version`, which is everything the cost depends on.

**Effect.** Pairs differ in length by at most `w·θ` per curve (about 14 m per 90°). A detour through
crossovers adds 0.4 m plus the 250 link penalty. An express whose stops are all on the express pair
can only lose by leaving it. A route that skips stations on a line with a platform-free bypass now
takes the bypass, which is what "express" means. Networks with no alternative paths, including every
v1 test and balance network, produce **identical** paths. A test asserts this (§13).

Also exported: `trackPath(net, cls, A: StopPos, B: StopPos, usable?) → PathLeg[] | null`, a wrapper over
`legSearch` used by the stretch retrofit.

### 4.7 Stations along a path, skip and serve, patterns (`src/routes/express.ts`, new)

```ts
export interface AlongStation {
  station: number;     // platform the route uses (or would use)
  partner?: number;    // the other platform of a cross-platform pair
  s: number;           // distance along the direction-0 path
  served: boolean;     // route stops at station or partner
  terminal: boolean;
  where: 'on-track' | 'beside';   // on the route's own track / on the parallel pair (needs crossovers)
}
export function stationsAlongPath(net: Network, stops: number[], path: RoutePath): AlongStation[]
```

Algorithm:
1. Walk `path.legs` while accumulating `s0`.
2. For each leg, every station on `leg.edge` whose `u` is inside the leg interval is added as
   `'on-track'` at `s0 + (dir 0 ? u − lo : hi − u)`.
3. If the edge is a local or express quad edge, every station on the other-role edges of the same
   group (indexed once per call) is projected onto the leg slice with `projectOnPolyline`
   (`geometry.ts:251`), using a bounding-box pre-reject. Stations within `spacing + partnerTolerance`
   are added as `'beside'`.
4. Entries are merged by pair key `min(id, pair)`, preferring `'on-track'`, and sorted by `s`.

Cost is O(stations on the path's edges + quad partners × leg points). It runs only for the selected
route or the draft, and is cached by `(route id, net.version, routes.version)`.

```ts
export function serveStops(net, cls, stops, path, stationId): { stops: number[] } | { error: string }
// Insert at the first i ≥ 1 with path.stopS[i] > entry.s; validate with findRoutePath; specific error for 'beside'.
export function skipStops(net, stops, stationId): { stops: number[] } | { error: string }
// Remove station or its partner; terminals → "Terminals can't be skipped — shorten the route instead".
export function expressPattern(net, stops): number[]
// Local-role stop with a partner → partner; local-role stop without one → dropped (terminals kept).
export function allStopsPattern(net, cls, stops, path): number[]
// Every along-path station, choosing the local-role platform of pairs; terminals unchanged.
export function choosePlatform(net, stationId, express: boolean, alt: boolean): number
// For a pair: the express-role platform if (express !== alt), else the local one.
export function quadRole(net, stationId): QuadRole | null
```

### 4.8 Simulation: what changes and what emerges
**Nothing in the moving block or merge-lock logic changes.**
- Each pair is its own edge, so it has its own two directed tracks (`trackIdx`, `compile.ts:205`). An
  express on X never appears in a local's occupancy lookahead on L (`trainSim.ts:344-369`).
- At a **fan** (a degree-3 junction), the converging direction gets a merge lock (FCFS,
  `trainSim.ts:371-389`). The diverging direction needs none, because the follower stops seeing the
  leader once the leader's tail is on another track.
- A **scissors** adds 4 locks (§4.3).
- In the experiment the express ran slightly *under* its schedule (280 s against 298 s), because
  schedules assume `scheduledDwell` = 30 s while the sim dwells 20 s with no passengers.

**Overtake counter** (new, cheap, deterministic) in `TrainSim`. An overtake is an inversion of order
between two consecutive cross-platform stations shared by both trains:

```ts
// per compiled station index: pairKey[si] = min(si, pair) or −1; log[key*2 + sgn] = recent arrivals [{train, t}]
// per train: lastPair?: { key, t, sgn }
// per route-direction: nextPair: Map<key, key>   (the next pair key along its stops; built in setNetwork)
arriveAt(tr, r, stopIdx, t):                              // trainSim.ts:439
  const si = dir.stopStation[stopIdx], key = pairKey[si]; if (key < 0) return;
  const sgn = travelSign(tr, dir, si);                    // edgeDir of the stop element, flipped if !pairSameDir on the non-reference platform
  const prev = tr.lastPair;
  if (prev && prev.sgn === sgn)
    for (const e of log[prev.key*2 + sgn]) {              // arrivals at the previous pair, last 30 min
      if (e.t >= prev.t || e.train === tr.id) continue;   // they arrived there before us
      const y = this.byId(e.train); if (!y || y.routeId === tr.routeId) continue;
      if (y.lastPair?.key === prev.key && nextPairOf(y) === key) this.day.overtakes.set(r.id, +1);   // still behind us
    }
  pushTrimmed(log[key*2 + sgn], { train: tr.id, t }); tr.lastPair = { key, t, sgn };
```

The cost is O(log length, typically ≤ 6) per arrival at paired stations only. `toReady` clears
`lastPair`. `setNetwork` rebuilds `log` and `nextPair`. `TrainDayStats` gains
`overtakes: Map<routeId, number>`, and `newDayStats` (`trainSim.ts:495`) initialises it.

### 4.9 Commuters: cross-platform transfers
New helpers in `src/routes/interchange.ts`, next to `transferTime` (line 63):

```ts
export function platformTransfer(a: CStation, b: CStation, bIndex: number): number {
  return a.pair === bIndex ? QUAD.crossPlatformTransfer : transferTime(Math.hypot(b.x - a.x, b.y - a.y));
}
export function transferPenaltyFor(a: CStation, bIndex: number): number {
  return COMMUTERS.transferPenalty * (a.pair === bIndex ? QUAD.crossPlatformPenaltyFactor : 1);
}
```

- `TransitGraph` constructor (`transitGraph.ts:96-122`): `walk.push(platformTransfer(sp, s2, st2))`
  plus a new `pen.push(transferPenaltyFor(sp, st2))` stored as `trPen: Float64Array`. In `run`
  (line 203) the relaxation becomes `nc = c + trWalk[k] + wait[t] + trPen[k]`. A new export
  `effectiveTransfers(net, legs)` returns Σ over transfers of 1, or 0.4 across a pair.
- `Commuters.bestPath` (`commuters.ts:441`): `const eff = effectiveTransfers(net, legs)`, then
  `time: cand.cost − eff·penalty` and `transfers: eff`. `transfers` is already averaged and fractional,
  and `modeChoice.ts:67` multiplies it by the penalty, so mode choice stays consistent.
- `Commuters.arrive` (`commuters.ts:644`): the hard-coded `hypot/1.2 + 60` is exactly
  `transferTime(d)`. Replace it with `platformTransfer(station, nextSt, nextIdx)`. When it is a pair,
  `day.crossTransfers` adds one at `min(station.id, nextSt.id)`. `newDayStats` (`commuters.ts:1034`)
  gains `crossTransfers: new Map()`, and `dayReport` (`commuters.ts:784`) emits it ×scale.
- When the express is dwelling across the platform, a transferring agent reaches the queue in 15 s and
  boards at `depart()` (`commuters.ts:653`). Timed cross-platform connections emerge without holding
  logic.

**v1 equivalence.** With no pairs, `trPen[k]` is 300 for every transfer and
`eff = legs.length − 1` exactly (a sum of integer 1.0 values), so graph costs, path times and mode
shares are bit-identical.

### 4.10 Rendering math (`src/map/networkLayers.ts`, `stationLayers.ts`)
Pair offset per group, in px at line scale 1, computed in `NetworkLayers.update` after
`routesOnEdge` (`networkLayers.ts:253-268`):

```ts
export function quadOffsets(net: Network, routesOnEdge: Map<number, unknown[]>): Map<number, number> {
  const Q = new Map<number, number>();
  for (const e of net.edges.values()) {
    const t = e.quad; if (!t || t.role === 'link') continue;
    const k = Math.max(1, routesOnEdge.get(e.id)?.length ?? 0);
    const q = ((k - 1) * MAP.interlineSpacingPx) / 2 + MAP.routeLineWidthPx / 2 + QUAD.pairGapPx / 2;
    Q.set(t.g, Math.max(Q.get(t.g) ?? 0, q));
  }
  return Q;
}
export const pairOffsetAB = (e: TrackEdge, Q: Map<number, number>) => (e.quad?.away ? e.quad.away * (Q.get(e.quad.g) ?? 0) : 0);
```

The drawn offset is `flip ? −pab : pab`, using `orientEdges` flips (line 249), because MapLibre's
positive `line-offset` is to the right of the drawn direction. With one route per pair, Q = 3.5 px.
The route centrelines are then 7 px apart plus 9 m in metres, which leaves a 3 px gap between 4 px
lines. Because the pixel push has the same sign as the metric separation, the pairs never cross
visually, and picking by nearest metres (`pickEdge`) still selects the side the cursor is on.

- Track features get `quad: boolean` and `pairOff` properties. v1's `built(level)` filter
  (`networkLayers.ts:164`) adds `['!', ['get','quad']]`. Four new layers, `hw-quad-{level}`, use the
  filter `built && quad && level` and paint:
  - `line-color` MUTED,
  - `line-width W(QUAD.railWidthPx)`,
  - `line-gap-width W(QUAD.railGapPx)`,
  - `line-offset` zoom-scaled `pairOff` (same form as `routePaint`, line 206),
  - v1's per-level dasharray and opacity.

  Each pair is drawn as two rails, so four rails show in total: at ±1.95 and ±5.05 px.
- `hw-blueprint` and `hw-blueprint-invalid` (lines 225-238) also get the zoom-scaled `pairOff` offset.
- Route features (line 305): `offset = pairOffDrawn + (i − (k−1)/2)·spacing`.
  `routeOffsets.set(key, flip ? −offset : offset)` is unchanged, so trains (`trainLayer.ts:241-244`)
  sit on their pair without any trainLayer change. `elevated3d` entries (lines 288 and 319) use the
  same offset.
- `NetworkLayers.quadOffsets: Map<group, Q>` is public for station rendering.

**Station capsule** in `StationLayers.update(is3D, quadQ)` (`stationLayers.ts:47`):
- For each pair with `s.id < s.pair` and both stations present, build a `PairDatum` holding:
  - centre: the midpoint of the two platforms;
  - unit normal `n` across the track at `s`;
  - group id;
  - the larger radius;
  - the "least built" status;
  - the higher crowding.
- Both platforms are excluded from the circle and label data, and one label datum is added at the
  centre.
- v1 MST pills between pair partners are skipped (line 72).
- In `layers(zoom, …)` the capsule's half-length in metres is
  `w/2 + Q_g · lineScale(zoom) · metresPerPixel(zoom)`. Two PathLayers (outline width `2r+3`, fill
  `2r`, `capRounded`) draw `[c − n·half, c + n·half]`, so the caps land on the two route bundles at
  every zoom.
- `metresPerPixel(z) = 40075016.686·cos(φ₀)/(512·2^z)` is a new export of `src/core/geo.ts`.
- `updateTriggers.getPath: [version, round(zoom·20)]`. There are typically fewer than 100 pairs.

---

## 5. Exact changes per existing file

| File | Change |
|---|---|
| `src/balance.ts` | New `QUAD` section (§9). |
| `src/construction/types.ts` | `QuadRole`, `QuadTag`, `TrackNode.twin?`, `TrackEdge.quad?`, `Station.pair?`; export `ChainVertex { x; y; level; r; existing?; leadOf?: number /*vertex index*/; twin? }`. |
| `src/construction/network.ts` | **`addChain(verts, cls): number[]`**: anchors `existing` endpoints with `makeAnchor` first (line 209), creates nodes with explicit `r`, `twin` (both ways) and `leadOf` (index → id), then edges; `touch()`. **`splitEdge`** (227): copy `quad` to `e1` and `e2`. **`moveNode`** (398): `syncTwins(refit)` after line 426; refuse the drag if `n.twin` exists and the twin is not editable while `n` is (keeps pairs consistent). **`syncTwins`** (§4.4). **`removeEdge`** (442) / **`removeStation`** (499): clear dangling `pair`/`twin`. **`toData`/`load`** (58/73): deep-copy `quad`; `load` drops dangling refs. **`addStationPair`**, **`linkPair`**. **`edgeBetween(a, b)`** helper. |
| `src/construction/validate.ts` | `edgeReport` (46): `cost *= classMult(e.cls) * quadCostFactor(e)` at line 136 (express ×0.75, link ×0.5). `stationReport` (169): `opts` param, partner-aware spacing, pair cost share. `nearestStationAlongTrack` (214): extra `ignore2` id. |
| `src/construction/describe.ts` | `edgeTooltip` (18): row `Four-track · local pair / express pair / crossover`. |
| `src/construction/trackTool.ts` | Fields `mode: 'double'\|'quad'\|'crossover'`, `side: 1\|-1`. `buildPreview` (106): in quad mode `addQuadStroke(net, points, cls, startSnap, endSnap, { side })`; reports for all new edges; per-role colours; tooltip §2.1. `finish` (179): same call inside `editBlueprint`; refuse with a toast when `fatal`. `key` (228): `Q`, `F`, `X`. `move` (83): quad hover texts; crossover-mode hover computes `scissorsCandidate` on a clone. `click` (148): crossover mode → `editBlueprint(() => addScissors(...))`. `layers` (251): role colours via a `roles: Map<edgeId, QuadRole>` in `Preview`. `options` (346): rows §2.1. |
| `src/construction/stationTool.ts` | `move` (34): pair/link/single modes (`partnerPoint`, existing-partner search within `QUAD.pairLinkDistance`), two reports, summed cost; `click` (60): `addStationPair` / `addStation`+`linkPair` / v1; `layers` (80): both platform highlights + one catchment at the midpoint; `options` (119) hint line about four tracks. |
| `src/construction/bulldozeTool.ts` | `move` (37) / `click` (76): pair-aware text and refund; `shift` → single platform. |
| `src/core/game.ts` | `bulldozeStation(id, opts = { withPartner: true })` (153). |
| `src/core/geo.ts` | `metresPerPixel(zoom)`. |
| `src/routes/types.ts` | `Route.express?: boolean`. |
| `src/routes/routeSet.ts` | `create` (30) / `load` (122): `express: r.express ?? false`. |
| `src/routes/pathfind.ts` | Cost model (§4.6): `legSearch`, `reconstruct` (`dist`), `findRoutePath` (`costs` param, dist-based `stopS`/`length`), export `trackPath`, `PathCostOptions`. |
| `src/routes/routeTool.ts` | `RouteDraft.express` (20); `newDraft`/`editRoute`/`asRoute`/`save` (52/67/93/134) carry it; `key` (221): `E`; `click` (194): `choosePlatform` + insert-in-order via `serveStops`; `recompute` (81): `this.along = stationsAlongPath(...)`; `move` (175): pair/skip tooltips; `layers` (237): `route-draft-skips` rings. |
| `src/routes/compile.ts` | `compileRoute` (225): `express: !!r.express`. `compileNetwork` (244): after building `stations`, set `pair` / `pairSameDir`; `staffedStations = Σ (pair ? QUAD.pairStaffing/2 : 1)` in the returned net (271). |
| `src/routes/interchange.ts` | `platformTransfer`, `transferPenaltyFor` (§4.9). |
| `src/sim/protocol.ts` | §7. |
| `src/sim/trainSim.ts` | Overtake counter (§4.8): fields `pairKey`, `pairLog`, `nextPair`, `Train.lastPair?`; `setNetwork` (87) builds them; `arriveAt` (439) counts; `toReady` (187) clears; `step` (210) keeps `byId` on `this` for the counter; `TrainDayStats.overtakes`. |
| `src/sim/engine.ts` | `closeDay` (90): `stationsOpen: this.net?.staffedStations ?? this.net?.stations.length ?? 0` (line 102); `routeOvertakes: Object.fromEntries(tr.overtakes)`; `emptyReport` gets `{}` for the new records. |
| `src/sim/transitGraph.ts` | `trPen`, `platformTransfer` (§4.9); export `effectiveTransfers`. |
| `src/sim/commuters.ts` | `bestPath` (441), `arrive` (644), `newDayStats` (1034), `dayReport` (784): §4.9. |
| `src/sim/worker.ts` | `answer` `'route'` (85): add `overtakesToday: engine.trains.day.overtakes.get(q.route) ?? 0`. |
| `src/sim/headless.ts` | `stationNear(..., opts?: { role?: QuadRole })` filter (55); new `quadLine(game, pts, level, start?, end?, side?)`, `pairNear(game, p, name, cars)`, `buildExpressTestNetwork(game)` (§13); `buildPerfNetwork` option `quads?: number` (189). |
| `src/map/networkLayers.ts` | §4.10: `quadOffsets`, `pairOffsetAB` (exported pure), rail layers, blueprint/route/elevated offsets, `quadOffsets` property. |
| `src/map/stationLayers.ts` | §4.10 capsules; `update(is3D, quadQ)`; single label per pair; stats merged for radius/crowding. |
| `src/trains/trainLayer.ts` | `TrainDatum.express`; casing colour at line 71 (light casing for express). |
| `src/ui/toolTypes.ts`, `src/ui/toolManager.ts` | `Pointer.alt`. |
| `src/ui/dom.ts`, `src/ui/styles.css` | `bullet(..., express)` lozenge (§2.4); `.line-list` styles (spine, served/skipped rows). |
| `src/ui/panels/routePanel.ts` | Service section, Line list with toggles, Overtakes card, express bullet; `routeEditor` gets the same Line list + `E` seg; `routesList` shows the lozenge. |
| `src/ui/panels/stationPanel.ts` | Pair-aware kicker, kv `Platforms`, merged stats (two `station` queries), `Cross-platform transfers` card from `report.crossTransfers`; rename both (39-60). |
| `src/ui/panels/inspectPanels.ts` | Express bullet in the train panel (27). |
| `src/ui/app.ts` | `render` (338) and `onDayEnd` (423): `this.stations.update(is3D, this.network.quadOffsets)`; new provider `view.addLayers('route-pattern', …)` after `'stations'` (194) drawing skipped-station rings for the selected route (cached along-list). |
| `src/save/format.ts`, `src/save/migrate.ts` | §8. |
| `scripts/balance.ts` | `scenario=express` (§12). |
| `scripts/perf.ts` | `quads=N` flag passed to `buildPerfNetwork`. |
| `README.md` | Controls rows (§2.6), a "Four tracks and express service" paragraph in *Testing each part*, balance row for `scenario=express`. |

## 6. New files and their exports

**`src/construction/quad.ts`**:
- types: `QuadOptions { side: 1 | -1; spacing?: number; autoCrossovers?: boolean }`,
  `QuadResult { ok; fatal?; group; local: number[]; express: number[]; links: number[]; problems: string[] }`;
- geometry: `mitre(p, v, q, d)`, `concentric(r, turn, d)`, `turnSign(p, v, q)`;
- construction: `addQuadStroke(net, points, cls, startSnap, endSnap, opt)`,
  `buildTwin(net, legs, cls, spec)` (internal, exported for tests), `addScissors(net, g, edge, uA, uB, cls)`,
  `scissorsCandidate(net, edge, u, cls)` (slides to the nearest valid span for crossover mode);
- lookups: `partnerPoint(net, edge, u)`, `quadEndPartner(net, nodeId)`, `findStraight(net, legs, from, len, cls)`,
  `locateTagged(net, g, role, pt)`.

**`src/routes/express.ts`**: `AlongStation`, `stationsAlongPath`, `serveStops`, `skipStops`,
`expressPattern`, `allStopsPattern`, `choosePlatform`, `quadRole`.

**`tests/quad.test.ts`**: §13. The headless express case is added to `tests/headless.test.ts`.

## 7. Worker protocol additions (`src/sim/protocol.ts`)
All additions are **optional** fields, so the literal `CompiledNetwork` fixtures in
`tests/sim.test.ts:12-70` keep type-checking. `tsc` includes `tests/` (see `tsconfig.json`).

```ts
export interface CStation { /* … */ pair?: number; pairSameDir?: boolean }   // compiled index of partner (−1/absent = none)
export interface CRoute { /* … */ express?: boolean }
export interface CompiledNetwork { /* … */ staffedStations?: number }
export interface DayReport { /* … */
  /** Per route id: times its trains overtook another route's train between consecutive cross-platform stations. */
  routeOvertakes?: Record<number, number>;
  /** Per cross-platform station (key = lower station id of the pair): people transferring across the platform. */
  crossTransfers?: Record<number, number>;
}
```

The `'route'` query reply adds `overtakesToday: number`. There are no new message types. The compiled
network is still structured-clone plain data.

## 8. Save format v3

| Field | Where | Absent means |
|---|---|---|
| `nodes[].twin` | `NetworkData` | no twin |
| `edges[].quad` `{ g, role, away }` | `NetworkData` | ordinary double track |
| `stations[].pair` | `NetworkData` | lone platform |
| `routes[].express` | `RouteSetData` | `false` (set by migration) |
| `lastReport.routeOvertakes`, `lastReport.crossTransfers` | `game.lastReport` | `{}` |

```ts
// src/save/format.ts
export const SAVE_VERSION = 3;
// src/save/migrate.ts STEPS (line 9)
2: (s) => {   // v2 → v3: express routes and four-track sections
  const game = (s.game ?? {}) as Record<string, unknown>;
  const routes = (game.routes ?? {}) as { routes?: Record<string, unknown>[] };
  for (const r of routes.routes ?? []) r.express ??= false;
  const lr = game.lastReport as Record<string, unknown> | null | undefined;
  if (lr) { lr.routeOvertakes ??= {}; lr.crossTransfers ??= {}; }
  s.game = game;
  s.version = 3;
  return s;
},
```

The step only fills defaults and is idempotent (`??=`). If another v2 feature claims the v2→v3 bump
first, this becomes the v3→v4 step unchanged, or merges into a single v2→v3 step. Agents are still not
saved. `ModeState` is unaffected because the commuter groups don't change.

## 9. `balance.ts` section

```ts
// ---------------------------------------------------------------------------
// Four-track trunks and express service (v2)
export const QUAD = {
  spacing: 9,
  turnoutLength: 150,
  crossoverLength: 150,
  connectorMargin: 20,
  connectorSearch: 1500,
  autoCrossovers: true,
  partnerTolerance: 3,
  pairLinkDistance: 40,
  secondPairCostFactor: 0.75,
  linkCostFactor: 0.5,
  pairPlatformCostShare: 0.8,
  pairStaffing: 1.4,
  crossPlatformTransfer: 15,
  crossPlatformPenaltyFactor: 0.4,
  passPenalty: 600,
  linkPenalty: 250,
  pairGapPx: 3,
  railWidthPx: 1.3,
  railGapPx: 1.8,
};
```

| Key | Value | Rationale |
|---|---|---|
| `spacing` | 9 m | Centre to centre of two double-track pairs: four tracks at about 4.5 m. Narrow enough that the inner pair loses only 9 m of curve radius. |
| `turnoutLength` | 150 m | With 40 m leads it gives r ≈ 551 m (about 85 km/h, measured), so the split is nearly free running. |
| `crossoverLength` | 150 m | Same geometry as a turnout, and the same speed. |
| `connectorMargin` | 20 m | Above `canSplitAt`'s 15 m node and 5 m piece clearances, with slack for float noise. |
| `connectorSearch` | 1500 m | How far a fan may start from the snapped point before the stroke is refused. Keeps the result near the click. |
| `autoCrossovers` | true | Free-ended quads should switch both ways out of the box. |
| `partnerTolerance` | 3 m | Tolerance for matching partner points and partner ends; drags and float error stay well under it. |
| `pairLinkDistance` | 40 m | How far an existing platform on the other pair may be and still pair up. Clicks are not that precise. |
| `secondPairCostFactor` | 0.75 | The express pair shares excavation, structure and right of way. The whole quad costs about 1.75× a double track. |
| `linkCostFactor` | 0.5 | Connectors sit inside the four-track box. A scissors in deep tunnel costs about $42M. |
| `pairPlatformCostShare` | 0.8 | Shared entrances and mezzanine: a pair costs 1.6× a station, not 2×. |
| `pairStaffing` | 1.4 | One station complex with extra platform staff. |
| `crossPlatformTransfer` | 15 s | Step across an island platform, against v1's 60 s plus walk. |
| `crossPlatformPenaltyFactor` | 0.4 | A 2-minute penalty instead of 5. Cross-platform transfers are the point of local/express service; a 5-minute penalty would hide them. |
| `passPenalty` | 600 m | Larger than any length difference between the pairs (≤ 9·θ m) and smaller than real detours, so a route avoids unserved platforms only when there is a parallel alternative. |
| `linkPenalty` | 250 m | Stops routes weaving between pairs to gain the few metres on an inner curve. |
| `pairGapPx` | 3 px | Visible gap between the local and express bundles. |
| `railWidthPx` / `railGapPx` | 1.3 / 1.8 px | Four evenly spaced thin rails on unrouted quads, inside the width of a routed bundle. |

## 10. Performance (target: 300 stations / 25 routes / 400 trains / 285k agents at 60×; v1 has about 5× headroom)

- **Train sim per step.** Moving block and lock work is unchanged per train (§4.8). A quad *reduces*
  occupancy-list lengths, because expresses and locals no longer share a directed track. The overtake
  counter does O(≤ 6) work per arrival at paired stations only: about 400 trains × ≤ 1 arrival per
  minute is roughly 7 operations per game second. Dwell tracking is O(1).
- **Track and lock counts.** A quad edge doubles the directed tracks on its section. Each fan adds 1
  lock and each scissors 4. `occ` and `lockHolder` arrays grow linearly, which is negligible.
- **Transit graph and commuters.** `P` (platforms per route stop) is unchanged per route. Transfers
  grow only at pairs, by one partner per station. `trPen` is one more `Float64Array`. The access lists
  in `setNetwork` (`commuters.ts:346`) gain one entry per paired station, so the 0.5 s path build grows
  by about the share of paired stations: under 10% for a network with 30 pairs. Dijkstra cost is
  unchanged.
- **Route pathfinding.** `costModel` costs O(stations) per `findRoutePath` plus a memo per edge. Paths
  are cached in `RouteSet.path`.
- **Main thread.**
  - `quadOffsets`: O(E) per network render.
  - Capsules: O(pairs) per frame (about 100 two-point paths).
  - `stationsAlongPath`: only for the selected route or the draft, cached; about 1–2 ms on 300
    stations with bounding-box rejects.
  - Quad preview: one `clone()` (as in v1) plus up to 7 `addStroke` calls and a few filtered
    `pickEdge`s per mouse move. With 2,000 edges this is estimated under 4 ms. If profiling shows
    more, compute free-end crossovers only in `finish` and flag them as "added on finish" in the
    tooltip.
- **Verification.**
  - `npm run perf`: unchanged network, so the same numbers are expected.
  - `npm run perf -- quads=5`: turns 5 of the 17 north–south strokes into free/free quads with an
    express route each (adding about 5 routes and 60 trains). Target: the peak hour stays under
    300 ms of sim time (v1: 190 ms), and the per-frame cost stays at about 1 ms.

## 11. Determinism
- No new randomness. Quad group ids come from `Network.nextId`, which is serialised.
- Construction re-locates edges by position with tag filters (`pickEdge` returns the strict minimum,
  ties go to the first edge in `Map` insertion order). Repeated runs from the same edit history
  therefore produce identical networks.
- `costModel` iterates stations and edges in `Map` insertion order. The linear-scan heap tie-break in
  `legSearch` (`pathfind.ts:71`) is unchanged.
- The overtake counter depends only on train iteration order, which is the deterministic order of
  `this.trains`, and on sim time.
- Commuter changes are pure functions of the compiled network. The RNG streams in `commuters.ts:143`
  and `:147` are untouched, so `ModeState.key` and saved shares stay valid.

## 12. Balance impact

**Existing scenarios (no quads): unchanged by construction.**
- Paths are identical: there are no alternative paths, which a test asserts (§13).
- Transfer walks are identical: the replaced constant was `transferTime(d)`.
- Transit graph costs are bit-identical (§4.9).
- Staffing is identical (no pairs).
- Expected results, to be re-run after implementation:
  - `balance -- scenario=core days=12`: 1.33M riders, +$1.4M/day operating, −$0.28M/day after
    interest;
  - `scenario=sprawl`: −$0.8M/day;
  - headless test outputs: same numbers, within the existing assertions.

**New `scenario=express`** in `scripts/balance.ts`. It is the core network with the Lexington line's
Midtown and Upper East Side section drawn as a quad:
1. Draw the south part Bowling Green → Canal as double track.
2. Draw the north part from beyond 106 St to 120 St as double track.
3. Draw the quad between their end nodes, which fans at both ends.

Stations:
- cross-platform pairs at 18 St, Grand Central, 53 St and 92 St (`pairNear`);
- local-only stops at Astor Pl, 28 St, 68 St, 79 St and 106 St (`stationNear(..., { role: 'local' })`).

Routes:
- **Lexington Local**: all 13 stops, 5-minute peak headway;
- **Lexington Express** (`express: true`): Bowling Green, Fulton, Canal, 18 St, Grand Central, 53 St,
  92 St, 120 St; 5-minute peak headway. The combined 2.5 minutes on the shared ends equals the core
  scenario's `PEAK`.

Back-of-envelope expectation, to be confirmed by the script:
- **Extra capital: about $2.2B.**
  - Express pair: about 7.3 km × $280k × 0.75 ≈ $1.5B.
  - Two turnouts: about $42M.
  - Four partner platforms: 4 × 0.8 × $210M ≈ $0.67B.
  - Total capital rises from $23.2B to about $25.4B, still under the $20B bond cap with the $6B
    start.
- **Extra costs: about $0.31M/day.**
  - Interest at 2.5%: about $210k/day.
  - Maintenance: about $85k/day.
  - Staffing: about $13k/day.
  - Car-km is about the same at the same combined frequency. Expresses have shorter cycles and need
    1–2 fewer trainsets.
- **Ridership: about +3–6% (+40–80k boardings).** Upper East Side to Midtown and Downtown trips save
  about 4–5 minutes (5 skipped stops at about 55 s), and cross-platform transfers at Grand Central
  and 92 St cost 2 minutes instead of 5. Peak crowding on the core's Lexington section falls because
  long trips move to the express.
- **Net: about −$0.1 to −$0.2M/day against core.** A quad is a service-quality investment that pays
  back only on long, dense corridors. That is intended. The cheapest useful quad is a bypass with no
  partner platforms: the express pair at 0.75× plus about $42M of turnouts.

The tuning lever, if the script shows the scenario losing more than $0.3M/day relative to core, is
lowering `pairPlatformCostShare` to 0.7. If it makes money relative to core, the factors are too
generous: raise `secondPairCostFactor` to 0.85. The README balance table gets an `express` row with
the measured values.

## 13. Test plan

**`tests/quad.test.ts`** uses local metres, a dry terrain `{ isWater: () => false, density: () => 0 }`
and a stub `new Game({} as World, dry, { sandbox: true, fare: 3 })`. That is enough for
`compileNetwork`, `makeRoute` and `game.build(true)`, as checked in the scratch experiments. The file
needs no world data, so it belongs in `test:unit`.

*Quad geometry*
1. `mitre` on an L-shaped polyline (90°): the twin is at `(w, −w)`; both offset segments are exactly
   `w` from the originals; `|v' − v| = w/cos(45°)`.
2. `concentric`: a left turn with the express on the right gives `r + w`; on the left, `r − w`;
   `r = 0` gives `0`.
3. Parallelism: a free/free quad stroke with a 60° turn. Sample 200 points along the local chain
   between the express ends; the distance to the express polyline is within `w ± 0.1 m` everywhere,
   arcs included.
4. Side: express is on the right for `side: 1` (cross-product sign) and on the left for `side: −1`.

*Quad strokes*

5. Free/free straight stroke, with every edge `edgeReport.ok`:
   - 2 chains and 2 scissors (12 link edges);
   - one group id on every new edge;
   - `away` is −1 on the drawn edges and +1 on the express edges for `side: 1`;
   - all twin pointers are symmetric;
   - node degree ≤ 3;
   - `compileNetwork(...).net.lockCount === 8` (4 per scissors).
6. Fan start from a double-track end node:
   - the junction `J` has degree 3; the turnout radius is ≥ 500 m and its speed limit ≥ 22 m/s;
   - `findRoutePath` from a station on the approach reaches a local platform and an express
     platform;
   - `lockCount` is 1.
7. Fan at both ends (approach → quad → exit): 2 locks; the express route path from the approach to
   the exit uses no local-role edge between the turnouts.
8. Continue: a quad with a free end, then a quad stroke from its local end node. No new link edges at
   the joint; the express end node has degree 2; the group id is unchanged; the twin side follows
   the existing pair even with `side` set to the other side.
9. Fatal: a fan start into a zig-zag of 150 m segments gives `ok: false` and a message containing
   "straight". A 120 m quad gives "Too short".
10. Ramps and cost: a deep → elevated stroke gives both chains a ramp edge with the same end levels;
    the express edge cost is 0.75 × the matching local edge cost (±2%); link cost is ×0.5.
11. Twin drag: `moveNode` on a middle local vertex moves the twin so that the distance and the
    concentric radius still hold (±0.1 m); dragging a built twin's partner is refused.
12. Undo isolation: run `addQuadStroke` on `net.clone()`; the original network's tags are unchanged
    (guards the shallow-copy bug), and `toData → load` round-trips tags, twins and pairs.

*Crossovers*

13. `addScissors` on a free/free quad mid-span: four valid connector paths (each 40 + 70.5 + 40 m), and
    `findRoutePath` is ok for `[L_w, X_e]`, `[X_w, L_e]` and both reverses, each using link edges.
14. A scissors over a platform is refused with the reason text; `scissorsCandidate` slides to a valid
    span.

*Route pathfinding*

15. On a quad with scissors at both ends, pairs at A, C, E and local-only stops at B and D:
    - the express `[A_x, C_x, E_x]` uses only express-role and approach edges;
    - the local `[A_l, B, C_l, D, E_l]` uses only local-role edges.
16. Pass penalty on a bypass: line S1–S2–S3–S4, plus a platform-free bypass between junctions near S1
    and S4 that is 5% longer. Route `[S1, S4]` takes the bypass. With `{ passPenalty: 0 }` it takes
    the main line.
17. **v1 invariance**: on a local-coordinate copy of the test network (trunk plus branch, 16
    stations), both routes' `legs` and `stopS` are deep-equal with default costs and with
    `{ passPenalty: 0, linkPenalty: 0 }`.
18. `RoutePath.length` and `stopS` are distances, not costs: on 15, express `length` equals Σ leg
    lengths.

*Express patterns (`express.ts`)*

19. `stationsAlongPath` on the express in 15 lists A, C, E as served and B, D as `'beside'`, in path
    order, with increasing `s`.
20. `serveStops(B)` inserts B between A and C. With no crossover between A and C, the error says "no
    crossover". With scissors before and after B it succeeds and the path includes link edges.
    `skipStops(A)` (a terminal) returns an error; `skipStops(C)` removes it.
21. `expressPattern` turns the all-stops local `[A_l, B, C_l, D, E_l]` into `[A_x, C_x, E_x]`.
    `allStopsPattern` turns it back.
22. `choosePlatform`: an express draft picks the express platform; with Alt it picks the local one;
    an unpaired station returns itself.

*Cross-platform stations and commuters*

23. `addStationPair` gives two linked stations. Both `stationReport.ok` despite the partner being
    within 400 m along track through a crossover. Each costs 0.8× a single platform.
24. `removeStation` on one clears the other's `pair`. `Game.bulldozeStation` with the default removes
    both. Both are refused if either is served by a route.
25. `compileNetwork` sets `pair` indices symmetrically and `pairSameDir = true`;
    `staffedStations = N − pairs × 0.6`.

*`tests/sim.test.ts` additions (extend the tiny fixture)*

26. Transit graph with stations 2 and 6 as a pair: the transfer at the pair costs `15 + wait + 120`
    (0.4 × 300). `effectiveTransfers` returns 0.4 for that path and 1 for the normal interchange.
    The time reported by `bestPath` excludes exactly the penalty applied.

*Overtaking: train sim only, with no commuters (a fast unit test)*

27. **"lets expresses overtake locals on a quad and cuts their run time against a shared pair"**.
    This reproduces the scratch experiment with `addQuadStroke` and pairs.
    - Approach (0,0)→(2000,0), then a quad fanning from its end to (9000,0) with a free end.
    - Stations: S0 at 300 and S1 at 1300; pairs at 3000, 6000 and 8600; local-only at 3800, 4600,
      5300, 6800 and 7600.
    - Local route: all stops. Express route: `[S0, S1, A_x, C_x, E_x]`. Both 6-minute headways.
    - Run `new TrainSim(hooks)` from 06:00 for 4 h, recording `arrive` and `depart`.
    - Control: the same layout as plain double track, with the express on the shared platforms.
    - Assert:
      - mean express A→E (direction 0 and direction 1) on the quad is under 0.85 × the control
        (measured: 280 s against 462 s);
      - the quad express is within the scheduled time + 30 s;
      - `sim.day.overtakes.get(express.id) > 0`;
      - deadlocks are 0 in both runs;
      - every dispatched express completes a trip.
28. Fan merge stress: both routes at 3 minutes (1.5 minutes combined on the approach) for 4 h. Expect
    0 deadlocks (measured: 0) and quad lateness ≤ control lateness.

*Save*

29. `migrate()` on a v2 save object gives `version === 3`, `routes[].express === false` and
    `lastReport.routeOvertakes` set to `{}`. Running the step twice is a no-op.
30. `buildSave` → `JSON` → `migrate` → `applySave` preserves quad tags, twins, pairs and the express
    flag. `load` drops a dangling `pair`.

*Headless (`tests/headless.test.ts`)*

31. **"runs an express on a four-track West Side trunk"**. `buildExpressTestNetwork(game)` uses
    `buildTestNetwork`'s West Side waypoints:
    - double track from South Ferry to Houston (vertices 0–2);
    - a quad from vertex 2 to vertex 7, fanning at both ends;
    - double track from vertex 7 to Inwood (vertices 7–10);
    - pairs at 14 St, 34 St–Penn and 72 St; local-only stops at 23 St, 50 St, Columbus Circle and
      86 St;
    - routes: local all stops, and an express with `expressPattern` applied.

    The deflections at vertices 3–6 are ≤ 18°, giving fillets of about 1.5 km, so the inner pair is
    fine. Run 2 days at scale 10 and assert:
    - deadlocks 0, `stuckCount() === 0`;
    - express riders > 0;
    - Σ `crossTransfers` > 0;
    - Σ `routeOvertakes[express]` > 0;
    - finances finite;
    - riders within the existing plausibility bounds.

**Manual check in `npm run dev`:**
1. Draw a free/free quad and a fanned quad; watch the turnouts and scissors appear; drag a vertex.
2. Place a cross-platform station and a local-only one.
3. Make a local route, apply **Express pattern** to a copy, watch white-outlined trains overtake.
4. Toggle `Stop here` on a skipped station; save and load.

## 14. Risks and de-risking

| Risk | Mitigation |
|---|---|
| **Shared nested `quad` objects** between the live network, preview clones and undo snapshots (`toData` and `load` shallow-copy) silently corrupt tags. | Deep-copy in `toData` and `load`; never mutate tags in place; test 12. |
| **Edge ids change mid-construction** because every turnout or crossover splits edges. | All placement is by position with tag filters (`locateTagged`, `locateOnChain`), and tags are inherited through `splitEdge`. Tests 5–8 and 13 cover every end-mode combination. |
| The overtaking premise depends on the moving block treating pairs as separate tracks. | **Already verified against unmodified v1 code** with a hand-built quad: 280 s against 462 s, 0 deadlocks at 3-minute headways, lateness 47 → 4 s. It is kept as test 27. |
| Deadlocks at fans or scissors under heavy merge traffic. | Locks are the v1 FCFS ones (4 per scissors, measured), with the existing `lockStallRelease` and deadlock watchdog. Tests 28 and 31 assert 0 deadlocks. |
| Pathfinding penalties re-route v1 networks. | They apply only when alternatives exist; v1 invariance is test 17; `PathCostOptions` lets tests and debugging switch them off. Saves that re-route on load just get new paths, because the sim restarts from compiled routes anyway. |
| Twin desync (one pair built, or edited separately). | Sync only when both pairs are blueprint. Validation still guards geometry. Rendering only needs the tags, so a non-parallel twin still works and draws correctly. |
| Spacing rule through crossovers wrongly blocks stations. | The pair partner is ignored. Other cases are genuine (a station 300 m away along track through a crossover is too close), and the existing message names the conflicting station. |
| Visual kink where the express bundle jumps from the shared offset to +Q at a fan. | It is at most about 8 px over a 150 m turnout and only visible at mid zooms. A stretch item is a tapered offset on link edges. |
| Pixel offset against metric spacing at high zoom (the separation grows). | This is intentional and monotonic, so the pairs never cross. Picking stays on the cursor's side (§4.10). |
| Preview cost on big networks. | Measure; fall back to adding free-end crossovers only in `finish` (§10). |
| Save version collision with other v2 features. | The step is idempotent and only fills defaults (§8). |
| Cross-platform transfers concentrate load on expresses and cause crowding. | That is realistic and visible through the crowding overlay; `crossPlatformPenaltyFactor` is the knob. The balance scenario reports the peak left-behind count. |
| Overtake definition misses overtakes not bracketed by two shared pairs. | Documented in the stat card tooltip ("between cross-platform stations"). Test 27 covers it. |

## 15. Ordered implementation checklist

Each step ends green on `npm run typecheck` and `npm run test:unit`.

1. **Types and constants.** Add `QUAD` to `balance.ts`, the types in `construction/types.ts`,
   `Route.express?`, the optional protocol fields (§7) and `Pointer.alt`. Typecheck only.
2. **Geometry helpers** in `quad.ts` (`mitre`, `concentric`, `turnSign`). Tests 1–2.
3. **Network primitives.** `addChain`; `splitEdge` tag copy; deep-copy in `toData`/`load` and
   dangling-reference cleanup; `edgeBetween`; `syncTwins` hooked into `moveNode`; `addStationPair`
   and `linkPair`; pair/twin cleanup in `removeEdge`/`removeStation`. Test 12, partly.
4. **Quad construction.** `findStraight`, `quadEndPartner`, `partnerPoint`, `locateTagged`,
   `buildTwin`, `addQuadStroke`, `addScissors`, `scissorsCandidate`. Tests 3–11 and 13–14.
5. **Validation and cost.** `edgeReport` cost factors; pair-aware `stationReport` and
   `nearestStationAlongTrack`; the `describe.ts` tooltip row. Tests 10 and 23.
6. **Pathfinding.** Cost model with `dist`, `trackPath`, the `costs` parameter. Tests 15–18. **Run
   the full suite**: the v1 headless numbers must be unchanged.
7. **Routes.** `express` in `RouteSet` and `RouteDraft`; `routes/express.ts`. Tests 19–22.
8. **Compile, worker and sim.**
   - Compile: `pair`/`pairSameDir`/`express`/`staffedStations`.
   - Engine `closeDay`.
   - Interchange helpers; `TransitGraph` `trPen` and `effectiveTransfers`.
   - Commuters `arrive`/`bestPath`/day stats.
   - TrainSim overtake counter.
   - Worker route reply.

   Tests 25–28.
9. **Save v3.** `SAVE_VERSION`, migration step, `Network.load` sanitising. Tests 29–30.
10. **Track tool UI.** Modes, keys, preview by role, tooltips, options card, crossover mode, finish
    or refuse. Manual check.
11. **Station and bulldoze UI.** Pair, link and single modes; pair-aware bulldoze;
    `Game.bulldozeStation`; station panel pair view and rename-both.
12. **Route UI.**
    - Lozenge `bullet` and CSS.
    - Route tool: `E`, `choosePlatform`, insert-in-order, skip rings.
    - Route panel: Service section, Line list with toggles, Overtakes card.
    - `routesList` and inspect panel bullets.
13. **Rendering.** `quadOffsets` and `pairOffsetAB` (unit-test the sign convention with `orientEdges`
    on a reversed chain); rail layers and blueprint offsets; route and elevated offsets; station
    capsules (`metresPerPixel`); express train casing; App wiring (`stations.update(…, quadOffsets)`,
    the `route-pattern` provider).
14. **Headless and scripts.**
    - `stationNear` role filter, `quadLine`, `pairNear`, `buildExpressTestNetwork`; test 31.
    - `scripts/balance.ts scenario=express`.
    - `perf quads=N`.
    - Run `balance -- scenario=core days=12`, `scenario=sprawl days=8` (unchanged) and
      `scenario=express days=12`, plus `perf` and `perf -- quads=5`. Record the results.
15. **README.** Controls rows, a *Testing each part* paragraph, the balance table row with measured
    numbers, and a known-issues note on the flying crossover abstraction.

**Stretch, if time remains:**
- **Retrofit "Add express pair"**: track tool, 4-track mode, `A`, click two points on existing
  track. Implemented as `addExpressPair(net, a, b, cls, side)` = `trackPath` + `buildTwin` with fan
  ends at both points. Existing stations get partners with the station tool's link mode.
- An **express comparison** line in the route panel: "vs 1 Local: 14 St → 72 St in 6.1 min vs
  9.4 min", from `routeTimetable` on both routes between their first and last shared pairs.
- A white centre stripe on express route lines on non-deep levels.
- Tapered link-edge offsets at fans.
- A "first overtake" toast and goal ("Run an express that overtakes 100 trains in a day").

## 16. Size estimate

| Part | Lines |
|---|---|
| `quad.ts` | ≈330 |
| `network.ts` / `types.ts` | ≈110 |
| `validate.ts` / `describe.ts` | ≈25 |
| `pathfind.ts` | ≈55 |
| `express.ts` | ≈150 |
| Route tool, `routeSet`, `types` | ≈50 |
| Compile, protocol, engine, trainSim, commuters, transitGraph, interchange, worker | ≈130 |
| Save | ≈25 |
| Track, station and bulldoze tools, `game.ts` | ≈250 |
| Panels, DOM, CSS | ≈160 |
| `networkLayers`, `stationLayers`, `trainLayer`, `app`, `geo` | ≈160 |
| Headless helpers and scripts | ≈100 |
| **Core source total** | **≈1,550** |
| Tests | ≈450 |
| Stretch | ≈200 |

Difficulty is **high but bounded**. The risky parts are the geometry and the edge-id churn, which are
pure, unit-tested code in `quad.ts`. The simulation needs no new mechanics, as the v1 experiment
shows.
