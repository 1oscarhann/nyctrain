# Headway

A metro builder set in real cities where nobody ever built one. Pick a mode on the title screen:
**Metro** (**New York**, the five boroughs, or **London**, all 33 boroughs) or **Intertown**
(**South East**: London and the whole ONS South East region, a railway builder at regional
scale; see [Intertown](#intertown-the-south-east)). You get the actual streets,
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
**Load game**, **Settings** (units, agent scale, day and night) and **Continue** (the autosave). Units follow
the city (miles in New York, kilometres in London) until you pick some for that city in Settings
or the menu. Saves remember
their city, so loading a London save from the New York title screen switches over. A new game
asks for the city chaos level (Off / Calm / Normal / Wild, remembered; Normal by default) and
offers an 8-step tutorial. The city grows around good transit once a month ([Living City](#living-city);
Steady by default). The light follows the game clock: dawn, day, dusk and night with each city's own
sunrise and sunset, lit windows and glowing lines at night, a follow camera, photo mode and a
timelapse of your network ([Cinematic](#cinematic)).

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

## Intertown: the South East

A third map and a second mode. London's 33 boroughs plus the 67 districts of the South East
(Brighton, Portsmouth, Southampton, Reading, Oxford, Milton Keynes, Canterbury, Dover…), 2,091
MSOAs and **6.35 million** commuters (2011 census, every commute that starts and ends in the area,
so London-bound commuters from the coast count). Every game starts with one free, built terminal:
**Victoria**, an elevated 14-car platform on a stub of main line pointing south over the river.
£15B to start.

* **Data**: `npm run data:southeast` (`scripts/build-data-southeast.ts`, the London pipeline widened;
  writes `public/data/southeast/`). Regions and chart areas are `src/cities/southeastRegions.ts`.
  The land mask uses 60 m cells (`MAP.landCell`), so the narrow upper Thames is land at this scale.
* **Distance fares**: a journey costs the fare × (1 + (km − 3) ÷ 20), straight line home to work
  (`ECONOMY.fareDistanceKm`, `fareFreeKm`; Infinity in the metro cities, which are unchanged).
* **Driving**: road beyond 12 km runs at 70 km/h (`COMMUTERS.driveLongAfter`, `driveSpeedLong`), so
  Brighton–Westminster is about two hours by car, not six at street speed. Off in the metro cities.
* **Naming**: stations take the nearest town or village label, else the district name.
* **Agents**: at least 1 : 20 (about 318,000 agents, New York's count at 1 : 10).
* **Goals**: London to the sea; reach the big towns (stretch); Victoria to Brighton in under an hour.

## Train types and high-speed line

Routes pick a train type (route panel → Trains); every type has its own capacity, acceleration,
top speed and price (`TRAINS` in `balance.ts`):

| Type | Car | Cars | Comfortable / crush per car | Top speed | Per car |
|---|---|---|---|---|---|
| Metro (`heavy`) | 18 m | 2–10 | 110 / 200 | 90 km/h | 2.5M |
| Light metro (`light`) | 20 m | 2–4 | 90 / 160 | 100 km/h | 2.0M |
| Commuter EMU | 20 m | 4–12 | 80 / 140 | 160 km/h | 2.2M |
| Intercity | 24 m | 4–11 | 70 / 95 | 200 km/h | 3.0M |
| High-speed | 26 m | 4–16 | 60 / 75 | 300 km/h | 4.5M |

Track has a **line speed** per class (`TRACK.lineSpeed`: heavy 200, light 100, high-speed
320 km/h); curves can lower it. Metro trains are slower than heavy track allows, so metro play is
unchanged. **High-speed line** is a third track class: 1.8× the cost, curves of 1.5 km or wider
(canted: lateral 1.4 m/s²), 3 km fillet tangents. It is heavy-rail track built for speed, so it
joins ordinary heavy track at junctions and high-speed trains can run into an ordinary terminal
(at 200 km/h there). Light track still can't join either.

Platforms are counted in platform cars (18 m on heavy track, 20 m light, 26 m high-speed), and a
route's train length is what fits its shortest platform for its train type (a 14-car heavy
platform takes 12 commuter or 10 intercity cars). Changing a route's train type puts its old cars
in the spare pool (sell them in Finances → Fleet) and buys the new fleet. Old saves load with
their routes on metro trains, exactly as before.

## London style

London and the South East use a London-transport look (`theme: 'tfl'`, `html[data-theme]`): navy
panels, a blue primary action, the Cabin typeface (a humanist sans in the Johnston/Gill tradition,
SIL OFL), line bars instead of round bullets, a London line palette, and map stations as **ticks**
in the line colour (one-line stations) and white **rings** (interchanges). Deliberately no roundel
and no Johnston: both belong to TfL. New York keeps the subway look (letter discs, small dots).

## Schools

Every real school on each map, from official data: **Overlays → Schools** turns the layer on (it
sits on top of any overlay) and filter chips show or hide each kind (primary, secondary,
all-through, special & alternative, independent, nursery; New York: elementary, middle & high,
K-8 & K-12). Dots are coloured by kind and sized by pupils; names appear from street level; hover
for the type, pupils and age range. A station's panel lists the schools within the 800 m walk and
their pupils. The filter is remembered per browser.

* **England** (London, South East): DfE school census 2025/26, school-level data (Explore Education
  Statistics: name, type, phase, postcode, pupils by age), placed by postcode with the ONS Postcode
  Directory. Open Government Licence v3.0.
* **New York**: NYC DOE 2019–20 School Locations joined to the 2021–22 Demographic Snapshot for
  enrolment (NYC Open Data).
* Rebuild with `npm run data:schools` (`scripts/build-schools.ts`; downloads cached in
  `scripts/.cache/schools/`, the census file is ~2.8 GB). Output: `public/data/<city>/schools.json`.

### The school run

On school days (term time: England's terms and half terms, New York's school year) every real
school's secondary-age pupils (11–18; New York grades 6–12, from the census and enrolment data)
travel to it. The census has no home-to-school flows, so each pupil's home is drawn from nearby
neighbourhoods (residents · exp(−d / 2.5 km); 4.5 km in the South East). Pupils choose walking, a
lift or the school bus (one "car or bus" option, no buses are simulated) or your trains, with child
fares (`SCHOOLS.childFare`: half in England, free in New York) and their own times (at school
8:10–8:50, home from 15:05). They ride the same trains as commuters, adding morning-peak crowding
near big schools. A station panel shows how many pupils came by train to the schools around it.

## Park & ride

Stations can have a car park (station panel → Park & ride: 250 / 500 / 1,000 spaces at
`PARK_RIDE.costPerSpace`, up to 5,000). From home, people can then drive up to 15 km to the station
(the drive, 4 minutes to park, a £4 / $4 daily fee, fuel and a little hassle), take the train, and
drive home from it in the evening. Only the home end is driven. Car parks are rationed: where more
drivers want a station's spaces than it has, the overflow drives the whole way, and the panel shows
"full: N more wanted a space". Old saves load with no car parks; without car parks the simulation is
exactly as before.

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
| G | City growth overlay (toggle): growth since 2030 and the value-capture district; tilted (V), new development |
| Menu → City growth | Off / Steady / Boom (applies from the next month end; a toast confirms) |
| H | Holding on / off for the selected route (a toast confirms) |
| Clock toggle (route panel stop list) | Timepoint: trains may be held there to even out gaps (shown while holding is on) |
| Q (Track tool) | Two or four tracks; works mid-stroke |
| F (Track tool, four tracks) | Flip the side the express pair runs on; works mid-stroke |
| X (Track tool, four tracks) | Scissors crossover placement on / off (Esc also leaves it) |
| Shift-click (Station tool, four tracks) | One platform on the pair under the cursor (a local-only stop) instead of a cross-platform station |
| E (Route tool) | Local or express draft |
| Alt-click (Route tool) | The other platform of a cross-platform station |
| Shift-click (Bulldoze) | Only this platform of a cross-platform station (the other stays as a lone platform) |
| P | Photo mode on / off: the interface hides (L letterbox, C caption with date, time and city); Esc or P leaves |
| Follow (train panel) or F (a train selected) | The camera follows the train: a chase camera in 3D, centred in 2D; F, Esc or dragging the map stops; the wheel sets the distance |
| Film button (toolbar) | Timelapse: replay the network's growth month by month (Space play / pause, ← → a month, Esc closes) |
| Menu → Light, title → Settings | Day and night / Always day; lit windows or dark (per browser) |

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
  cinematic/      day/night palette and the sun (palette.ts, solar.ts), the runtime light (daylight.ts), night glow, follow-cam (chase.ts maths, followCam.ts), photo mode, timelapse recording/encoding and player
  map/            MapLibre style recolouring, network/station/elevated layers (four-track pair push, cross-platform capsules), overlays (city growth: growthMath.ts), naming and tract names (placeNames.ts), city chaos markers
  construction/   track graph with arc fillets, levels and ramps, validation and costs, four-track sections and crossovers (quad.ts), tools
  routes/         route pathfinding on track, compilation for the sim, fleet sizing and car sales, operations control settings, express patterns (express.ts), route tool, event service estimates
  trains/         kinematics (run profiles), interpolated train layer
  sim/            worker, engine, train sim (moving block, merge locks, holding), regularity, commuters, mode choice, transit graph, city chaos (incidents, event trips), city growth (growth.ts)
  economy/        finance: daily settlement, monthly reports, bonds, bankruptcy, value capture; fares, credit rating and bond market, year in review
  ui/             app shell, panels, charts, tutorial, menus, city chaos (alert feed, news ticker, Service alerts), Living City text (livingCity.ts), four-track and express text (express.ts)
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
the network (with four-track sections and cross-platform stations), routes (with their operations
control settings and the express flag), finances (bonds with their coupons,
the bond market and the rating), the fare policy, goals, the day's mode shares and observations,
the city chaos level (today's and the one from the next 3 am), seed, today's incident-plan
basis and planned event service, and the city's growth (pace, per-tract multipliers and balancing
factors, the land-value premium and a thinned history), and the Cinematic timelapse (the network
at each month close, compactly encoded; save format v7; older saves migrate). The
commuters are rebuilt from the data, scaled by the saved growth, when the save is loaded.

## Testing each part

```bash
npm test                 # all 338 tests (unit + headless, both cities)
npm run test:unit        # 311: geometry, costs, ramps, water, pathfinding, logit, kinematics, economy, London,
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
                         # scorecard and the year in review, its goals, save v5, and its UI text in both
                         # cities (toasts and their selection, the month report's City rows, the tract,
                         # station and finance lines, goals, the year's City line, units and currency), the
                         # growth ramp and its span, and tract names (map labels, stations, the fallback);
                         # four-track trunks and express service: quad geometry and strokes, crossovers, pairs
                         # and costs (also on London's land), route pathfinding and its gate (ordinary track
                         # keeps its paths), stations along a path, skip/serve and the patterns, compile,
                         # cross-platform transfers, overtaking against a shared pair (280 s against 334 s),
                         # riders taking the first train of either and changing across the platform (to an
                         # express in or due), incidents, closures, event service, holding, timepoints and value
                         # capture on four tracks, save v6, the express pair priced ×0.5 only beside a local
                         # pair, drags beside a fan, load sanitising, putting a bulldozed stretch of one pair
                         # back; and their UI: the pair push on the map and its sign whichever way a chain is
                         # drawn, the four-track, crossover, station and bulldoze texts (connectors by kind,
                         # units and currency in both cities), link candidates, the Line list, the Overtakes
                         # card, the merged station figures, the route tool's insert-in-order and Alt-click,
                         # event cards and construction labels listing a pair once, Service edits that change
                         # nothing; Cinematic: the day/night palette (keyframes, OKLab mixing, weather tints,
                         # the change threshold, the light), sunrise and sunset in both cities (published times
                         # at the solstices and an equinox, DST rules, London's shorter winter days), the chase
                         # camera maths and the drawn train pose (interline and pair offsets, track height), the
                         # timelapse (recording, bounds, size cap, encode/decode, the draw schedule, the replay's
                         # frames, timing, draw-in and stations popping up), save v7, the runtime light against a
                         # fake map (paint pushed only on change, Always day, windows twice a day), the settings,
                         # and the copy in both cities (follow chip, photo caption, timelapse counter and units)
npm run test:headless    # 27: 3 days on the test network (with regularity and fares by band and period),
                         # holding against no holding, holding next to Wild chaos and event service, chaos end
                         # to end (closures, event agents, determinism, snow, breakdowns, Off is inert, mid-day
                         # loads after a level change, an edit or an event, a London venue event), the
                         # browser's message order (an edit followed at once by a skip), and Living City (the
                         # commute benefit, a month close in New York and London, a save mid-growth, value
                         # capture through the finances, pace Off, an event day right after a month close,
                         # one snowy closing day against a clear one, a save made at once after a close), and
                         # an express on a four-track trunk (West Side; Oxford Street and the City)
npm run sim -- days=3    # headless run of the test network, with a daily summary (and regularity, fares, market)
npm run sim -- days=3 chaos=normal           # the same with city chaos: weather, incidents and events per day
npm run sim -- days=3 ops=off                # operations control, fare policy and bond market all off: as before v2
npm run sim -- days=3 pace=off               # Living City off (pace=off|steady|boom; the default Steady first grows after day 18)
npm run sim -- days=3 timelapse=1            # Cinematic: also record a timelapse frame every day end (timelapseDump=file.json)
npm run balance -- scenario=core days=12     # ~40-station core: ridership, daily money, regularity, credit rating
npm run balance -- scenario=sprawl days=8    # low-density sprawl: should lose money
npm run balance -- city=london scenario=core days=12   # the same for London (43 stations)
npm run balance -- scenario=core days=12 chaos=normal  # chaos=off|calm|normal|wild, seed=N, money=1
npm run balance -- scenario=core days=12 control=tp    # control=default|legacy|tp|off, ops=off,
                                                       # farePeak= fareOff= low=1|0.5|0, dump=file.json
npm run balance -- scenario=express days=12            # the core with a four-track Lexington trunk: local + express
npm run balance -- city=london scenario=express days=12 # Oxford Street and the City as four tracks
npm run balance -- scenario=express allstops=1 days=12 # its all-stops twin (the same stations, double track);
                                                       # localPeak= expressPeak= localCars= expressCars= exact=1
npm run balance -- scenario=core months=12             # Living City: 12 growth months of monthDays=5 days each
                                                       # (pace=off|steady|boom); days=262 runs a calendar year
npm run perf -- city=london                            # London's grid of the same size; month=0 skips the month closes
npm run perf             # 300 stations / 25 routes / ~430 trains: times one peak game-hour and two month closes
npm run perf -- chaos=wild weather=snow outdoor=1      # worst case: Wild, full snow, every track outdoor
npm run perf -- ops=off  # without operations control (by default every route holds, with timepoints)
npm run perf -- quads=5  # 5 north–south lines as four-track lines, each with an express (25 pairs, 30 routes)
```

`dump=file.json` (sim and balance) writes the run's `DayReport`s, the finance state and hashes of
the mode shares, for comparing two versions field by field. With `pace=off` every dump is
byte-identical to the code before Living City, including runs that cross a month end. A network
with no four-track sections and no express routes is byte-identical to the code before them
(`headless-sim days=3`, `balance` core and sprawl in both cities, core over 25 days across the
January month close, and the perf peak hour). Cinematic never touches the simulation: every dump
is byte-identical to the code before it (tag `pre-cinematic`), with or without `timelapse=1`.

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
9. **Living City:** build a line and skip past 31 January. The busy pill says "The city is
   growing", up to three toasts name the neighbourhoods that grew, and the month report has a
   City section with the boomtowns. **Show growth map** (or **G**) colours the tracts by growth
   since 2030 and rings the value-capture district; **V** raises the new development. Click a
   tract for its growth, index chart and value capture, a station for the value capture paid
   through it, and open Finances for the month's payment. Menu → City growth switches the pace.
10. **Four tracks and express service:** press **T**, then **Q**, and draw a line off the end of
    existing track and on into open map. The preview shows the local pair green, the express pair
    cyan (pushed apart a few pixels, as the map draws them) and the turnout and scissors grey, with
    each pair's length and cost and the connectors ("1 turnout, 1 scissors"); **F** flips the
    express side. Start the next stroke on the free end ("Click to extend the four-track section").
    **X** places more scissors. With **S**, a click on a four-track section places a cross-platform
    station (one capsule across both pairs), Shift-click a local-only stop, and a click opposite a
    lone platform adds its partner. Build; unrouted, a quad shows four thin rails. Press **R** for a
    local at every station, then **R**, **E** for an express: click its terminals, then the pairs
    (each goes in path order; Alt-click takes the local platform). Skip to the morning: express
    trains have a light casing and pass the locals; the route panel has *Service* (Local / Express,
    **Express pattern**, **All stops**), the Line list with **Skip** / **Stop here** and the
    *Overtakes yesterday* card, and the station panel shows a pair as one station with its
    cross-platform transfers. **B** on a pair demolishes both platforms (Shift: one).
11. **Cinematic:** a new game starts at 5 am, before sunrise: the map is night blue, lines,
    trains and stations glow, and in 3D (**V**) the buildings' windows are lit. Run to dawn (about
    7:20 in New York in January, 8:04 in London), day, dusk and night; rain greys the city and snow
    whitens it. Click a train and **Follow**: in 3D the camera rides behind and above it, the chip at
    the bottom says where it is going and any hold or incident; drag the map or press Esc to stop.
    **P** hides everything but the map and the attribution (**L** letterbox, **C** caption). After a
    month end or two, the film button replays the network growing. Menu → Light: Always day.

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
| **Express** (`scenario=express`) | The core with Lexington from Canal to 106 St as four tracks: cross-platform hubs at Grand Central and 92 St, the other seven trunk stations local-only (three or four skipped between hubs); local A and express X every 5 min each, the express half a headway after the local | $24.7B (+$1.4B; $18.7B of bonds) | 1.36M on day 11 (+1.1%) | Operating +$1.3M/day; −$0.51M/day after bond interest (core −$0.28M); rated BBB |

**Four tracks and express service** (day 11 of 12, details in `docs/v2/express-quad.md`; London against its
all-stops twin, `allstops=1`: the same stations on double track):

| Trunk | Run time, local / express | Trains | Riders, local + express | Lateness, local / express | Overtakes a day | Cross-platform transfers a day | Left behind (network) |
|---|---|---|---|---|---|---|---|
| New York, Lexington | 18.3 / 12.2 min (13 / 6 stops) | 11 + 8 (core: 20) | 321,610 + 171,640 (core: 487,160) | 168 / 53 s | 169 | 16,855 | 479k (core 824k) |
| London, Oxford Street and the City | 17.9 / 13.6 min (12 / 7 stops) | 11 + 9 (twin: 20) | 111,880 + 93,490 (twin: 205,630) | 10 / 11 s | 194 | 3,639 | 510 (twin 400) |

The express saves 6.1 minutes end to end in New York (4.3 in London). Riders take the first train
of either at a station both routes serve when it gets them to their stop about as soon, and on a
local at a hub they step across to an express that is in, or due within five minutes, when it still
gets them there sooner; the express leaves half a headway after the local, so at the shared stations
the two alternate. Commuters whose trip passes at least three of the express's skipped stations
(the same commuters in both runs, by the all-stops paths) ride 7.2 minutes faster by express in New
York (53.0 → 45.8 min door to door, with half the crowding) and 0.7 minutes in London (52.9 → 52.2;
its trips are dominated by long walks). Riders (boardings) rise 1.1% in New York and 0.2% in
London, but fare-paying journeys stay level (−0.2% and −0.3%): the trunk's through trips already go
85% (London 95%) by transit, so faster trips win few new commuters, and splitting the trains between
two routes halves the service at the local-only stations.

So the express network still earns less than the all-stops one: −$0.51M against −$0.28M a day after
interest (London −£2.23M against −£2.09M). The gap is the quad's capital: with the express pair
free, the New York express would run within $59k a day of the core (London £42k). Paying for $1.4B of
four-track works from fares would take about 38,000 more transit commuters (+6%). The express
review cut the gap from $0.35M to $0.23M a day (the express pair now costs ×0.5 of a double track,
a cross-platform pair 1.4× a station) and fitted London under the bond cap (£19.8B of £20B; line D
without its three least-used central stations). Keeping the local at 2.5 minutes and adding the
express on top (`localPeak=2.5 expressPeak=5`): 1.38M riders (+2.3%) for −$0.63M/day after interest
(London 763k, −£2.39M/day, and over the cap).

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
| **Express** (`city=london scenario=express`) | The core with west of Marble Arch to east of Bank as four tracks and the Central line's Chancery Lane added to line A: hubs at Oxford Circus and Bank, the other five trunk stations local-only; line D without Covent Garden, Temple and Tower Hill (to stay within the bond cap); local A and express X every 5 min each | £24.8B (£19.8B of bonds, within the cap; the all-stops twin £23.9B) | 764k on day 11 (twin 762k, +0.2%) | Operating −£0.33M/day; −£2.2M/day after bond interest (twin −£2.1M); rated BB |

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

**Four tracks and express service.** On the unchanged grid the peak hour is the same (40,320
boardings, 1,090 waiting; 176 / 140 / 152 ms against 173 / 223 / 200 ms for the code before it, in
interleaved runs). `perf -- quads=5` (325 stations, 30 routes, 494 trains, 25 cross-platform pairs,
40 merge locks, about 440 overtakes by 08:00) takes 176–255 ms (London 183 ms), within the 300 ms
target. Re-measured after the UI (which adds no sim work): 157 / 148 ms for the code before it
against 147 / 175 ms, and 212 ms for `quads=5`. After the express review (riders taking the first
train of either and stepping across to a due express, the express timed between the locals), 3
interleaved runs: 120 / 176 / 113 ms for the code before it against 121 / 143 / 134 ms, the same
40,320 boardings and 1,090 waiting; `quads=5` 185 / 182 ms (London 167 ms), 695 overtakes by 08:00.
On the main thread, the track tool's four-track preview (a clone, the stroke, every new edge's
report and the tooltip) takes about 1.2 ms per mouse move on that grid (p90 4 ms).

**Living City.** The peak hour never crosses a month, so it is unchanged: 40,320 boardings and
1,090 waiting as before, 220–266 ms against 211–265 ms for the code before Living City in
interleaved runs, and within ±1% in one process (old and new engines stepped alternately; which
engine loads first matters more than the code). The script then runs on through two growth month
closes (the midnights after days 1 and 3) and times each, with a 600 ms budget:

| Month close (perf grid, scale 10) | New York (285k agents, 300 stations) | London (292k agents, 300 stations) |
|---|---|---|
| The first (every agent switches to its per-agent placement) | 261–311 ms | 180–197 ms |
| A typical month | 188–243 ms | 117–164 ms |

(After the second review; the script prints the worst close too. Before it, the first New York
close took 433–616 ms and up to 716 ms with two background jobs, because it placed all 285k agents
again from their own seeds at midnight, ≈ 110–150 ms. Those placements are now computed ahead, a
few thousand agents per sim step while the city has not grown, into side arrays the sim never
reads, and the first close copies them like any later one.) Of a typical New York close, the
commute benefit takes ≈ 30–50 ms (the closing day's sample; the other days' samples are taken at
their own midnights), the growth step ≈ 35–55 ms (Furness over 976k pairs) and regeneration
≈ 115–180 ms (rounding the OD ≈ 70, groups and agents copied in runs, paths for the ≈ 160 new
pairs ≈ 20). Every other midnight now adds one benefit sample (≈ 30–50 ms) while growth is on.
Nothing else in a step changed: the peak hour has the same 40,320 boardings and 1,090 waiting
(157–177 ms against 185–197 ms for `pre-living` in interleaved runs).

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
   the mode choice the sim already runs: transit at exactly the cost mode choice uses (the day's
   observed door-to-door time, transfers, crowding and the group's fare by band and period), walk
   and drive on a clear day. Crowding, left-behinds, lateness, incidents and the fare all reduce it.
   It is sampled at every midnight of the month and averaged at the close, so one snowy or
   incident-hit day moves the month's growth by about a twentieth of its effect (a snowy closing
   day alone used to cut the month's value capture by 12% on the perf grid).
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
   Hudson Yards bonds for the 7 line were backed by district tax increment). The scorecard
   annualises it from the closed months in its 60-day window (their mean payment × 12 over 261
   service days), so a review and the panel's preview on any day see the same rate. The *Make a
   monthly profit* goal counts it too ("Fares and value capture beat operating costs and bond
   interest for a month").

| | New York | London |
|---|---|---|
| Value per commuter | $390k per resident, $115k per job (DOF FY2025 roll: homes $1.11T, class 4 $330B, over 2.85M commuters each) | £680k per resident, £140k per job (≈ £2T of homes; ≈ £20B of rateable value at ≈ 5% yields, over 2.93M commuters each) |
| Effective tax on market value | homes 1.6%, workplaces 3.9% (the ≈ $34B levy by class shares) | homes 0.25% (council tax ≈ £5B a year), workplaces 2.5% (business rates ≈ 51p per £ of rateable value). The UK has no ad valorem property tax; the Crossrail business rate supplement and the Nine Elms enterprise zone (Northern line extension) are the precedents, so most of London's value capture comes from workplaces |
| Share pledged to the authority | 12% | 14% |
| Goal "Land value pays" | $10M of value capture in one month | £6M |

The pace (`Game.growthPace`, saved) is **Off** (the city before Living City, bit for bit),
**Steady** (new games and migrated saves) or **Boom** (×3). It applies from the next month close.
Goals: *Boomtown* (a neighbourhood of at least 1,000 people grows 25% since the start year) and
*Land value pays*.

### In the game

- **Month end.** The busy pill reads "The city is growing" while the worker closes the month (a
  fraction of a second). Up to three toasts follow: the month's top boomtown when it is news (it
  grew at least 0.3% and by at least 25 residents and jobs, and it is not the tract the last such
  toast named: "Long Island City is booming: +0.4% this month · +41 residents, +12 jobs · +4.8%
  since 2030"), then milestones (+10/25/50/100% in green, "is losing people" at −5/−10/−20% in
  amber). A click flies to the tract and opens its panel.
- **Month report.** Value capture is its own money row. A **City** section lists residents (with
  the month's change), jobs, commuters and agents, and the district (tracts and the value
  increment it pays on), then up to five **Boomtowns** (tracts that grew at least twice the
  city's natural rate that month; a city growing at its natural rate alone has none: "No
  neighbourhood grew this month."; a click opens the tract) and **Show growth map**. The sandbox gets a toast instead ("1.35M riders a day · +2,860 residents").
- **City growth overlay** (layers button or **G**; G again turns it off). Each tract is drawn in a
  diverging ramp of its residents + jobs growth since the start: magenta to violet for decline,
  teal to ice for growth, nothing under ±0.2%. The ramp's ends follow the biggest change so far
  (±2%, ±5%, ±10%, then ±20%, shown in the legend), so the first months are visible. Thin rings
  mark the value-capture district (½ mile, or 800 m, around every served station). Tilted (**V**),
  growing tracts get hexagonal columns, 6 m × √(residents and jobs added), from 10 people and at
  most 500 m: a median tract growing at Steady's boomtown rates stands 25–29 m after three months
  in New York (38–44 m in London's larger zones), +2,500 people is 300 m. On a short window the legend sits right of the tool bar. The Residents and Jobs overlays show the city as it is now. The overlay is
  rebuilt only when new growth arrives (a month close, a network change, a pace change). Hovering
  a tract shows its name and growth.
- **Tract panel** (click a neighbourhood). The title is the name the toasts use. Residents and
  jobs are today's; *Growth since Jan 2030* has their change, the transit benefit (minutes saved
  per commute) and the land-value premium, an index chart (the start = 100, one point per month
  end on a month axis, so a month with growth Off keeps its gap; residents teal and jobs orange),
  a sentence ("Growing 0.43% a month. Residents here save
  61 min per commute with your network (city average 7 min).") and the value-capture line ("In the
  value-capture district (83% of its area) · $1,113/month to the authority · via Inwood";
  before the first month end "… · first payment at the end of Jan 2030"; or "Outside the
  district: no served station within ½ mi").
- **Station panel.** *Value capture nearby*: the month's levy from the district tracts nearest
  the station ("$39k/month · 7 tracts"; the tooltip names the tax).
- **Finances → Overview.** Yesterday's ledger has a Value capture row (non-zero on month-close
  days), and the month so far once any was paid. The *Value capture (Transit Improvement
  District)* section (London: *business rate supplement district*, after Crossrail's) counts the district's tracts and gives last month's payment and this
  month's at today's values. The chart's revenue line is "Revenue (fares + value capture)". The
  year in review adds value capture to its money line and a City row (residents and jobs over the
  year, with **Show growth map**).
- **Menu → City growth:** Off / Steady / Boom with a one-line hint (each button's tooltip
  describes its pace); it applies from the next month end and a toast confirms. The menu's
  *Exit to title* / *Resume* row stays in view when the menu scrolls (720p). **Goals** shows the best tract and the best month so far.
- **Names.** There is no neighbourhood dataset, so a tract is named after the nearest map place
  label seen this session within 1.2 km of its edge (London's MSOAs are about 2.5× New York's
  tracts), on land and in the same borough (each city's place classes: London adds villages and
  hamlets, and its towns for tract names; neighbourhood labels load when you zoom in close),
  else the nearest served station within the same reach ("around 36 St"), else its own name
  ("Queens tract 57", "Camden 028"). When two boomtowns share a name, the report adds their own names.
- **Older saves** join on Steady. A toast says so when the save loads, and the first month report
  carries a one-time hint ("Living City: your city now grows around good transit. Menu → City
  growth.").

**Placement and determinism.** The starting city's agents are placed exactly as before (one
seeded stream). At the first growth regeneration every agent is placed again once from its own
seed, hash(seed, home·3 + band, work, k), so from then on a kept agent is copied unchanged and a
reload of a grown city rebuilds the same agents bit for bit (tested in both cities). The
starting city's per-agent placements are computed ahead, a few thousand agents per sim step while
the city has not grown (side arrays the sim never reads), so the first close copies them. Growth
uses no random numbers, stores Float32 state canonicalised with `Math.fround` (the month's benefit
samples in Float64, saved exactly), and closes a month once (a save from just before midnight
re-runs it on load, idempotently). The worker sends the mode shares and the growth state with each
day's report, so any save after it (the midnight autosave, or one on quit or tab hide) holds that
day's finances with the growth and groups they belong to. A
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

After the second review (the benefit averaged over the month's days, boomtowns above twice the
natural rate) the same `months=12` runs give $353k/day (New York core, 1.42M riders and rising),
$3.1k/day (sprawl, which now lists no boomtowns), £207k/day (London core, 825k riders) and
£1.5k/day (London sprawl): the table stands. London's core earns 59% of New York's value capture in pounds, in step with its riders (58%) and
fares (value capture is ≈ 9% of fares in both cities). With month 12's value capture the New York core goes from
−$0.08M/day after bond interest to about **+$0.27M/day**; London's core improves from −£2.0M to
−£1.8M/day (it is the harder city, as before); both sprawl networks keep losing ($0.80M and
£0.59M a day). **Boom** at month 12: New York $0.72M/day (1.51M riders, city ×1.04, best tract
+13%), London £0.42M/day (915k riders, +15%); the New York sprawl stays under $0.01M/day. The
calendar-year runs had 0 deadlocks on all 262 days in both cities. *Land value pays* comes at
about month 17–19 on Steady (extrapolated) and month 6–7 on Boom.

## Cinematic

The city by day and by night, a camera that rides with a train, a photo mode and a timelapse of
your network (design: `docs/v2/cinematic.md`, whose end has the implementation notes). It all
runs on the main thread from the game clock and the latest snapshot; nothing is sent to the
worker, and the simulation is the same with any of it in use.

### In the game

- **Day and night.** The light follows the game clock: dawn, day, golden hour, dusk and night are
  interpolated (in OKLab) on the recoloured basemap: land, water, parks, roads, labels, the
  building footprints, the 3D buildings, the fill-extrusion light's colour, intensity and
  direction (from the sun's azimuth and height), and the sky. Sunrise and sunset come from each
  city's latitude, longitude, time zone and daylight saving and the game date (NOAA solar
  equations): on Tue 8 Jan 2030 New York's sun rises at 7:20 and sets at 16:46 (9 h 26 min),
  London's at 8:04 and 16:11 (8 h 7 min); on 24 June London's day is 16 h 38 min against New
  York's 15 h 5 min. Blue hour is cool on the
  buildings with the warmth on the horizon; the avenues' street lights come on at dusk. Weather
  tints it (rain greys and wets the streets, snow whitens the ground and roofs, heat hazes) by day
  and by night; the weather chip shows a moon on a clear night.
- **Night glow.** Route lines, trains (white for expresses), stations, elevated lines and today's
  event venues glow at night (additive blending); a station closed by police activity stays dark.
  In 3D the buildings' windows light up after sunset (a seeded window pattern: the same in every
  session).
- **Follow-cam.** **Follow** in the train panel (or **F** with a train selected) locks the camera
  to the train: in 3D a chase camera behind and above it, aimed at track height (elevated +8 m),
  its bearing eased to the train's heading on the interpolated path, sitting on the train as drawn
  (interline and four-track pair offsets); in 2D a centre lock. The chip at the bottom names the
  route, the next stop and the load, with any incident or hold first ("Held at 96 St for an even
  gap", "Stalled: mechanical problem…", "Bank is closed: running through"). The wheel sets the
  chase distance; dragging the map, Esc or F stops. A train turning round at a terminal is waited
  for (10 game minutes at most). **V** switches between the chase and the centre lock.
- **Photo mode (P).** The interface hides (panels keep their state and come back as they were);
  **L** letterbox bars, **C** a caption ("TUE 8 JAN 2030 · 18:42 · NEW YORK", and the weather when
  it isn't clear). The map attribution stays visible over the letterbox (licence requirement).
  Space, 1–4, V and F still work; P or Esc leaves.
- **Timelapse** (film button). The network is recorded at every month end (in the save, bounded to
  120 frames and 600,000 characters, compactly encoded; save v7, older saves start empty). The
  player replays it from an empty city to now: new lines draw themselves out from the existing
  network, stations pop up as the line reaches them, with the month and the track length (miles
  or kilometres), stations and routes counting up. Space plays and pauses, ← → step a month, 1×
  2× 4×, a scrubber; the game is paused while it plays, and Esc puts everything back.
- **Settings.** Menu → Light (or Settings on the title screen): **Day and night** (default) or
  **Always day** (the map as before: no runtime style changes at all), lit windows or dark. Per
  browser, not in saves. The title screen is blue hour with the windows lit.

### Identity and performance

**Identity.** Nothing in Cinematic reaches the worker or touches the RNG, the event order or any
state the sim reads: the timelapse is recorded on the main thread from the network and routes,
the follow-cam reads the latest snapshot, and the rest is rendering. Every `dump=` output
(`DayReport`s, `finance.toData()`, the share and observation hashes) is byte-identical to the
code before it (tag `pre-cinematic`) for `headless-sim days=3` (chaos Off and Normal), `balance`
core over 25 days across the 31 January month close in New York and London, and `balance`
express (4 days) in both cities, both as they are and while recording a timelapse frame every day
end (`timelapse=1`). The worker bundle is the same code (65 bytes more: the cities' time zones).

**Performance.** `npm run perf` (3 interleaved runs, New York; 2 for London) is unchanged, as it
must be: the same 40,320 boardings and 1,090 waiting (London 34,380 and 1,380); the peak hour took
161–197 ms before against 128–159 ms now (London 146–155 against 141–176 ms) and the month closes
181–283 against 163–338 ms (London 108–196 against 101–179 ms), all noise. On the main thread
(measured in the browser): a day/night tick 0.006–0.017 ms when nothing moved, a full palette
push 0.2–0.26 ms (at most four times a second, only in twilight), a followed train's pose
0.001–0.005 ms per frame, and collecting the deck.gl layers with the night glow 0.30–0.38 ms a
frame against 0.30–0.31 ms by day. The software renderer here takes 180–200 ms a frame at
960 × 600, so frame rates were compared, not measured: the night palette and the glow change
nothing (183 ms against 183 ms in 2D), following a train in 3D costs the same as not following
(about 1,100 ms either way at 1×), but the lit windows (a pattern on every 3D building) take
about +65% of the software renderer's frame in 3D at night (1,100 against 670 ms). That is GPU
texture sampling emulated on the CPU, not main-thread work; *Dark* in Menu → Light turns the
windows off.

## Known issues

- Changing the city chaos level redraws the announced events from that level's calendar at
  once (Wild draws more, and a venue can draw a different kind), while today's events stay as
  the worker planned them at 3 am. Event service planned for an announced event that the redraw
  removes is cancelled, with a toast.
- After a mid-day load, the day's report counts boardings from the load onwards only (as in v1),
  so event fans' trips to the venue made before the save are missing from its event riders.
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
- Four-track junctions are *flying*, as every junction is: a scissors crossover's two connectors
  cross with no conflict between them, a fan's diverging move never blocks the opposite direction,
  and only converging moves take a merge lock (one per turnout, four per scissors). Real flat
  crossovers would cost a little capacity at busy fans.
- At a fan the route bundle on the express pair steps from the shared track's offset to its pair's
  push over the turnout (a few pixels' kink at mid zooms). The pairs are 9 m apart, so the map pushes
  them a few pixels further apart at every zoom; a pair's route lines, trains, local-only stops and
  capsule ends follow the push, while clicks still pick by distance in metres (which is always the
  side the cursor is on).
- Express service on the trains, not in the plans: riders take the first train of either and step
  across to an express that is in or due, but route planning and the timetable mode choice falls
  back on (for a group nobody rode yesterday) still see each route's own headway. An express always
  leaves half a headway after the slots an ordinary route gets (there is no per-route offset to set),
  which spaces it between a local at the same headway at the shared stations but times no
  connections at the hubs. On these corridors an express wins few new commuters (the long trips
  already go by transit), so it doesn't pay back its four-track works in fares (see the express
  balance rows).
- Cinematic: the frame rate could only be judged relatively here (software WebGL takes about
  0.5 s a frame at 1440 × 900). The sky shows only above the horizon, so at the chase camera's 72°
  it is rarely in view. The lit-window pattern covers roofs as well as walls (they read as rooftop
  lights). The timelapse draws elevated lines on the ground and does not grow the buildings. A save
  from before Cinematic replays straight from an empty city to the network as it is until its next
  month ends are recorded. A followed train turning round is waited for 10 game minutes at most
  (trains leave the snapshot while they queue at a terminal).
