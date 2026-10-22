# v2 design: Commuter stories

Status: design (this section), then implementation notes at the end. Baseline: git tag
`pre-cinematic` (Cinematic, the feature before this one, is in the working tree).

Make the commuters feel real: ride along with one of them, see the crowds on the platforms and in
the trains, and meet a commuter of the day. Nothing here may change the simulation: the worker
records one agent's trip as it happens and answers questions about it; the sim never reads
anything this feature writes.

## 1. Goals and non-goals

Goals:
- **Ride along.** Pick a random transit commuter (top bar button or **J**), someone waiting at the
  selected station (station panel), or tomorrow's ride of the commuter of the day. The worker
  returns the agent's identity and itinerary: home and work tract, earnings band, departure time,
  today's mode and why (the generalised cost of each mode as mode choice saw it, and the group's
  shares), the planned legs (route, board and alight stations) and their scheduled time, yesterday's
  observed time, and then every step as it happens: walking to the station, waiting on the platform,
  riding route X in train T (with the fare paid at the first boarding), held at a timepoint, a
  stalled train, a closed station, a transfer (across the platform at a cross-platform pair, or
  stepping across to wait for an express), left behind by a full train, arrived, or gave up and
  took a cab. A story card shows a generated first name (seeded, diverse, original), the
  neighbourhood names (`app.tractName`), the plan and a live timeline; the camera follows them
  (Cinematic's follow-cam: their train when riding, a marker moving along the straight walk
  otherwise).
- **Crowd dots.** From zoom 14.5, waiting passengers are drawn on the platforms as a dot cloud
  (deck.gl ScatterplotLayer, one dot per agent from the snapshot's waiting counts, deterministic
  jitter, capped), pale until the platform is crowded, then amber and red; each platform of a
  cross-platform pair has its own cloud on its side of the capsule. Trains get a fill bar (riders
  over crush capacity), coloured by load against comfortable capacity.
- **Commuter of the day.** At midnight the worker reports a few real agents of the day: the biggest
  time saved against the faster of walking and driving, the longest wait on a platform, an
  event-goer's journey (the longest trip to an event), a cross-platform changer. One is toasted
  ("Commuter of the day"); a click opens their story and rides along with them the next day.

Non-goals: tracing more than one agent at a time, saving stories, per-agent detail for everyone,
surnames or photos.

## 2. Controls

| Key / control | Action |
|---|---|
| **J** or the rider button (top bar) | Ride along with a random transit commuter (again: another one) |
| Station panel → *Ride along* | Someone waiting on one of its platforms (else someone who boards there today) |
| Commuter of the day toast | Their story; rides along with them tomorrow |
| Story card: Follow / Another rider / Skip to departure / × | Re-follow with the camera, pick again, jump to their next departure, end the story |
| Esc | Stops the camera (as for any follow); the card stays until ×. |

The story card sits left of the screen beside the tool bar; photo mode and the timelapse hide it
(the panel is kept). Ending the story stops the follow-cam if it was following the rider.

## 3. Data flow

- **Worker** (`src/sim/stories.ts`): `StoryTracer`, owned by the Engine. `Commuters.traceA` is the
  traced agent's index (−1: nobody) and `Commuters.tracer` its recorder. Every place an agent's
  trip changes (start, platform, closed gate, board, sibling board, alight, transfer, switch and
  step across, carried past, left behind, give-up, cab, arrival, the 3 am reset) has one guard,
  `if (a === this.traceA)`, before a call that only reads sim state and appends a small event. Per
  step, only while someone rides, the tracer polls their train (held at a timepoint, stalled,
  sick-passenger hold). The 3 am mode choice refreshes the plan (a new day); a month-close
  regeneration re-finds the agent by identity (home, work, band, index in its group) or ends the
  story ("moved away"); event-goers end at 3 am. Nothing calls the RNG, schedules an event or writes
  a field the sim reads.
- **Picks** (query `storyPick`): random = a seeded hash of (salt, time) over agents mid-trip by
  transit (else transit commuters still to travel); station = live waiters on the station's
  platforms (else commuters whose path boards there); who = an identity. Reply: the trace or null.
  Query `storyStop` ends it.
- **Live**: while tracing, each snapshot carries `story` (trace id, version, the agent's state) and
  the whole trace only when its version changed (a few hundred bytes a few times a trip). Nobody
  traced: no field.
- **Commuter of the day** (`storiesDaily` message; on in the browser, off in scripts unless
  `trace=1`): O(1) candidate checks at boarding and trip completion; at midnight, before the
  report and any regeneration, the engine posts `dayStories` (separate from the `DayReport`, which is
  unchanged).
- **Main thread** (`src/stories/`): `names.ts` (pure, the name generator), `storyText.ts` (pure,
  every line of copy), `ridePose.ts` (pure, where the rider is at a game time), `crowdDots.ts`
  (pure, the jitter, counts and colours, binary attributes), and `index.ts` (`Stories`: the card,
  the follow binding, the marker and crowd layers, the toast). The train fill bars are in
  `trains/trainLayer.ts`.

## 4. Performance budget

- Worker, nobody traced and commuter of the day off: one integer compare per agent event (no
  measurable change in `npm run perf`). Tracing: one call per event of one agent, one train poll per
  step while riding. Commuter of the day: a compare per boarding and per completed trip.
- Main thread: crowd dots rebuilt only when a snapshot's waiting counts, the zoom bucket or the
  visible stations change (binary attributes, ≤ 160 dots a platform, only stations in view, only
  from zoom 14.5); fill bars share the trains' per-frame data (one extra path per train at high
  zoom); the rider marker is one point a frame while a story is open; the card re-renders on a trace
  version change or once a second (clock text).

## 5. Tests

`tests/stories.test.ts` (unit): the name generator (deterministic, diverse in both cities, no name
repeated in a run of 50 seeds more than a few times, no surnames), the crowd-dot jitter
(deterministic, inside the platform box, prefix-stable as the count grows, capped), the rider's
position along a walk, and the copy in both cities (currency, units, names of tracts).
`tests/stories.headless.test.ts`: on the headless test network, a traced agent's legs match its
group's path, timestamps are monotone, the story ends in a valid state; traced against untraced
runs give identical DayReports and share hashes; a trace across a month close (re-found or ended);
the commuter of the day is a real agent of the day with consistent numbers; London too.
