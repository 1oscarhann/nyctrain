# Headway

A metro builder set in real cities where nobody ever built one. Pick **New York** (the five
boroughs) or **London** (all 33 boroughs) on the title screen. You get the actual streets,
shoreline and buildings, real commuting data and a few billion dollars or pounds. You design
track, stations and routes. Then about 2.9 million simulated commuters decide each morning
whether your network beats walking or driving.

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

From the title screen: pick the city (New York / London; remembered), then **New game**
(career, $6B in New York, £5B in London), **Sandbox** (unlimited money, instant construction),
**Load game**, **Settings** (units, agent scale) and **Continue** (the autosave). Saves remember
their city, so loading a London save from the New York title screen switches over. A new game
offers an 8-step tutorial.

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

**London** (`npm run data:london`, `scripts/build-data-london.ts` → `public/data/london/`) uses the
**2011 Census** travel-to-work flows (Nomis WU03EW, MSOA level). The 2021 census was taken in
March 2021, during lockdown and furlough, so its commute flows are badly distorted. It keeps
London-internal flows (residence and workplace both among London's 983 MSOAs) and drops anyone
working mainly from home, giving 2,926,149 commuters in 352,300 pairs. Positions are ONS
population-weighted MSOA centroids; radii come from ONS MSOA boundaries. The land mask is the ONS
borough boundaries clipped to the coastline, which cut the tidal Thames out. Inland water the ONS
clip leaves in (the Docklands docks, the Thames above Teddington Lock, the reservoirs; about
16.5 km²) is cut out using OpenStreetMap water polygons from the same OpenFreeMap tiles the map
uses, so the water rule works exactly as in New York. Job-heavy areas (more than three jobs per
resident, such as the City and the West End) are placed at the centre of their area rather than at
the residents' population-weighted centroid. The City's centroid sits on the Barbican estate,
800 m from Bank. The census flows carry no income, so each pair is split into three
earnings bands (30/40/30 across London) with an ordered logit on the home MSOA's household
income (ONS small-area income estimates 2011/12). Contains National Statistics data © Crown
copyright and database right 2011/2013; contains OS data © Crown copyright and database right;
Open Government Licence v3.0.

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

**City chaos** (special events, disruptions and weather; see [City chaos](#city-chaos)) runs in
the simulation. New games start at the Normal level, and saves keep their level and seed. The
in-game controls are not built yet. They will be the Service alerts panel (`A`, or a bell
button), the weather chip and news ticker, and the chaos level (Off / Calm / Normal / Wild) in
the menu. In the scripts, `chaos=` and `seed=` set the level and seed.

## Architecture

```
src/
  balance.ts      every tunable number (SI units inside; the UI shows miles/mph or km), per-city overrides in CITY_BALANCE
  cities/         New York and London: regions, goals, copy, naming style; applyCity() switches everything
  core/           geo (local metres around City Hall), calendar (weekdays only), city chaos calendar and weather, units, game state, goals
  data/           world loading, tract index, land mask
  map/            MapLibre style recolouring, network/station/elevated layers, overlays, naming
  construction/   track graph with arc fillets, levels and ramps, validation and costs, tools
  routes/         route pathfinding on track, compilation for the sim, fleet sizing, route tool
  trains/         kinematics (run profiles), interpolated train layer
  sim/            worker, engine, train sim (moving block, merge locks), commuters, mode choice, transit graph, city chaos (incidents, event trips)
  economy/        finance: daily settlement, monthly reports, bonds, bankruptcy
  ui/             app shell, panels, charts, tutorial, menus
  save/           save format, migrations, IndexedDB store, export and import
scripts/          data pipeline, headless sim, balance tuning, performance check
tests/            Vitest unit tests and the headless simulation tests
```

Each city is a `CityConfig` (`src/cities/`: regions, chart areas, goals, tutorial copy, naming
style, currency, data path) plus a `CITY_BALANCE` entry in `balance.ts` (projection origin, map
view, core and CBD zones, driving and parking, values of time, fares, starting cash, the
timed-trip goal). `applyCity()` restores New York's defaults and applies the city on each thread:
at game start on the main thread, at init in the worker, and first thing in scripts and tests.

The worker steps a fixed 2 s game timestep in 14 ms slices and posts compact snapshots about
10 times per second: train positions and loads, platform queues and live counters. The main
thread interpolates train positions between snapshots. Agents are never saved. A save stores
the network, routes, finances, goals, the day's mode shares and observations, and the city chaos
level, seed and planned event service (save format v3). The commuters are rebuilt from the data
when the save is loaded.

## Testing each part

```bash
npm test                 # all 80 tests (unit + headless, both cities)
npm run test:unit        # geometry, costs, ramps, water, pathfinding, logit, kinematics, economy, London,
                         # chaos (calendar, weather, incidents, train-sim hooks, event trips, save v3)
npm run test:headless    # 3 days on the test network, plus chaos end to end (closures, event agents,
                         # determinism, snow, breakdowns, Off is inert, a London venue event)
npm run sim -- days=3    # headless run of the test network, with a daily summary
npm run sim -- days=3 chaos=normal           # the same with city chaos: weather, incidents and events per day
npm run balance -- scenario=core days=12     # ~40-station core: ridership and daily money
npm run balance -- scenario=sprawl days=8    # low-density sprawl: should lose money
npm run balance -- city=london scenario=core days=12   # the same for London (43 stations)
npm run balance -- scenario=core days=12 chaos=normal  # chaos=off|calm|normal|wild, seed=N, money=1
npm run perf             # 300 stations / 25 routes / ~430 trains: times one peak game-hour
npm run perf -- chaos=wild weather=snow outdoor=1      # worst case: Wild, full snow, every track outdoor
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

### London

London uses the same construction, train and operating numbers (read as pounds). Its own values
are in `CITY_BALANCE.london`:

| Area | London |
|---|---|
| Money | £5B start; fare £2.80 (£0–5, step £0.10); values of time £8/£14/£26 per hour |
| Driving | 13 km/h in inner London (the 14 ONS inner boroughs), 24 km/h outside; £0.25/km; drive constant +35 min (fewer London households own a car) |
| CBD | inside the inner ring road (approximately the congestion-charge zone): 20 min and £25 (£15 charge plus parking) |
| Goals | Cross the Thames; reach every borough (stretch); Bank to Heathrow in under 45 minutes; plus the shared milestones |

| Scenario | Network | Capital | Riders/day | Daily money |
|---|---|---|---|---|
| **Core** (`city=london scenario=core`) | 4 deep routes, 43 stations: Paddington–Bank–Stratford, Kentish Town–King's Cross–Elephant–Brixton, Victoria–Waterloo–Canary Wharf–North Greenwich, Hammersmith–Piccadilly–Cannon St–Shadwell | £24.2B (needs £19.2B of bonds) | 761k on day 11, 13% transit share | Operating −£0.29M/day; −£2.1M/day after bond interest |
| **Sprawl** (`scenario=sprawl`) | Elevated Dagenham–Upminster and Eltham–Bexleyheath | £3.38B | 16k | −£0.59M/day |

London is the harder city. Its jobs are far less concentrated than Manhattan's, and commutes are
longer (7.6 km on average, centroid to centroid), so the same ~40 central stations reach only 20%
of commuters, against 30% in New York. Of those they reach, the network wins 65%. Revenue per
rider is the same as in New York (about £2.75), so break-even including interest still sits near
1.5M riders. In London that takes a bigger network reaching further out.

### Performance (`npm run perf`)

The perf network is a grid of 25 deep routes with 300 stations and 431 trains, at agent scale 10.
One AM-peak game-hour takes about 190 ms of sim time. At 60× the budget is 1000 ms, so there is
about 5× headroom. Building paths for every tract pair takes about 0.5 s. In the browser the
worker holds a sim rate of 3600 game seconds per real second (60×). Per-frame main-thread work
(train interpolation and layer rebuild) is about 1 ms.

## City chaos

Every weekday the city throws something at the network: special events at real venues,
disruptions and weather. Each one goes through mechanics the sim already has:
- train speeds and dwell times;
- boarding and platform queues;
- walking and driving times.

So it shows up in observed door-to-door times and crowding, and in the next day's mode choice.
The design is `docs/v2/events-chaos.md` (its top section has the implementation notes). The
simulation side is done; the UI (Service alerts panel, ticker, map markers, event service editor)
comes next.

**Determinism.** Everything comes from the game's chaos seed:
- the event calendar, the weather and its one-day forecast, and the incident plan are pure
  functions of `(seed, day, level)`, computed identically on the main thread and in the worker
  (`src/core/cityCalendar.ts`, `src/sim/incidents.ts`);
- event-goers are drawn from a stream per event.

The commuter RNG is never touched. With chaos **Off** the simulation is bit-identical to the
code before chaos: the same `DayReport`s, finances and mode shares, checked by hashing the
headless and balance runs. Headless runs and scripts default to Off. A save stores the level,
the seed and the planned event service, and a load mid-day replans the rest of the day from
the seed.

| Level | Incidents | Weather | Events |
|---|---|---|---|
| Off | none | always clear | none |
| Calm | ×0.5 | normal | normal |
| Normal (new games) | ×1 | normal | normal |
| Wild | ×2.5 | chances ×1.5 | chances ×1.25 |

A level change takes effect at the next 3 am.

### Incidents

They fire between 05:30 and 23:30, without warning, at rates set by the network's exposure. On
the ~40-station core that is about 7–9 a day at Normal and about 21 at Wild.

| Kind | Rate (Normal) | Lasts | What happens |
|---|---|---|---|
| Signal problem | 1 per 50 directed-track km a day | 15–60 min | an 800 m stretch of one track is limited to 15 km/h; trains bunch behind it |
| Train breakdown | 1 per 10,000 planned train-km | 5–20 min | a running train brakes hard and stalls; the moving block queues followers |
| Sick passenger | 1 per 12,000 train-km | 3–8 min | the train is held at its next stop (never at a terminal) |
| Police activity | 0.02 per station a day, busy stations likelier | 10–40 min | the station closes. Trains run through, and riders for it get off at the next stop and walk back. People waiting come back when it reopens if that is within 15 min; otherwise they take a cab |

The deadlock watchdog ignores stall time while an incident is active. There is no separate
incident cost: it shows up as lost fares, crowding, give-ups and the next day's choices.

### Weather

Weather is drawn per day. A snow or heat spell can carry over to the next day at 80% of its
strength. Severity is between 0.5 and 1, and effects scale linearly with it (0.85 and above is
"Heavy snow", "Heavy rain" or "Heat wave"). At full severity:

| | Walking | Walk penalty | Road speed | Elevated and at-grade trains | Dwell | Crowding felt | Incident rates |
|---|---|---|---|---|---|---|---|
| Rain | −8% | +8 min | −15% | — | +5% | +10% | signal ×1.5, breakdown ×1.1, police ×0.8 |
| Snow | −25% | +15 min | −40% | ≤ 55% of top speed (≈ 50 km/h) | +15% | +10% | signal ×2, breakdown ×1.5, police ×0.7 |
| Heat | −10% | +6 min | −5% | ≤ 85% of top speed | +5% | +35% | signal ×1.3, breakdown ×2, sick ×2.5, police ×1.2 |

Mode choice at 3 am uses the day's walking and driving costs, and the day's walks, drives and cab
fallbacks take the slower times. The report's baseline commute is the no-subway commute under the
same weather, so a snow day doesn't look like the subway made things worse.

| Climate (Normal, weekdays a year) | Snow | Rain | Heat |
|---|---|---|---|
| New York | ≈ 12 (Dec–Mar) | ≈ 22 | ≈ 10 (May–Sep) |
| London | ≈ 2.5 (Dec–Mar) | ≈ 33 | ≈ 2.6 (Jun–Sep) |

### Special events

Events come from a seeded calendar, at most one per venue a day, announced 3 days ahead (5 for a
parade). The labels are generic and use no trademarks. On the day:
- fans are drawn from the city's residents, weighted towards the venue
  (`exp(−distance / 12 km)`);
- they choose walking, driving (plus the venue's parking time and cost) or transit (one
  Dijkstra from the venue);
- the transit fans become agents for that day only (a pool of up to 200,000 people). They pay
  fares, crowd trains and platforms, and are removed at the next 3 am.

Event service (temporary headway overrides on chosen routes) works in the sim. Overrides planned
before 3 am also raise the share of fans who come by transit.

| City | Venues and events (weekday chances in season) |
|---|---|
| New York (≈ 1.1 a weekday) | Bronx and Queens ballpark games (Apr–Sep); Midtown and Brooklyn arena games (Oct–Apr) and concerts; Flushing tennis open (26 Aug – 8 Sep); Downtown parade (rare); Central Park summer concerts; Coney Island fireworks (Fridays, Jun–Aug) |
| London (≈ 0.6 a weekday) | Wembley stadium match (international windows) and concerts (summer); Stratford stadium match, North London football (Holloway) and Tottenham football on midweek evenings, Aug–May; Greenwich arena concerts; Twickenham rugby (Friday nights, Feb, Mar and Nov); Wimbledon tennis fortnight (24 Jun – 7 Jul); Oval cricket test match (late Aug); Hyde Park summer concerts; Whitehall parade (rare) |

### Balance impact (headless, agent scale 10, 12 days from 7 Jan 2030)

| Scenario | Off | Normal (seed 2030) | Normal (seeds 1–6) | Wild (seed 2030) |
|---|---|---|---|---|
| NYC core: day-11 riders | 1.333M | 1.374M (+3.1%) | +0.3% … +1.5% | 1.354M (+1.6%) |
| NYC core: operating result, days 8–11 | +$1.32M/day | +$1.52M/day | +$1.35 … +$1.43M/day | +$1.48M/day |
| London core: day-11 riders | 761k | 766k (+0.7%) | −0.1% … +1.3% | 769k (+1.1%) |
| London core: operating result, days 8–11 | −£0.32M/day | −£0.28M/day | −£0.31 … −£0.29M/day | −£0.23M/day |
| Sprawl, days 0–7 | NYC −$0.81 … −0.84M; London −£0.59 … −0.62M | NYC −$0.75 … −0.84M; London −£0.58 … −0.62M | | |

There were 0 deadlocks in every run.
- Snow days are ridership days. Walking and driving get much worse, so mode choice tips towards
  the subway. Seed 2030 gives New York five snow days in its first twelve (it is January), which
  is why it sits above the other seeds.
- Incidents cost lateness and give-ups: at Wild (seed 2030), give-ups on days 8–11 were 3–6× those
  at Off.
- Events add fans only where a station is within 1.5 km of the venue. The New York core reaches
  the Midtown and Brooklyn arenas, the parade route and Central Park: about 4–12k fans a day by
  transit, averaged over a run. The London core reaches the Greenwich arena, Stratford, the Oval,
  Hyde Park and Whitehall.

### Performance with chaos

On the perf network, timing the peak game-hour (minimum of 5 interleaved runs on this shared
machine, where the code before chaos measures 235 ms rather than 190):

| Run | Peak hour |
|---|---|
| Off | 227 ms |
| Normal | 242 ms |
| `chaos=wild weather=snow outdoor=1` | 301 ms |

The last run has every route treated as outdoor in full snow, so 378 trains run at once instead
of 311. The 3 am event injection takes 2–8 ms for a typical event and 22–57 ms for a four-event
day with a 150,000-person parade. The first snow day adds a one-off ~150 ms to the 3 am step,
because the weather baseline is cached per kind and severity.

## Known issues

- City chaos has no UI yet. Its alerts, daily info and event service are fully exposed by the
  worker, client and game state, but new browser games run at Normal without the Service alerts
  panel, ticker or map markers that explain what is happening.
- London uses 2011 census flows, because the 2021 census was taken in lockdown. Its commuter
  totals are 2011's, and its earnings bands are modelled from area income rather than measured.

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
