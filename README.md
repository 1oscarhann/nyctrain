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
asks for the city chaos level (Off / Calm / Normal / Wild, remembered; Normal by default) and
offers an 8-step tutorial. The city grows around good transit once a month ([Living City](#living-city);
Steady by default).

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
| A | Service alerts panel (toggle): incidents, weather, events, event service, chaos level |
| Bell button (toolbar) | Service alerts; the red badge counts active incidents |
| Weather chip / ticker item (top bar) | Opens Service alerts at that item |
| Incident / venue marker (map) | Tooltip; a click opens Service alerts focused on it |
| Menu → City chaos | Off / Calm / Normal / Wild (applies from the next 3 am) |
| M | Finances panel (toggle): Overview, Fares, Borrowing, Fleet |
| H | Holding on / off for the selected route (a toast confirms) |
| Clock toggle (route panel stop list) | Timepoint: trains may be held there to even out gaps (shown while holding is on) |

All toolbar buttons have tooltips that show their shortcut.

**City chaos** (special events, disruptions and weather; see [City chaos](#city-chaos)) is on
by default (Normal). Saves keep their level and seed, and the level in force today. In the
scripts, `chaos=` and `seed=` set the level and seed.

## Architecture

```
src/
  balance.ts      every tunable number (SI units inside; the UI shows miles/mph or km), per-city overrides in CITY_BALANCE
  cities/         New York and London: regions, goals, copy, naming style; applyCity() switches everything
  core/           geo (local metres around City Hall), calendar (weekdays only), city chaos calendar and weather, units, game state, goals
  data/           world loading, tract index, land mask
  map/            MapLibre style recolouring, network/station/elevated layers, overlays, naming, city chaos markers
  construction/   track graph with arc fillets, levels and ramps, validation and costs, tools
  routes/         route pathfinding on track, compilation for the sim, fleet sizing and car sales, operations control settings, route tool, event service estimates
  trains/         kinematics (run profiles), interpolated train layer
  sim/            worker, engine, train sim (moving block, merge locks, holding), regularity, commuters, mode choice, transit graph, city chaos (incidents, event trips), city growth (growth.ts)
  economy/        finance: daily settlement, monthly reports, bonds, bankruptcy, value capture; fares, credit rating and bond market, year in review
  ui/             app shell, panels, charts, tutorial, menus, city chaos (alert feed, news ticker, Service alerts)
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
thread interpolates train positions between snapshots. Edits are compiled and sent to the worker
200 ms after they stop (`SimClient.setNetworkSoon`). A compile still pending is sent before any
skip or speed change, so the night and the 3 am mode choice always run on the network on screen. Agents are never saved. A save stores
the network, routes (with their operations control settings), finances (bonds with their coupons,
the bond market and the rating), the fare policy, goals, the day's mode shares and observations,
the city chaos level (today's and the one from the next 3 am), seed, today's incident-plan
basis and planned event service, and the city's growth (pace, per-tract multipliers and balancing
factors, the land-value premium and a thinned history; save format v5; older saves migrate). The
commuters are rebuilt from the data, scaled by the saved growth, when the save is loaded.

## Testing each part

```bash
npm test                 # all 196 tests (unit + headless, both cities)
npm run test:unit        # 173: geometry, costs, ramps, water, pathfinding, logit, kinematics, economy, London,
                         # chaos (calendar, weather, incidents, train-sim hooks and the watchdog's scope, event
                         # trips, event service, save v3 with today's level), chaos UI (alert text, feed and
                         # ticker order, announcements, cancelled service, wrap-up toasts, London wording and £),
                         # operations control (regularity maths, holding on a synthetic line, headway changes
                         # at period ends and event service, the yield rule, short turns, holding next to chaos,
                         # recovery sizing, timepoints, car sales), the money market (scorecard, hysteresis,
                         # rate walk, coupons, refinance, prepay, monthly review, year in review, save v4 with
                         # old months' debt rebuilt, the rating and clockwork goals, London's scorecard), fares
                         # (by band and period, mode choice, London) and the panels' pure helpers (route drafts
                         # kept across a rebuild, yesterday's regularity after a load); Living City: the growth
                         # model (logsum, growth, bounds, Furness on both cities' data, value capture, history),
                         # agent regeneration equal to a from-scratch build in both cities, the starting city
                         # exactly as before Living City, carry-over, value capture in the ledger, the credit
                         # scorecard and the year in review, its goals, save v5
npm run test:headless    # 23: 3 days on the test network (with regularity and fares by band and period),
                         # holding against no holding, holding next to Wild chaos and event service, chaos end
                         # to end (closures, event agents, determinism, snow, breakdowns, Off is inert, mid-day
                         # loads after a level change, an edit or an event, a London venue event), the
                         # browser's message order (an edit followed at once by a skip), and Living City (the
                         # commute benefit, a month close in New York and London, a save mid-growth, value
                         # capture through the finances, pace Off, an event day right after a month close)
npm run sim -- days=3    # headless run of the test network, with a daily summary (and regularity, fares, market)
npm run sim -- days=3 chaos=normal           # the same with city chaos: weather, incidents and events per day
npm run sim -- days=3 ops=off                # operations control, fare policy and bond market all off: as before v2
npm run sim -- days=3 pace=off               # Living City off (pace=off|steady|boom; the default Steady first grows after day 18)
npm run balance -- scenario=core days=12     # ~40-station core: ridership, daily money, regularity, credit rating
npm run balance -- scenario=sprawl days=8    # low-density sprawl: should lose money
npm run balance -- city=london scenario=core days=12   # the same for London (43 stations)
npm run balance -- scenario=core days=12 chaos=normal  # chaos=off|calm|normal|wild, seed=N, money=1
npm run balance -- scenario=core days=12 control=tp    # control=default|legacy|tp|off, ops=off,
                                                       # farePeak= fareOff= low=1|0.5|0, dump=file.json
npm run balance -- scenario=core months=12             # Living City: 12 growth months of monthDays=5 days each
                                                       # (pace=off|steady|boom); days=262 runs a calendar year
npm run perf -- city=london                            # London's grid of the same size; month=0 skips the month closes
npm run perf             # 300 stations / 25 routes / ~430 trains: times one peak game-hour and two month closes
npm run perf -- chaos=wild weather=snow outdoor=1      # worst case: Wild, full snow, every track outdoor
npm run perf -- ops=off  # without operations control (by default every route holds, with timepoints)
```

`dump=file.json` (sim and balance) writes the run's `DayReport`s, the finance state and hashes of
the mode shares, for comparing two versions field by field. With `pace=off` every dump is
byte-identical to the code before Living City, including runs that cross a month end.

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
5. **Economy:** the finance panel (chart button or **M**) has four tabs: Overview (cash, debt,
   bond room, assets, credit rating, today's new-bond rate, yesterday's ledger, the monthly chart),
   Fares, Borrowing and Fleet. A month report appears at each month end, and the year in review
   on the first weekday of January. The unserved, crowding and flows overlays help you see what
   is missing.
6. **Polish:** goals panel (flag), tutorial (? button), saving (menu: three slots, autosave at
   midnight, export and import JSON), Sandbox, units toggle.
7. **City chaos:** start at Wild, build a line past a venue (34 St–Penn for the Midtown arena,
   North Greenwich for the Greenwich arena) and skip to the morning. The weather chip and the
   ticker show the day. **A** lists incidents, weather and events. **Event service…** on a
   card plans extra trains around an event. Incidents pulse on the map: a closed station turns
   red with "CLOSED", a stalled train gets a red casing, and a signal problem shows an amber
   dashed stretch.
8. **Operations and money:** select a busy route. Service regularity shows yesterday's gaps
   (grade, bunched, extra wait, holds) and the headway spread stop by stop. In Operations,
   **Suggest** timepoints (or click the clocks in the stop list), pick a recovery share and
   **Apply**; **H** switches holding off and on. A train held at a timepoint reads "Held at…"
   in amber. In Finances, change the fares (a toast confirms), issue a bond, **Prepay…** it, and
   refinance when the market falls below its coupon. Lower a frequency and sell the idle cars
   (route panel or Fleet tab). Skip to a month end for the review (rating toast, rate history)
   and to January for the year in review.

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
| Economy | $6B start; fare $3 all day ($0–5, step $0.25; peak and off-peak fares, low-income fare full/half/free for the lowest band); $4 per car-km; $8k per station per day; maintenance 1% of build cost per year; bonds $1B chunks up to $20B outstanding, 30 years; used cars sell for 40% |
| Operations control | new routes hold at the first stop at 70% of the headway, 10% recovery; timepoint holds ≤ 90 s, yield to another route's train within 400 m; short turnaround 2 min when the next departure is due; bunched < ½ headway, gaps > 1.5× (of the headway the trains were dispatched under); regularity grades CV 0.25 / 0.45 |
| Bond market | base rate starts at 2.5%, mean-reverting (12%/month, σ 0.2%), shocks ±0.75% (4%/month, 60% up), 1–6%; spread AAA 0 … BBB +0.6% … CCC +4.5%; prepay penalty 1%; refinance fee 1% (gain ≥ 0.05%) |
| Credit rating | monthly scorecard: farebox recovery 30%, interest coverage 30%, leverage 25%, liquidity 15% (ratios, so currency-free); AAA ≥ 85, AA 75, A 65, BBB 52, BB 40, B 28; ±2 hysteresis; 60-day window; London has its own farebox and coverage anchors (below) |

### Where the numbers differ from the spec, and why

- **The bond market's long-run mean is 2.5%, not the spec's 4%, and month 1 borrows at exactly
  2.5%.** At the spec's capital costs, a 40-station deep-tunnel core costs about $23B. Even with
  1.5M riders paying a $3 fare, 4% interest on the roughly $17B of debt that needs (about $1.9M a
  day) can never be covered. At 2.5% the tuning target can be met.
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
  more. They still cost maintenance, until they are sold (40% of the new price).

### Tuning results (headless, agent scale 10, a new game's operations control and fares)

| Scenario | Network | Capital | Riders/day | Daily money |
|---|---|---|---|---|
| **Core** (`balance -- scenario=core`) | 4 deep routes, 40 stations: Lexington, CPW–Atlantic, Times Sq–Jackson Hts, 6 Av–Myrtle–Wyckoff; 67 trains (holding, 10% recovery: one more train per route) | $23.3B (needs $17.3B of bonds) | 1.35M on day 11 (still rising slowly), 21% transit share | Operating +$1.4M/day; −$0.28M/day after bond interest; −$1.8M/day after full debt service; rated BBB (new bonds 3.10%) |
| **Sprawl** (`scenario=sprawl`) | Elevated Jamaica–Glen Oaks and St George–Huguenot | $5.00B | 15.7k | −$0.81M/day; rated BB with no debt |

So the core covers its operating costs and interest at about 1.45–1.5M riders. Repaying the
principal as well needs more ridership or a higher fare. The sprawl network loses money every
day. With everything off (`ops=off`) the numbers are exactly those of the code before operations
control: 1.333M riders on day 11, $23.2B, +$1.4M/−$0.28M/−$1.8M a day, sprawl $4.95B and
−$0.8M/day.

### London

London uses the same construction, train and operating numbers (read as pounds). Its own values
are in `CITY_BALANCE.london`:

| Area | London |
|---|---|
| Money | £5B start; fares £2.80 peak (6–10 am, 4–8 pm) / £2.70 off-peak (£0–5, step £0.10; the flat fare of older saves and of `ops=off` is £2.80); values of time £8/£14/£26 per hour |
| Credit | the same ratios, judged against London's ridership: farebox anchors × 0.6 (0.3 / 0.6 / 0.9 / 1.2× for 0 / 50 / 80 / 100 points) and coverage anchors 0.5 lower (−0.5 / 0 / 0.5 / 1.0 / 2.5×), since the same central network carries about 58% of New York's riders |
| Driving | 13 km/h in inner London (the 14 ONS inner boroughs), 24 km/h outside; £0.25/km; drive constant +35 min (fewer London households own a car) |
| CBD | inside the inner ring road (approximately the congestion-charge zone): 20 min and £25 (£15 charge plus parking) |
| Goals | Cross the Thames; reach every borough (stretch); Bank to Heathrow in under 45 minutes; plus the shared milestones |

| Scenario | Network | Capital | Riders/day | Daily money |
|---|---|---|---|---|
| **Core** (`city=london scenario=core`) | 4 deep routes, 43 stations: Paddington–Bank–Stratford, Kentish Town–King's Cross–Elephant–Brixton, Victoria–Waterloo–Canary Wharf–North Greenwich, Hammersmith–Piccadilly–Cannon St–Shadwell | £24.3B (needs £19.3B of bonds) | 764k on day 11, 13% transit share | Operating −£0.31M/day; −£2.2M/day after bond interest; rated BB (new bonds 3.75%: it recovers 86% of its operating costs; New York's anchors would rate it CCC) |
| **Sprawl** (`scenario=sprawl`) | Elevated Dagenham–Upminster and Eltham–Bexleyheath | £3.43B | 16k | −£0.59M/day; rated BB with no debt |

(With `ops=off`: 761k, £24.2B, −£0.29M/−£2.1M a day; sprawl £3.38B, −£0.59M/day, as before
operations control.)

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

With operations control (every perf route holds at 70% with suggested timepoints, no recovery, so
the fleet stays at 431 trains), on this shared machine, medians of 6 interleaved runs:

| Run | Before operations control | Now |
|---|---|---|
| chaos Off | 217 ms | 232 ms (`ops=off`: 222 ms) |
| chaos Normal (76 holds in the timed hour) | 237 ms | 226 ms |
| `chaos=wild weather=snow outdoor=1` (279 holds in the timed hour) | 307 ms | 309 ms |

After the second review's fixes (regularity and holds judged by the dispatch headway, suggested
timepoints spaced out), medians of 6 interleaved runs on a busier moment of the machine: `pre-ops`
271 ms, now 264 ms (`ops=off` 299 ms); chaos Normal (3 runs) 247 → 274 ms. Single runs ranged from
214 to 382 ms, with the same 40,320 boardings and 1,090 waiting as `pre-ops`; all far inside the
1,000 ms budget.

Single runs vary by ±40 ms here, so the same hour was also timed in one process, stepping the old
and new engines alternately in 30-step chunks: the new code costs about +3.5% with operations
control on and +4.5% with it off (the regularity statistics run either way). The clean grid runs
like clockwork (headway CV 0.04), so nothing is held there with chaos Off.

**Living City.** The peak hour never crosses a month, so it is unchanged: 40,320 boardings and
1,090 waiting as before, 220–266 ms against 211–265 ms for the code before Living City in
interleaved runs, and within ±1% in one process (old and new engines stepped alternately; which
engine loads first matters more than the code). The script then runs on through two growth month
closes (the midnights after days 1 and 3) and times each, with a 600 ms budget:

| Month close (perf grid, scale 10) | New York (285k agents, 300 stations) | London (292k agents, 300 stations) |
|---|---|---|
| The first (every agent is re-placed once) | 500–616 ms, median 502 | 360–391 ms |
| A typical month | 290–375 ms | 153–340 ms, typically ≈ 220 |

Of a typical New York close, the commute benefit takes ≈ 50 ms, the growth step ≈ 55 ms (Furness
over 976k pairs) and regeneration ≈ 170–260 ms (rounding the OD ≈ 70, groups and agents copied in
runs, paths for the ≈ 160 new pairs ≈ 25). The first close also places all 285k agents again from
their own seeds (≈ 150 ms). Nothing else in a step changed.

## City chaos

Every weekday the city throws something at the network: special events at real venues,
disruptions and weather. Each one goes through mechanics the sim already has:
- train speeds and dwell times;
- boarding and platform queues;
- walking and driving times.

So it shows up in observed door-to-door times and crowding, and in the next day's mode choice.
The design is `docs/v2/events-chaos.md` (its top sections have the implementation notes for the
sim and the UI).

### In the game

- **Top bar.** A weather chip shows today's weather and the next day's forecast ("Tmrw: snow
  90%"). Its tooltip lists the effects in your units. A news ticker scrolls the active incidents,
  today's events (with the 3 am estimate by subway or metro), the weather and forecast,
  announcements and recently cleared incidents. It pauses on hover, and each item opens Service
  alerts at that item. When its slot is narrower than 220 px (about 1,366 px wide and below) the
  ticker hides and the chip stays. With reduced motion it
  shows one item and "+N", rotating every 5 s. With chaos Off, both are hidden.
- **Service alerts** (`A`, the bell, the chip, a ticker item, a marker or a toast). The sections
  are:
  - **Now:** active incidents. A click flies the map there, and **Show** opens the station,
    train or route.
  - **Weather:** today's effects and tomorrow's forecast.
  - **Events:** today's and the announced ones, with the stations within 1.5 km, the routes
    serving the venue and today's split by mode.
  - **Earlier today:** cleared incidents and event wrap-ups.
  - **City chaos:** the level control, which applies from 3 am.
- **Event service.** "Event service…" on an event card opens an inline editor:
  - routes stopping within 1.2 km of the venue are ticked;
  - a window before and one after the event (15-minute steps), and a headway;
  - per route: trains needed (sized with the route's recovery, as in the route panel) against owned, the effective headway if the fleet is short, and
    the extra car-km and their cost in dollars or pounds.

  Planned service shows under the event card and in the route panel (Frequency), with
  **Remove**, until its last window ends. Planned before 3 am on the day, it also brings more
  fans by train. Deleting a route drops its event service. If a level change takes an announced
  event off the calendar, its service is cancelled (with a toast), so you never pay for service
  you can't see.
- **Map.** Venue markers are lavender dots sized by attendance, solid for today and faded for
  announced days, with labels above them from zoom 11.5 (drawn over stations and trains).
  Venue and incident dots face the camera in 3D. Incident markers pulse even while paused: red for
  breakdowns and police, amber otherwise. Closed stations get a red ring and "CLOSED". Stalled
  or held trains get a red casing with a white rim. Signal problems are amber dashed stretches
  of track. A focused event shows its 1.5 km catchment ring.
- **Panels and toasts.** The station panel shows a red "Closed: police activity until…"
  banner. The train panel shows "Stalled…" or "Held at…", and the route panel lists its active
  incidents. New incidents toast at 1× and 5× (severity 3 at any speed, at most one every 20 real
  seconds). Announcements always toast. Event wrap-ups toast where fans could come by train
  (some did, or a station is within 1.5 km of the venue); the others go to the feed only, as do
  alerts from hours that were skipped. Loading a save from before city chaos shows a one-off
  "New: city events…" toast.

**Determinism.** Everything comes from the game's chaos seed:
- the event calendar, the weather and its one-day forecast, and the incident plan are pure
  functions of `(seed, day, level)`, computed identically on the main thread and in the worker
  (`src/core/cityCalendar.ts`, `src/sim/incidents.ts`);
- event-goers are drawn from a stream per event.

The commuter RNG is never touched. With chaos **Off** the simulation is bit-identical to the
code before chaos: the same `DayReport`s, finances and mode shares, checked by hashing the
headless and balance runs. Headless runs and scripts default to Off. A save stores the level
from the next 3 am and the level in force today, the seed, the exposure today's incidents were
planned from at 3 am, and the planned event service. A load mid-day replans the rest of the day
from the seed at today's level and from that exposure, so it matches the uninterrupted day even
after a level change or a network edit since 3 am. Fans already on their way to (or at) an event
count as arrived at their expected trip time, and wrap-ups posted before the save are not posted
again.

| Level | Incidents | Weather | Events |
|---|---|---|---|
| Off | none | always clear | none |
| Calm | ×0.5 | normal | normal |
| Normal (new games) | ×1 | normal | normal |
| Wild | ×2.5 | chances ×1.5 | chances ×1.25 |

A level change takes effect at the next 3 am, including after a save and load.

### Incidents

They fire between 05:30 and 23:30, without warning, at rates set by the network's exposure. On
the ~40-station core that is about 7–9 a day at Normal and about 21 at Wild.

| Kind | Rate (Normal) | Lasts | What happens |
|---|---|---|---|
| Signal problem | 1 per 50 directed-track km a day | 15–60 min | an 800 m stretch of one track is limited to 15 km/h; trains bunch behind it |
| Train breakdown | 1 per 10,000 planned train-km | 5–20 min | a running train brakes hard and stalls; the moving block queues followers |
| Sick passenger | 1 per 12,000 train-km | 3–8 min | the train is held at its next stop (never at a terminal) |
| Police activity | 0.02 per station a day, busy stations likelier | 10–40 min | the station closes. Trains run through, and riders for it get off at the next stop and walk back. People waiting come back when it reopens if that is within 15 min; otherwise they take a cab |

While an incident is active, the deadlock watchdog ignores stall time on its routes and on every
route sharing track or a junction with them; a stall anywhere else is still caught after 30 min.
There is no separate incident cost: it shows up as lost fares, crowding, give-ups and the next
day's choices.

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

(Measured before operations control and the money market, i.e. as `ops=off` today.)

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

Re-measured after the UI work, on a quieter moment of the same machine (3 interleaved runs each):
the code before chaos took 132–215 ms and chaos Off 132–141 ms, with the same 40,320 boardings
and 1,090 waiting. Single runs gave 178 ms at Normal and 179 ms for
`chaos=wild weather=snow outdoor=1`. The UI adds no sim work.

After the review fixes (per-route watchdog grace, saves keeping today's plan), 3 interleaved runs
on a busier moment: Off 206–260 ms against 202–278 ms just before the fixes, Normal 245 ms
(241 before) and `chaos=wild weather=snow outdoor=1` 346 ms (341 before), with identical
boardings and waiting. All well inside the 1,000 ms budget.

## Operations control and the money market

v2 adds dispatching, fare policy and treasury management (design: `docs/v2/ops-money.md`, whose
top sections have the implementation notes for the sim and the UI).

**Operations control** (per route, `Route.control`):
- **Holding.** A departure from the first stop waits off the running track while its gap behind
  the train ahead would be under 70% of the headway in force (event service included). At
  *timepoints* the player picks, a train due to leave waits for the same gap, at most 90 s, and
  leaves at once if another route's train queues within 400 m behind it; junction claims ahead are
  released while it waits. There is no hold at a closed station.
- **Recovery** adds a share of the run time (0–20%, 10% for new routes) to the terminal layovers:
  the fleet grows (one train per core route at 10%) and late trains use the slack.
- **Short turnarounds.** A crew turns a train in 2 minutes instead of 3 when its next departure is
  already due and no train is waiting for it.
- **Regularity** is measured at every departure: headway CV, the share bunched (under half the
  headway) or gapped (over 1.5×), the excess wait riders feel, holds, and the mean lateness into
  the terminals (a recovery advisor). It is in each day's report, per route and for the network.
  Gaps are judged against the headway the trains were dispatched under (a train sent at 09:58 on
  the 4-minute peak still reaches the far end after 10:00, when midday's 8 minutes are in force),
  and holds use the same rule, so an on-time train is never held at a period change or at the
  start or end of event service.

Routes from older saves keep their fleet: holding off, no recovery (short turnarounds on).

| Core, day 11 (headless) | Bunched | Headway CV | Lateness | Left behind | Riders |
|---|---|---|---|---|---|
| New York, holding off, no recovery | 9.0% | 0.49 | 112 s | 937k | 1,340,860 |
| New York, new-route defaults | 5.4% | 0.43 | 103 s | 824k | 1,349,870 |
| New York, defaults + 2 suggested timepoints per route | 2.4% | 0.40 | 102 s | 686k | 1,346,640 |
| London, everything off | — | — | 32 s | 16k | 760,560 |
| London, new-route defaults | 0.4% | 0.12 | 8 s | 120 | 763,700 |

Timepoints more than halve the bunching again; lateness moves a little either way from day to day
(the timetable doesn't know about the holds). On the test network, day 1 bunching falls from 10.2%
to 1.9%; on a synthetic busy line from 33.2% to 0.9%, carrying 32% more trains. A noise-free line
whose headways change by period (and with event service) reads CV 0 and holds nobody. No run had a deadlock, including holding next to Wild city chaos,
event service and a 40-minute breakdown.

**Fares.** A peak fare (6–10 am, 4–8 pm), an off-peak fare and a low-income multiplier (full,
half or free) for the lowest earnings band. Each journey pays once, at its first boarding, by band
and period. Mode choice sees each group's expected fare (96–97% of commuter trips start in a peak),
and agents travelling off-peak are tilted towards transit by their own fare. New York defaults to
one $3 fare; London to £2.80 peak / £2.70 off-peak. On the New York core (day 11): $3.25 peak /
$2.50 off-peak earns about 7% more fare revenue for 0.4% fewer riders; a half fare for the lowest band costs 3%
of revenue and lifts that band's transit share from 13.5% to 14.5%.

**The money market.** Each bond keeps the coupon it was issued (or refinanced) at. New bonds cost
the market's base rate plus the authority's credit spread. The base rate starts at 2.5% and moves
at each month end as a seeded, mean-reverting walk (from the game's seed, so a reload walks the
same path) with rare ±0.75% shocks. The rating, AAA to CCC, comes from a monthly scorecard of
farebox recovery, interest coverage (with one more $1B bond pro forma), leverage and months of
cash, with a ±2-point margin before it moves. A new game is AAA, so month 1 borrows at exactly
2.5%. Bonds can be prepaid (1% penalty, the maturity is kept with a lower payment) or refinanced
at today's rate (1% fee, the remaining term is kept). Idle and spare cars sell for 40% of the
new price. A year in review is built at each year end. The New York core rates BBB (3.10% for new
bonds); London's core, which recovers 86% of its operating costs, BB (3.75%) on London's own
farebox and coverage anchors; a sprawl network with no debt BB in both cities. Only a rating set by
a month-end review counts for the Investment grade goal (a new game's AAA is a placeholder).

### In the game

- **Route panel.** *Service regularity* has four cards from yesterday (after a load or Continue,
  yesterday's from the saved report; otherwise today so far): the
  grade with the headway CV (even under 0.25, uneven under 0.45, then bunched), the share of
  bunched headways, the extra wait riders feel and the holds. Below them, *Headway spread along
  the line* charts the CV stop by stop for both directions, with the timepoints listed under it.
  *Operations* has Holding (Off / On, threshold 50–90% of the headway), Recovery (0–20%, with the
  minutes per terminal, the extra trains and, when yesterday's terminal lateness calls for more,
  a suggestion) and Timepoints (**Suggest**, **Clear**, and a clock toggle on every intermediate
  stop in the stop list). These edit the same draft as Frequency and Train length; **Apply** in
  the panel's footer commits them together and buys any trains. The fleet lines show the
  recovery, and idle cars with a **Sell** button. **H** switches holding at once and keeps any
  other unapplied edits in the draft. **Suggest** picks a stop near ⅓ and ⅔ along the line,
  preferring stops no other route serves when one is close to the target, and never two stops
  side by side.
- **Train panel.** A train held at a timepoint reads "Held at 110 St" in amber ("Waiting for an
  even gap behind the train ahead"). The routes list adds "gaps even", "uneven" or "bunching".
- **Finances** (**M**), in tabs (the open tab is kept for the session):
  - **Overview:** cash, debt, bond room, assets, the credit rating (with an outlook arrow; click
    for the scorecard) and today's new-bond rate; yesterday's ledger with financing fees and bond
    prepayments; this month so far; the monthly chart; **Year in review** (any year with data).
  - **Fares:** peak (6–10 am, 4–8 pm) and off-peak sliders (they keep keyboard focus as each step
    applies; a split policy stays split when the two fares meet), *Same fare all day*, the low-income
    fare (Full / Half / Free), and yesterday's fares: the peak share, the average fare, the lowest
    earners' share and transit share, and revenue by earnings band. In London the sliders move in
    10p steps.
  - **Borrowing:** the market, your spread and the new-bond rate, the next review date, **Issue
    bond**, the credit scorecard (each ratio's points and what the next step earns, then
    "Score 56 → BBB (A needs 67) · outlook stable"), the rate history chart (market, your new
    bonds, the average cost of your debt), and each bond with **Prepay…** ($250M, $500M or all,
    with the penalty and the new payment) and **Refinance at x%** (enabled when today's rate is
    at least 0.05% below its coupon; the confirm shows the fee, the monthly saving and the
    payback).
  - **Fleet:** cars per class on routes, needed, idle and in the spare pool; sell the spare pool
    or a route's idle cars (each confirmed with the new price and the maintenance saved).
- **Toasts** for rating changes and bond market shocks (a click opens Borrowing), fare changes,
  bonds issued, prepaid and refinanced, car sales and holding. The month report adds the credit
  rating and financing fees. On the first weekday of January the **year in review** replaces
  December's report: riders by month, money, the rating's path, the bond market's range and
  shocks, service regularity and the goals of the year. Every figure, and the date span, covers the
  closed months; the riders chart follows the window's width. Months closed before v4 get their
  month-end debt rebuilt from the bonds when the save migrates (unknown debt reads "—").

## Living City

Once a month the city responds to the network (design: `docs/v2/living-city.md`, whose top
sections have the implementation notes for the model and the sim). At the midnight after the
month's last weekday, the same moment the finances close the month, the worker:

1. **Measures each tract's commute benefit:** the minutes per commute the network saves the
   people who live there and who work there, against no network. It is the logsum difference of
   the mode choice the sim already runs: transit at exactly the cost mode choice uses (yesterday's
   observed door-to-door time, transfers, crowding and the group's fare by band and period), walk
   and drive on a clear day. Crowding, left-behinds, lateness, incidents and the fare all reduce it.
2. **Grows residents and jobs** toward well-served tracts (attractiveness b / (b + 20 min)): the
   city's natural growth (New York 0.8%, London 1.1% a year) plus a boost for good transit, part
   of it drawn from elsewhere in the city. Monthly caps (residents +1.2% / −0.4%, jobs +1.0% /
   −0.3%), long-run bounds (×0.7 … ×2 per tract) and a city ceiling (×1.5) keep it in check.
3. **Rebalances the OD matrix** with Furness factors, OD′ = OD · fHome · fWork, so every tract's
   row and column sums match its grown residents and jobs (within 0.5%).
4. **Regenerates the commuters** from OD′ with common random numbers: one rounding draw per OD
   cell in file order, so each pair's count only moves when its factor crosses a threshold.
   Unchanged groups keep their shares, observations and paths; new bands of a known pair copy its
   paths; only new pairs are searched. New groups start at their logit target. Ridership carries
   over without a jump.
5. **Captures land value.** Every part of a tract within 800 m of a served station is in a Transit
   Improvement District, which pays the authority a share of the extra property tax from new
   development and from an accessibility premium that capitalises over about 10 months (at most
   12%). It is booked as its own line in the day's ledger (and the month report, the profit, the
   year in review and the credit scorecard's interest coverage, but not its farebox recovery: the
   Hudson Yards bonds for the 7 line were backed by district tax increment).

| | New York | London |
|---|---|---|
| Value per commuter | $390k per resident, $115k per job (DOF FY2025 roll: homes $1.11T, class 4 $330B, over 2.85M commuters each) | £680k per resident, £140k per job (≈ £2T of homes; ≈ £20B of rateable value at ≈ 5% yields, over 2.93M commuters each) |
| Effective tax on market value | homes 1.6%, workplaces 3.9% (the ≈ $34B levy by class shares) | homes 0.25% (council tax ≈ £5B a year), workplaces 2.5% (business rates ≈ 51p per £ of rateable value). The UK has no ad valorem property tax; the Crossrail business rate supplement and the Nine Elms enterprise zone (Northern line extension) are the precedents, so most of London's value capture comes from workplaces |
| Share pledged to the authority | 12% | 14% |
| Goal "Land value pays" | $10M of value capture in one month | £6M |

The pace (`Game.growthPace`, saved) is **Off** (the city before Living City, bit for bit),
**Steady** (new games and migrated saves) or **Boom** (×3). It applies from the next month close.
Goals: *Boomtown* (a neighbourhood of at least 1,000 people grows 25% since the start year) and
*Land value pays*. (The growth overlay, the tract and station panels' growth sections, the month
report's City section, the toasts and the menu switch are the next step; `App` already exposes
the month's `GrowthMonth`, a cached `GrowthView` and `setGrowthPace`.)

**Placement and determinism.** The starting city's agents are placed exactly as before (one
seeded stream). At the first growth regeneration every agent is placed again once from its own
seed, hash(seed, home·3 + band, work, k), so from then on a kept agent is copied unchanged and a
reload of a grown city rebuilds the same agents bit for bit (tested in both cities). Growth uses
no random numbers, stores Float32 state canonicalised with `Math.fround`, and closes a month once
(a save from just before midnight re-runs it on load, idempotently). The midnight autosave takes
the mode shares and the growth state in one reply, so they always describe the same groups. A
save whose growth no longer fits the city's data starts the city over, with a "City growth was
reset" toast. With chaos on, event-goers come from the grown city's residents; fans still out at
a month-end midnight are sent home with everyone else (as at 3 am), and the next day's events run
on the new agents.

**Identity.** With `pace=off` the `dump=` output (every `DayReport`, `finance.toData()`, hashes of
the shares and observations) is byte-identical to the code before Living City in both cities,
for `headless-sim days=3` and for `balance` core and sprawl runs of 25 days that cross the January
month end, with chaos Off and Normal. On Steady, everything before the first month close is
byte-identical too (`balance days=12`, `headless-sim days=3`, `perf`); on day 18 the report gains
its `growth` section and the ledger its value capture.

### Balance (headless, agent scale 10, a new game's operations control and fares, chaos Off)

`balance -- months=12` (12 growth months of 5 days; value capture per day is the month's payment
over an average month's 21.75 weekdays) and a calendar year (`days=262`, 12 real month closes)
agree within 3%:

| Steady | Month 1 | Month 6 | **Month 12** | Riders | City at month 12 |
|---|---|---|---|---|---|
| New York core | $0.04M/day | $0.21M/day | **$0.35M/day** ($7.7M in December) | 1.35M (day 11) → 1.42M, still rising | ×1.013; best tract +4.4% |
| New York sprawl | $0.0003M/day | $0.002M/day | **$0.003M/day** | 17k | ×1.008 |
| London core | £0.02M/day | £0.12M/day | **£0.21M/day** (£4.5M in December) | 764k (day 11) → 828k, still rising | ×1.016; best zone +5.1% |
| London sprawl | £0.0002M/day | £0.0008M/day | **£0.002M/day** | 18k | ×1.011 |

London's core earns 59% of New York's value capture in pounds, in step with its riders (58%) and
fares (value capture is ≈ 9% of fares in both cities). With month 12's value capture the New York core goes from
−$0.08M/day after bond interest to about **+$0.27M/day**; London's core improves from −£2.0M to
−£1.8M/day (it is the harder city, as before); both sprawl networks keep losing ($0.80M and
£0.59M a day). **Boom** at month 12: New York $0.72M/day (1.51M riders, city ×1.04, best tract
+13%), London £0.42M/day (915k riders, +15%); the New York sprawl stays under $0.01M/day. The
calendar-year runs had 0 deadlocks on all 262 days in both cities. *Land value pays* comes at
about month 17–19 on Steady (extrapolated) and month 6–7 on Boom.

## Known issues

- Changing the city chaos level redraws the announced events from that level's calendar at
  once (Wild draws more, and a venue can draw a different kind), while today's events stay as
  the worker planned them at 3 am. Event service planned for an announced event that the redraw
  removes is cancelled, with a toast.
- After a mid-day load, the day's report counts boardings from the load onwards only (as in v1),
  so event fans' trips to the venue made before the save are missing from its event riders.
- Units are one setting for both cities (miles by default), so London shows miles until you
  switch to kilometres in the menu.
- London uses 2011 census flows, because the 2021 census was taken in lockdown. Its commuter
  totals are 2011's, and its earnings bands are modelled from area income rather than measured.

- I could not measure frame rate in this environment, which has no GPU (only software WebGL).
  The 60 fps target needs checking on real hardware. Per-frame JS cost is small, so any
  bottleneck would be on the GPU (3D buildings at high pitch).
- Riders on the core network are limited by coverage: about 30% of commuters have any transit
  path, and about 70% of those take it. The core is also crowded at the peak, with a lot of
  left-behind events at 2.5-minute headways.
- Station auto-names come from the street labels in loaded tiles. Zoomed far out, a station may
  get a neighbourhood name instead of cross streets. Use Rename.
- Bulldozing is not undoable (undo covers blueprint edits). Built track or stations used by a
  route must be removed from the route first.
