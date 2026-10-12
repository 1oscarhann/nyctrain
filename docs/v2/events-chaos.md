# City chaos: events, disruptions and weather (v2)

Status: design, ready to implement · Target: one focused session, about 1,750 lines of production
code plus about 450 lines of tests (§16)
Depends on: v1 as committed (`a27dbfa`). Touches the sim worker (train sim, commuters, engine),
compile, protocol, save format (v2 → v3) and the UI shell. Coordinates with `living-city.md` and
`express-quad.md` on shared files (§5.0).

## Implementation notes (sim)

The sim half is implemented: checklist steps 1–12 and 17, plus the game state and save parts of
step 13. The UI (steps 13–16) is implemented too; see "Implementation notes (UI)" below. This
section lists where things live, what differs from the design below, and the hooks the UI uses.
**Where the code and the line references below disagree, trust the code.**

**Where it lives.**
- `src/balance.ts`: `CHAOS`, `WEATHER` and `EVENTS` (shared tunables), and **`CHAOS_BY_CITY`**
  (venues, event kinds and climate per city), referenced as `CITY_BALANCE[city].chaos`.
- `src/core/rng.ts`: `hashSeed`, `poisson`, `triangular`, `stochasticRound`, `pickWeighted`.
- `src/core/cityCalendar.ts`: the pure calendar and weather, shared by both threads.
- `src/sim/incidents.ts`: exposure and the incident plan (pure).
- `src/sim/eventTrips.ts`: the pure event-trip helpers.
- `src/sim/chaos.ts`: `ChaosController` (fires and clears incidents, weather, wrap-ups, network
  remapping).
- Changes to `trainSim.ts`, `commuters.ts`, `engine.ts`, `modeChoice.ts`, `transitGraph.ts`,
  `compile.ts`, `protocol.ts`, `worker.ts`, `client.ts`, `headless.ts`, `core/game.ts`,
  `save/*`, and `scripts/{balance,perf,headless-sim}.ts`.
- `src/ui/app.ts` has only the plumbing: the new-game seed, the `sim.init` fields, the midnight
  `pruneService`, and the methods `setChaosLevel` / `addEventService` / `removeEventService`.

**Differences from the design (multi-city and later commits).**
- **Per-city tables.** `EVENTS.venues`/`EVENTS.kinds` and `WEATHER.chance` moved to
  `CHAOS_BY_CITY[city]` as `{ venues, kinds, climate }`. `VenueDef` gains `region` (its borough),
  which decides whether driving there is "core". Every calendar function takes an optional
  last argument `cc: CityChaos`; by default it uses the current city (`applyCity`).
- New York uses the design's values. London has its own venues:
  - Wembley stadium (match, concert), in Brent;
  - Stratford stadium, in Newham;
  - "North London football" at Holloway, in Islington;
  - Tottenham football, in Haringey;
  - Greenwich arena concert, on the North Greenwich peninsula;
  - Twickenham rugby (Friday nights in Feb, Mar and Nov), in Richmond;
  - the Wimbledon tennis fortnight (24 Jun – 7 Jul), in Merton;
  - an Oval cricket test match (22–26 Aug), in Kennington;
  - a Hyde Park summer concert;
  - a rare Whitehall parade (5 days' notice).

  London's football is on midweek evenings (Tue–Thu) from August to May. Its climate gives about
  2.5 snow, 33 rain and 2.6 heat days a year; New York gets 12 / 22 / 10. That works out to 0.57
  events per weekday in London and 1.13 in New York.
- `checkKinds` asks for Σ chance × Wild ≤ 1 only for venues with **several** kinds. A
  fixed-window kind on its own, like the tennis (chance 1), is fine.
- `ChaosController.setEventInfo(day, events, info)` and `daySummary(outcomes, stats)`;
  `Commuters.setWeather(w: DayWeather)` (it needs the kind and severity for the baseline cache).
- The protocol adds a **`{ kind: 'chaos' }` query** that replies with a `ChaosState`: level,
  next level, seed, today's `DayChaosInfo`, active alerts, today's outcomes and service. It lets
  the UI resync after a load or when a panel opens. `DayChaosInfo` gains `mods` (today's weather
  factors), and a cleared `Alert` can carry a `reason` ("track removed", "train withdrawn",
  "station removed").
- A **sick-passenger** incident counts (tally, minutes, alert) when the hold starts at a station.
  A hold dropped at the terminal is not counted and posts no alert.
- `Game` defaults to `CHAOS.defaultLevel` (Normal). `createHeadlessGame` defaults to **Off** (and
  takes `chaosSeed`), so tests and the README balance numbers reproduce v1.
  `engine.chaos.forceWeather` / `forceEvents` / `force` work at any level, including Off.
- `migrate()` sets `save.migratedFrom` (not stored) when it upgraded a file. The one-off "New:
  city events…" toast can key off `migratedFrom < 3`.
- The moving block lets a follower creep up to ~10 m into the 100 m margin with 2 s steps (this is
  v1 behaviour), so test 13.1-11.3 checks a gap above 85 m.
- Test 13.1-13 (`eventService.serviceEstimate`) is in `tests/chaos.test.ts`, with the UI file
  `src/routes/eventService.ts`.
- §10.4 bands, from `npm run balance -- scenario=core days=12 chaos=normal` and six more seeds
  (`seed=1…6`):
  - New York: day-11 riders +0.3% to +1.5% against Off; days 8–11 operating result +$0.03M to
    +$0.10M/day.
  - London: −0.1% to +1.3%, and +£0.01M to +£0.04M/day.
  - The default seed 2030 draws 5 snow days in New York's first 12 (January), which gives +3.1%
    and +$0.20M/day, just outside the bands. It is seed variance (snow days are ridership days),
    not a bias.
  - 0 deadlocks everywhere. The sprawl networks still lose $0.75–0.84M/day (New York) and
    £0.58–0.62M/day (London).

**Hooks for the UI.**
- **Client** (`SimClient`):
  - Events: `events.on('alert', (a: Alert) => …)` and `events.on('dayChaos', (i: DayChaosInfo) => …)`.
  - Commands: `setChaosLevel(level)` (applies from the next 3 am) and `setService(list)` (the full
    list).
  - Query: `query<ChaosState>({ kind: 'chaos' })`.
  - `init` already sends `chaos: { level, seed }` and `service` from `game.chaos`.
- **App**: `app.setChaosLevel(level)`, `app.addEventService(list)` → `ServiceOverride[]`, and
  `app.removeEventService(id)`. Each updates `game.chaos` and the worker together.
- **Game**:
  - State: `game.chaos: ChaosSettings` (`{ level, seed, service, nextServiceId }`).
  - Methods: `setChaosLevel`, `addService(o)`, `removeService(id)`, `pruneService(now)`. Each emits
    `'chaos'`.
  - `Selection` gains `{ kind: 'alerts'; focus?: number }`.
  - New games draw a seed with `newChaosSeed()` (`crypto.getRandomValues`). Loaded games keep
    theirs.
- **Calendar on the main thread** (same results as the worker): `announcedEvents(seed, today,
  level)` gives the events card list. Also `eventsForDay`, `weatherForDay`, `forecastFor(seed,
  day + 1, level)` ("Tmrw"), `weatherMods`, `weatherLabel`, `venueOf`, `venueXY`, `eventKind` and
  `maxAnnounceDays`. The worker's `dayChaos` is authoritative for today (forced events and
  weather, and the mode split).
- **Alerts** (`protocol.ts` `Alert`):
  - Life cycle: `active` → `cleared` with the same `id`. A cleared alert's `until` is the actual
    clear time.
  - Weather: one `info` alert at 3 am when it isn't clear (`id = day·1000`).
  - Event wrap-ups: `kind 'event'`, `info`, `id = day·1000 + 900 + i`, with `outcome`. They come
    2 h after the end, or at the next 3 am at the latest.
  - Breakdowns and sick holds carry `trainId`; police alerts carry `stationId`. The UI's closed
    stations and alerted trains are the active alerts' ids.
  - Signal problems carry `path` (up to 17 points), `crawl` (m/s) and `towards`.
  - Positions are local metres (`toLonLat`). `place` and `towards` are names only; the main thread
    formats units.
- **Reports**: `DayReport.chaos` (`DayChaos`) holds weather, incidents by kind, incident minutes,
  `diverted`, `carriedPast`, `eventRiders` and per-event outcomes. Reports saved before chaos
  existed lack it.
- **Event service**: `ServiceOverride { id, routeId, from, to (absolute game s), headwayMin,
  eventId }`.
  - The worker never lengthens a headway, and adds service where the route has none.
  - Overrides already planned at 3 am also raise the event's transit share (`capWait`).
  - Trains come from the owned fleet.
  - The extra car-km go through the existing operating cost.

**Measured.**
- Chaos **Off is bit-identical** to the code before this feature. The full `DayReport` JSON, the
  finance history and the mode shares hash the same on the test network (3 days) and on the New
  York and London core and sprawl scenarios (4 days). The `npm run sim` and `npm run balance`
  outputs differ only in timings.
- `npm run perf`, peak game-hour, minimum of 5 interleaved runs on a shared machine:
  - code before chaos: 235 ms;
  - Off: 227 ms;
  - Normal: 242 ms;
  - `chaos=wild weather=snow outdoor=1`: 301 ms. That run also has 378 trains running instead of
    311, because snow slows every train.

  All are well inside the 1,000 ms budget.
- The 3 am injection on the core network takes 2–8 ms for one arena event, and 22–57 ms for a
  four-event day with a 150k parade (warm).

## Implementation notes (UI)

Checklist steps 13–16 and the stretch item "today's event service in the route panel" are done,
for both cities (London venues, "metro", £).

**Where it lives.**
- `src/ui/alertFeed.ts`: `AlertFeed` (alerts, today's info, the announced calendar, ticker items in
  the §2.3 order) and `describeAlert` (titles and details in the player's units). It has no DOM;
  `tests/chaosUi.test.ts` covers it.
- `src/ui/ticker.ts`: `NewsTicker`.
- `src/ui/topbar.ts`: the weather chip.
- `src/ui/toolbar.ts`: the bell and its badge.
- `src/ui/panels/alertsPanel.ts`: Service alerts and the inline event service editor.
- `src/routes/eventService.ts`: `routesNearVenue`, `stationsNear`, `defaultWindows`,
  `serviceEstimate`.
- `src/map/chaosLayers.ts`: the venues, signal segments, venue ring and pulsing incidents.
- The rest are small touches:
  - `StationLayers.closed` and `TrainLayer.alerted`;
  - the station, train and route panel banners;
  - the "City chaos" section in `menu.ts`;
  - the chaos level in the new-game dialog (`boot.ts`, remembered in `settings.ts`);
  - `styles.css`.

**Differences from the design.**
- The new-game dialog also asks for the chaos level, which is remembered per viewer.
- A card whose venue no station or route reaches has no "Event service…" button (as in the §2.4
  mock-up).
- The venue tooltip shows the wrap-up once it is in, or "over" until then. A wrap-up with nobody by
  train reads "No fans came by subway".
- The route panel also lists the route's active incidents.
- A stalled or held train gets a white rim outside the red casing, so it reads on red routes.
- The deck.gl labels use "•" instead of "·", because the glyph atlas leaves the middle dot blank.
- In reduced motion the ticker item is cut with an ellipsis so "+N" stays visible.

**Fixed: the browser lost a day of riders after an edit followed by a skip.** The App debounced
network compiles (200 ms, longer while SwiftShader blocks the main thread), but `skipTo` went to
the worker at once. So the worker skipped through the 3 am mode choice with no network: no
transit commuters, and 0 fans by subway, until the next day. This was a v1 bug in the App path
(the pre-chaos build fails the same way); headless never raced, because it sets the network
synchronously.
- The debounce now lives in `SimClient.setNetworkSoon(build)`, and `skipTo` and `setSpeed` flush
  any compile still pending first.
- The worker's skip is bracketed by the busy label `SKIP_LABEL`. While it shows,
  `SimClient.skipping` is true, and the App files alerts from the skipped hours without toasts.
  That burst used to deliver, for example, day 0's wrap-up ("Midtown arena game · 0 came by
  subway") at 17:30 on day 1.
- The regression test is the "browser message order" test in `tests/chaos.headless.test.ts`. It
  drives the real `SimClient` against a real `Engine` in process.

## 0. Summary

In v1 every weekday is the same weekday. In v2 the city throws things at the network, and each
one goes through the simulation the player already knows:

1. **Special events** at real venue locations ("Bronx ballpark game", "Midtown arena concert",
   "Flushing tennis open", "Brooklyn arena game", "Downtown parade", plus a few seasonal ones).
   A seeded calendar is a pure function of `(seed, day)`. It sets attendance and start and end
   times, and announces each event 3 days ahead (5 for a parade). On the day, the worker draws
   event-goers from the city's residents, weighted towards the venue. They choose between
   transit, driving (with a venue parking penalty) and walking. Only the ones who choose transit
   become agents. They are injected for that day only: they ride to arrive before the start,
   leave after the end, pay fares, crowd trains and platforms, and are removed at the next
   3 am.
2. **Disruptions** are drawn at a rate and seeded per day. A **signal failure** limits a
   directed-track segment to a crawl for 15–60 min. In a **train breakdown** a running train
   stalls for 5–20 min. For a **sick passenger** a train is held at its next station for
   3–8 min. **Police activity** closes a station for 10–40 min: no boarding and no alighting,
   trains run through, and riders for it ride on to the next stop. The rates are per train-km,
   per directed-track-km and per station-day.
3. **Weather days**, with a forecast one day ahead. **Snow** cuts speeds on elevated and at-grade
   track, makes walking and driving slower and adds a walking penalty. **Rain** slows driving and
   adds a walking penalty. **Heat** brings AC failures (more breakdowns and sick passengers),
   heat slow orders on outdoor track and worse crowding. Severity varies, so "Snow" and "Heavy
   snow" differ.
4. **UI and the player's response.** A news ticker and a weather chip sit in the top bar. A
   **Service alerts** panel (`A`) holds the active incidents, the weather, upcoming events and
   the chaos level. Incident markers pulse on the map, closed stations show red rings, stalled
   trains a red casing, signal problems a dashed segment, and venue markers show attendance.
   **Event service** gives temporary headway overrides on chosen routes for a time window before
   and after an event.

Every effect goes through existing mechanics: speed limits and dwell in `trainSim.ts`, boarding
and platform queues in `commuters.ts`, walking and driving costs in `modeChoice.ts`. So it turns
up in the observed door-to-door times and crowding that feed the next day's mode choice
(`Commuters.finishObservations`, `commuters.ts:844`). With chaos **Off** the sim is bit-identical
to v1. The chaos RNG streams never touch the commuter RNG, and every new multiplier is exactly 1
when inactive (§12).

Measured balance impact (prototype, §10): on the README core network, Normal chaos changes the
average daily result by about +$0.03M/day. Events add +$25–40k/day, incidents cost about
−$10–20k/day, and weather averages +$13k/day. Day-to-day variance grows to about ±$0.2M/day.
The sprawl network still loses about $0.8M/day.

---

## 1. Goals and non-goals

### Goals
- The city feels alive and unpredictable from day 1, but it is **fair**: everything is announced
  or forecast where real life would announce it. Events come 3–5 days ahead and weather one day
  ahead. Incidents come without warning but at seeded, tunable rates.
- **New decisions from existing mechanics:**
  - deep tunnels against cheap elevated track (snow);
  - spare fleet against cost (event service runs on owned trains, and extra car-km are billed
    at $4);
  - where to put stations (venues are ridership magnets: a Midtown arena concert brings about
    9k riders each way on the core network);
  - redundancy (a breakdown on a single trunk blocks every route on it).
- **One code path:** effects land in train speeds, dwell, boarding and walking times, so
  observed times, crowding, left-behinds, give-ups, lateness, revenue and the next-day logit
  respond with no special cases.
- **Deterministic** and save-safe. The calendar, weather and the incident *plan* are pure
  functions of `(chaosSeed, day)`. A save stores the seed, the level and the planned event
  services.
- **Off / Calm / Normal / Wild** chaos level, per game. Off is exactly v1.
- **Perf:** at most 8% extra per-step cost at 300 stations, 400 trains and 285k agents. The
  3 am event injection takes under 50 ms.

### Non-goals (v2)
- No real-time rerouting. Riders on a disrupted trip wait, ride past, walk or give up and take a
  cab, as v1 riders already do. Their *next-day* choice reacts.
- No weekend events: the calendar is weekdays only, like the game.
- No team, league or venue trademarks. Labels are generic ("Bronx ballpark game"). Place names
  are fine.
- No incident cost line in the finances. The cost shows up as lost fares, extra car-km and
  next-day ridership.
- Incidents do not interact with construction or bulldozing, apart from being remapped or
  dropped when track changes (§3.5.5).
- Event agents' experience does not feed group observations: they are one-off trips. Regular
  commuters' crowding *does* include the event crowds.
- No month-report chaos section. It is listed as a stretch item in §15.

---

## 2. Player-facing behaviour and UI

### 2.1 Story of a day
- **Midnight.** The day closes (`Engine.closeDay`). `DayReport.chaos` summarises the day: the
  weather, incidents by kind, event outcomes, event riders and the people turned away by
  closures. The ticker briefly shows "Yesterday: 7 incidents · Midtown arena concert: 9.4k
  came by subway".
- **3 am.** The worker sets the day's weather. Commuters choose modes with today's walking and
  driving penalties. Today's events are injected. The worker posts `dayChaos`: the top bar
  weather chip updates, and each event card shows "~9.4k by subway (51%)". If the weather is
  not clear, an info alert appears ("Heavy snow: elevated and street-level trains limited to
  31 mph").
- **During the day** (05:30–23:30) incidents fire. Each one appears as a pulsing marker, a
  ticker line and an entry in Service alerts. A toast appears too, but only at 1× or 5×, or for
  severity 3. When an incident clears, its marker disappears and a "✓ cleared after 14 min"
  ticker line stays for 90 game minutes.
- **Events.** Fans arrive over the 90 minutes before the start, so station queues near the
  venue grow and the crowding halo lights up. After the end there is a surge of departures. Two
  hours after the end, a wrap-up alert reports, for example, "Midtown arena concert: 9,420 came
  by subway · 610 arrived late · 120 gave up".
- **Announcements.** When a new event enters the 3-day window, the ticker shows "Announced:
  Thu 11 Jul 20:00 · Midtown arena concert · 18,400" and a green toast appears.

### 2.2 Chaos level
`Off · Calm · Normal · Wild`. It is set in the Service alerts panel footer and in the in-game
menu (new section "City chaos", above "Units"). New games default to **Normal**. A change takes
effect at the next 3 am, and the control says "Changes apply from 3 am."

| Level | Incidents | Weather | Events |
|---|---|---|---|
| Off | none | always clear | none |
| Calm | ×0.5 | normal | normal |
| Normal | ×1 | normal | normal |
| Wild | ×2.5 | weather chances ×1.5 | event chances ×1.25 |

### 2.3 Top bar: weather chip and news ticker (`src/ui/topbar.ts`)
The new order of the bar is: `brand | Cash | Date + speed | (sim rate) | sep | Weather chip |
Ticker (flex: 1, replaces .tb-spacer) | Daily riders | Transit share | Avg commute | menu`.

- **Weather chip** (`.tb-stat.tb-weather`). It shows an icon (sun, rain, snow or heat), the
  value "Heavy snow" and the sub-line "Tmrw: clear 85%". The tooltip lists today's effects in
  the player's units, for example: "Elevated and street-level trains ≤ 31 mph · walking 25%
  slower · driving 40% slower · more signal failures". Clicking opens Service alerts. The chip
  is hidden when the chaos level is Off.
- **Ticker** (`.ticker`). It shows a single line of up to 10 items, each with a coloured dot
  (red, amber, green, lavender for events, grey for info). It scrolls right to left at
  40 px/s using a CSS transform animation, and the strip is duplicated so the loop is seamless.
  It pauses on hover. Clicking an item opens Service alerts, focused on that item. With
  `prefers-reduced-motion` it does not scroll: it shows the first item with "+N" and rotates
  every 5 s. It is hidden below 1,180 px width (`@media`); the chip stays. It is rebuilt only
  when the item list changes (a signature string), never on each 250 ms top bar tick, so the
  animation does not restart.
- Item order: active incidents (severity, then newest), today's events not yet over, today's
  weather if not clear, tomorrow's forecast, announcements inside the window, then cleared
  incidents and wrap-ups from the last 90 game minutes.

### 2.4 Service alerts panel (`A`; `src/ui/panels/alertsPanel.ts`)
- Opened from:
  - a new toolbar button (bell icon) after Goals, with a red badge showing the number of active
    incidents;
  - the `A` key (toggles);
  - the weather chip, a ticker item, an incident or venue marker click, or the toast text.
- Tooltip: "Service alerts" · `A` · "Incidents, weather, events and event service".
- Uses `shell('Service alerts', fmtDate(day) + ' · ' + weatherLabel + ' · ' + levelLabel, …)`.

```
SERVICE ALERTS                                                     [x]
Tue 9 Jul 2030 · Heavy snow · Normal chaos
NOW (2)
 ● Signal problem near 34 St                         until 14:35
   A C trains crawl at 9 mph towards Atlantic Av        [Show]
 ● Train breakdown on B · between Marcy Av and Flushing Av   ~14:05
WEATHER
 [snow] Heavy snow. Elevated and street-level trains ≤ 31 mph; walking
 25% slower; driving 40% slower. Tomorrow: clear (85%).
EVENTS
 Tonight 19:05 · Bronx ballpark game · 41,200
   No station within 1 mi (nearest 120 St, 2.1 mi): fans drive.
 Thu 11 Jul 20:00 · Midtown arena concert · 18,400
   34 St 0.14 mi · Times Sq 0.5 mi · served by A C B   [Event service…]
   └ Event service: A every 3 min 18:00–20:15 and 22:15–00:00  [Remove]
EARLIER TODAY
 ✓ Police activity at Grand Central (31 min)   ✓ Sick passenger at 14 St
CITY CHAOS   [Off][Calm][Normal][Wild]    Changes apply from 3 am.
```

- **Now:** active incidents. Clicking a card flies the map to it
  (`map.easeTo({ zoom: max(z, 13.5) })`). **Show** selects the station (police), the train
  (breakdown or sick) or the first affected route (signal).
- **Events:** today plus the announced window (`EVENTS.announceDays`). Today's cards show the
  3 am estimate by mode, from `dayChaos`. Future cards show "Estimate at 3 am on the day". The
  stations within `EVENTS.venueAccess` (1.5 km) are listed with distances, from the compiled
  network on the main thread.
- **Earlier today:** cleared incidents and wrap-ups.
- The panel re-renders on `feed.version` changes, checked in `update()` (2 Hz).

### 2.5 Event service (the player's response)
`[Event service…]` expands an inline editor under the event card:

```
Routes   [x] A  8 Av   [x] C  CPW   [ ] B  Crosstown     (stop within 0.75 mi)
Before   [17:00 ▾] → [20:15 ▾]      After  [22:15 ▾] → [00:00 ▾]   (15-min steps)
Every    [3 min ▾]
A: 14 trains needed, 16 owned · +2,900 car-km ≈ $12k
C: 12 trains needed, 9 owned → effectively every ~4 min · +1,700 car-km ≈ $7k
[Run event service]  [Cancel]
```

- Routes are pre-checked when one of their stops is within `EVENTS.serviceRadius` (1.2 km) of
  the venue (`routesNearVenue`, §6).
- The default windows are `start − 2 h … start + 15 min` and `end − 15 min … end + 90 min`.
- The headway choices are `OPERATIONS.headwayChoices`. An override never lengthens a headway
  (`min(base, override)`), and it adds service where the base is 0 (night).
- Each checked route and each window becomes one `ServiceOverride`, stored in
  `game.chaos.service` (saved) and sent to the worker. Overrides from the past are pruned on
  save and at midnight.
- Trains come from the route's **owned** fleet. If too few trains are owned, the effective
  headway is about `roundTrip / fleet`, and the editor says so. Extra car-km are billed through
  the existing `carKm` operating cost. It is a real trade-off: about $12k of car-km to move
  about 9k fans without crowding out regular commuters.
- **Plan before 3 am.** The day's event mode choice sees overrides that are already active for
  the event window: those routes' expected waits are capped at half the override headway
  (`TransitGraph.capWait`). So event service planned the day before also *raises* the share of
  fans who come by subway. Event service added on the day still relieves the crowding but does
  not change who comes. The editor hint says so.
- The route panel lists today's overrides under Frequency ("Event service today: 18:00–20:15
  every 3 min · Remove"). This is a stretch item (§15).

### 2.6 Map
New deck.gl providers in `App` (`src/map/chaosLayers.ts`):
- `'venues'`, registered after `'elevated'` and before `'flows'`, draws:
  - **venue markers**: a lavender `#C9A0FF` dot with a dark outline, radius
    `6 + 8·√(attendance/50k)` px, at full opacity today and 55% for upcoming days;
  - a **label** at zoom ≥ 11.5, such as "Bronx ballpark game · 41k · 19:05" or "Thu · Downtown
    parade · 120k";
  - **signal segments**: an amber dashed `PathLayer` (`PathStyleExtension({ dash: true })`,
    6 px), drawn under the trains;
  - a faint 1.5 km venue ring while that event's card is focused.
- `'incidents'`, registered after `'stations'`, draws a pulsing halo
  (`radius 10 + 10·pulse px`, alpha `150·(1 − pulse)`), a solid dot (red for severity 3, amber
  otherwise, with a white outline and `pickable: true`) and a `TextLayer` glyph `!`.
- **Closed stations** get a red outline from `StationLayers.closed` (a `Set` of ids). Their
  label reads "34 St · CLOSED".
- **Held or stalled trains** get a red casing from `TrainLayer.alerted` (a `Set` of train ids).
- **Pulsing while paused.** While `feed.activeCount() > 0`, `App` holds a
  `view.beginAnimation()` token and releases it at 0. Like the existing crowd halo, the layers
  use `performance.now()`.
- **Tooltips** (in `SelectTool.move`, picked before trains):
  - an incident shows its title, body and "click for Service alerts";
  - a venue shows "Midtown arena concert · Thu 20:00 · 18,400 expected · ~9.4k by subway".
  - A click selects `{ kind: 'alerts', focus: id }`.

### 2.7 Station, train and route panels
- **Station panel:** while a police alert is active for the station, a red `.err` banner shows
  "Closed: police activity until 14:20. Trains run through; riders are sent to nearby
  stations."
- **Train panel:** a breakdown shows "Stalled: mechanical problem, moving again ~14:05"; a sick
  passenger hold shows "Held at 14 St: sick passenger, ~4 min". The panel looks up the active
  alert by `trainId`, so the snapshot format is unchanged.
- **Toasts:** a new incident gets a toast when `speedIndex ≤ CHAOS.toastMaxSpeedIndex` (1×/5×)
  or severity is 3, at most one per 20 real seconds. Announcements and wrap-ups always get one.

### 2.8 Controls summary (README additions)

| Key / control | Action |
|---|---|
| `A` | Service alerts panel (toggle) |
| Bell button (toolbar) | Service alerts; the badge shows active incidents |
| Weather chip / ticker item | Opens Service alerts at that item |
| Incident / venue marker | Tooltip; click opens Service alerts focused on it |
| Menu → City chaos | Off / Calm / Normal / Wild (from 3 am) |

---

## 3. Model and algorithms

### 3.1 Seeds and random streams
- `game.chaos.seed` (uint32) is drawn once when a new game is created, on the main thread,
  using `crypto.getRandomValues`. Headless runs and migrated v2 saves use
  `CHAOS.defaultSeed`. The sim never calls `Math.random`.
- Every random draw comes from a fresh `Rng(hashSeed(seed, day, index, SALT))`. The salts are
  fixed constants in `cityCalendar.ts`. Each stream is independent and stateless, so any day
  can be computed on the main thread or in the worker with no history.

| Stream | Seed parts | Used for |
|---|---|---|
| calendar | `seed, day, venueIdx, SALT_EVENT` | which event, attendance, start |
| weather | `seed, day, 0, SALT_WEATHER` | kind, severity, persistence draw |
| forecast | `seed, day, 1, SALT_FORECAST` | forecast hit or miss, confidence |
| incidents | `seed, day, 0, SALT_INCIDENTS` | counts, times, durations, target draws r1/r2 |
| event trips | `seed, eventId, 0, SALT_TRIPS` | origins, bands, modes, times, scatter |

New in `src/core/rng.ts`:
```ts
export function hashSeed(...parts: number[]): number {      // FNV-1a + murmur finaliser, never 0
  let h = 0x811c9dc5;
  for (const p of parts) { h = Math.imul(h ^ (p | 0), 0x01000193); h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15; }
  return h >>> 0 || 1;
}
export function poisson(rng: Rng, lambda: number): number;  // Knuth for λ ≤ 30, else round(normal approx), ≥ 0
export function triangular(rng: Rng, a: number, b: number): number; // a + (b − a)·(u1 + u2)/2
export function stochasticRound(rng: Rng, x: number): number;      // floor(x) + (u < frac)
export function pickWeighted(pairs: readonly [number, number][], u: number): number; // value of [value, weight]
```
(`living-city.md` adds `hash32x4`/`fnv32`. If it lands first, `hashSeed` can wrap them. The
names do not collide.)

### 3.2 Event calendar (`src/core/cityCalendar.ts`, pure, main thread and worker)
`EVENTS.venues` holds 8 locations. `EVENTS.kinds` holds 10 kinds, each with a venue, label,
season (`months`, an optional `window: [m0, d0, m1, d1]` and optional `weekdays`), `chance`
per weekday, an `attendance` range, `starts` as `[hour, weight]` pairs, a duration and the
arrive and leave windows (§9).

```ts
export function eventsForDay(seed: number, day: number, level: ChaosLevel): CityEvent[] {
  if (level === 'off') return [];
  const date = dateOfDay(day), m = date.getUTCMonth(), dom = date.getUTCDate(), dow = date.getUTCDay();
  const out: CityEvent[] = [];
  EVENTS.venues.forEach((v, vi) => {
    const kinds = EVENT_KINDS_BY_VENUE[vi].filter((k) => inSeason(k, m, dom, dow));
    if (!kinds.length) return;
    const rng = new Rng(hashSeed(seed, day, vi, SALT_EVENT));
    const u = rng.next();                       // one draw decides the kind (or none)
    let acc = 0;
    for (const k of kinds) {                    // Σ chance ≤ 1 per venue (asserted in a test)
      acc += k.chance * CHAOS.eventChance[level];
      if (u >= acc) continue;
      const attendance = Math.round((k.attendance[0] + (k.attendance[1] - k.attendance[0]) * rng.next()) / 100) * 100;
      const start = pickWeighted(k.starts, rng.next()) * 3600;
      out.push({ id: day * 16 + vi, day, venue: vi, kind: kindIndex(k), label: k.label, attendance,
                 start, end: start + k.duration, announced: day - (k.announce ?? EVENTS.announceDays) });
      break;                                    // at most one event per venue per day
    }
  });
  return out;
}
export function announcedEvents(seed, today, level): CityEvent[]  // days today…today+5 with ev.announced ≤ today
```
The same `u` is used at every level, so a lower level's events are always a subset of Wild's.

### 3.3 Weather (`cityCalendar.ts`)
```ts
function baseDraw(seed, day, level) {                    // independent per day
  const m = dateOfDay(day).getUTCMonth(), rng = new Rng(hashSeed(seed, day, 0, SALT_WEATHER));
  const u = rng.next(), c = scaledChances(level);         // WEATHER.chance × CHAOS.weatherChance[level]
  const kind = u < c.snow[m] ? 'snow' : u < c.snow[m] + c.rain[m] ? 'rain' : u < c.snow[m] + c.rain[m] + c.heat[m] ? 'heat' : 'clear';
  return { kind, severity: WEATHER.minSeverity + (1 - WEATHER.minSeverity) * rng.next(), persist: rng.next() };
}
export function weatherForDay(seed, day, level): DayWeather {
  if (level === 'off') return CLEAR;
  const t = baseDraw(seed, day, level);
  if (t.kind === 'clear' && day > 0) {                    // one-step lookback only: still pure, O(1)
    const y = baseDraw(seed, day - 1, level);
    const m = dateOfDay(day).getUTCMonth();
    if ((y.kind === 'snow' || y.kind === 'heat') && WEATHER.chance[y.kind][m] > 0 && t.persist < WEATHER.persist)
      return { kind: y.kind, severity: y.severity * 0.8, carried: true };
  }
  return { kind: t.kind, severity: t.kind === 'clear' ? 0 : t.severity, carried: false };
}
export function forecastFor(seed, day, level): { kind: WeatherKind; confidence: number } {
  const actual = weatherForDay(seed, day, level), rng = new Rng(hashSeed(seed, day, 1, SALT_FORECAST));
  if (rng.next() < WEATHER.forecastAccuracy) return { kind: actual.kind, confidence: round05(0.7 + 0.25 * rng.next()) };
  const m = dateOfDay(day).getUTCMonth();
  const miss = actual.kind !== 'clear' ? 'clear' : WEATHER.chance.snow[m] > 0 ? 'snow' : WEATHER.chance.heat[m] > 0 ? 'heat' : 'rain';
  return { kind: miss, confidence: round05(0.5 + 0.2 * rng.next()) };
}
export function weatherMods(w: DayWeather): FullWeatherMods {  // linear in severity
  if (w.kind === 'clear') return CLEAR_MODS;                   // all factors exactly 1, penalties 0
  const e = WEATHER.effects[w.kind], s = w.severity, f = (x: number) => 1 - s * (1 - x);
  return { walkSpeed: f(e.walkSpeed), walkPenalty: s * e.walkPenalty, driveSpeed: f(e.driveSpeed), outdoorSpeed: f(e.outdoorSpeed),
           dwell: f(e.dwell), crowd: f(e.crowd), rates: mapValues(e.rates, f) };
}
export function weatherLabel(w): string   // 'Clear' | 'Rain' | 'Heavy rain' | 'Snow' | 'Heavy snow' | 'Hot' | 'Heat wave' (≥ 0.85 = heavy)
```
The forecast for day `d` is shown during day `d − 1`.

### 3.4 Event trips (`Commuters.injectEvents` + `src/sim/eventTrips.ts`)

**Agent pool.** The `Commuters` constructor (`commuters.ts:196–214`) allocates every per-agent
array with `cap = A + poolCap`, where `poolCap = ceil(EVENTS.maxPeoplePerDay / scale)` (20,000
at scale 10, about 2 MB). `A`, `G`, `key` and `ModeState` are unchanged. Agents `a ≥ A` are
event agents. For them, `aGroup[a]` is an index into `evGroups` (one entry per event and origin
tract). Five methods branch on `a >= this.A`: `beginTrip`, `finishByCab`, `recordTrip`, the
`E_GIVEUP` case and `board` (the event boarding counter). Everything that loops over groups
(`stationDetail`, `routeDetail`, `tractDetail`, `flows`) is untouched. `inFlight()` keeps
looping over `a < A`, and a new `eventInFlight()` covers the pool.

**Who goes.** The origin weight is `w_i = residents_i · exp(−d_i / EVENTS.originDecay)`
(12 km). This is "distributed by residents" with a gentle distance tilt; set the decay to
Infinity for pure residents. Bands come from `homeBand[tract·3 + b]`, the tract's resident band
mix, which the constructor computes from `gHome/gBand/gCount`.

**Mode choice.** The venue geometry gets `workCbd: false`, and the venue's own parking time and
cost are added on top:
```ts
export function eventCosts(geom: PairGeometry, band: number, path: GroupPath | null, venue: VenueDef, wx: WeatherMods, fare: number): [number, number, number] {
  const c = generalisedCosts(geom, band, path ? { time: path.time, transfers: path.transfers, crowdMinutes: EVENTS.crowdMinutes, fare } : null, wx);
  c[1] += venue.parkingTime / 60 + moneyToMinutes(venue.parkingCost, band);
  return c;   // logitShares(c) → [walk, drive, transit]
}
```

**Injection** runs at 3 am after `dailyModeChoice`, or after `startDay` on a mid-day load:
```
injectEvents(events, dayStart, now, ctx = { seed, wx, service, fare }):
  reset pool: evUsed = 0, evGroups = [], evTally = events.map(empty), evDayStart = dayStart
  for each ev (by id):
    rng = Rng(hashSeed(seed, ev.id, 0, SALT_TRIPS)); venue = EVENTS.venues[ev.venue]; (vx, vy) = toLocal(venue)
    vAcc = stations within EVENTS.venueAccess of (vx, vy), walk = d·walkDetour / (walkSpeed·wx.walkSpeed)
    if graph && vAcc.length:
      graph.setPeriod(periodIndex(dayStart + ev.end))
      for o in service where o overlaps [end − 15 min, end + 90 min]: graph.capWait(routeIndex(o), min(waitCap, o.headwayMin·30))
      graph.run(vAcc)                            // ONE Dijkstra per event: venue → everywhere (post-event trip)
    cdf = originCdf(tracts, vx, vy)              // Float64Array(T), cumulative w_i
    n = stochasticRound(rng, ev.attendance / scale)
    pathCache = Map<tract, GroupPath | null>; shareCache = Map<tract·3+band, [pw, pd, pt]>
    for k in 0..n−1:
      tract = sampleCdf(cdf, rng.next()); band = sampleBand(homeBand, tract, rng.next())
      path = pathCache(tract) ??= (vAcc.length && access[tract].length ? bestPath(graph, access[tract]) : null)
      p = shareCache(tract, band) ??= logitShares(eventCosts(geom(tract, venue), band, path, venue, wx, fare))
      u = rng.next(); mode = u < p.walk ? WALK : u < p.walk + p.drive ? DRIVE : TRANSIT
      if mode ≠ TRANSIT or !path: tally[mode] += scale; continue
      if evUsed ≥ poolCap: overflow += scale; tally.drive += scale; continue      // logged once
      a = A + evUsed++; gi = groupFor(ev, tract) → evGroups.push({ ev: idx, tract, from: path, to: reverseLegs(path), drive })
      aGroup[a] = gi; aMode[a] = TRANSIT; aPM[a] = 0; aBoarded[a] = 0
      (aHx, aHy) = pointInDisc(rng, tract.x, tract.y, tract.radius); (aWx, aWy) = pointInDisc(rng, vx, vy, EVENTS.venueScatter)
      arrive = dayStart + ev.start + triangular(rng, kind.arrive[0], kind.arrive[1])
      depart = arrive − path.time · EVENTS.tripBuffer
      leave  = ev.end + triangular(rng, kind.leave[0], kind.leave[1])        // seconds of day (may exceed 86 400)
      aReturn[a] = leave                                                     // relative: Float32 keeps 1/128 s precision
      if depart ≥ now: aState = S_HOME; push(depart, a, E_DEPART)
      else if dayStart + leave ≥ now: aState = S_WORK; push(dayStart + leave, a, E_RETURN)    // loaded mid-event
      else aState = S_DONE
      tally.transit += scale
  graph.setPeriod(1)                             // restore what recomputePaths leaves
  return EventDayInfo[] (planned people by mode, overflow)
```
- **Directions.** The Dijkstra runs *from* the venue, so `bestPath` gives venue → home (the
  `from` trip). The `to` trip reverses it: `reverseLegs` turns leg `[route, board, alight]` into
  `[route, alight, board]` in reverse order. `platformFor` already tries both directions
  (`commuters.ts:323–327`), and route directions are mirror images, so the reversed legs
  resolve to the opposite direction.
- **Lifecycle.**
  - `beginTrip(a, t, pm)` takes `evGroups[aGroup[a]].to/from` instead of
    `pathAM/pathPM[g]`.
  - `recordTrip`, for an event agent:
    - adds the trip to the event tally (arrived, late if after `dayStart + ev.start`,
      `timeSum`);
    - counts it in `day.transitTrips` if it boarded (it paid a fare);
    - does **not** touch `day.trips`, `tripTimeSum`, `modeCount` or the group observations;
    - after an `!aPM` trip, schedules `E_RETURN` at `max(tEnd + 60, evDayStart + aReturn[a])`.
  - `finishByCab` uses the event group's `drive` time.
  - At the next 3 am, `drawModesAndSchedule` resets agents `0 … A + evUsed`, then sets
    `evUsed = 0` and `evGroups = []`. The pool is empty again: event agents are *removed*.
- Fares are charged at the first boarding, as in v1, so event riders add to `fareRevenue`,
  `riders`, `routeRiders` and `stationBoardings`. A separate `day.eventBoard` counter feeds
  `DayReport.chaos.eventRiders`.
- **Done by 3 am.** A test asserts that every kind ends by 23:30 with `leave[1] ≤ +40 min`, so
  even a 45-minute give-up plus a cab ride finishes before the next 3 am and nothing counts as
  stuck.

### 3.5 Incidents (`src/sim/incidents.ts` plans; `src/sim/chaos.ts` fires and clears)

#### 3.5.1 Exposure and plan (pure)
```ts
export interface Exposure { trainKmByPeriod: number[]; trainKm: number; trackKm: number; stations: number }
export function measureExposure(net: CompiledNetwork): Exposure;
// trainKmByPeriod[i] = Σ_routes (hours_i·3600 / headway_i)·(len0 + len1)/1000   (headway_i > 0)
// trackKm = Σ distinct directed tracks (max − min track coordinate over the elements that use it) / 1000
// stations = compiled stations served by ≥ 1 route

export function planIncidents(seed: number, day: number, ex: Exposure, mult: number, rates: RateMods, after: number): PlannedIncident[] {
  const rng = new Rng(hashSeed(seed, day, 0, SALT_INCIDENTS));
  const lambda = { signal: ex.trackKm * CHAOS.signal.perTrackKmDay, breakdown: ex.trainKm * CHAOS.breakdown.perTrainKm,
                   sick: ex.trainKm * CHAOS.sick.perTrainKm, police: ex.stations * CHAOS.police.perStationDay };
  const out: PlannedIncident[] = [];
  for (const kind of INCIDENT_KINDS) {                       // fixed order → deterministic
    const n = Math.min(CHAOS.maxPerKindPerDay, poisson(rng, lambda[kind] * mult * rates[kind]));
    for (let i = 0; i < n; i++) {
      const tod = kind === 'police' ? CHAOS.serviceStart + rng.next() * (CHAOS.serviceEnd - CHAOS.serviceStart)
                                    : timeByService(rng, ex.trainKmByPeriod);   // period ∝ train-km, uniform within, clipped to service hours
      const [d0, d1] = CHAOS[kind].duration;
      out.push({ kind, t: day * 86400 + tod, dur: d0 + (d1 - d0) * rng.next(), r1: rng.next(), r2: rng.next() });
    }
  }
  return out.filter((p) => p.t >= after).sort((a, b) => a.t - b.t || kindOrder(a) - kindOrder(b));
}
```
Every incident is drawn before the `after` filter. A mid-day load therefore sees the same
remaining plan as an uninterrupted run.

#### 3.5.2 Firing (in `ChaosController.step(t)`, before `trains.step`)
Targets are picked at fire time from the current sim state, using the pre-drawn `r1`/`r2`
values. The trains array order is deterministic, so the targets are too.

```
signal:    track = trackList[cdfIndex(trackCdf, r1)]          // distinct directed tracks weighted by length
           uMid = track.u0 + r2·(track.u1 − track.u0); [u0, u1] = clip(uMid ± CHAOS.signal.segment/2)
           restr = { id, edge: track.edge, edgeDir: track.edgeDir, u0, u1, v: CHAOS.signal.crawl, until: t + dur }
           trains.setRestrictions([...restrs]); routes = every route with an element on this track
           place = nearest compiled station to the segment midpoint; path = sampled points of the segment (≤ 17)
breakdown: cands = trains with state Running, holdUntil ≤ t, holdNext = 0 (array order); if none → dropped
           tr = cands[floor(r1·n)]; tr.holdUntil = t + dur; tr.incident = id
           pos = point at s + v²/(2·emergencyBrake) (where it will come to rest); place = "between X and Y"
sick:      same candidates with stop < last; tr.holdNext = dur; tr.incident = id
           → the alert is posted by TrainSim.onHold when the hold starts at the next open, non-terminal stop
police:    stations weighted by 1 + yesterday's boardings / CHAOS.police.busyWeight (cdf, r1)
           closedUntil[si] = t + dur; commuters.evictStation(si, t + dur, t); routes = routes stopping there
every fire: trains.graceUntil = max(trains.graceUntil, until); tally[kind]++, minutes += dur/60; cb.alert(active)
```

#### 3.5.3 Effects inside `TrainSim` (`trainSim.ts:319` `move`, `:439` `arriveAt`)
```ts
// (1) top of move(): closed stations are run through (never the first or last stop)
const last = dir.stopS.length - 1;
while (tr.stop > 0 && tr.stop < last && this.closedUntil[dir.stopStation[tr.stop]] > t) { this.hooks.pass(tr, r, tr.stop, t); tr.stop++; }
// (2) breakdown: brake hard and stay put
if (tr.holdUntil > t) vAllow = 0;                       // integrate() already clamps to v − emergencyBrake·dt
// (3) after the curve-limit loop (l. 331–337): weather cap on outdoor track, same pattern
if (this.outdoorFactor < 1 && dir.outS0) {
  const cap = r.vmax * this.outdoorFactor;
  while (tr.out < dir.outS0.length && dir.outS1![tr.out] < s - L) tr.out++;
  for (let j = tr.out; j < dir.outS0.length && dir.outS0[j] < s + look; j++) {
    if (dir.outS0[j] <= s && dir.outS1![j] >= s - L) vAllow = Math.min(vAllow, cap);
    else if (dir.outS0[j] > s) vAllow = Math.min(vAllow, Math.sqrt(cap * cap + 2 * b * (dir.outS0[j] - s)));
  }
}
// (4) temporary restrictions (signal problems) on the directed tracks under and ahead of the train
if (this.restr.length) for (let k = Math.max(0, tr.elem - 1); k < dir.elems.length; k++) {
  const el = dir.elems[k]; if (el.s0 > s + look) break;
  if (!this.restrOnTrack[el.track]) continue;           // Uint8Array(trackCount)
  for (const q of this.restr) {
    if (q.track !== el.track) continue;
    const a = el.s0 + Math.max(0, q.u0 - el.u0), z = el.s0 + Math.min(el.s1 - el.s0, q.u1 - el.u0);
    if (z <= a) continue;
    if (s >= a && s - L <= z) vAllow = Math.min(vAllow, q.v);
    else if (a > s) vAllow = Math.min(vAllow, Math.sqrt(q.v * q.v + 2 * b * (a - s)));
  }
}
// (5) watchdog (l. 432): count stall time only outside incident periods
} else if (t - Math.max(tr.stoppedSince, this.graceUntil) > OPERATIONS.deadlockAfter) {
```
- In `arriveAt` (lines 456–460), dwell becomes
  `Math.min(dwellMax, rawDwell · dwellFactor) × crowdedFactor`.
- Then, for a sick passenger hold, if `tr.holdNext > 0 && 0 < stopIdx < last`: `tr.until +=
  tr.holdNext`, `this.onHold?.(tr, stationIdx, t)`, `tr.holdNext = 0`. A train that reaches its
  terminal first drops the hold silently, and no alert is posted.
- `stoppedSince` stays honest, so the existing lock-claim release (lines 412–416) still frees
  junctions ahead of a stalled train.
- The moving block makes followers queue behind it.
- The timetable (`schedArrive`) is unchanged, so lateness records the disruption.

#### 3.5.4 Effects inside `Commuters`
- `evictStation(si, until, t)` empties every board platform queue at the station
  (`graph.stationBoard[si]`). Each live waiter calls `leaveQueue`. If
  `until − t ≤ CHAOS.police.waitOutside` (15 min), the waiter waits at the gate:
  `aState = S_WALK; push(until + (a % 120), a, E_PLATFORM)`, with deterministic jitter to avoid
  a stampede. Otherwise: `day.diverted++` and `finishByCab`. Stale `E_GIVEUP` events are
  already ignored by the `aWaitStart` check (`commuters.ts:563`).
- `arrivePlatform(a, t)` (`:604`): if the platform's station (`graph.platStation[p]`) is
  closed, it applies the same wait-or-cab rule.
- `board()` (`:673`) returns 0 at a closed station, which covers a train already dwelling when
  the closure starts and stop 0 at a closed terminal. Alighting at a closed **terminal** is
  allowed, because the train must empty to turn around.
- `pass(train, route, k, t)` (new `PassengerHooks` member) moves `buckets[k]` into
  `buckets[k + 1]` and counts `day.carriedPast`. At the next stop those riders get off and
  `arrive()` computes their egress or transfer walk *from the actual station*, so the detour is
  real.
- **Weather.**
  - Walks: `beginTrip` (`:599`), the transfer walk (`:644`, `1.2` becomes
    `1.2 · wx.walkSpeed`) and the egress walk (`:650`) are all divided by `wx.walkSpeed`.
  - Crowding: in `board()` (`:704`) it is multiplied by `wx.crowd`.
  - Walk and drive trip times in `drawModesAndSchedule` (`:531`) and the cab fallback use
    `driveTime(g, pm)`. It scales only the road part (`(base − park)/driveSpeed + park`) and
    returns `base` exactly when `driveSpeed === 1`.
- **Mode choice at 3 am.** `generalisedCosts(gGeom[g], band, transit, wx)` (`:466`) makes
  walking and driving slower and adds `walkPenalty` minutes to walking. Transit uses
  yesterday's observed time, which already includes yesterday's chaos.
- **Fair baseline.** `baselineToday` is the no-subway baseline under today's weather, cached per
  `WeatherKind`/severity bucket (0.1 steps), because one computation is a 145 ms loop over
  252k groups. `DayReport.baselineCommute` reports it, so a snow day doesn't look like the
  subway made commutes worse.

#### 3.5.5 Clearing and network changes
- `step(t)` removes active incidents whose `until ≤ t`. For a signal problem it also removes the
  restriction and calls `setRestrictions`. Holds and closures end by themselves
  (`holdUntil`, `closedUntil` are times).
- Every cleared incident posts `cb.alert({ …, status: 'cleared' })`.
- `setNetwork(net, t)`:
  - rebuilds `closedUntil` (keyed by station id) and the restrictions (keyed by
    `(edge, edgeDir, u0, u1)` in track coordinates, mapped to the new `track` index by scanning
    the elements);
  - drops targets that vanished, posting a cleared alert ("track removed");
  - calls `commuters.evictStation` again for stations that are still closed (re-queued
    waiters);
  - recomputes the exposure. `TrainSim.setNetwork` re-resolves the service overrides by route
    id.

### 3.6 Event service in dispatch (`TrainSim.runDispatch`, `trainSim.ts:238`)
```ts
headwayAt(ri: number, r: CRoute, tt: number): number {          // seconds; replaces r.headways[periodIndex(tt)]
  const base = r.headways[periodIndex(tt)];
  for (const o of this.ovByRoute[ri] ?? NONE) if (tt >= o.from && tt < o.to) return base > 0 ? Math.min(base, o.headwayMin * 60) : o.headwayMin * 60;
  return base;
}
// in the slot loop:  const hw = this.headwayAt(ri, r, ds.next[d]); if (hw > 0) { ds.pending[d].push(ds.next[d]); ds.last[d] = ds.next[d]; }
// after it, only while an override is active (so v1 period changes are untouched):
const ov = this.activeOverride(ri, t);
if (ov) { const h = this.headwayAt(ri, r, t); if (ds.next[d] > Math.max(t, ds.last[d] + h)) ds.next[d] = Math.max(t, ds.last[d] + h); }
```
- `nextServiceTime(ri, r, t)` uses `headwayAt`, so a night window with base 0 gets service.
- `DispatchState` gains `last: [number, number]` (initially `−Infinity`), copied over for an
  unchanged path in `setNetwork` (line 149).
- The fleet stays `r.fleet`. When the ready queue is empty, slots pend (at most 2, as today) and
  trains leave as soon as they come back.

### 3.7 How each effect reaches tomorrow

| Cause | Mechanism today | Shows up in | Next day |
|---|---|---|---|
| Snow or heat on outdoor track | `vAllow` cap on `outS` stretches | lateness, longer rides | `obsTime` ↑ for the groups that rode |
| Signal problem | crawl on a track segment, followers bunch | lateness, left-behinds | `obsTime`, `obsCrowd` ↑ |
| Breakdown | train stalls, moving block queues followers | trips 10–25 min longer, give-ups | `obsTime` ↑ |
| Sick passenger | dwell + 3–8 min | as above, smaller | `obsTime` ↑ |
| Police | queues evicted, trains run through | waits at the gate, cabs, ride-past detours | `obsTime` ↑ (give-ups count, `commuters.ts:751`) |
| Event crowds | extra agents in queues and trains | crowding, left-behinds, dwell ↑ | regular riders' `obsCrowd` ↑ (event days cost PM riders) |
| Weather on the day | walk and drive costs at 3 am, slower walks | mode shares that day, commute minutes | via `obsTime` (slower access walks) |

### 3.8 Engine daily sequence (`engine.ts:67` `step`)
```
step(dt):
  midnight:    closeDay(day) → report.chaos = chaos.daySummary(day, commuters.eventOutcomes()); chaos.endDay()
  3 am (mc):   this.beginDay(day, mc, true)
  every step:  chaos.step(t1)            // fire due incidents, clear expired ones, post wrap-ups
               trains.step(t1, dt); commuters.step(t1)

private beginDay(day, now, choose):
  chaos.flushWrapups()                                  // yesterday's late events, before the pool resets
  const { events, wx } = chaos.beginDay(day, now)       // weather → trains.setWeather / commuters.setWeather; plan incidents; weather alert
  choose ? commuters.dailyModeChoice(now) : commuters.startDay(now)
  const info = commuters?.injectEvents(events, day·86400, now, { seed, wx, service, fare }) ?? []
  chaos.setEventInfo(day, info)                         // posts dayChaos; schedules wrap-ups at end + EVENTS.wrapUpAfter
start(): after 3 am → beginDay(dayIndex(t), t, false); before 3 am → commuters.startDay(t) as today
```

---

## 4. Data structures

```ts
// balance.ts
export type ChaosLevel = 'off' | 'calm' | 'normal' | 'wild';
export type WeatherKind = 'clear' | 'rain' | 'snow' | 'heat';
export interface VenueDef { key: string; name: string; lon: number; lat: number; parkingTime: number; parkingCost: number }
export interface EventKindDef { venue: string; label: string; months: number[]; chance: number; attendance: [number, number];
  starts: [number, number][]; duration: number; arrive: [number, number]; leave: [number, number];
  window?: [number, number, number, number]; weekdays?: number[]; announce?: number }

// core/cityCalendar.ts
export interface CityEvent { id: number; day: number; venue: number; kind: number; label: string; attendance: number;
  start: number /* s of day */; end: number; announced: number /* day */ }
export interface FullWeatherMods extends WeatherMods { outdoorSpeed: number; dwell: number; crowd: number; rates: RateMods }
export type RateMods = Record<IncidentKind, number>;

// sim/modeChoice.ts
export interface WeatherMods { walkSpeed: number; walkPenalty: number /* min */; driveSpeed: number }
export const CLEAR_WX: WeatherMods = { walkSpeed: 1, walkPenalty: 0, driveSpeed: 1 };

// sim/incidents.ts
export type IncidentKind = 'signal' | 'breakdown' | 'sick' | 'police';
export interface PlannedIncident { kind: IncidentKind; t: number; dur: number; r1: number; r2: number }

// sim/trainSim.ts
export interface TrackRestriction { id: number; edge: number; edgeDir: 0 | 1; u0: number; u1: number; v: number; until: number; track: number }
// Train += { holdUntil: number; holdNext: number; incident: number; out: number }

// sim/commuters.ts (private)
interface EventGroup { ev: number; tract: number; to: GroupPath; from: GroupPath; drive: number }
interface EventTally { planned: [number, number, number]; overflow: number; arrived: number; late: number; gaveUp: number; home: number; timeSum: number }
```
The plain-data message types live in `protocol.ts` (§7). Main-thread state:
```ts
// core/game.ts
export interface ChaosSettings { level: ChaosLevel; seed: number; service: ServiceOverride[]; nextServiceId: number }
```

---

## 5. Exact changes per existing file

### 5.0 Shared-file coordination
- `protocol.ts`, `trainSim.ts`, `commuters.ts`, `engine.ts`, `compile.ts`, `balance.ts`,
  `save/*`, `app.ts`, `topbar.ts`, `toolbar.ts` and `styles.css` are also touched by the other
  v2 features. All chaos changes are **additive**:
  - new optional fields;
  - new members appended at the end of interfaces;
  - new `balance.ts` sections appended before `UNITS`.
- `living-city.md` regenerates agents monthly. Its `regenerate()` must allocate `A + poolCap`
  and call `resetEventPool()`; the midnight timing means no event agent is mid-trip.
- `express-quad.md` touches `move()` and `buildDir`. The chaos hooks are self-contained blocks
  and merge in any order.
- **Save v3.** If another feature has already bumped to v3, the chaos defaults merge into the
  same `2:` step (every line is `??=`).

### 5.1 `src/balance.ts` (+115)
Append the `ChaosLevel`, `WeatherKind`, `VenueDef`, `EventKindDef`, `CHAOS`, `WEATHER` and
`EVENTS` sections before `export const UNITS` (line 295). Values are in §9.

### 5.2 `src/core/rng.ts` (+25)
Add `hashSeed`, `poisson`, `triangular`, `stochasticRound` and `pickWeighted` (§3.1). `Rng` is
unchanged.

### 5.3 `src/sim/modeChoice.ts` (+15)
- `walkTime(d, wx?)` (l. 28) divides by `COMMUTERS.walkSpeed * (wx?.walkSpeed ?? 1)`.
- `driveTripTime(g, wx?)` (l. 34) uses `vM * f` and `vO * f`, with
  `f = wx?.driveSpeed ?? 1`.
- `generalisedCosts(g, band, transit, wx?)` (l. 59) passes `wx` through and adds
  `wx?.walkPenalty ?? 0` to walking.
- Export `WeatherMods` and `CLEAR_WX`.
- When the factor is 1 the arithmetic is unchanged, so v1 is bit-identical.

### 5.4 `src/sim/transitGraph.ts` (+8)
Add `capWait(routeIdx, wait)` after `setPeriod` (l. 135). It lowers `wait[p]` for every
platform from `base[ri][0]` to the end of the route's dir 1.

### 5.5 `src/sim/protocol.ts` (+80)
- `CRouteDir` (l. 30) gains optional `outS0?: Float64Array; outS1?: Float64Array`: the outdoor
  stretches (elevated, at-grade or the exposed half of a ramp), in path `s`, sorted and merged.
  Optional fields keep the hand-made test networks in `tests/sim.test.ts` valid.
- New types: `ServiceOverride`, `Alert`, `DayWeather`, `EventDayInfo`, `DayChaosInfo`,
  `EventOutcome`, `DayChaos`. `ChaosLevel` and `WeatherKind` are re-exported from balance.
- `ToWorker`, `FromWorker` and `DayReport` changes as in §7.

### 5.6 `src/routes/compile.ts` (+25)
In `buildDir` (l. 56), in the leg loop next to the curve limits (l. 102–109):
- Read the end-node levels `la`/`lb`. A level is exposed if it is `elevated` or `at-grade`.
- The exposed edge-coordinate intervals are: `[0, L]` if `la === lb` and it is exposed; for a
  ramp, `[0, L/2]` if `la` is exposed and `[L/2, L]` if `lb` is. This is the same half-way rule
  as `Network.levelAt`, `network.ts:129`.
- Intersect them with `[lo, hi]` and map to path `s` as the limits are mapped.
- After the loop, scale by `k` (l. 131–139), sort, merge gaps under 1 m, and return them as
  `outS0`/`outS1` (l. 159–174).
- `samePaths` is unchanged.

### 5.7 `src/sim/trainSim.ts` (+100)
- `Train` (l. 18) gains `holdUntil`, `holdNext`, `incident`, `out`. They are initialised to 0 in
  `newTrain` (l. 164) and reset in `toReady` (l. 187). `tr.out = 0` at dispatch, next to
  `tr.lim = 0` (l. 268).
- `PassengerHooks` (l. 43) gains
  `pass(train: Train, route: CRoute, stopIdx: number, t: number): void`.
- `DispatchState` (l. 52) gains `last`.
- New public fields:
  - `closedUntil = new Float64Array(0)` and `graceUntil = -Infinity`;
  - `onHold: ((tr: Train, stationIdx: number, t: number) => void) | null`;
  - private `outdoorFactor = 1`, `dwellFactor = 1`, `restr: TrackRestriction[]`,
    `restrOnTrack: Uint8Array`, `overrides`, `ovByRoute`.
- New methods: `setWeather(outdoor, dwell)`, `setRestrictions(list)` (fills `track` indices
  from the current net and rebuilds `restrOnTrack`), `setOverrides(list)`,
  `headwayAt(ri, r, t)`, private `activeOverride(ri, t)`.
- `setNetwork` (l. 87):
  - resolves `ovByRoute`;
  - `const hw = this.headwayAt(ri, r, t) || 600` (l. 152);
  - copies `ds.last` from `pds`;
  - calls `this.nextServiceTime(ri, r, …)` (l. 153 and 155);
  - re-sizes `restrOnTrack`.
- `nextServiceTime(ri, r, t)` (l. 201) uses `headwayAt`.
- `runDispatch` (l. 238–278) as in §3.6.
- `move` (l. 319) gets blocks (1)–(5) of §3.5.3.
- `arriveAt` (l. 456–460) gets the dwell factor and the sick hold.

### 5.8 `src/sim/commuters.ts` (+165)
- Constructor (l. 138):
  - per-agent arrays use `cap = A + poolCap` (l. 196–214);
  - compute `homeBand` (T × 3 shares);
  - `baselineToday = baseline`.
- New fields: `poolCap`, `evUsed`, `evGroups`, `evTally`, `evEvents`, `evDayStart`,
  `wx: FullWeatherMods`, `closedUntil: Float64Array`, `access` (now kept from
  `recomputePaths`, l. 346), `baselineCache`.
- New methods:
  - `setWeather(mods)`: sets `wx` and recomputes `baselineToday` from the cache;
  - `setClosures(arr)`, `evictStation(si, until, t)`;
  - `injectEvents(...)` (§3.4);
  - `eventOutcomes(): EventOutcome[]`, `eventAgentCount()`, `eventInFlight()`;
  - `pass(...)`;
  - private `driveTime(g, pm)` and `isEvent(a)`.
- `dailyModeChoice` (l. 466) passes `this.wx` to `generalisedCosts`.
- `drawModesAndSchedule` (l. 485):
  - the reset loop runs to `A + evUsed` (l. 488), then `evUsed = 0`, `evGroups = []`;
  - drive and walk times come from `driveTime(g, false/true)` and `gWalk[g] / wx.walkSpeed`,
    with no division when the factor is 1 (l. 531–532).
- `step` (l. 562): the `E_GIVEUP` case also bumps the event's `gaveUp` tally for an event agent.
- `beginTrip` (l. 573): event path, and walks scaled by weather (l. 581–601).
- `arrivePlatform` (l. 604): closure check.
- `arrive` (l. 644, l. 650): walks scaled by weather.
- `depart` (l. 660) and `board` (l. 673): closure guard, `wx.crowd` (l. 704) and
  `day.eventBoard++` for `a ≥ A`.
- `finishByCab` (l. 733) and `recordTrip` (l. 743): event branches (§3.4).
- `dayReport` (l. 784): `baselineCommute: this.baselineToday`. The engine attaches the chaos
  fields.
- `newDayStats` (l. 1034) gains `eventBoard`, `eventTrips`, `diverted`, `carriedPast`.

### 5.9 `src/sim/engine.ts` (+45)
- `EngineCallbacks` (l. 13) gains `alert?(a: Alert)` and `dayChaos?(info: DayChaosInfo)`.
- `EngineOptions` (l. 19) gains `chaos?: { level: ChaosLevel; seed: number }` (default
  `{ 'off', CHAOS.defaultSeed }`) and `service?: ServiceOverride[]`.
- Constructor (l. 34): the null-hooks stub (l. 39–43) gains `pass: () => {}`, and
  `this.chaos = new ChaosController(opts.chaos, this.trains, this.commuters, cb)` is a public
  readonly field.
- `start` (l. 51) and `step` (l. 67) as in §3.8.
- `setNetwork` (l. 56) calls `this.chaos.setNetwork(net, this.time)` last.
- `closeDay` (l. 90) adds `report.chaos`.
- New `setService(list)` and `setChaosLevel(level)` delegate to `chaos`. `emptyReport`
  (l. 129) is unchanged (`chaos` is optional).

### 5.10 `src/sim/worker.ts` (+20) and `src/sim/client.ts` (+20)
- In the worker, `init` (l. 27) passes `chaos`/`service` and the `alert`/`dayChaos` callbacks,
  which post `{ type: 'alert' }`/`{ type: 'dayChaos' }`. `handle` (l. 44) gains cases for
  `'service'` (`engine.setService`) and `'chaosLevel'`.
- In the client, `SimEvents` (l. 9) gains `alert` and `dayChaos`. `init` (l. 51) takes `chaos`
  and `service`. New `setService(list)` and `setChaosLevel(level)`. `onMessage` (l. 84) gains
  the two new cases.

### 5.11 `src/sim/headless.ts` (+30)
- `createHeadlessGame(world, land, { sandbox, fare, chaos = 'off' })` (l. 23). The default is
  **off**, so the existing tests and the README balance numbers are reproduced exactly.
- `runDays` (l. 163) passes `game.chaos` to `Engine`.
- New exports:
  - `startEngine(game, opts) → Engine` (compiles and sets the network; `runDays` uses it);
  - `stepUntil(engine, t)`;
  - `midtownArenaEvent(day, attendance, startHour)`, a test fixture that builds a `CityEvent`.

### 5.12 `src/core/game.ts` (+20)
- `GameEvents` (l. 21) gains `chaos: void`.
- `Selection` (l. 33) gains `{ kind: 'alerts'; focus?: number }`.
- `Game` gains `chaos: ChaosSettings`. The constructor option `chaos?: ChaosLevel` sets it, and
  the seed defaults to `CHAOS.defaultSeed`.
- New methods: `addService(o)`, `removeService(id)`, `pruneService(now)`. They emit `'chaos'`.

### 5.13 Saves (`format.ts` +12, `migrate.ts` +10, `serialize.ts` +15)
See §8.

### 5.14 `src/ui/app.ts` (+60)
- New fields: `feed = new AlertFeed(this.game)`, `chaosLayers`, `private chaosAnim`.
- Layer registration (l. 189–196): `'venues'` after `'elevated'` and `'incidents'` after
  `'stations'`.
- Sim events (l. 209–217):
  - `alert` → `feed.upsert`, toast rule (§2.7), `stations.closed`/`trains.alerted` refresh,
    animation token, `toolbar.update()`;
  - `dayChaos` → `feed.setInfo`.
- `sim.init` (l. 219) gains `chaos: { level, seed }` and `service`. For a new game (no save) the
  constructor first draws `game.chaos.seed`.
- `onSnapshot` (l. 379): when `dayIndex(s.time) !== feed.day`, call `feed.rollDay(day)`. It
  returns newly announced events, which get toasts and a ticker line.
- `onDayEnd` (l. 412): `feed.endDay(r.chaos)` and `game.pruneService(time)` before the
  autosave.
- `refreshPanel` (l. 462–479) gains `case 'alerts': return this.showPanel(alertsPanel(this,
  sel.focus))`.
- `onKey` (l. 781) gains `case 'a': case 'A':` to toggle the alerts selection.
- New methods:
  - `setChaosLevel(l)`: `game.chaos.level`, `sim.setChaosLevel`, toast "From 3 am";
  - `addEventService(list)` and `removeEventService(id)`, each followed by
    `sim.setService(game.chaos.service)`;
  - `flyTo(x, y)`.

### 5.15 `src/ui/topbar.ts` (+30), `toolbar.ts` (+10), `icons.ts` (+7)
- **Topbar.** The weather chip and `NewsTicker` replace `h('div', { class: 'tb-spacer' })`
  (l. 52). `update()` (l. 63) sets the chip from `feed` and calls
  `ticker.set(feed.tickerItems(now))`; the ticker compares signatures itself.
- **Toolbar.** A bell button after `goals` (l. 46) with `<span class="badge">`. Its tooltip is
  "Service alerts" · `A`. `update()` sets the badge text and visibility from
  `feed.activeCount()`.
- **Icons.** New original 24×24 stroke icons:
  ```
  sun:    <circle cx="12" cy="12" r="4.5"/><path d="M12 2.5V5 M12 19v2.5 M2.5 12H5 M19 12h2.5 M5.3 5.3l1.8 1.8 M16.9 16.9l1.8 1.8 M5.3 18.7l1.8-1.8 M16.9 7.1l1.8-1.8"/>
  rain:   <path d="M7 15h9.5a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6 1.6A3.2 3.2 0 0 0 7 15Z"/><path d="M8.5 18l-1 2.5 M12.5 18l-1 2.5 M16.5 18l-1 2.5"/>
  snow:   <path d="M12 3v18 M4.2 7.5l15.6 9 M4.2 16.5l15.6-9"/><path d="M9.5 4.5 12 7l2.5-2.5 M9.5 19.5 12 17l2.5 2.5"/>
  heat:   <path d="M10 4.5a2 2 0 0 1 4 0v9.3a4 4 0 1 1-4 0Z"/><path d="M12 9v6.5 M17.5 6h2.5 M17.5 9.5h2.5"/>
  alert:  <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>
  ticket: <path d="M4 8.5V6h16v2.5a2.5 2.5 0 0 0 0 5V18H4v-4.5a2.5 2.5 0 0 0 0-5Z"/><path d="M14 6.5v11" stroke-dasharray="2 2"/>
  ```

### 5.16 Smaller UI touches (+60 in total)
- `selectTool.ts`: `move` (l. 17) and `click` (l. 43) pick `'chaos-incidents'` and then
  `'chaos-venues'` before trains.
- `stationLayers.ts`: `closed: Set<number>`. The outline is red when the station is closed
  (l. 141) and the label gets " · CLOSED" (l. 153). Add `this.version` to the update triggers.
- `trainLayer.ts`: `alerted: Set<number>`. The casing is red for alerted trains (l. 71), and
  the update triggers gain `alertedVersion`.
- `panels/stationPanel.ts` (after l. 36) and `panels/inspectPanels.ts` (`trainPanel` render,
  l. 28): banners (§2.7).
- `menu.ts`: a "City chaos" section and segmented control before "Units" (l. 94).
- `styles.css` (+55): `.ticker`, `.ticker-track`, `@keyframes ticker-scroll`,
  `.tb-weather svg`, `.tool-btn .badge`, `.alert-card` (left border by tone), `.alert-card.focus`
  (outline), `@media (max-width: 1180px) { .ticker { display: none } }` and
  `@media (prefers-reduced-motion: reduce) { .ticker-track { animation: none } }`.

### 5.17 Scripts, package and README
- `scripts/balance.ts` (+15): `chaos=off|calm|normal|wild` and `seed=` args (l. 175–183) set
  `game.chaos`. The per-day line (l. 229) appends
  `· ${weather} · inc ${n} · events ${byTransit}`.
- `scripts/perf.ts` (+12): the `chaos=wild` arg, `weather=snow` (`engine.chaos.forceWeather`)
  and `outdoor=1`, which marks every route direction fully outdoor after compiling to measure
  the worst case. It prints the number of incidents in the timed hour.
- `package.json`: `"test:unit": "vitest run --exclude 'tests/*headless*.test.ts'"` and
  `"test:headless": "vitest run tests/headless.test.ts tests/chaos.headless.test.ts"`.
- `README.md`: controls rows (§2.8), a new "City chaos" section (levels, rates, weather table,
  venues) and the balance and perf numbers (§10–11). Test count 36 → about 62.

---

## 6. New files and their exports

| File | Lines | Exports |
|---|---|---|
| `src/core/cityCalendar.ts` | 140 | `CityEvent`, `eventsForDay`, `announcedEvents`, `weatherForDay`, `forecastFor`, `weatherMods`, `weatherLabel`, `CLEAR`, `CLEAR_MODS`, `venueXY(ev)`, `eventKind(ev)`, `SALT_*` |
| `src/sim/incidents.ts` | 80 | `IncidentKind`, `INCIDENT_KINDS`, `PlannedIncident`, `Exposure`, `measureExposure`, `planIncidents`, `timeByService` |
| `src/sim/eventTrips.ts` | 90 | `originCdf`, `sampleCdf`, `sampleBand`, `eventCosts`, `reverseLegs`, `venueGeometry`, `checkKinds()` (used by a test) |
| `src/sim/chaos.ts` | 210 | `ChaosController` (`beginDay`, `setEventInfo`, `step`, `setNetwork`, `setLevel`, `setService`, `daySummary`, `endDay`, `flushWrapups`, `activeAlerts`, `force`, `forceWeather`, `forceEvents`), `ForcedIncident` |
| `src/routes/eventService.ts` | 50 | `routesNearVenue(net, x, y, r)`, `defaultWindows(ev)`, `serviceEstimate(cr, from, to, headwayMin)` → `{ extraCarKm, cost, trainsNeeded, trainsOwned, effectiveHeadway }` |
| `src/ui/alertFeed.ts` | 95 | `AlertFeed` (`upsert`, `setInfo`, `rollDay`, `endDay`, `active`, `activeCount`, `closedStations`, `alertedTrains`, `tickerItems`, `version`), `describeAlert(a, routes)`, `TickerItem` |
| `src/ui/ticker.ts` | 45 | `NewsTicker` (`el`, `set(items)`) |
| `src/ui/panels/alertsPanel.ts` | 150 | `alertsPanel(app, focus?)` (includes the inline event service editor) |
| `src/map/chaosLayers.ts` | 100 | `ChaosLayers` (`venueLayers(zoom)`, `incidentLayers(zoom, time)`) |
| `tests/chaos.test.ts` | 250 | unit tests §13.1 |
| `tests/chaos.headless.test.ts` | 200 | headless tests §13.2 |

- **Unit formatting.** `describeAlert` composes the title and body on the main thread from
  structured fields (`place`, `towards`, `crawl` in m/s, `routes`), so units follow the player's
  setting. The worker never formats speeds.
- **Serviceability.** `serviceEstimate` uses this formula:
  - extra trips per direction = Σ over 10-minute slices of
    `max(0, slice/h − slice/base)`, scaled by `h / effectiveHeadway`;
  - `effectiveHeadway = max(h, roundTrip / fleet)`, where
    `roundTrip = runTime0 + runTime1 + 2·turnaround`;
  - `trainsNeeded = ceil(roundTrip / h) + spareTrains`, the same as `trainsNeeded()` in
    `compile.ts:177`;
  - car-km = extra trips × `(len0 + len1)/1000` × cars, and cost = car-km ×
    `ECONOMY.operatingPerCarKm`.

---

## 7. Worker protocol additions (`src/sim/protocol.ts`)

```ts
export type { ChaosLevel, WeatherKind } from '../balance';
export type IncidentKind = 'signal' | 'breakdown' | 'sick' | 'police';

export interface ServiceOverride {
  id: number; routeId: number;
  /** Absolute game times [from, to). */ from: number; to: number;
  headwayMin: number; /** City event it was planned for, or 0. */ eventId: number;
}

export interface Alert {
  /** day·1000 + seq (0 = weather, 1–899 incidents, 900 + i event wrap-ups). */ id: number;
  kind: IncidentKind | 'weather' | 'event';
  status: 'active' | 'cleared' | 'info';
  day: number; start: number; /** expected clear time */ until: number;
  severity: 1 | 2 | 3;               // signal 2, breakdown 3, sick 1, police 3, weather/event 1
  /** "34 St", "between Marcy Av and Flushing Av", "Midtown arena" (names only, no units). */ place: string;
  towards?: string; routes: number[]; stationId?: number; trainId?: number; eventId?: number;
  /** Signal crawl speed, m/s. */ crawl?: number;
  /** Local metres. */ pos?: [number, number]; path?: [number, number][];
  weather?: DayWeather; outcome?: EventOutcome;
}

export interface DayWeather { kind: WeatherKind; severity: number; carried: boolean }
export interface EventDayInfo { id: number; label: string; venue: number; attendance: number; start: number; end: number;
  byTransit: number; byDrive: number; byWalk: number; overflow: number }        // real people
export interface DayChaosInfo { day: number; level: ChaosLevel; weather: DayWeather; events: EventDayInfo[] }
export interface EventOutcome { id: number; label: string; attendance: number; byTransit: number;
  arrived: number; late: number; gaveUp: number; avgTripMin: number }           // real people
export interface DayChaos { weather: DayWeather; incidents: Record<IncidentKind, number>; incidentMinutes: number;
  diverted: number; carriedPast: number; eventRiders: number; events: EventOutcome[] }

// DayReport (l. 147): add   chaos?: DayChaos;        (optional: v2 saves' lastReport stays valid)

export type ToWorker =
  | { type: 'init'; …existing…; chaos: { level: ChaosLevel; seed: number }; service: ServiceOverride[] }
  | …existing…
  | { type: 'chaosLevel'; level: ChaosLevel }               // applies from the next 3 am
  | { type: 'service'; overrides: ServiceOverride[] };      // full list, replaces

export type FromWorker =
  | …existing…
  | { type: 'alert'; alert: Alert }                         // start, clear, weather info, event wrap-up
  | { type: 'dayChaos'; info: DayChaosInfo };               // 3 am (or on start after 3 am)
```
- There are no new `Query` kinds, and the `Snapshot`/`TRAIN_STRIDE` format is unchanged. Alerts
  carry positions, and the main thread derives the closed stations and alerted trains from
  them.
- About 2 messages per incident: under 100 a day on the perf network at Normal.

---

## 8. Save format v3 and migration

### `src/save/format.ts`
```ts
export const SAVE_VERSION = 3;
export interface SavedChaos { level: ChaosLevel; seed: number; service: ServiceOverride[]; nextServiceId: number }
// SaveFile.game += chaos: SavedChaos;
```
Saved: the level, the seed (the calendar, weather and incident plan all derive from it) and the
planned event services. **Not saved:** active incidents, alerts and event agents. A midnight
autosave has no event agents in a meaningful state, and incidents only run 05:30–23:30. A
mid-day load replans the rest of the day from the same seed (§12).

### `src/save/migrate.ts`: new step `2:`
```ts
2: (s) => {   // v2 → v3: city chaos (events, disruptions, weather)
  const game = (s.game ?? {}) as Record<string, unknown>;
  game.chaos ??= { level: CHAOS.defaultLevel, seed: CHAOS.defaultSeed, service: [], nextServiceId: 1 };
  s.game = game;
  s.version = 3;
  return s;
},
```
This is idempotent and fills defaults only. A v1 save runs `1:` and then `2:`. Migrated games get
Normal chaos. On the first load of a migrated save, `App` shows a one-off toast: "New: city
events, disruptions and weather. Change the chaos level in Service alerts (A)."

### `src/save/serialize.ts`
- `buildSave` (l. 25–35) adds
  `chaos: { ...game.chaos, service: game.chaos.service.filter((o) => o.to > game.time) }`.
- `applySave` (l. 44–49): `game.chaos = sanitizeChaos(g.chaos)`. An unknown level becomes
  `'normal'`. The seed is `>>> 0`, or the default if it is not finite. Overrides without finite
  `from`, `to` and `headwayMin`, or with `to ≤ time`, are dropped. `nextServiceId` becomes
  `max(id) + 1`.

---

## 8a. Event-day example (core network, measured paths)
These figures come from the prototype in Appendix A: the README core network, scale 10,
evening headway 7.5 min, venue parking added to the drive cost, one Dijkstra per event.

| Venue | Stations ≤ 1.5 km | Origins with a path | Avg path | Expected share by subway |
|---|---|---|---|---|
| Midtown arena | 8 | 59% | 40 min | 50% |
| Downtown parade | 4 | 46% | 38 min | 42% |
| Central Park lawn | 5 | 50% | 42 min | 39% |
| Brooklyn arena | 1 (Atlantic Av) | 27% | 41 min | 21% |
| Bronx/Queens ballparks, tennis, Coney Island | 0 | 0% | — | 0% (build there!) |

---

## 9. `src/balance.ts`: new section (concrete values)

```ts
// ---------------------------------------------------------------------------
// City chaos: events, disruptions and weather (v2)
export type ChaosLevel = 'off' | 'calm' | 'normal' | 'wild';
export type WeatherKind = 'clear' | 'rain' | 'snow' | 'heat';

export const CHAOS = {
  levels: ['off', 'calm', 'normal', 'wild'] as ChaosLevel[],
  defaultLevel: 'normal' as ChaosLevel,           // new games; v2 saves migrate to this
  /** Headless runs and migrated saves; new games draw their own on the main thread. */
  defaultSeed: 2030,
  /** Incident rate multiplier: Calm halves, Wild is the "make it crazy" setting. */
  rate: { off: 0, calm: 0.5, normal: 1, wild: 2.5 } as Record<ChaosLevel, number>,
  /** Weather chance multiplier (snow/rain/heat probabilities, capped so Σ ≤ 0.9). */
  weatherChance: { off: 0, calm: 1, normal: 1, wild: 1.5 } as Record<ChaosLevel, number>,
  /** Event chance multiplier per venue-day. */
  eventChance: { off: 0, calm: 1, normal: 1, wild: 1.25 } as Record<ChaosLevel, number>,
  /** Incidents happen between these times of day (trains run; people notice). */
  serviceStart: 5.5 * HOUR,
  serviceEnd: 23.5 * HOUR,
  /** Hard cap per kind per day (perf network at Wild ≈ 43 breakdowns → 40). */
  maxPerKindPerDay: 40,
  /** Core ≈ 1.8/day on 88 directed-track km; perf ≈ 11/day on 560 km. */
  signal: { perTrackKmDay: 1 / 50, segment: 800, crawl: 15 * KMH, duration: [15 * MIN, 60 * MIN] as [number, number] },
  /** Core ≈ 2.8/day on 27.6k planned train-km; perf ≈ 17/day on 171k. */
  breakdown: { perTrainKm: 1 / 10_000, duration: [5 * MIN, 20 * MIN] as [number, number] },
  /** Core ≈ 2.3/day; holds stay short so they nudge, not block. */
  sick: { perTrainKm: 1 / 12_000, duration: [3 * MIN, 8 * MIN] as [number, number] },
  /** Core ≈ 0.8/day (40 stations); busy stations are likelier (weight 1 + boardings/20k). */
  police: { perStationDay: 0.02, duration: [10 * MIN, 40 * MIN] as [number, number], waitOutside: 15 * MIN, busyWeight: 20_000 },
  /** Incident toasts only at 1×/5× (TIME.speeds index ≤ 1) unless severity 3; ticker always. */
  toastMaxSpeedIndex: 1,
  toastMinGapMs: 20_000,
};

export const WEATHER = {
  /** Chance per weekday by month (Jan…Dec), rounded NYC climatology: ≈ 12 snow, 21 rain, 10 heat days a year. */
  chance: {
    snow: [0.14, 0.13, 0.07, 0.01, 0, 0, 0, 0, 0, 0, 0.01, 0.07],
    rain: [0.06, 0.06, 0.08, 0.09, 0.09, 0.09, 0.1, 0.1, 0.08, 0.08, 0.08, 0.07],
    heat: [0, 0, 0, 0, 0.01, 0.07, 0.14, 0.11, 0.03, 0, 0, 0],
  },
  /** A snow or heat day continues into a clear-drawn next day with this chance (at 0.8 × severity). */
  persist: 0.4,
  /** Forecasts are right this often; misses show lower confidence (50–70%). */
  forecastAccuracy: 0.8,
  /** Severity is uniform in [minSeverity, 1]; effects scale linearly; ≥ 0.85 is "Heavy …"/"Heat wave". */
  minSeverity: 0.5,
  /** Full-severity effects. walkPenalty is minutes added to the walk mode's generalised cost. */
  effects: {
    rain: { walkSpeed: 0.92, walkPenalty: 8, driveSpeed: 0.85, outdoorSpeed: 1, dwell: 1.05, crowd: 1.1,
            rates: { signal: 1.5, breakdown: 1.1, sick: 1, police: 0.8 } },          // wet rails, umbrellas, nobody walks 2 km
    snow: { walkSpeed: 0.75, walkPenalty: 15, driveSpeed: 0.6, outdoorSpeed: 0.55, dwell: 1.15, crowd: 1.1,
            rates: { signal: 2, breakdown: 1.5, sick: 1, police: 0.7 } },            // elevated/at-grade capped at 55% of top speed
    heat: { walkSpeed: 0.9, walkPenalty: 6, driveSpeed: 0.95, outdoorSpeed: 0.85, dwell: 1.05, crowd: 1.35,
            rates: { signal: 1.3, breakdown: 2, sick: 2.5, police: 1.2 } },          // AC failures, heat slow orders, hot crowded cars
  },
};

export const EVENTS = {
  /** Days of notice (a kind can override, e.g. parades 5). */
  announceDays: 3,
  /** Agent pool: at most this many event-goers by transit per day (poolCap = ceil(/ agentScale)). */
  maxPeoplePerDay: 200_000,
  /** Origin weight = residents · exp(−d / originDecay): city-wide draw, mild pull to nearby tracts. */
  originDecay: 12_000,
  /** Stations within this walk of the venue serve it (same order as the 2.5 km access walk, but crowds won't go as far). */
  venueAccess: 1500,
  /** Fans' destination points scatter this far around the venue. */
  venueScatter: 150,
  /** Expected crowding minutes added to event transit costs (packed trains). */
  crowdMinutes: 4,
  /** Fans leave home path.time × this before their target arrival. */
  tripBuffer: 1.15,
  /** Wrap-up alert this long after the event ends. */
  wrapUpAfter: 2 * HOUR,
  /** Event service: routes stopping within this of the venue are pre-selected. */
  serviceRadius: 1200,
  serviceHeadway: 3,
  serviceBefore: [-2 * HOUR, 15 * MIN] as [number, number],
  serviceAfter: [-15 * MIN, 90 * MIN] as [number, number],
  venues: [
    { key: 'bronx-ballpark', name: 'Bronx ballpark', lon: -73.9262, lat: 40.8296, parkingTime: 25 * MIN, parkingCost: 35 },
    { key: 'queens-ballpark', name: 'Queens ballpark', lon: -73.8456, lat: 40.7571, parkingTime: 20 * MIN, parkingCost: 30 },
    { key: 'midtown-arena', name: 'Midtown arena', lon: -73.9934, lat: 40.7505, parkingTime: 30 * MIN, parkingCost: 50 },
    { key: 'brooklyn-arena', name: 'Brooklyn arena', lon: -73.9754, lat: 40.6826, parkingTime: 25 * MIN, parkingCost: 40 },
    { key: 'flushing-tennis', name: 'Flushing tennis centre', lon: -73.8467, lat: 40.7499, parkingTime: 25 * MIN, parkingCost: 40 },
    { key: 'downtown-parade', name: 'Lower Broadway', lon: -74.0105, lat: 40.709, parkingTime: 45 * MIN, parkingCost: 50 },
    { key: 'central-park', name: 'Central Park Great Lawn', lon: -73.9665, lat: 40.7812, parkingTime: 30 * MIN, parkingCost: 45 },
    { key: 'coney-island', name: 'Coney Island boardwalk', lon: -73.9787, lat: 40.5743, parkingTime: 20 * MIN, parkingCost: 25 },
  ] as VenueDef[],
  // arrive: offset from start (triangular); leave: offset from end (triangular). Months 0 = Jan.
  kinds: [
    { venue: 'bronx-ballpark', label: 'Bronx ballpark game', months: [3, 4, 5, 6, 7, 8], chance: 0.42, attendance: [28_000, 46_000],
      starts: [[19.08, 0.7], [13.08, 0.3]], duration: 3 * HOUR, arrive: [-90 * MIN, 5 * MIN], leave: [-20 * MIN, 40 * MIN] },
    { venue: 'queens-ballpark', label: 'Queens ballpark game', months: [3, 4, 5, 6, 7, 8], chance: 0.42, attendance: [24_000, 42_000],
      starts: [[19.17, 0.7], [13.17, 0.3]], duration: 3 * HOUR, arrive: [-90 * MIN, 5 * MIN], leave: [-20 * MIN, 40 * MIN] },
    { venue: 'midtown-arena', label: 'Midtown arena game', months: [0, 1, 2, 3, 9, 10, 11], chance: 0.25, attendance: [17_000, 19_800],
      starts: [[19.5, 1]], duration: 2.5 * HOUR, arrive: [-75 * MIN, 5 * MIN], leave: [-10 * MIN, 30 * MIN] },
    { venue: 'midtown-arena', label: 'Midtown arena concert', months: ALL_MONTHS, chance: 0.2, attendance: [15_000, 19_500],
      starts: [[20, 1]], duration: 3 * HOUR, arrive: [-75 * MIN, 30 * MIN], leave: [-10 * MIN, 30 * MIN] },
    { venue: 'brooklyn-arena', label: 'Brooklyn arena game', months: [0, 1, 2, 3, 9, 10, 11], chance: 0.25, attendance: [14_000, 17_700],
      starts: [[19.5, 1]], duration: 2.5 * HOUR, arrive: [-75 * MIN, 5 * MIN], leave: [-10 * MIN, 30 * MIN] },
    { venue: 'brooklyn-arena', label: 'Brooklyn arena concert', months: ALL_MONTHS, chance: 0.12, attendance: [13_000, 18_000],
      starts: [[20, 1]], duration: 3 * HOUR, arrive: [-75 * MIN, 30 * MIN], leave: [-10 * MIN, 30 * MIN] },
    { venue: 'flushing-tennis', label: 'Flushing tennis open', months: [7, 8], window: [7, 26, 8, 8], chance: 1, attendance: [35_000, 50_000],
      starts: [[11, 1]], duration: 11 * HOUR, arrive: [-60 * MIN, 5 * HOUR], leave: [-6 * HOUR, 30 * MIN] },
    { venue: 'downtown-parade', label: 'Downtown parade', months: ALL_MONTHS, chance: 0.012, attendance: [80_000, 150_000],
      starts: [[11, 1]], duration: 2.5 * HOUR, arrive: [-2 * HOUR, 0], leave: [-30 * MIN, 40 * MIN], announce: 5 },
    { venue: 'central-park', label: 'Central Park summer concert', months: [5, 6, 7], chance: 0.08, attendance: [30_000, 60_000],
      starts: [[19, 1]], duration: 3 * HOUR, arrive: [-2 * HOUR, 30 * MIN], leave: [-20 * MIN, 30 * MIN] },
    { venue: 'coney-island', label: 'Coney Island fireworks', months: [5, 6, 7], weekdays: [5], chance: 0.8, attendance: [8_000, 20_000],
      starts: [[21.5, 1]], duration: 0.75 * HOUR, arrive: [-2 * HOUR, 0], leave: [0, 30 * MIN] },
  ] as EventKindDef[],
};
```
(`const ALL_MONTHS = [0, 1, …, 11]`, defined locally above `EVENTS`.)

Rationale per value:
- **Rates.** They are set so Normal gives the core network about 7–8 incidents a day (one every
  2.5 service hours) and the perf network about 48 (about 0.8 active at any time).
- **Durations.** The spec's signal range is 15–60 min. A stall of up to 20 min stays below the
  30-min watchdog.
- **Weather chances.** NYC averages, so a winter month has 2–3 snow days.
- **Snow factors.** 0.55 × 90 km/h ≈ 50 km/h (31 mph) on outdoor track. Driving speed 0.6 makes
  an average 40-min drive about 60 min.
- **Attendance.** Typical ranges for the venue sizes. The parade is huge but rare (about 3 a
  year).
- **Season lengths.** Ballparks Apr–Sep, arenas year-round with games in Oct–Apr. The chances
  give about 1.1 events per weekday.
- **Parking.** Real-world venue parking costs about $30–50 and takes 20–45 min to get in and
  out.
- **Pool.** 200k people a day covers the worst realistic day (parade + two ballgames ≈ 110k by
  transit). At scale 10 that is 20k agents, about 2 MB.

---

## 10. Balance impact

### 10.1 Method
- I wrote a scratch prototype outside the repo: Appendix A lists the scripts and every output
  line.
- It builds the README core network (`scripts/balance.ts` `buildCoreNetwork`, 10-car trains,
  2.5-min peak, sandbox) and runs 11 days at scale 10.
- It applies the chaos effect from day 8 and compares days 8–10 with a baseline run. Every run
  is identical up to day 7, so the differences are causal.
- How each effect was approximated:
  - **Weather:** by mutating the `COMMUTERS` walk and drive speeds and the walk constant for
    that day. This is exactly what `wx` does in mode choice and in the sim's walks.
  - **Breakdowns and sick passengers:** by wrapping `TrainSim.move`/`arriveAt` (stall in place;
    extend the dwell) at the §9 rates.
  - **Snow on elevated track:** by capping `vmax` on the all-elevated sprawl network.
  - **Events:** by measuring one venue Dijkstra and the logit with parking (§8a).
  - Police closures and signal crawls were not prototyped. Their effect is estimated from the
    breakdown result: similar minutes of disruption.

### 10.2 Results

| Scenario (core, day 8–10 vs baseline) | Riders | Fares/day | Notes |
|---|---|---|---|
| Baseline (v1) | 1.298M / 1.313M / 1.327M | $3.48 / 3.52 / 3.56M | |
| One **snow** day (day 8 only) | **+4.9%** / +1.0% / +0.7% | +$168k / +$35k / +$24k | walkers switch, driving slower; the smoothed share carries on |
| Three snow days in a row | +4.9% / +6.9% / +7.8% | +$168k … +$275k | commute 51.8 vs 49.4 min (the weather-adjusted baseline handles this) |
| Rain (three days) | +1.6% / +2.9% / +3.3% | +$57k … +$122k | |
| Breakdowns + sick holds, Normal (≈ 6/day) | 0.0% / −0.03% / −0.21% | −$0 … −$6k | lateness +3–10 s, give-ups +1.6k people/day |
| Same, Wild (×2.5, ≈ 12/day) | −0.15% / −0.17% / −0.9% | −$6k … −$28k | give-ups 15.3k vs 8.9k |
| Sprawl, one snow day (elevated) | +17% (15.9k → 18.6k) | +$8k | avg lateness 262 s vs 0; back to normal the next day |

### 10.3 Expected average impact (Normal, core network, per weekday)
- **Weather:** about +$13k/day averaged over a year: about 12 snow days × ~$230k (including the
  carry-over), plus about 21 rain days × ~$70k, minus heat crowding.
- **Incidents:** about −$10–20k/day. That is the breakdown result above, doubled for the police
  closures and signal crawls that were not prototyped.
- **Events:** about +$25–40k/day. On average 1.1 events a day, but the core network only serves
  Midtown arena, the parade, Central Park and Brooklyn arena. That is about 4–6k round trips a
  day at $3, a little more on parade days (about 50k fans by subway, +$300k that day). It is
  partly offset by event-day crowding of PM-peak commuters.
- **Net:** about **+$0.03M/day**. The README's "−$0.28M/day after interest" becomes about
  **−$0.25M/day on average**. Individual days now range from about −$0.45M (a Wild incident day
  in a heat wave) to about $0 (a snow day with a Midtown concert).
- **Riders:** within ±1% of v1 on average, so the milestones are reached at about the same
  time. Snow days can hit a milestone early, and that is intended: they are real ridership
  days.
- **Sprawl:** still about −$0.8M/day. Snow costs it lateness, not money: there are no riders to
  lose.
- **Wild:** about −$0.05 to −0.09M/day on the core network from incidents, part of which events
  win back. It is harder, as intended.

### 10.4 Acceptance bands (checked with `npm run balance -- scenario=core days=12 chaos=normal`)
- The day-11 riders are within ±3% of the chaos-off run on the same seed.
- The days 8–11 average operating result is within ±$0.1M/day of chaos off.
- `deadlocks` is 0 every day. Sprawl with chaos still loses at least $0.7M/day.

---

## 11. Performance (target: 300 stations / 25 routes / 400 trains / 285k agents at 60×; v1 has 5.3× headroom, 190 ms per peak hour)

**Per step (2 s) in `TrainSim.move`, for each running train:**
- one `Float64Array` read for the closed-stop check;
- one compare for the hold;
- one `Uint8Array` read per element in the lookahead (usually 1–3) for restrictions;
- the outdoor loop, only when `outdoorFactor < 1`, which costs the same as the existing
  curve-limit loop.

That is about 10–20 ns per train per step: 430 × 1,800 × 20 ns ≈ 15 ms per peak hour in the
worst case (Wild, snow, every track outdoor), so +8% and headroom ≥ 4.9×. With chaos off, all
branches are skipped (≤ 1%).

**Dispatch.** `headwayAt` replaces one array read. It loops over that route's overrides, usually
none: 50 route-directions × 1,800 steps ≈ 90k calls, under 1 ms per hour.

**`ChaosController.step`.** A pointer into the sorted plan plus a scan of the active list (≤ 10
entries), so it costs nothing measurable.

**Commuters.**
- Closure checks are O(1) per `arrive`/`board`.
- Event agents add up to 20k agents × about 5 heap events on event days, about 8% more heap
  traffic for that day, concentrated in the evening. `board()` is already O(boarded).
- `evictStation` is O(queue length) once per closure.

**3 am** (measured in the prototype):
- The v1 `dailyModeChoice` takes 257 ms on the core network (G = 252,543 groups).
- Chaos adds the event injection: 3–8 ms per event (one venue Dijkstra plus `bestPath` for all
  2,324 tracts) plus about 1 ms of origin sampling per 10k agents. That is ≤ 40 ms on a
  4-event day.
- Incident planning takes < 1 ms.
- The weather baseline loop costs 145 ms but is cached per kind and 0.1 severity bucket, so it
  runs at most about 15 times per session.
- The 3 am step is already a known single-step spike. The worker's backlog drop rule
  (`worker.ts:123`) keeps it from spiralling.

**Memory.** The event pool is 20k agents × about 100 B ≈ 2 MB at scale 10 (4 MB at scale 5).
Restrictions, closures and alerts are negligible.

**Main thread.**
- The chaos deck layers hold ≤ 30 objects and are rebuilt per frame only while animating.
- The alert-pulse animation token keeps rendering while paused with incidents active (about
  1 ms of JS per frame; the GPU load is the same as when running).
- The ticker rebuilds its DOM only when its signature changes. Scrolling is a compositor-only
  `transform` animation.

**Verification:** `npm run perf -- chaos=wild weather=snow outdoor=1` must print ≥ 4.5× headroom
(≤ 222 ms for the peak hour), alongside the plain `npm run perf` (≥ 5×, unchanged).

---

## 12. Determinism

- **Pure functions.** The calendar, weather, forecast and incident plan are pure functions of
  `(seed, day, level)` and the network exposure, using independent `Rng(hashSeed(…))` streams
  (§3.1). The main thread and the worker compute identical calendars from the same seed. A unit
  test compares `eventsForDay` across separate module imports and runs.
- **Targets.** Incident targets come from the pre-drawn `r1`/`r2` and the deterministic sim
  state: the trains array order, station indices and track list order.
- **Event trips.** Origins, bands, modes, times and scatter come from `hashSeed(seed, ev.id)`.
  The result is the same whatever else happened that day, given the same network, overrides
  and weather.
- **The commuter RNG** (`Commuters.rng`, seed 1885) is never used by chaos. With level **Off**:
  - no streams are consumed;
  - every multiplier is exactly 1 or 0, and `x / 1`, `x * 1` and `x + 0` are exact;
  - the pool is empty;
  - the dispatch pull-in runs only while an override is active.

  So the run is **bit-identical to v1**. The checklist includes diffing the
  `npm run balance` output before and after.
- **Reload.** A save restores the seed, level and overrides. A load at midnight is exactly
  reproducible. A mid-day load replans the same remaining incidents (the `after` filter is
  applied after drawing) and re-injects the same event agents (ongoing events: fans are "at the
  venue"). The incident *targets* can differ, because the trains restart from terminals after a
  load, exactly like v1's agents.
- **Headless proof.** Two `Engine`s with the same options run 2 days at Wild with seed 42 and
  produce identical `DayReport` JSON and an identical alert sequence (§13.2, test 3).

---

## 13. Test plan (Vitest)

### 13.1 `tests/chaos.test.ts` (unit; no world data; runs in `test:unit`)
1. **hashSeed/poisson/triangular.** `hashSeed` is stable for fixed inputs, and 10k random part
   tuples never return 0. The mean of `poisson(rng, 3.7)` over 20k draws is within 3% of 3.7,
   and the mean of `poisson(·, 60)` is within 2%. `triangular` stays inside `[a, b]` with a mean
   of about `(a + b)/2`.
2. **Calendar determinism.** `eventsForDay(7, d, 'normal')` is deep-equal across two calls.
   Seeds 7 and 8 differ in at least one of 30 days. Ids are unique and equal `day·16 + venue`.
   There is at most one event per venue per day.
3. **Calendar seasons and notice.** Over days 0–520 (two years): there are no ballpark events in
   Oct–Mar, tennis falls only on 26 Aug – 8 Sep, fireworks only on Fridays in Jun–Aug, and
   `announced === day − 3` (parade `− 5`). Attendance is in range and rounded to 100.
4. **Calendar rates and levels.** Over 2,000 days, the mean events per day is in `[0.9, 1.4]`
   for Normal. The Calm events equal the Normal events. Off is empty. Normal ⊆ Wild by id.
5. **Event kinds fit the day.** `checkKinds()`: for every kind and start option,
   `start + duration + leave[1] ≤ 24 h + 10 min`, every venue's Σ chance × 1.25 ≤ 1, and every
   venue key resolves.
6. **Weather.** It is pure. There is no snow in Jun–Sep or heat in Nov–Mar. The January snow
   frequency over 3,000 January days (synthetic day indices) is in `[0.12, 0.30]`, counting the
   carry-over. A carried day has `severity ≤ 0.8 ×` the previous day's. Off is always clear.
7. **Forecast accuracy.** Over 3,000 days, `forecastFor(d).kind === weatherForDay(d).kind` in
   `[0.75, 0.85]` of cases. A miss always has confidence ≤ 0.7.
8. **Weather mods.** Clear gives exactly `CLEAR_MODS`. At severity 1, snow equals the table. At
   severity 0.5, `outdoorSpeed = 0.775`.
9. **Mode choice with weather.** `generalisedCosts(g, b, t, CLEAR_WX)` is `toEqual`
   `generalisedCosts(g, b, t)` (bit-exact). Snow makes driving and walking cost more, so the
   transit share rises for a CBD pair.
10. **Incident plan.** For the core-like exposure (27.6k train-km, 88 km, 40 stations), the mean
    count over 500 days is within 10% of λ per kind. Off gives `[]`. The times lie inside the
    service hours and are sorted. With the `after` filter the plan is an exact suffix of the
    full plan.
11. **Mini-network TrainSim helper.** A hand-built `CompiledNetwork` with one route, a 4 km
    straight, stops at 0/2,000/4,000 m, one directed track per direction with real `elems`, and
    optional outdoor stretches. It uses stub `PassengerHooks` that record `pass` calls.
    1. **Snow slows trains:** with `outS = [0, 4000]` and `setWeather(0.55, 1)`, the arrival at
       stop 2 is ≥ 25% later than at factor 1, and the speed never exceeds `0.55·vmax + 0.01`.
       With no `outS` (deep) the arrival time is identical.
    2. **Signal crawl:** a restriction `[800, 1600]` at 4.17 m/s caps the speed while the train
       overlaps it, and the arrival is ≥ 150 s later. After `setRestrictions([])` the next train
       runs at normal speed.
    3. **Breakdown:** a leader is held for 600 s, then a follower dispatched 120 s behind. While
       the leader is held its `s` changes by under 1 m (after stopping), the follower's head
       stays ≥ 100 m behind the leader's tail, and both resume. `day.deadlocks === 0`, with
       `graceUntil` set.
    4. **Sick hold:** `holdNext = 300`, so the dwell at stop 1 is ≥ 320 s and `onHold` is
       called once with station 1. A hold set on a train whose next stop is the terminal does
       nothing.
    5. **Closed station:** with `closedUntil[station 1] = Infinity`, the train never dwells with
       `stop === 1`, `pass` is called once with stopIdx 1, and the train arrives at stop 2.
    6. **Event service:** base headway 600 s with a 180 s override for 1 h and fleet 8. The
       dispatches in the window are ≥ 2.5 × the no-override count. A night window with base 0
       still dispatches.
12. **eventTrips.** `sampleCdf` on 3 synthetic tracts with weights 1:2:7 gives frequencies
    within 2% over 30k samples. `reverseLegs` reverses the order and swaps board and alight.
    `eventCosts` adds exactly the parking time and cost to driving.
13. **eventService.** `serviceEstimate` on a fixture route (2 × 12 km, 10 cars, base 450 s, 3 min
    for 2 h) gives extra car-km = `(7200/180 − 7200/450)·24·10`. A fleet of 5 caps the
    effective headway at `roundTrip/5`.
14. **Save v3.**
    - A minimal v2 object migrates to v3 with the chaos defaults, a v1 object migrates all the
      way, and running the step twice is idempotent.
    - `buildSave` → `applySave` round-trips the level, seed and overrides, and drops past
      overrides.
    - An invalid level becomes `'normal'`.
    - A v2 `lastReport` without `chaos` loads.

### 13.2 `tests/chaos.headless.test.ts` (world data; runs in `test:headless`)
1. **Station closure blocks boarding.**
   - Setup: `buildTestNetwork`, chaos off (so nothing random), `startEngine`, `stepUntil` day 1
     07:30. Then `engine.chaos.force({ kind: 'police', station: penn, duration: 1200 })`.
   - During the closure, sampled every 60 s:
     - `stationDetail(penn).hourlyToday` sums are constant (no boarding);
     - `waitingByStation()[penn] === 0`;
     - no train is `Dwelling` at penn, apart from one that arrived before the closure;
     - the stub-free hooks recorded at least one `carriedPast`.
   - 20 min after reopening, the boardings have grown. The day's
     `report.chaos.diverted + carriedPast > 0`. Two alerts: active, then cleared at
     `until ± 2 s`.
2. **Event agents generated and removed.**
   - Setup: test network, chaos `normal` with
     `forceEvents(1, [midtownArenaEvent(1, 18_000, 19.5)])` and `forceWeather(1, CLEAR)`.
   - After day 1 03:01:
     - `eventAgentCount() > 300`;
     - `dayChaos.events[0].byTransit > 0`;
     - `byTransit + byDrive + byWalk === attendance` (± scale).
   - At day 1 23:59: the outcome has `arrived > 0`, `chaos.eventRiders > 0`, and the routes'
     riders exceed those of a control run without the event.
   - After day 2 03:01: `eventAgentCount() === 0`, `stuckCount() === 0` and
     `eventInFlight() === 0`.
3. **Determinism.** Two engines, chaos `wild`, seed 42, test network, 2 days each:
   `JSON.stringify(reports)` is equal, and the collected alert arrays are deep-equal (ids,
   times, targets).
4. **Snow slows trains** (end to end, elevated).
   - Setup: an elevated line (the sprawl `E` alignment, Jamaica–Glen Oaks, 6 stations, at
     2.5 min). `compileNetwork` gives `outS` covering ≥ 95% of each direction; a deep control
     line gets `outS` empty.
   - Run day 1 with `forceWeather(1, { kind: 'snow', severity: 1 })` against a clear control on
     the same seed:
     - `routeLateness` is higher by ≥ 60 s;
     - the maximum sampled train speed on the line is ≤ `0.55·vmax + 0.05`;
     - the mean `obsTime` over groups with observations after day 1 is higher than in the
       control (**the effect reaches the next day's choice**).
5. **Incident lifecycle.** Test network, chaos off. At day 1 08:00, `force({ kind:
   'breakdown', train: firstRunning(r1), duration: 600 })`. Expected:
   - one active alert with `trainId` and `until = t + 600`;
   - the train's `s` is constant (< 1 m) from t + 60 to t + 590;
   - a cleared alert at `≥ until`;
   - the train moves again within 120 s;
   - `deadlocks === 0` and `stuckCount() === 0` at the next 3 am.
6. **Chaos off is inert.** A test-network run for 1 day at Off: no alerts are emitted,
   `report.chaos.incidents` are all 0, `events` is `[]` and the weather is `clear`. The riders
   equal the existing `headless.test.ts` run for the same day, because the default is Off.

### 13.3 Scenario scripts (manual, recorded in the README)
- `npm run balance -- scenario=core days=12 chaos=normal` and `chaos=wild`.
- `npm run balance -- scenario=sprawl days=8 chaos=normal`.
- `npm run perf -- chaos=wild weather=snow outdoor=1` (§11).

---

## 14. Risks and how to de-risk them

| Risk | De-risking |
|---|---|
| Event agents (`a ≥ A`) reach group-indexed code and corrupt shares or observations | Only 5 functions branch, via `isEvent(a)`. The pool never enters `modeCount`, `trips` or `todayTime*`. Test 13.2-2 checks `stuckCount`/`inFlight`, and test 13.2-6 checks that Off equals v1. |
| False deadlocks: trains queued behind a stall trip the 30-min watchdog | `graceUntil` excludes stall time during incident windows, and the maximum stall is 20 min. Tests 11.3 and 13.2-5 assert 0 deadlocks. |
| A closure strands riders (bound for a closed terminal, or carried to the end) | Terminals always allow alighting. `pass` never runs on the first or last stop. Riders go on to `k + 1` and walk back. Test 13.2-1. |
| Balance drift (parade days, Wild too punishing) | Every rate is in `balance.ts`, with the acceptance bands in §10.4 and the `chaos=` arg in the balance script. Calm exists for players who want less. |
| A 3 am spike on the first snow day (+145 ms) | Cached per weather bucket. It is a single step, and the worker already tolerates the 257 ms mode-choice step. Optionally precompute all buckets in idle time (stretch). |
| Toast spam at 60× on the perf network (about 48 a day) | Toasts only at 1×/5× or for severity 3, with a 20 s minimum gap. The ticker and the badge are the main channel. |
| The ticker or pulses cost frames | Compositor-only CSS transform. The DOM is rebuilt only on signature change. Deck layers hold ≤ 30 objects. Reduced-motion support. |
| Save conflicts with other v2 features over v3 | The step is purely additive with `??=`, so it merges into a single `2:` step. `chaos` is a new top-level key under `game`. |
| A restriction refers to track that was removed or re-indexed by an edit | Keyed by `(edge, edgeDir, u-range)` and remapped in `setNetwork`. Dropped with a cleared alert if the edge is gone. |
| Event service with too few trains looks broken | The estimate shows `effectiveHeadway` and the owned/needed trains. The sim degrades gracefully: pending slots wait for returning trains. |
| Main-thread and worker calendars diverge | One pure module, unit-tested. The worker's `dayChaos` is authoritative for today, and the UI uses it whenever it is present. |
| `CRouteDir` field additions break other features' fixtures | `outS0/outS1` are optional. |

---

## 15. Implementation checklist (in order)

1. **Balance and RNG.** Add the `balance.ts` sections (§9). In `rng.ts`, add `hashSeed`,
   `poisson`, `triangular`, `stochasticRound` and `pickWeighted`. Tests 13.1-1.
2. **Calendar and weather.** Write `cityCalendar.ts`. Tests 13.1-2 to 13.1-8.
3. **Mode choice.** Add `wx` to `walkTime`, `driveTripTime` and `generalisedCosts`.
   Test 13.1-9. Run `npm test`: everything must still pass.
4. **Compile.** Add outdoor stretches to `buildDir`. Check them with test 13.2-4's first assert.
5. **TrainSim.** Train fields, `pass` hook, holds, closed-stop pass, outdoor cap, restrictions,
   dwell factor, watchdog grace, overrides, `headwayAt`, `last`. Tests 13.1-11.
6. **Incident planning.** Write `incidents.ts` (`measureExposure`, `planIncidents`).
   Test 13.1-10.
7. **Event trips.** Write `eventTrips.ts`. Test 13.1-12. Add `capWait` to `transitGraph.ts`.
8. **Commuters.** Pool allocation, `homeBand`, `access` kept, weather (`driveTime`, walks,
   crowd, baseline cache), closures (`evictStation`, `arrivePlatform`, the board guard,
   `pass`), `injectEvents`, the event branches, `eventOutcomes` and the new stats.
9. **Controller and engine.** Write `chaos.ts` (`ChaosController`, `force*`). Wire it into the
   engine (`beginDay`, `step`, `closeDay`, `setNetwork`), add the protocol types and the
   headless helpers (`startEngine`, `stepUntil`, fixture). Tests 13.2-1 to 13.2-6.
10. **Bit-identity check.** Run `npm run balance -- scenario=core days=4` before and after
    with the default chaos (Off). The output must be identical. Run `npm run perf`.
11. **Worker and client.** Add the messages (`init` fields, `service`, `chaosLevel`, `alert`,
    `dayChaos`).
12. **Saves.** Save v3, the migration step and `sanitizeChaos`. Tests 13.1-14.
13. **Game state.** `Game.chaos`, the service methods, `Selection 'alerts'`, `GameEvents
    'chaos'`. In `App`: seed draw for new games, the `sim.init` fields, `AlertFeed`, message
    handlers, `rollDay` and announcements, the `onDayEnd` prune, the `A` key.
14. **UI part 1.** Icons; the weather chip and ticker (`ticker.ts`, `topbar.ts`); the toolbar
    bell and badge; styles.
15. **UI part 2.** `alertsPanel.ts` and `eventService.ts` (test 13.1-13); the event service
    editor; the level control (panel and menu).
16. **Map.** `chaosLayers.ts` (venues, segments, incidents, pulse token); `selectTool` picking;
    the station and train layer flags; the panel banners.
17. **Scripts.** Add the `chaos=` args to `balance.ts` and `perf.ts`. Run §13.3, check the
    §10.4 bands and record the numbers in the README.
18. **README.** Controls, the "City chaos" section, the balance and perf tables, the test
    count.
19. **Stretch, only if time remains:**
    - a "today's event service" section in the route panel;
    - a pop-up event at Wild, near a random busy station, announced the same morning;
    - a snowfall CSS particle overlay on snow days (disabled for reduced motion);
    - a month-report chaos line;
    - a goal "Carry 20,000 fans to one event".

---

## 16. Size estimate

| Part | Lines |
|---|---|
| New sim files (`cityCalendar`, `incidents`, `eventTrips`, `chaos`) | ≈ 520 |
| Sim changes (`trainSim` +100, `commuters` +165, `engine` +45, `protocol` +80, `compile` +25, `modeChoice`/`rng`/`transitGraph` +48, worker and client +40, headless +30) | ≈ 535 |
| `balance.ts` | ≈ 115 |
| UI new files (`alertFeed`, `ticker`, `alertsPanel`, `chaosLayers`, `eventService`) | ≈ 440 |
| UI changes (app, topbar, toolbar, icons, select tool, layers, panels, menu, styles) | ≈ 220 |
| Saves, scripts, package | ≈ 65 |
| **Production total** | **≈ 1,900** (≈ 1,750 if the stretch items and the route panel section are left out) |
| Tests | ≈ 450 |

**Difficulty:** medium-high.
- The hard parts are the `move()` additions, which must keep the moving block and lock logic
  intact, the event-agent branches in `commuters.ts`, and keeping chaos Off bit-identical.
- Everything else is pure functions or straightforward UI.
- The sim half (checklist steps 1–10, about 1,100 lines) can be merged and shipped on its own,
  with the UI following.

---

## Appendix A: prototype measurements (this machine, scale 10)

The scratch scripts lived in the session scratchpad: `proto/measure.ts`, `proto/impact.ts`
and `proto/g.ts`, with `proto/core.ts` (a copy of `buildCoreNetwork`/`buildSprawlNetwork`).
None of them are in the repo.

**Exposure and venue coverage** (`measure.ts`)
```
core:   40 stations, 4 routes, fleet 63,  planned train-km/day 27,603, directed-track km ≥ 87.9, outdoor 0.0
test:   16 stations, 2 routes, fleet 25,  planned train-km/day 13,996, directed-track km ≥ 58.4, outdoor 0.0
sprawl: 13 stations, 2 routes, fleet 27,  planned train-km/day 14,204, directed-track km ≥ 45.2, outdoor 45.2
perf:  300 stations, 25 routes, fleet 431, planned train-km/day 171,360, directed-track km ≥ 560.0, outdoor 0.0
core venue Dijkstra + 2,324 bestPath: 3.2–8.1 ms per venue; perf 2.1–8.0 ms; access lists 10 ms (core), 53 ms (perf)
core venues: Midtown arena 34 St 227 m · Downtown parade Bowling Green 347 m · Brooklyn arena Atlantic Av 394 m ·
             Central Park lawn 91 St 645 m · Bronx ballpark 3.4 km · Queens ballpark 3.8 km · tennis 3.5 km · Coney Island 12.3 km
```

**Mode-choice timing** (`g.ts`, core): G = 252,543 groups, A = 285,288 agents. `dailyModeChoice`
takes 257 ms. A no-transit logit loop over all groups (the weather baseline) takes 145 ms.

**Impact runs** (`impact.ts`, core unless noted, 11 days, chaos from day 8; showing days 8 / 9 / 10)
```
base       riders 1,298,060 / 1,312,940 / 1,326,750 · fares $3.480M / $3.520M / $3.557M · late 108 / 123 / 117 s
snow ×1    riders 1,362,070 / 1,326,070 / 1,335,860 · fares $3.648M / $3.553M / $3.581M · commute 51.83 / 49.42 / 49.33
snow ×3    riders 1,362,070 / 1,404,000 / 1,429,730 · fares $3.648M / $3.761M / $3.832M
rain ×3    riders 1,319,010 / 1,350,840 / 1,370,860 · fares $3.537M / $3.623M / $3.679M
incidents  (Normal, 7 stalls + 11 holds over 3 days)  riders 1,298,060 / 1,312,590 / 1,323,950 · gave up 5.1k / 9.1k / 10.5k
incidents  (Wild ×2.5, 21 stalls + 14 holds)          riders 1,296,010 / 1,310,770 / 1,314,690 · gave up 7.1k / 11.0k / 15.3k
sprawl     base 15,860 / 16,140 / 16,600 · snow ×1 (vmax ×0.55) 18,560 / 16,560 / 17,000 · late 262 s on the snow day
```
All runs had 0 deadlocks.
