# v2 design: express services and four-track trunks

Status: **implemented** (checklist steps 1–15): construction (steps 1–5), the simulation side,
saves and scripts (steps 6–9 and 14: pathfinding, routes, compile, the sim, save v6, the headless
helpers, `balance scenario=express` and `perf quads=N`, and the interplay with city chaos,
operations control and Living City), and the UI and README (steps 10–13 and 15); implementation
notes for all three below. The stretch items (§15) are not built. The design below predates London, city
chaos, operations control and Living City. Its `file:line` references are to the v1 tree at commit
`a27dbfa` and are stale. **Where the code and this design disagree, trust the code and the task's
amendments** (saves are v5 → v6, not v2 → v3).

## Implementation notes (review fixes)

Two reviews (eleven findings) and the sim engineer's balance measurements, fixed after the UI
notes below; this section supersedes the balance figures in the sim notes. Baseline `pre-express`.
**A network with no quads and no express routes is still byte-identical to `pre-express`**: every
change is on quad tags, pairs or express routes (checked as before: `headless-sim days=3`, `balance`
core and sprawl in both cities at 8 days, core days=25 in both cities and sprawl days=25 across the
31 Jan month close on Steady; `dump=` files and printed output identical apart from timings; `npm
run perf` the same 40,320 boardings and 1,090 waiting).

### Findings

1. **The express-pair discount outlived the local pair** (bulldozed blueprints, then build:
   ×0.75 on plain double track). `quadCostFactor(net, e)` now prices an express edge by
   `partnerCoverage` (the share of its length with an other-role edge of its group 9 m to the
   partner side, sampled every ~20 m): ×factor where the local pair runs alongside, ×1 where it
   doesn't, prorated between; a connector is discounted only while its group has both pairs. The
   edge tooltip says which ("no local pair alongside, full price").
2. **Drags beside a fan desynced the pairs.** A twinned vertex next to a fan junction (whose
   counterpart on the other pair is the turnout's far end, not opposite it) now slides along that
   junction's axis; between two fans it can't move ("pinned", with its own red tip); a twin fillet
   that would overrun its own shorter chord next to a fan shrinks both fillets concentrically. The
   reviewer's fuzz (2,142 random drags): 141 desyncs before, now 0 silent and 1 flagged on *both*
   pairs (a vertex between a fan and a scissors dragged past the 2° junction tolerance, which v1
   flags the same way on ordinary track).
3. **Blueprint platforms re-routed running locals.** `RouteSet.path`'s built-track search counts only
   built platforms as ones a route passes (`PathCostOptions.platform`).
4. **Load accepted nonsense.** `sanitizeQuadTag` drops pair tags with `away` 0;
   `Network.dropImplausible` drops twins more than 60 m apart and pairs that are not one platform on
   each pair of one group within `hypot(spacing, pairLinkDistance) + tolerance` of each other.
5. **Headless timeouts.** The three headless files set `testTimeout: 180_000` (`vi.setConfig`).
6. **Alt-click** switches a served pair's platform each time (`switchPlatform`), the hover hints are
   worded from the platform a plain click picks, and a path error on four tracks adds the crossover
   hint (`pathErrorHint`).
7. **Event cards** list a pair once: `stationsNear` dedupes by station complex (nearer platform).
8. **Construction labels**: one per pair of twin edges (`constructionLabelEdges`).
9. **Line list tags** wrap onto their own line under the name (CSS).
10. **A bulldozed stretch of one pair can be put back**: a four-track stroke from one end of the gap
    to the other (`repairPair`) rebuilds it as the exact parallel of the surviving pair (tags, twins,
    concentric fillets); a two-track stroke between the ends takes the pair's tag where it runs
    beside the other pair (`rejoinPair`). The bulldoze and track tool hovers say so.
11. **Service edits that change nothing** (Express pattern on an express) edit nothing and say so.

### Balance: why the express made the core worse, and what changed

Measured with `balance scenario=express` against its all-stops twin (`allstops=1`: the same
stations on double track; in New York the core itself), day 11 of 12, plus a same-commuter
comparison (groups are the data's OD pairs, identical in both runs) of trips that pass at least
three of the express's skipped stations:

- **Riders waited for one route**, so a station both routes served at 5 minutes each waited twice as
  long as the core's 2.5-minute line. Now a rider waiting for one route boards another route's train
  at the same station complex (or across the island just as it arrives) when its ride to their
  stop's complex is no longer than their own route's plus half its headway (`boardSiblings`; only
  where one of the two routes is an express).
- **Changing across the platform never paid** (15 s + half the express headway + the 2-minute
  penalty against one or two skipped stops). Now riders on a train at a cross-platform station move
  to another route's train dwelling across the island when it reaches their stop's complex sooner
  by more than 15 s + `QUAD.switchGain` (45 s), and riders on a local step across to wait for an
  express due there within `QUAD.crossPlatformWaitMax` (5 min, by its timetable from where it is now)
  when that still gets them there sooner. Mode choice sees it through the observed times.
- **Express and local ran as a pair.** Dispatch slots are multiples of the headway for every route,
  so two routes at one headway left their shared terminal together. An express now leaves half a
  headway after an ordinary route's slots (`TrainSim.runDispatch`, express routes only), so the two
  alternate at the shared stations (overtakes: NYC 101 → 169, London 11 → 194 a day; test 27's
  shared-pair control now runs 334 s instead of 462 s, the quad express still 280 s).
- **The scenarios skipped too little.** The design's pairs (four in each city) left one or two
  local stops between them. Now the express calls only at the hubs: New York Grand Central and 92 St
  (the other seven trunk stations local-only), London Oxford Circus and Bank with the Central line's
  Chancery Lane added (five local-only). London's line D leaves out its three least-used central
  stations (Covent Garden, Temple, Tower Hill: about 16k boardings between them), which is what
  fits it under the bond cap; Bond Street as a sixth local stop would leave £2M of headroom.
- **The express pair's capital is the whole money gap.** With it free (`secondPairCostFactor` 0)
  the New York express runs within $59k a day of the core (London £42k). The trunk's through trips
  already go 85% (London 95%) by transit, so faster trips win few new commuters, and splitting the
  trains halves the service at local-only stations: fare journeys stay level in every split tried
  (5/5, 2.5/5, 3.75/7.5, 3.33/10, 4.17/6.25 minutes; shorter local trains) and in a 30-day
  converged run. `secondPairCostFactor` is now 0.5 (a four-track section 1.5× a double track, the
  historic ratio, against 2× for a second line) and `pairPlatformCostShare` 0.7 (§12's own lever:
  the scenario lost more than $0.3M/day against the core). Value capture doesn't move (Living City
  12 months: $354k against $353k a day).

| Day 11 of 12 | NYC core (twin) | NYC express before | NYC express now | London twin | London express before | London express now |
|---|---|---|---|---|---|---|
| Capital (bonds) | $23.3B ($17.3B) | $25.7B | $24.7B ($18.7B) | £23.9B (£18.9B) | £26.6B (£21.6B, over the cap) | £24.8B (£19.8B) |
| Riders | 1,349,870 | 1,346,070 | 1,364,130 (+1.1%) | 761,920 | 761,400 | 763,580 (+0.2%) |
| Fare journeys | 1,204,510 | — | 1,202,070 | 761,920 | — | 759,320 |
| Cross-platform transfers a day | — | 0 | 16,855 | — | 0 | 3,639 |
| Through trips by express, door to door (same commuters) | 53.0 min | — | 45.8 min | 52.9 min | — | 52.2 min |
| Overtakes a day | — | 170 | 169 | — | 148 | 194 |
| Operating result | +$1.37M | +$1.3M | +$1.28M | −£0.28M | −£0.43M | −£0.33M |
| After bond interest | −$0.28M | −$0.63M | −$0.51M | −£2.09M | −£2.5M | −£2.23M |

So three of the four aims hold in New York (riders up, through trips 7.2 minutes faster, transfers),
London gains little (its line A is uncrowded and its through trips are dominated by long walks: an
Oxford Circus–City express saves 4–5 minutes of a 50-minute door-to-door trip), and **neither city's
express earns its four-track works back in fares**: the gap after interest shrank from $0.35M to
$0.23M a day (London £0.3M to £0.14M), and closing it would take about 38,000 more transit commuters
(+6%) or an express pair almost free. `localPeak=2.5 expressPeak=5` (the local kept at the core's
headway): 1,381,480 riders, −$0.63M/day (London 763,170, −£2.39M and over the cap).

`balance` gained `allstops=1` (the twin), `localCars=`/`expressCars=`, `exact=1` (the money lines in
thousands) and the through-trip line; `scripts/scenarios.ts` holds the networks.

### Tests

301 pass (274 unit, 27 headless): the 283 before, plus `quad.test.ts` (pricing beside a pair and
prorated, drags beside a fan, pinned vertices, fillets that shrink to fit, load sanitising, repairing
a gap both ways), `expressUi.test.ts` (Alt-click, the path hint, blueprint stops, event cards,
construction labels, no-op Service edits, the bulldoze hint) and `express.test.ts` (the first train
of either on a synthetic trunk city, stepping across to an express in and to one due).

## Implementation notes (construction)

Baseline: the `pre-express` tag. This covers checklist steps 1–5: constants, types, network
primitives, quad construction, and validation and cost. It finishes the WIP commit `a14f37e`,
which had the step-1 types and constants and the geometry helpers; I kept all of it. Nothing
outside `src/construction/` changes behaviour. For a network with no quads, `toData()` is
byte-for-byte the same (no new keys), costs are multiplied by exactly 1, and `headless-sim days=3`
gives a byte-identical `dump=`.

### What exists

- **`src/balance.ts` `QUAD`**: the keys from §9, plus `minLength: 200`. An express pair shorter
  than that, measured between its turnouts or ends, is refused ("Too short for four tracks").
  The constants are shared by both cities. Costs, levels and the water rule come from
  `TRACK`/`STATION` and the city's terrain, as for any track.
- **Types.** `src/construction/types.ts` has `QuadRole`, `QuadTag { g, role, away }`,
  `TrackNode.twin?`, `TrackEdge.quad?`, `Station.pair?` and `ChainVertex`. `src/routes/types.ts`
  has `Route.express?`. `src/sim/protocol.ts` has the optional fields from §7 (nothing sets them
  yet). `src/ui/toolTypes.ts` has `Pointer.alt`, which `ToolManager.pointer` sets from `altKey`;
  `App`'s synthetic route-tool click passes `false`.
- **`src/construction/geometry.ts`**: `XY`, `mitre(p, v, q, d)` (null for a turn sharper than
  about 162°; with `p` or `q` null it gives a square offset), `concentric(r, turn, d)` (0 stays 0;
  never below 1 m, so validation reports a too-tight inner curve) and `turnSign`. They live here so
  `network.ts` can keep twins parallel without importing `quad.ts`, which re-exports them.
- **`src/construction/network.ts`**:
  - `toData`/`load` deep-copy `quad`. `load` drops malformed tags (a link's `away` is normalised
    to 0) and dangling or one-way `twin`/`pair` references. `removeEdge` cleans up references the
    same way (private `dropDangling`).
  - `splitEdge` gives both halves a copy of the tag.
  - `addChain(verts, cls, status?)` returns edge ids in order, running a→b along the list.
    `existing` ends are made anchors when they have track. Other vertices get their explicit `r`
    (no autoFillet), `twin` (linked both ways) and `leadOf` (an index into `verts`).
  - `edgeBetween(a, b)`.
  - `syncTwins(ids)` runs at the end of `moveNode`. `moveNode` is refused when the vertex has a
    twin that is not a blueprint.
  - `addStationPair(e1, u1, e2, u2, cars, name, status?)` returns `[platform on e1, platform on
    e2]`. `linkPair(a, b)` unlinks any previous partners. `removeStation` makes the partner a lone
    platform.
- **`src/construction/quad.ts`**:
  - Types: `QuadOptions { side, autoCrossovers? }`, `QuadResult { ok, fatal?, group, local,
    express, links, double, edges, problems }`, `EndMode`, `QuadLeg { edge, dir }` (a `PathLeg`
    is one), `StraightSpan` and `TwinSpec`.
  - Construction: `addQuadStroke`, `buildTwin`, `addScissors(net, g, edge, uA, uB, cls,
    onStroke?)` and `scissorsCandidate(net, edge, u, cls)`, which returns `{ ok, g, edge, uA, uB }`
    or `{ ok: false, reason }`.
  - Lookups: `partnerPoint`, `locateTagged(net, g, role, pt, tol = 1)`, `quadEndPartner`,
    `sideOfPartner`, `endModeOf(net, snap, 'start' | 'end')`, `findStraight`, `pointAt`,
    `otherRole` and `relabel`.
- **`src/construction/validate.ts`**:
  - `quadCostFactor(e)`: express ×0.75, link ×0.5, otherwise exactly 1. It is applied in
    `edgeReport`.
  - `stationReport(..., ignoreStation, opts: { paired?, partner? })`. `partner` defaults to the
    `pair` of `ignoreStation`, and `paired` defaults to whether there is a partner. A paired
    platform costs ×`pairPlatformCostShare`, and the partner is ignored by the spacing rule.
  - `nearestStationAlongTrack(..., ignore, ignore2 = null)`.
- **`src/construction/describe.ts`**: `quadLabel(e)` and a "Four-track" row in `edgeTooltip`
  ("Local pair", "Express pair · shared works ×0.75" or "Turnout or crossover · ×0.5").
- **`tests/quad.test.ts`** (22 tests, in `test:unit`): §13 tests 1–14 and 23, the network half of
  24, splits and `edgeBetween`, `findStraight` (both directions and reversed legs), load
  sanitising, group joining, and two London checks on the real land mask:
  - a deep quad along the Oxford Street corridor (Marble Arch → Bank) with a cross-platform pair
    at Oxford Circus;
  - Bank → London Bridge → Borough under the Thames: both pairs are valid at deep level and both
    are flagged at cut-and-cover;
  - a quad fanning off an existing London line (1 turnout lock + 4 scissors locks).

### How to use it (track, station and route tools)

- **Track tool, quad mode.**
  - Preview: run `addQuadStroke(net.clone(), points, cls, startSnap, endSnap, { side })`.
    `result.edges` lists every new edge for the per-edge reports. Colour each edge by its tag's
    role: `double` edges are ordinary track. `fatal` is the red line, and `problems` are the amber
    ones.
  - Finish: decide on the clone first and only call `editBlueprint` when the result is ok. A
    refused stroke restores the network itself (snapshot + `load`), but `editBlueprint` would
    already have recorded an empty undo step.
  - Hover text: `endModeOf(net, snap, …)` says whether an end is free, fan or continue, and
    `quadEndPartner` finds the free end pair.
- **Crossover mode (X).**
  - Hover: `scissorsCandidate`. To preview, run `addScissors` on a clone.
  - Click: `editBlueprint(() => addScissors(net, c.g, c.edge, c.uA, c.uB, cls))`.
- **Station tool.**
  - Placement: `partnerPoint(net, hit.edge, hit.u)` gives the other platform's position. Price
    both platforms with `stationReport(…, null, { paired: true })`, then place them with
    `addStationPair`.
  - Link mode: price the new platform with `{ partner: existingId }`, then call `linkPair`.
  - Once placed, `stationReport(…, s.id)` finds the partner by itself, which is how
    `blueprintSummary`/`commitBlueprints` already call it.
- **Routes and compile.** Roles are on `edge.quad.role`. A stroke that continues an *express*
  free end draws the express pair, and its twin is the local pair. So always read roles from the
  tags, never from "drawn" or "twin".

### Deviations from the design

1. **Free ends are twinned too.** The design twins only degree-2 vertices. Twinning the ends as
   well means a dragged free end keeps its partner beside it, so "continue" still finds the pair.
   `syncTwins` offsets a degree-1 vertex square to its one edge. After a continue, the joined ends
   become degree-2 anchors and keep their (symmetric) twins. `syncTwins` never moves an anchor or
   a junction, and a twin that has since become a junction simply stops following (no refusal).
2. **Ordered paths instead of `locateOnChain`/`edgesAlong`.** The drawn path and the new pair are
   kept as ordered leg lists, updated from `Network.splitMap` after every connector stroke
   (`PathTracker`).
   - The end turnout is placed by path position, taken before any split.
   - The drawn path is tagged first, so splits inherit the tag, and then untagged outside its
     turnouts.
   - Free-end crossovers are both chosen before either is built. The second is re-found with
     `locateTagged`, as in the design. `addScissors` takes an `onStroke` callback for the trackers.
3. **Refusals leave nothing behind.** Every `buildTwin` refusal happens before any change.
   `addQuadStroke` snapshots before allocating the group id and drawing, and restores the snapshot
   on refusal (`nextId` included; `version` still bumps).
4. **`QuadOptions.spacing` is dropped.** `partnerPoint`, `quadEndPartner` and `syncTwins` all use
   `QUAD.spacing`, so a per-stroke spacing would break them.
5. **The "too short" rule** is `QUAD.minLength` (200 m of express pair), not the design's 50 m gap.
6. **`findStraight`** checks `canSplitAt` at both ends of the span and slides within a straight
   piece in 10 m steps, so it also works on track with platforms. The search distance is measured
   to the junction.
7. **A continued end's twin lead is projected onto the partner end's axis.** This absorbs any drag
   error within `partnerTolerance`, so the joint leaves the old track straight.
8. **Extra refusals:** "A pair can't join its own partner", and "The two four-track ends are on
   different pairs" (one end continues a local pair and the other an express pair).
9. **`QuadResult` has `double` and `edges`.** `double` holds the drawn edges between a fan's
   attachment and its turnout. Both feed the preview.
10. **`buildTwin` takes whole edges** in travel order (`dir` respected; `u0`/`u1` ignored). The
    stretch retrofit (§15) must split the path at its two fan points first.

### Gotchas

- **Edge ids change at every connector.** Never hold an edge id across `addStroke` or
  `addScissors`. Use positions with tag filters (`locateTagged`) or the result arrays.
- **Tags are replaced, never mutated** (`e.quad = { ...e.quad, g }`); `delete e.quad` is fine. The
  undo snapshots, preview clones and live network each have their own copies (test 12).
- **Turnout and scissors geometry:**
  - A turnout runs J → 40 m lead → 70.5 m diagonal → 40 m lead → X, with r ≈ 551 m (85 km/h).
    J is a degree-3 anchor on the drawn pair; X is the other pair's end, a degree-2 anchor.
  - A scissors is two such connectors crossing, with no node between them. Every junction has
    degree ≤ 3.
  - The unchanged `mergeLocks` gives 1 lock per turnout and 4 per scissors (tests 5–7, 13).
- **A fan's turnout starts about 60 m past the attachment point** (40 m lead + 20 m margin), not
  "150 m in" as the §2.1 hover text says; the express pair itself starts 150 m after that.
- **Plain v1 pathfinding already handles quads.** It keeps a local route on its pair (the
  crossovers are longer), and a route with an express platform between two fans uses no local edge
  between the turnouts (test 7). The pass and link penalties (§4.6) are only needed where a route
  *skips* platforms. Gate them so ordinary networks keep their paths (amendment 3).
- **Interchanges.** The two platforms of a pair are 9 m apart, so `computeInterchanges` (200 m)
  already puts them in one interchange group. The compile engineer should decide how `pair`
  relates to that.
- **Pricing a pair.** When a link-mode pair is made, the existing blueprint platform's price drops
  to 0.8× as well. A built platform's cost is already spent, so it doesn't change.
- **Speed.**
  - Preview (`clone()` + `addQuadStroke`): about 3 ms on a 2,000-edge network (the clone alone is
    1 ms), and 1.2 ms on the perf grid.
  - `quadEndPartner` is O(nodes), only on snap and finish.
  - `removeEdge` and `load` add one O(nodes + stations) scan.
- **Determinism.** There are no random numbers. Group ids come from `nextId`, and `pickEdge` ties
  go to `Map` insertion order.
- **Copy.** Distances in refusal and problem messages go through `fmtDistance`, so they follow the
  units setting ("190 m" / "623 ft").

### Verification (construction)

- `tsc` is clean, and `npm test` passes 247 tests (225 + 22).
- `headless-sim days=3 dump=` is byte-identical to a fresh run of the `pre-express` worktree.
- `balance` core and sprawl (days=3, `dump=`) are byte-identical to the tag in both cities.

## Implementation notes (sim)

Checklist steps 6–9 and 14, plus the non-UI plumbing the UI needs, built on the construction notes
above. Baseline: the `pre-express` tag. **A network with no quads and no express routes runs
bit-identically to `pre-express`** (amendment 3; how the gate works and what was checked is under
*Identity*).

### What exists

- **Pathfinding (`src/routes/pathfind.ts`).** `PathCostOptions { passPenalty?, linkPenalty? }`,
  `findRoutePath(net, cls, stops, usable?, costs?)` and `trackPath(net, A, B, usable?, costs?)`
  (the cheaper departure direction's merged legs; for the stretch retrofit). `legSearch` carries the
  track distance of each label alongside its cost, so `RoutePath.length` and `stopS` are distances.
  The cost model is gated to four-track sections (below).
- **`src/routes/express.ts`**: `AlongStation`, `stationsAlongPath`, `stationsAlongRoute` (cached per
  route by network version, stops and path), `serveStops`, `skipStops`, `expressPattern`,
  `allStopsPattern`, `choosePlatform`, `quadRole`, `partnerOf` and `pairKeyId` (one id per station
  complex: the lower id of a pair whose platforms are both built, as compile pairs them).
- **Routes.** `RouteSet.create` sets `express: partial.express ?? false`; `load` sets
  `express: r.express === true`. `RouteDraft.express` (route tool) is carried by `newDraft`,
  `editRoute`, `asRoute` and `save`; the `E` key, Alt-click and insert-in-order are UI work.
- **Compile.** `CStation.pair`/`pairSameDir` only where both platforms are built (headings at the
  two platforms, dot ≥ 0). `CompiledNetwork.staffedStations = stations − pairs × (2 −
  pairStaffing)`, only when there is a pair. `CRoute.express: true` only on expresses.
  `hasExpressService(net)` (protocol.ts): a pair or an express route.
- **Engine.** `closeDay` uses `staffedStations ?? stations.length` for `stationsOpen`, and adds
  `routeOvertakes` and `crossTransfers` to the day report **only when `hasExpressService`**.
  `Commuters.crossTransfersToday()` is read before `dayReport` resets the day.
- **Interchange helpers** (`src/routes/interchange.ts`): `platformTransfer(a, b, bIndex)` (15 s to
  the partner, else exactly `transferTime(distance)`) and `transferPenaltyFor(a, bIndex)`.
- **Transit graph.** `trPen: Float64Array | null`, null without pairs; `run` then keeps the old
  scalar loop (`+ penalty`), otherwise uses `+ trPen[k]`. `effectiveTransfers(net, legs)`
  (transitGraph.ts) counts 0.4 across a pair, 1 otherwise.
- **Commuters.** `bestPath` reports `transfers = effectiveTransfers(...)` and subtracts that many
  penalties; `arrive` walks 15 s to the partner (else the old `hypot/(1.2·walkSpeed) + 60`) and counts
  `crossTransfers` by the pair's lower station id.
- **TrainSim overtake counter.** Inert without pairs (`pairOn`). Tables built in `setNetwork`
  (`buildPairs`): `pairKey` per station, and per route direction and stop `stopSgn` (travel sign
  along the pair's reference platform) and `nextPairAt`. `notePair` runs in `arriveAt`; the last
  pair call per train is in a `Map` by train id (not on `Train`, which is hot), cleared by `toReady`
  and on every network change. Arrival logs keep 30 min and at most 16 entries per pair and sign.
  `TrainDayStats.overtakes: Map<routeId, number>`.
- **Worker.** The `'route'` reply adds `overtakesToday`; `RouteDetail.overtakesToday?` is declared
  in `routePanel.ts` for the UI.
- **Saves v6.** `SAVE_VERSION = 6`; one step `5 →`: `routes[].express ??= false`,
  `lastReport.routeOvertakes ??= {}`, `lastReport.crossTransfers ??= {}`. Quad tags, twins and pairs
  are optional network fields; `Network.load` drops malformed tags and dangling or one-way references
  (construction step).
- **`Game.bulldozeStation(id, { withPartner = true })`**: a pair goes together (refunds both built
  platforms), refused if a route serves either; `withPartner: false` removes one platform.
- **Headless (`src/sim/headless.ts`).** `stationNear(..., { role })`, `quadLine(game, pts, level,
  start?, end?, side?, cls?)` (throws if refused), `nodeSnapNear(game, lonLat)`, `pairNear(game,
  lonLat, name, cars?) → [local, express]`, `makeRoute(..., control?, express?)`,
  `buildExpressTestNetwork(game)`, `buildLondonExpressTestNetwork(game)` and
  `buildPerfNetwork({ quads })`.
- **Scripts.** `balance scenario=express` (both cities; `localPeak=` / `expressPeak=` override the
  two routes' peak headways) prints each route's run times, trains, riders, lateness and overtakes and
  the cross-platform transfers. `perf quads=N` turns N north–south lines into free/free quads (pairs at
  the terminals and every third stop, an express per line) and prints the overtakes.

### Identity (amendment 3)

- **The pathfinding gate.** Penalties apply only to *unserved platforms on a local- or express-pair
  edge* and to *entering a run of link edges*. Ordinary track always costs exactly its length, and
  each cost term is computed as before plus a penalty that is exactly 0 there (`x + 0 === x`), with
  the distance summed in the same order. So on a network without quads every path, `stopS` and
  `length` is bit-identical, whatever the route skips. Tests 16 (an ordinary bypass is still not
  taken) and 17 (deep-equal paths with default and zero penalties) assert it.
- **Reports.** `routeOvertakes`/`crossTransfers` appear only with a pair or an express route;
  `staffedStations` and `CStation.pair` only with pairs; the transit graph keeps its scalar loop.
- **Checked** against a worktree of the tag (`git worktree add <scratchpad>/xq/base pre-express`,
  `node_modules` symlinked), comparing `dump=` files byte for byte: `headless-sim days=3`;
  `balance` core and sprawl (8 days) in both cities; `balance scenario=core days=25` in both
  cities (crossing the 31 Jan month close on Living City's default Steady pace). All identical, and
  the printed output matches apart from timings. `npm run perf`: the same 40,320 boardings and
  1,090 waiting in the peak hour.

### Chaos, operations control and Living City

- **Incidents on quad edges** work unchanged: each pair is its own directed tracks, so a stalled
  local queues locals only and a crawl on the express pair slows expresses only (tests). The
  watchdog's route groups (shared track or lock) put a quad's local and express in one group
  through the fan or the shared approach, so an incident on either covers both.
- **A closed pair: both platforms close.** A cross-platform station is one complex with shared
  entrances, so police at either platform close both (`firePolice`); the alert carries
  `partnerStationId`, which `AlertFeed.closedStations`/`activeFor` honour. Police targets and the
  exposure (`measureExposure().stations`) count a pair once; its busy weight sums both platforms.
- **Event service** overrides are per route id, so they work on expresses as on locals (test:
  more express departures, more overtakes, no deadlocks).
- **Holding.** A train held at a timepoint sits on its own pair's track; the yield rule only looks
  at its own path's tracks, so an express passes a held local (and the other way round). Terminal
  holds are off the running track as before. Timepoints follow the stop list (`RouteSet.update`
  filters them), so skipping a timepoint drops it; `suggestTimepoints` only picks served stops.
  Recovery and fleet sizing use each route's own compiled run time (the express's is shorter).
  Regularity is per route and per stop index, so an overtake never reads as bunching (test 27 checks
  CV and bunching per route).
- **Fares** are unchanged (billed at the first boarding; a cross-platform transfer is free).
- **Living City.** `servedStations` lists a pair once, under its lower station id at the midpoint
  of its platforms, when a route calls at either platform. A platform no route calls at is never
  served (skipping is leaving it out of the stop list); a local-only stop skipped by the express
  is served if the local calls there. The station panel looks its value capture up by `pairKeyId`.

### Deviations from the design

1. **Penalties are gated to four-track sections** (above). The design's test 16 (a platform-free
   ordinary bypass taken by a skipping route) would re-route ordinary networks; it now asserts the
   opposite on ordinary track, and the bypass behaviour on a quad.
2. **The link penalty is charged once per connector** (when a path enters a run of link edges), not
   per link edge: a turnout or a scissors half is three edges (lead, diagonal, lead), and charging
   each would make a crossover cost 750 m, more than passing one platform (600 m).
3. **Terminal pairs switch platforms too** in `expressPattern` (to the express platform) and
   `allStopsPattern` (to the local one), so the two buttons undo each other (test 21); the route
   still starts and ends at the same station complex.
4. **Test 31's network has more local-only stops** (23, 28, 42, 50 St, Columbus Circle, 66, 79, 86
   and 103 St) **and a fourth pair (96 St).** With the design's four local stops between three
   pairs, changing across the platform never paid: each skipped stop saves about 51 s, while a change
   costs 15 s + half the express headway + 120 s. With three to four skips between pairs it does
   (about 6,000 cross-platform transfers on the second day).
5. **Test 26** is in `tests/express.test.ts` (with its own small fixture), not `tests/sim.test.ts`.
6. **London** gets its own express scenario (Oxford Street and the City, four pairs, four local-only
   stops; Bond Street and Chancery Lane are added to the core's line A) and headless test.

### Verification

- `tsc` is clean. `npm test`: **272 tests pass** (245 unit, 27 headless): the 247 before, plus 23 in
  `tests/express.test.ts` (§13 tests 15–22 and 24–30, chaos, operations control and Living City on
  four tracks) and 2 headless (test 31 in New York and its London twin).
- Test 27 reproduces the design's experiment exactly: the express runs A→E in **280 s on the quad
  against 462 s / 480 s on a shared pair** (scheduled 298 s); at 3-minute headways mean lateness is
  4.5 s against 45 s; no deadlocks.
- **Performance** (`npm run perf`, peak game-hour, 3 interleaved runs each on this shared machine):
  `pre-express` 173 / 223 / 200 ms, now 176 / 140 / 152 ms (same boardings and waiting);
  `quads=5` (325 stations, 30 routes, 494 trains, 25 pairs, 40 locks, ≈ 440 overtakes by 08:00)
  255 / 208 / 176 ms, under the 300 ms target. London `quads=5`: 183 ms.
- **Balance** (12 days, agent scale 10, a new game's operations control, chaos Off), day 11:

  | | New York core | New York express | London core | London express |
  |---|---|---|---|---|
  | Capital | $23.3B | $25.7B (+$2.4B) | £24.3B | £26.6B (+£2.3B; £21.6B of bonds, over the £20B cap) |
  | Trunk run time, local / express | 18.3 min (13 stops) | 18.3 / 14.0 min (13 / 8 stops) | 17.0 min (11 stops) | 18.7 / 15.3 min (13 / 9 stops) |
  | Trunk trains, local + express | 20 | 11 + 9 | 19 | 11 + 9 |
  | Riders (network) | 1,349,870 | 1,346,070 | 763,700 | 761,400 |
  | Trunk riders, local + express | 487,160 | 219,570 + 257,810 | 204,570 | 91,800 + 108,240 |
  | Lateness, local / express | 103 s (network) | 120 / 191 s | 8 s (network) | 9 / 27 s |
  | Overtakes per day (express) | — | 170 (local 20) | — | 148 |
  | Left behind | 824k | 537k | 120 | 150 |
  | After bond interest | −$0.28M/day | −$0.63M/day | −£2.2M/day | −£2.5M/day |

  The express saves 4.3 minutes end to end in New York (3.4 in London) and relieves crowding (a
  third fewer left behind), but ridership doesn't rise: each route runs every 5 minutes, and riders
  wait for their own route (the sim has no "first train of either"), so stations served by both now
  see a 2.5-minute wait each way instead of 1.25. Cross-platform transfers are 0 in both scenarios
  for the same reason: with one or two skips between pairs, a change costs more than it saves. The
  design's fallback (lowering `pairPlatformCostShare` to 0.7 if the scenario lost more than
  $0.3M/day against the core) would save only about $20k/day here, so the constants are unchanged;
  this is a service investment that pays only on longer, denser corridors, as §12 says. Keeping the
  local at the core's headway and adding the express on top (`localPeak=2.5 expressPeak=5`) gives
  1,358,910 riders (+0.7%) for −$0.77M/day after interest (London 763,420, −£2.7M).

### Gotchas (for the UI)

- `stationsAlongRoute(net, routeId, stops, path)` for the Line list and the skip rings; rebuild the
  draft's with `stationsAlongPath` after each recompute.
- `serveStops` returns `{ error }` with the design's "no crossover reaches it" text for stations on
  the other pair; `skipStops` refuses terminals with the design's text.
- Day reports from networks without pairs or expresses have no `routeOvertakes`/`crossTransfers`
  (read them as `?? {}`); saved reports from v5 get `{}`.
- `Alert.partnerStationId` marks the second closed platform of a pair.
- Value capture: use `pairKeyId` for a station's levy (`stationLevy`/`stationTracts`).

### Known gaps

- (Superseded by the review fixes at the top: riders now take the first train of either and step
  across to an express in or due, and London's scenario fits the bond cap.) Route planning and the
  timetable fallback of mode choice still see each route's own headway.
- Overtakes are counted only between two consecutive cross-platform stations both trains call at,
  and a network edit forgets the pair calls in progress (an overtake right after an edit can be
  missed).

## Implementation notes (UI)

Checklist steps 10–13 and 15 (the README), built on the construction and sim notes above. This
finishes the work in WIP commit `d075e17`: the track and station tools, pair-aware bulldozing, the
station panel and most of the route UI and rendering were there, and I kept all of it. The UI
adds no sim work. Everything works in both cities: copy goes through `fmtDistance`/`fmtMoney`,
so it follows the units setting (which defaults per city) and the city's currency, and station
names come from the city's own naming.

### What exists

- **`src/ui/express.ts`** (pure, no DOM; tested): `SIDE_LABEL`; `PREVIEW_PAIR_PX` (3.5 px, the
  push of a pair carrying one route); `QUAD_COLORS` and `strokeRoles(res)` for the preview;
  `connectorKinds(net, links)` → `{ turnouts, scissors }` and `connectorText`; `quadHoverTip`,
  `quadStrokeTip`, `crossoverTip`; `linkCandidate(net, edge, x, y)`; `stationQuadTip`;
  `bulldozePairTip`; `pairWord`; the route panel's `lineRows`, `skipsText`, `overtakesValue`,
  `OVERTAKES_TIP`, `SERVICE_TIP` and `routeOnQuad`; `StationDetail` and `mergeDetails`.
- **Track tool** (`trackTool.ts`): `tracks: 2 | 4` (**Q**), `side` (**F**) and `crossing` (**X**,
  four tracks only; **Esc** or **X** leaves it, **Q** back to two tracks clears it), with
  `setTracks`/`setSide`/`setCrossing` and the options card rows. Q and F work mid-stroke (the
  preview is rebuilt from the same points).
  - Preview: `addQuadStroke` on a clone, every new edge reported. The local pair is green, the
    express pair cyan and connectors pale grey (thinner), anything invalid red; the pairs are pushed
    `PREVIEW_PAIR_PX` apart in pixels as the map draws them (deck.gl `PathStyleExtension` offset).
    A refused stroke draws the plain stroke in red with the reason.
  - Tooltip: double track before a fan's turnout, each pair's length and cost, "Turnouts/crossovers
    1 turnout, 1 scissors · £63.2M", the tightest curve and its pair, the total, the first error
    (red), problems (amber) and the keys.
  - Hover before the first click: open map, a free four-track end ("Click to extend the four-track
    section"), or other track (fan).
  - Finish: decided on a clone first, then one `editBlueprint` (one undo step); a refusal toasts
    "Can't build four tracks here" and keeps drawing. When the refusing click was an end snap, that
    end is dropped so another end can be tried.
  - Crossover mode: the hovered pair edge's `scissorsCandidate`, previewed with `addScissors` on a
    clone (cached by network version, edge and position); a click is one `editBlueprint`.
  - Dragging a blueprint vertex moves its twin (`syncTwins`); when the twin is built the drag is
    refused with a red tip.
- **Station tool**: on a four-track pair a click places a cross-platform station (both platforms
  priced `{ paired: true }`, one catchment at the midpoint, both platform highlights on their
  pushed pairs), next to a lone platform on the other pair it adds the partner (`linkCandidate`,
  aligned opposite it, priced `{ partner }`, same name), and Shift-click places one platform.
- **Bulldoze**: a pair is demolished together (both highlighted, the confirm names both platforms
  and the total refund); Shift-click takes one platform (`Game.bulldozeStation(id, { withPartner })`).
  `MapView` disables MapLibre's box zoom, which swallowed the click after every Shift+mouseup.
- **Station panel**: a pair is one station — the kicker says "cross-platform", route chips say
  which platform each route uses, the figures are both platforms' (two `'station'` queries merged
  with `mergeDetails`, boardings and waiting summed, the higher crowding), a *Cross-platform
  transfers* card (`report.crossTransfers[lower id]`), *Platforms* "local + express · 8 cars", the
  value capture once (by `pairKeyId`), the status of the least-built platform, and **Rename**
  renames both. The select tool's hover sums the pair's boardings.
- **Route tool**: **E** (or the editor's *Runs as* control) toggles the draft; a click on a pair
  picks `choosePlatform(…, draft.express, alt)`; **Alt-click** on a served pair switches its
  platform; a click on a station the draft runs past goes in path order (`insertStop` in
  `routes/express.ts`: the clicked platform if the track reaches it, else the one the line passes,
  else the design's "no crossover reaches it" toast). Skipped stations get hollow amber rings.
  The editor has the Line list (skipped rows with **Stop here**), *Pattern* buttons and "Skips N
  stations".
- **Route panel**: the lozenge in the header and "Express ·" in the kicker. A *Service* section
  (when the route is an express, stops on four tracks or passes a pair): *Runs as* Local / Express,
  **Express pattern** (also makes it an express) and **All stops** (also makes it a local). The stop
  list is now the *Line* list: every station between the terminals in direction-0 order, served
  rows with **Skip** (terminals say "terminal"), skipped rows muted with "passes" or "on the local
  pair" and **Stop here**. Each edit is checked by pathfinding and the fleet purchase and reverted
  with a toast on failure, and applies at once. An *Overtakes yesterday* card (yesterday's
  `routeOvertakes`, else today's count from the worker).
- **Bullets**: `bullet(color, text, size, express)` renders the lozenge (`.bullet.express`, §2.4)
  at every call site: route panel, editor and list, station panel, train panel, Service alerts and
  the event service editor, the finance Fleet tab (`RouteRef.express`).
- **Rendering**:
  - `networkLayers.ts`: `quadOffsets` and `pairOffsetAB` as designed.
  - Track features carry `quad` and `pairOff`; `built()` excludes quads, and `hw-quad-{level}`
    draws unrouted built pairs as two thin rails each (four in all).
  - `pairOff` (zoom-scaled) also offsets construction hatching, blueprints, invalid blueprints and
    the selection glow.
  - Route features and `routeOffsets` are the pair's push plus the interline offset, so trains sit
    on their pair with no train-layer change. `elevated3d` uses the same offsets, routed or not.
  - `stationLayers.ts`: one capsule per pair (`PairDatum`) from one pair's bundle to the other's at
    every zoom, its label offset clear of the capsule, sized by both platforms' boardings, crowding
    and "CLOSED" if either platform is closed. A pair is one node of an interchange's pills. A lone
    platform on a pair is drawn on its pair's push.
  - `trainLayer.ts`: expresses get the light casing.
  - `App`: `stations.update(is3D, network.quadOffsets)` after each network render and day end; the
    `route-pattern` provider rings the selected route's skipped stations in its colour, cached on
    the along list; `onSelect` invalidates the view.

### Operations and city chaos in the UI

- The *Service* edits and the Line list's **Skip** / **Stop here** change the stop list at once, like
  **Edit stops & style**. Frequency, train length and *Operations* stay in the panel's draft, applied
  together by **Apply**; that draft survives the panel rebuilding after a stop edit (`mergeDraft`).
- Timepoint clocks appear on served stops only, so a skipped station can't be a timepoint.
  Skipping a timepoint drops it (`RouteSet.update`), and **Suggest** only picks served stops
  (checked in the browser: London's local got Oxford Circus and Holborn at their local platforms,
  the express Oxford Circus at its express platform).
- A closed pair shows "CLOSED" on the capsule with a red outline, and the station panel banner
  shows for either platform's alert (`partnerStationId`).

### Deviations from the design

1. **All stops also makes the route a local**, and **Express pattern** an express, so the two buttons
   undo each other's stops *and* kind. The design doesn't say what happens to the flag.
2. **"Turnouts/crossovers 1 turnout, 1 scissors"** instead of a count of connector paths. A
   scissors is two crossing connectors, so a plain count read "4" for a free/free quad.
3. **Previews and lone platforms are pushed like the map.** The design pushes only route bundles,
   rails, blueprints and capsule ends. At city zooms 9 m is under a pixel, so without the push the
   preview's local pair hides under the express pair, and a local-only stop sits between the bundles.
4. **The Service section appears only where it applies** (an express, a stop on four tracks, or a
   pair along the line), so ordinary routes' panels are as before.
5. **The Line list replaces the stop list in place** ("Line · 10 stops, skips 2 · 6.9 km") and shows
   only stations between the terminals. The path's terminal run-outs never add stations.
6. **A refused four-track stroke keeps drawing**, and drops the end it couldn't attach to.
7. **`linkCandidate` moved to `ui/express.ts`** and the route tool's insert-in-order logic to
   `insertStop` (`routes/express.ts`), so both can be tested without deck.gl.
8. **The selection glow is pushed onto the pair** too, so a selected express glows on its own pair.
9. `PREVIEW_PAIR_PX` is shared by the track and station tool previews.

### Gotchas

- Clicks pick by distance in metres (`pickEdge`, `StationLayers.pick`). Because the pixel push has
  the same sign as the metric spacing, the nearer pair is always the one the cursor is drawn over.
- Zoom-dependent positions (capsules, pushed lone platforms, label offsets) use
  `updateTriggers: [version, round(zoom·20)]`.
- On some Linux desktops the window manager takes Alt+drag/Alt+click; the route tool's Alt-click
  then never reaches the page. An express draft can still use a local platform by clicking it
  after switching the draft to Local with **E**, then back.
- `stationsAlongRoute` caches per route by network version, stops and path length. The route panel
  and the `route-pattern` provider share it.

### Verification (UI)

- `tsc` is clean. `npm test`: **283 tests pass**, the 272 before plus 11 in `tests/expressUi.test.ts`:
  - the pair push's sign through `orientEdges` on a chain drawn either way, for both sides;
  - `quadOffsets` widening with a bundle;
  - connectors by kind;
  - the stroke, hover, crossover, station and bulldoze texts in both cities' units and currency;
  - `linkCandidate`;
  - the Line list, Service and Overtakes helpers, `insertStop` and `mergeDetails`.
- **In a browser** (Chromium with SwiftShader through Playwright, a Vite dev server, the real tools
  with mouse and keyboard, sandbox):
  - **New York, Second Avenue** (Houston to 96 St):
    - a free/free deep quad ("2 scissors · $84.2M"), F mid-stroke, and an extra scissors with X;
    - five pairs and five local-only stops (Shift);
    - Shift-bulldoze of one platform of a pair, then link mode to put it back;
    - Build, a local at all ten stops, then an express (E, terminals, then a pair inserted in order:
      "Click to stop at E 21st St & 2nd Av (express platform) (inserted in order)");
    - day 2 at 08:30: *Overtakes yesterday* 19–23, 100 cross-platform transfers at 21 St, Skip and
      Stop here on the local;
    - the station panel of a pair, express trains with the light casing, 3D;
    - save, then load from the title screen (38 quad edges, 10 twins, 10 paired platforms, the
      express flag kept).
  - **London, Paddington to Whitechapel** (km and £ throughout):
    - double track at both ends; a quad fanning off the west end ("1 turnout, 1 scissors"); a
      "continue" stroke from its free end to a fan into the east double track (one group throughout);
    - pairs (Marble Arch, Oxford Circus, Holborn) and local-only stops (Bond Street, Tottenham Court
      Road, St Paul's);
    - unrouted four-rail rendering and the fan's turnout;
    - a built pair demolished with the confirm ("Demolish both platforms of …? You get back
      £66.6M"), then placed again;
    - a local and an express (Alt-click shows "Click to add Oxford Circus (local platform)");
    - **Express pattern** → **All stops** on the local (express, 6 stops → local, 9 stops);
      **Suggest** timepoints on both;
    - a day: 194 express overtakes, the station panel, the routes list with its lozenge, a closed
      capsule, 3D;
    - save and load.
  - **Interactions** (New York): Q mid-stroke; one undo step per quad (Ctrl+Z, Ctrl+Shift+Z); dragging
    a middle vertex 280 m (its twin follows and stays 9.000 m away, no invalid edges); a too-short
    stroke refused with the toast while drawing continues; Esc; X and Esc; E twice in the route tool
    (the editor's control and the lozenge follow).
- **Identity:** UI-only changes, re-checked against the `pre-express` worktree after all changes.
  The `dump=` files are byte-identical for `headless-sim days=3`, `balance` core and sprawl (8 days)
  in both cities, and core `days=25` in both cities (day 18 carries the 31 Jan growth month). The
  printed output matches apart from timings and the dump path.
- **Performance:** the sim is unchanged by the UI. `npm run perf` peak hour, interleaved, on this shared machine:
  - `pre-express`: 157 / 148 ms; now: 147 / 175 ms, with the same 40,320 boardings and 1,090 waiting.
  - `perf -- quads=5` (325 stations, 494 trains, 25 pairs, 40 locks, 441 overtakes by 08:00): 212 ms.
  - On the main thread, the four-track preview (clone, stroke, every new edge's report, roles,
    connectors and the tooltip) takes 1.15 ms median (p90 4.0 ms) per mouse move on the `quads=5`
    grid.
  - The pushed station positions are one multiply-add per lone platform on a pair and only rerun on
    zoom steps.

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
