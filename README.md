# Headway: New York

A subway builder set in the real five boroughs. You get the actual streets, shoreline and
buildings, real commuting data for New York City, and a few billion dollars. You design track,
stations and routes. Then about 2.85 million simulated commuters decide each morning whether
your network beats walking or driving.

Everything runs in the browser: Vite + TypeScript (strict), MapLibre GL JS with deck.gl in
interleaved mode, Turf and uPlot. The simulation runs in a Web Worker; the main thread only
renders and handles input. No API keys are needed. The basemap is OpenFreeMap's Positron style,
recoloured at runtime.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # strict typecheck + production bundle in dist/
npm run preview      # serve dist/
```

From the title screen: **New game** (career, $6B), **Sandbox** (unlimited money, instant
construction), **Load game**, **Settings** (units, agent scale) and **Continue** (the autosave).
A new game offers an 8-step tutorial.

### Data

The processed data is committed in `public/data/`, so the game runs without downloading
anything. To rebuild it:

```bash
npm run data            # downloads into scripts/.cache, writes public/data/, prints a sanity report
npm run data:synthetic  # offline fallback: a plausible synthetic city with the same file formats
```

`scripts/build-data.ts` finds the latest **LEHD LODES8** NY origin–destination year (JT01, "main"
file; currently 2023). It keeps NYC-internal flows (the 5 county FIPS codes), aggregates blocks to
census tracts, and joins the 2020 **Census Gazetteer** tract internal points. Points that fall in
water or off a tract's main land part are moved using NYC's tract polygons. NYC borough
boundaries are kept as the land mask. Output:

| File | Contents |
|---|---|
| `tracts.json` | 2,324 tracts: borough, position, radius, residents and jobs by earnings band |
| `od.bin` | Binary OD table (`HWOD` header, Uint16 home/work/SE01/SE02/SE03 arrays) |
| `land.geojson` | Simplified borough land polygons (water rule and land mask) |

The sanity report prints the total number of commuters, the top job tracts and the borough
shares. If a download fails, the script falls back to synthetic data and says so.

## Controls

| Key | Action |
|---|---|
| Space | Pause / resume |
| 1 – 4 | Speed 1×, 5×, 20×, 60× (1× = one game minute per second) |
| ⏩ button | Skip to 6 am |
| T / S / R / B | Track / Station / Route / Bulldoze tool |
| V | Flat ⇄ tilted 3D (buildings grow while the camera tilts) |
| Esc | Back to Select, or cancel the current draft |
| Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) | Undo / redo (blueprints) |
| Enter / double-click | Finish a track stroke; save a route draft |
| Backspace | Remove the last track point |

All toolbar buttons have tooltips that show their shortcut.

## Architecture

```
src/
  balance.ts      every tunable number (SI units inside; the UI shows miles/mph or km)
  core/           geo (local metres around City Hall), calendar (weekdays only), units, game state, goals
  data/           world loading, tract index, land mask
  map/            MapLibre style recolouring, network/station/elevated layers, overlays, naming
  construction/   track graph with arc fillets, levels and ramps, validation and costs, tools
  routes/         route pathfinding on track, compilation for the sim, fleet sizing, route tool
  trains/         kinematics (run profiles), interpolated train layer
  sim/            worker, engine, train sim (moving block, merge locks), commuters, mode choice, transit graph
  economy/        finance: daily settlement, monthly reports, bonds, bankruptcy
  ui/             app shell, panels, charts, tutorial, menus
  save/           save format, migrations, IndexedDB store, export and import
scripts/          data pipeline, headless sim, balance tuning, performance check
tests/            Vitest unit tests and the headless simulation test
```

The worker steps a fixed 2 s game timestep in 14 ms slices and posts compact snapshots about
10 times per second: train positions and loads, platform queues and live counters. The main
thread interpolates train positions between snapshots. Agents are never saved. A save stores
the network, routes, finances, goals and the day's mode shares and observations, and the
commuters are rebuilt from the data when the save is loaded.

## Testing each part

```bash
npm test                 # all 36 tests (unit + headless)
npm run test:unit        # geometry, costs, ramps, water, pathfinding, logit, kinematics, economy
npm run test:headless    # 3 days on the test network: plausible numbers, no deadlocks, finite money
npm run sim -- days=3    # headless run of the test network, with a daily summary
npm run balance -- scenario=core days=12     # ~40-station core: ridership and daily money
npm run balance -- scenario=sprawl days=8    # low-density sprawl: should lose money
npm run perf             # 300 stations / 25 routes / ~430 trains: times one peak game-hour
```

To check each milestone by hand in `npm run dev`:

1. **Map and data:** pan around. The water, land, roads and labels use the palette. Overlays
   (layers button) show resident and job density. **V** tilts into 3D with growing buildings.
2. **Construction:** press **T**, choose a level and click a line. The tooltip shows length,
   cost, build time and any problem, such as a curve that is too tight, a missing ramp or water.
   Press **S** and click on the track to place stations. **Build** starts construction: blueprints
   become hatched and show a percentage, and finish over game days. In Sandbox they finish at
   once. **B** bulldozes with a 20% refund.
3. **Routes and trains:** press **R** and click stations in order, set frequencies per period,
   then save. Trains appear, and lines shared by several routes are drawn side by side.
   Click a train for its load and lateness.
4. **Commuters:** run to the next morning. Mode choice happens at 3 am. The top bar shows
   riders, transit share and the average commute against the no-subway baseline. Station panels
   show boardings by hour, where riders come from and where they go.
5. **Economy:** the finance panel (chart button) shows cash, debt, bond room, the fare slider,
   bonds and yesterday's ledger. A month report appears at each month end. The unserved,
   crowding and flows overlays help you see what is missing.
6. **Polish:** goals panel (flag), tutorial (? button), saving (menu: three slots, autosave at
   midnight, export and import JSON), Sandbox, units toggle.

## Balance

Every value is in `src/balance.ts`. Main values (spec values unless noted):

| Area | Values |
|---|---|
| Time | 1× = 60 game s per real s; speeds 1/5/20/60×; 2 s sim step; day starts 5 am; mode choice 3 am; weekdays only from Mon 7 Jan 2030 |
| Track $/m | elevated 90k, at-grade 40k, cut-and-cover 160k, deep 280k; bridge ×3; underwater tunnel ×1.5; light metro ×0.7 |
| Density | elevated / at-grade / cut-and-cover × (1 + density ÷ 6,000 per km²); deep ignores density |
| Build time | days per km: elevated 5, at-grade 3, cut-and-cover 8, deep 12 |
| Geometry | max grade 4% heavy / 6% light; min radius 150 m / 100 m; curve speed √(1.0 m/s² · r) |
| Stations | at-grade $25M, elevated $45M, cut-and-cover $80M, deep $200M, +$1M per car; spacing 400 m; interchange within 200 m; catchment 800 m |
| Trains | heavy 18 m cars, 2–10 cars, 110/200 per car, 1.1/1.2 m/s², 90 km/h, $2.5M per car · light 20 m, 2–4 cars, 90/160, 1.3/1.3, 100 km/h, $2M |
| Operations | turnaround 3 min; dwell 20 s + 1 s × (on + off) ÷ cars, max 90 s, ×1.5 above comfort; moving block = braking distance + 100 m; default headways night 20 / AM 4 / midday 8 / PM 4 / evening 10 min |
| Commuters | 1 agent = 10 people (285,288 agents); depart 8:15 ± 45 min; walk ≤ 2.5 km; drive 14 km/h Manhattan, 24 elsewhere; CBD parking 20 min + $20; VOT $10/$20/$40 per h; logit scale 0.085; transfer penalty 5 min; 30% daily smoothing |
| Economy | $6B start; fare $3 ($0–5, step $0.25); $4 per car-km; $8k per station per day; maintenance 1% of build cost per year; bonds $1B chunks up to $20B outstanding, 30 years |

### Where the numbers differ from the spec, and why

- **Bond rate is 2.5%, not 4%.** At the spec's capital costs, a 40-station deep-tunnel core costs
  about $23B. Even with 1.5M riders paying a $3 fare, 4% interest on the roughly $17B of debt
  that needs (about $1.9M a day) can never be covered. At 2.5% the tuning target can be met.
- **"Up to $20B" counts outstanding debt.** Repaying principal frees room to borrow again.
- **Daily riders are boardings** (unlinked trips, as transit agencies count them). Fares are paid
  once per linked journey, since transfers are free, at the fare in force when the journey first
  boards.
- **Mode constants.** These are tuning values the spec leaves open: drive +25 minutes, walk and
  transit 0. Transit access walks can be up to 2.5 km (the 800 m catchment is what the station
  tool shows). Crowding is weighted at 0.6 of the minutes spent above comfortable capacity.
- **A new bond pays interest only, pro-rated, in the month it is issued.** Level payments start
  at the end of its first full month.
- **Cars from a deleted route go to a spare pool.** New or growing routes use them before buying
  more. They still cost maintenance.

### Tuning results (headless, agent scale 10)

| Scenario | Network | Capital | Riders/day | Daily money |
|---|---|---|---|---|
| **Core** (`balance -- scenario=core`) | 4 deep routes, 40 stations: Lexington, CPW–Atlantic, Times Sq–Jackson Hts, 6 Av–Myrtle–Wyckoff | $23.2B (needs $17.2B of bonds) | 1.33M on day 11 (still rising slowly), 21% transit share | Operating +$1.4M/day; −$0.28M/day after bond interest; −$1.8M/day after full debt service |
| **Sprawl** (`scenario=sprawl`) | Elevated Jamaica–Glen Oaks and St George–Huguenot | $4.95B | 15.7k | −$0.8M/day |

So the core covers its operating costs and interest at about 1.45–1.5M riders. Repaying the
principal as well needs more ridership or a higher fare. The sprawl network loses money every
day.

### Performance (`npm run perf`)

The perf network is a grid of 25 deep routes with 300 stations and 431 trains, at agent scale 10.
One AM-peak game-hour takes about 190 ms of sim time. At 60× the budget is 1000 ms, so there is
about 5× headroom. Building paths for every tract pair takes about 0.5 s. In the browser the
worker holds a sim rate of 3600 game seconds per real second (60×). Per-frame main-thread work
(train interpolation and layer rebuild) is about 1 ms.

## Known issues

- I could not measure frame rate in this environment, which has no GPU (only software WebGL).
  The 60 fps target needs checking on real hardware. Per-frame JS cost is small, so any
  bottleneck would be on the GPU (3D buildings at high pitch).
- Riders on the core network are limited by coverage: about 30% of commuters have any transit
  path, and about 70% of those take it. The core is also crowded at the peak, with a lot of
  left-behind events at 2.5-minute headways.
- There are no timetable recovery or holding rules (by design in v1), so lateness builds up on
  crowded lines.
- Station auto-names come from the street labels in loaded tiles. Zoomed far out, a station may
  get a neighbourhood name instead of cross streets. Use Rename.
- Bulldozing is not undoable (undo covers blueprint edits). Built track or stations used by a
  route must be removed from the route first.
