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
| Settings (title) / Menu → Day and night | Cycle / Always day; lit windows |

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
