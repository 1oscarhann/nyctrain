# v2 design: Cinematic

Status: design (this section), then implementation notes at the end. Baseline: git tag
`pre-cinematic`.

Make the city gorgeous without touching the simulation: a day/night cycle driven by game time,
night glow on lines, trains and stations, lit windows, a follow camera, a photo mode and a
timelapse of the network's growth. Everything here runs on the main thread and reads game state;
nothing is sent to the worker, and the sim never reads anything this feature writes.

## 1. Goals and non-goals

Goals:
- **Day/night cycle** from the game clock and date: dawn, day, dusk and night palettes interpolated
  at runtime on the recoloured basemap (land, water, parks, roads, labels, building footprints,
  3D buildings, the fill-extrusion light's colour, intensity and direction, the sky). Sunrise and
  sunset follow each city's latitude, longitude, time zone and daylight saving (London's winter days
  are 1 h 25 min shorter than New York's; its summer days 1 h 30 min longer). Weather tints it.
- **Night glow**: route lines, elevated lines, trains (express trains with a white halo), stations
  and today's event venues glow at night (deck.gl, additive blending); **lit windows** on 3D
  buildings at night.
- **Follow-cam**: "Follow" in the train panel (or **F**) locks the camera to a train: in 3D a chase
  camera behind and above it, aimed at track height (elevated +8 m), its bearing eased to the
  train's heading (interpolated position, path tangent, interline and four-track pair offsets); in
  2D a centre lock. **Esc** or dragging the map ends it; the wheel sets the chase distance.
- **Photo mode** (**P**): all UI chrome hidden, optional letterbox (**L**) and a subtle caption
  (**C**: date, time, city); the map attribution stays visible (licence requirement).
- **Timelapse**: a compact snapshot of the built network (edges, stations, routes and their status)
  at every month close, stored in the save (bounded, thinned, compact encoding; save v6 → v7 with
  one migration step defaulting to an empty timelapse), and a player that replays the network's
  growth from the start to now with lines drawing themselves in and a date counter.
- **Settings**: Day and night **Cycle** (default) or **Always day** (the static basemap as before:
  no runtime style updates at all); lit windows on/off. Per viewer (localStorage), not saved.

Non-goals: real shadows, terrain, rain/snow particles, video export, a free-flight camera.

## 2. Controls

| Key / control | Action |
|---|---|
| P | Photo mode on / off (Esc also leaves) |
| L / C (photo mode) | Letterbox / caption on or off (remembered) |
| Follow (train panel) or F (a train selected) | Follow-cam on that train; F again or Esc stops |
| Wheel while following | Chase distance (3D) or zoom (2D) |
| Drag the map while following | Stops following |
| Timelapse (toolbar, film icon) | Replay the network's growth: Space play/pause, ← → month, Esc close |
| Settings (title) / Menu → Light | Day and night (cycle) / Always day; lit windows / dark |

Esc order: timelapse, then photo mode, then follow-cam, then the existing tool/selection rules.
Photo mode and the timelapse hide the chrome with a class on the root (panels are kept, not
destroyed, and come back as they were); in photo mode only Space, 1–4, V, P, L, C, F and Esc act.

## 3. Data flow

- `src/cinematic/solar.ts` (pure): sun altitude and azimuth (NOAA/Meeus, about a minute), sunrise,
  sunset and civil twilight, US and EU daylight-saving rules. The game clock is local civil time;
  each city has a time zone (CityConfig) and its CITY_BALANCE origin as its position.
- `src/cinematic/palette.ts` (pure): keyframes NIGHT, DAWN, DUSK, GOLDEN and DAY (DAY is the
  existing BASEMAP exactly), interpolated in OKLab by sun altitude (dawn before solar noon, dusk
  after), then a weather tint (rain greys and darkens, snow whitens the ground, heat hazes warm)
  scaled by severity; quantised to hex; `paletteChanges` says which keys moved meaningfully.
- `src/map/style.ts`: one table of palette bindings (layer, paint property, key) drives both the
  initial recolour and the runtime updates. The 3D buildings get a constant colour (no data-driven
  expression), so a colour change is a uniform, not a tile relayout.
- `src/cinematic/daylight.ts` (runtime): ticked from App's existing 250 ms interval with the
  interpolated game time and today's weather (AlertFeed). It pushes only changed keys
  (`setPaintProperty(..., {validate:false})`), the light when its direction moves ≥ 2° or its
  colour/intensity changes, and the sky. Lit windows switch the building layer to a window pattern
  below −4° (hysteresis ±0.75°): a relayout of the building source only, twice a game day. It
  exposes `night` (0…1) for the deck.gl glow layers, whose `opacity` prop carries it (no attribute
  rebuild).
- `src/cinematic/chase.ts` (pure): a train's pose on its route direction (position, path tangent
  over ±15 m, the drawn lateral offset in metres), the chase camera's centre (moved ahead so the
  point at track height sits at the screen centre), the zoom for a chase distance, angle easing.
- `src/cinematic/followCam.ts` (runtime): `follow({kind:'train', id})` or
  `follow({kind:'point', label, pose: (now) => FollowPose | null})` (the hook for Commuter
  stories), `stop(reason)`, a `change` event. Per frame while following (MapView `frame`, under
  `beginAnimation`), one `jumpTo`. A train that leaves the snapshot (turnaround, a recompile) is
  held for 10 game minutes, then follow ends with a toast.
- `src/cinematic/timelapse.ts` (pure): `recordFrame` (built and construction edges with their
  drawn orientation, stations, routes with their legs, colours, express flag and whether they run),
  `thinFrames` (at most 120 frames; the frame whose removal leaves the smallest gap goes first; the
  first and last are kept; then down to an encoded-size cap), `encodeTimelapse`/`decodeTimelapse`
  (geometry once per edge id: Douglas–Peucker at 1 m, metres as zig-zag varint deltas; frames as
  sorted id deltas with status and flip bits; route shapes deduplicated; base64), and the player's
  draw schedule (new edges draw outward from the existing network along their chains).
  `Game.timelapse` holds it; App records a frame at each month close (the month report's moment);
  the headless scripts can do the same (`timelapse=1`) through `Game.recordTimelapse`.
- `src/cinematic/timelapsePlayer.ts`, `photoMode.ts` (runtime DOM + deck.gl layers), and
  `src/cinematic/index.ts` (`Cinematic`, owned by App: key handling and the pieces above).

## 4. Performance budget (main thread, 60 fps)

- Day/night: ≤ 0.2 ms per 250 ms tick; paint pushes at most 4 Hz and only on change (none on the
  day and night plateaus; at 60× a twilight is about a minute of real time); no per-frame
  `setPaintProperty` and no layer rebuilds. Always day: zero.
- Glow: three more deck.gl layers at night; the train glow shares the trains' per-frame data, the
  station glow the stations' data object (rebuilt only when it changes). Opacity 0 by day: skipped.
- Follow-cam: one pose (≈ 0.05 ms) and one `jumpTo` per frame while following; nothing otherwise.
- Timelapse player: only the edges drawing in this month get new trimmed paths; the rest keep their
  data objects. Recording: once a month, a few ms on a 300-station network; the encoded string is
  cached until the next frame.
- Worker: zero (nothing is sent to it).

## 5. Tests (`tests/cinematic.test.ts`)

Palette: keyframes at their altitudes, DAY equals BASEMAP, monotone night factor, OKLab midpoints,
weather tints, quantisation and the change threshold. Solar: sunrise/sunset within 5 minutes of
published times for both cities at both solstices and an equinox, DST switch dates, London's
winter day shorter and summer day longer than New York's. Chase camera: heading on straight and
curved paths, the lateral offset's sign, the centre shift for height, zoom ⇄ distance, angle
easing across north. Timelapse: recording from a real network (status, flips, routes), the frame
bound and the size cap, encode/decode round trip, the draw schedule. Save: v6 → v7 migration
(idempotent) and a round trip of a game's timelapse.

---

# Implementation notes

Finished from the WIP commits after `pre-cinematic` (the pure modules and the save step were kept
as they were; the runtime wiring was completed, fixed where it was wrong, and the player, the
controller, the settings and the UI were added).

## Where things are

| File | What |
|---|---|
| `src/cinematic/solar.ts`, `palette.ts`, `chase.ts`, `timelapse.ts` | Pure: the sun, the palettes, the chase maths, the timelapse (recording, bounds, encoding, and the replay: `replayFrames`, `stepSeconds`, `replayAt`, `replayStep`, `drawnFraction`) |
| `src/cinematic/daylight.ts` | The runtime light: one `Daylight` per map (`Daylight.for`), so the title screen and the game that starts on its map share what the map shows |
| `src/cinematic/glow.ts` | Additive blending and the glow colours (route glow is a MapLibre line layer in `networkLayers.ts`; trains, stations, elevated lines, venues and the replay have deck.gl glow layers) |
| `src/cinematic/followCam.ts`, `src/trains/trainPose.ts` | The follow-cam; the drawn train pose (pure, no deck.gl, so tests and the camera share it) |
| `src/cinematic/photoMode.ts`, `timelapsePlayer.ts` | Photo mode; the timelapse player (DOM and deck.gl layers) |
| `src/cinematic/index.ts` | `Cinematic`, owned by the App: keys, the follow chip, chrome hiding, the timelapse's open/close, `titleLight` |
| `src/cinematic/prefs.ts` | Per-viewer settings (localStorage `headway-cinematic`): day and night, lit windows, letterbox, caption |
| `src/ui/cinematicText.ts` | Pure copy: the follow chip's status, the photo caption, the timelapse counter |
| App, `toolbar.ts`, `menu.ts`, `boot.ts`, `topbar.ts`, `inspectPanels.ts`, `toolManager.ts`, `mapView.ts`, `styles.css` | Wiring: glow factor to the layer providers, the 250 ms tick, month-close recording, keys, the film and camera buttons, Menu → Light, title Settings → Light, the moon on a clear night, the train panel's Follow, tool suspension, `MapView.setSolo` / `setHidden` |

## Day and night

- **The palettes.** DAY is the basemap exactly as before (every 2D colour and the light). The 3D
  buildings now have one colour (`#3b424c`, between the old block → roof height ramp), so a
  colour change is a uniform and not a relayout of the building tiles; Always day is otherwise the
  old map. NIGHT is blue-black with warm avenues (street lights). The first twilight keyframes
  were warm all over and made every building terracotta in 3D: MapLibre's fill-extrusion shader
  floors each channel at 0.3 · (1 − light colour), so a saturated light tints every dark wall with
  its complement. Every light colour is now near white and the roof colour carries the mood: DAWN
  and DUSK are blue hour (cool violet buildings, the pink or orange only on the horizon and sky, the
  avenues' lights coming on), GOLDEN gets warm lit faces and slightly cool shadows from a light
  low in the sky (polar 78°, from the sun's azimuth). Checked side by side at fixed sun altitudes
  (20°, 9°, 5°, 2°, −1°, −4°, −12°) in 3D over Midtown.
- **Pushes.** `Daylight.tick` runs from App's 250 ms interval with the interpolated game time
  and the weather in force (AlertFeed). It pushes only the colour keys that moved by 2/255 or more
  (`setPaintProperty(..., {validate: false})` on each bound layer), the light when it turned 2° or
  more or its colour or intensity changed, the sky when one of its keys moved, and the windows'
  pattern when it switches. MapLibre's default 300 ms paint transition smooths the 4 Hz steps. On
  the day and night plateaus a tick pushes nothing (the fake-map test checks it, and that the
  game's own `hw-` layers are never recoloured). Measured in the browser: a tick 0.006 ms, a full
  push of every key (worst case, at twilight) 0.26 ms. Always day pushes the Day palette once and
  then nothing.
- **Lit windows** switch the 3D buildings to a 64 × 64 window pattern (hash-seeded: the same in
  every session, about a quarter of the windows lit warm, a few cool) below −4.75° and back above
  −3.25°: a relayout of the building source twice a game day. The pattern also covers roofs, which
  read as rooftop lights from the chase camera.
- **Glow.** A blurred route-glow line layer under the route lines (`hw-route-glow`, its opacity
  the only thing the cycle changes); deck.gl halos with additive blending whose `opacity` prop
  carries the night factor (a uniform: no attribute rebuild), left out below 0.02: trains (route
  colour, white for expresses, so an express sliding past a local still reads), stations (two soft
  discs; the data object is rebuilt only when the stations or the closures change, not with the
  per-snapshot stats; a station closed by police activity stays dark), elevated lines at deck
  height, today's event venues (floodlights), and the timelapse's lines.
- **Weather** tints the palette at night too (rain darkens and wets the streets, snow whitens the
  ground and reflects the city's glow); the weather chip shows a moon on a clear night.
- **The title screen** is blue hour (−6°, windows lit) over the turning skyline; a new game takes
  the light over from the game clock (5 am in January: night; on 8 Jan sunrise 7:20 and sunset
  16:46 in New York, 8:04 and 16:11 in London; civil dusk 17:16 and 16:50).

## Follow-cam

- `Cinematic.trainPose` → `drawnTrainPose` (`trains/trainPose.ts`): the train's middle on its
  route direction at the interpolated position, the path tangent's heading, and the drawn
  sideways offset (interline and four-track pair push from `NetworkLayers.routeOffsets` at this
  zoom's line scale, plus the right-hand running nudge) converted to metres at the screen centre;
  height is the track's in 3D (elevated +8 m), 0 underground and in 2D.
- `FollowCam`: one `jumpTo` per frame (MapView's frame event, under `beginAnimation`); in 3D the
  centre is moved ahead so the point at track height sits at the centre, plus a 40 m look-ahead;
  bearing, pitch and distance ease (the wheel sets the distance, 90–2,500 m); in 2D a centre lock
  that keeps the player's bearing and zoom. Dragging, or rotating or pitching by hand, ends it; so
  do Esc, F and the train panel. V switches between the two while following. Measured in the
  browser: paused, the train is at the canvas centre (2D) and the centre 40 m ahead of it (3D);
  at 1× every frame's centre is exactly 40 m ahead of that frame's pose.
- Trains leave the snapshot while they turn round (the terminal's FIFO ready queue): the camera
  holds where the train stopped, the chip says it waits for the next departure, and after 10 game
  minutes following ends with a toast.
- The chip (bottom centre, above the blueprint bar when that is open) shows the route, the next
  stop, the load, and any incident first (stalled, sick passenger), a dispatcher's hold ("Held at
  96 St for an even gap") or a closed next stop ("running through").
- Hook for Commuter stories: `follow.follow({ kind: 'point', label, pose })` with a `pose(now)`
  that returns a `FollowPose` (or null while lost); `follow.events.on('change')`.

## Photo mode

`hw-photo` on the root hides every direct `.hw-panel` child, the toasts, tooltips and MapLibre's
navigation and scale controls; panels stay in the DOM with their state (the side panel is still
open after P). The letterbox bars and the caption sit inside the map container under MapLibre's
control layer, so the attribution stays on top of the bar. The tools are suspended (the map only
pans, zooms and rotates; no tool sees a click), the selection's highlight, the tool previews and
the station flows are hidden. Keys: P / Esc leave, L, C, F; Space, 1–4 and V pass through; every
other key (and any Ctrl/Alt combination) is swallowed. The caption is "Tue 8 Jan 2030 · 18:42 ·
New York" with the weather when it isn't clear; L and C are remembered.

## Timelapse

- **Recording.** App records a frame at every month close (`onDayEnd`, before the midnight
  autosave), the same moment as the month report; the scripts record one every day end with
  `timelapse=1`. `Game.timelapseData()` encodes once per recorded frame (cached for every autosave
  in between). Sizes: the New York browser run (two month closes) 720 characters; `balance core
  days=25 timelapse=1` (25 frames) 3,237 (New York) and 4,093 (London) characters; the 10-year test
  (120 monthly frames, 240 km of track) stays under the 600,000-character cap. Save v7; a v6 save
  migrates to an empty timelapse.
- **The player.** It clones the timelapse and snapshots the network as it is now into the clone
  (the save's timelapse is never touched), then walks an empty city → each recorded month → now.
  A step lasts its length in months × 1.1 s at 1× (⅔ to 3 months' worth; speeds 1×, 2×, 4×); new
  edges draw out from where they meet the old network during the first 80% of the step, route
  colours with them, new stations pop up as the line reaches them, then the month holds. Only the
  edges drawing in this step get new trimmed paths each frame; the rest of the step's data is
  built once when the step starts. While it is open the game is paused (its speed comes back on
  close), the live network's MapLibre layers are hidden and `MapView.setSolo('timelapse')` draws
  only the player's deck.gl layers; the camera fits the network and goes back on close; follow and
  photo mode end. Esc, Space, ← → (a month), the scrubber and the speed buttons.

## Identity and performance

- **Identity.** Checked against a worktree of `pre-cinematic` (node_modules linked;
  `public/data` is committed): `headless-sim days=3` with chaos Off and Normal, `balance
  scenario=core days=25` (across the 31 January close) in New York and London, and `balance
  scenario=express days=4` in both cities. All twelve `dump=` files (six as they are, six with
  `timelapse=1`, a frame recorded at every day end through `Game.recordTimelapse`) are
  byte-identical to the tag's. The worker bundle contains no Cinematic code (+65 bytes: the
  cities' `timeZone` fields).
- **`npm run perf`**, 3 interleaved runs (London 2) against the tag: identical boardings and
  waiting; peak hour 161–197 → 128–159 ms (London 146–155 → 141–176), month closes 181–283 →
  163–338 ms (London 108–196 → 101–179): noise; the worker code is unchanged.
- **Main thread** (Chromium with SwiftShader, so relative only): tick 0.006–0.017 ms; full palette
  push 0.2–0.26 ms; train pose 0.001–0.005 ms; layer collection 0.30–0.38 ms a frame with the glow
  against 0.30–0.31 ms without. Frames at 960 × 600: 2D night with glow 183–200 ms against
  183 ms in Always day; 3D following 1,083 ms against 1,117 ms not following; 3D night with lit
  windows 1,083–1,133 ms against 650–700 ms in Always day and 667–683 ms in the cycle with windows
  off, so the windows' pattern is the only measurable cost, and it is fragment work (texture
  sampling) on an emulated GPU. They stay on by default; Menu → Light → Dark turns them off.

## Browser checks (both cities)

Chromium (Playwright, SwiftShader) on the dev server, screenshots looked at:
- the title screens (blue hour, windows lit); 2D at 6:30, 7:10, 7:40, 12:00, 16:30, 17:00, 17:30
  and 21:00 on 8 Jan in New York; 3D over Midtown and the City at golden hour, sunset, blue hour,
  night and dawn in both cities (and fixed sun altitudes side by side while tuning); rain at 8 am;
- the follow-cam in 2D and 3D in both cities: paused, the train at the canvas centre (2D) and the
  centre exactly 40 m ahead (3D); on elevated track the centre 52.4 m ahead against the expected
  40 + 8 · tan(57.6°) = 52.6 m; at 1× every frame 40 m ahead; an express on the New York
  four-track trunk at night (white halo, light casing, pair offsets); the wheel, Esc, F, dragging
  and V; a train turning round at its terminal (held, then ended after 10 game minutes with the
  toast);
- photo mode in both cities: chrome hidden, the side panel still open after leaving, T swallowed,
  letterbox and caption toggles, the attribution visible over the bar; at night on a chase;
- the timelapse in both cities after two real month closes (frames on days 18 and 38, then the
  network as it is with an elevated spur in New York): lines drawing out from the junction, the
  counter in miles and kilometres, Esc restoring speed, layers and camera; the save holds v7 with
  both frames (720 and 304 characters);
- the growth overlay at night after the London month closes, in 2D and 3D; the moon in the
  weather chip; Menu → Light and title Settings → Light (Always day at 5 am is the old map; back
  to the cycle at once). No page errors and no simulation errors in any run.

## Hooks for Commuter stories

- `app.cinematic.follow.follow({ kind: 'point', label, pose: (now) => FollowPose | null })`
  follows a moving point (a rider walking to a platform, then `{ kind: 'train', id }` once aboard);
  `follow.events.on('change', ({ target, reason }))` reports ends (`user`, `drag`, `lost`,
  `replaced`, `timelapse`). A point returning null is waited for like a train in layover.
- `app.cinematic.trainPose(id, now)` is a train's drawn pose (for a rider's dot on the train).
- `app.cinematic.chromeHidden` and `events.on('chrome')`: photo mode and the timelapse hide the
  chrome by a class on the root and suspend the tools; panels are kept, so a story panel survives.
  `MapView.setHidden([...providers])` and `setSolo(provider)` are there for a feature's own layers.
- The follow chip takes a point target's `label` as its title.
