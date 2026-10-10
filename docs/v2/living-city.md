# Living City: transit-oriented growth and value capture (v2)

Status: design, ready to implement · Target: one focused session, about 1,300 lines including tests
Depends on: v1 as committed (`a27dbfa`). Touches the sim worker, finance, save format (v2 → v3) and UI.

## 0. Summary

In v1 the city is fixed: 2,324 tracts with the 2023 LODES residents and jobs, forever. In v2 the
city responds to the network. The worker closes each month at the midnight after the month's last
weekday. At that point it:

1. Measures each tract's **commute benefit**: the generalised minutes per commute that the player's
   network saves the people who live in the tract (home side) and the people who work in it
   (job side), compared with no subway. This is the logit *logsum* (consumer surplus) of the mode
   choice the sim already runs. It uses yesterday's *observed* door-to-door times, so crowding,
   left-behinds, lateness and the fare all reduce it.
2. **Grows residents and jobs** toward tracts with a high benefit. City-wide natural growth is
   redistributed by attractiveness. Part of each tract's boom relocates people from elsewhere in the
   city (small declines in poorly served areas) and the rest are newcomers. Growth has per-month
   limits, long-run bounds (a tract can at most double and loses at most 30%) and a city-wide
   ceiling.
3. **Rebalances the OD matrix** consistently: `OD'_hw = OD_hw · fHome[h] · fWork[w]`. The factors
   come from a Furness (IPF) fit, so tract row and column sums match the grown targets. It then
   **regenerates the agents** from `OD'` with common random numbers. Unchanged groups keep their
   exact agents. Every `(home, work, band)` group carries its mode shares, observations and transit
   paths over, so ridership changes smoothly and does not jump.
4. **Captures land value**. Tracts within ½ mile of a served station form a Transit Improvement
   District (tax-increment financing). The district pays the authority 25% of the extra property
   tax from rising land values: new development plus an accessibility premium that capitalises over
   about 10 months. The payment arrives as monthly revenue in the ledger.

What the player sees: a **City growth** overlay (G), with 3D "new development" columns when
tilted, a growth section in the tract panel with a history chart, a "City" section and boomtowns in
the month report, a value-capture line in the finances, "Astoria is booming" toasts, two new goals
and a **City growth: Off / Steady / Boom** switch in the menu. On the default *Steady* pace, the
README core network moves from −$0.28M/day after interest to about +$0.25M/day by the end of game
year 1. The sprawl network still loses money.

---

## 1. Goals and non-goals

### Goals
- The network visibly reshapes the city within one game year. Well-served neighbourhoods grow
  about 4–6% a year on Steady and 12–18% on Boom. Poorly served areas stagnate or decline slightly.
- **Good networks get a path to profit** through value capture and induced ridership. Bad ones
  (sprawl, empty trains, crowded lines) do not.
- New trade-offs come from the existing mechanics. The benefit uses observed times, crowding and
  the fare, so a cheap fare grows the city faster but earns less per ride. Overcrowding chokes
  growth.
- The OD is consistent. Tract row and column sums match targets within 0.5%. The city total is the
  same for residents and jobs. The agent count follows from `OD'` with no ad-hoc injection.
- Deterministic and save-safe. The state is a few `Float32Array`s per tract. A reload regenerates
  bit-identical agents and groups, and v2 saves migrate.
- No per-step cost. All the work happens once per game month and takes about 0.3 s in the worker.

### Non-goals (v2)
- No zoning tool, no land-use types and no per-band changes in who lives where (all three earnings
  bands of a tract scale together).
- Construction costs keep using 2030 density (`TRACK.densityK` in `construction/validate.ts`).
  Already-built assets are never re-priced.
- No neighbourhood dataset in the data pipeline. Names come from map labels or stations (§2.4).
- No forecast of value capture for blueprint stations (v3 idea).
- No weekend modelling. Growth is per calendar month, applied at the month-end midnight.

---

## 2. Player-facing behaviour and UI

### 2.1 Story of a month
- During the month nothing changes. Commuters ride and shares adapt daily, as in v1.
- At midnight after the last weekday of the month (the same moment `Finance.settleDay` closes the
  month), the busy pill shows **"The city is growing"** for about 0.3 s. Value capture for the
  month is booked in that day's ledger, and the month report opens with a new **City** section.
- Up to three toasts appear, for example:
  - green: **"Long Island City is booming"**: "+0.6% this month · +41 residents, +12 jobs ·
    +4.8% since 2030"
  - green: **"Astoria has grown 10% since 2030"** (milestones at +10/25/50/100%)
  - amber: **"Mott Haven is losing people"**: "−5% since 2030 · no good transit"
    (milestones at −5/−10/−20%)
- At 3 am the new population plans its first day of the new month.

### 2.2 Controls, where they live, shortcuts and tooltips

| Control | Location | Shortcut | Tooltip / text |
|---|---|---|---|
| **City growth** overlay | Toolbar → Overlays (layers icon) → "City growth since 2030" | **G** toggles it (G again goes back to none) | Overlay button body becomes "Residents, jobs, city growth (G), unserved demand, crowding, flows". Legend: title "Growth since Jan 2030", ends "−20%" … "+20%+", note "Residents + jobs. Rings: value-capture district (½ mi of a served station). Tilt (V) to see new development." |
| Residents / Jobs overlays | same menu | — | Now drawn from *current* residents and jobs (2030 × multipliers) |
| Tract hover (growth overlay on) | Map, Inspect tool | — | `<b>Astoria</b> · +6.2% since 2030 · click for details` |
| **Tract panel → Growth** | Click a neighbourhood (Inspect) | — | Stat cards: Residents (now, Δ%), Jobs (now, Δ%), Transit benefit (min), Land value (+x%). Index chart (2030 = 100) for residents and jobs. Sentence: "Growing 0.4% a month. Residents here save 23 min per commute with your network (city average 9 min)." Value capture line: "In the value-capture district · $41k/month to the authority" or "Outside the district: no served station within ½ mi". |
| **Station panel → Value capture nearby** | Station panel, *Station* key-value block | — | `$0.4M/month · 6 tracts` with title tooltip "25% of the extra property tax from tracts nearest this station" |
| **Finances → Value capture** | Finance panel (chart button / cash) | — | "Yesterday" row "Value capture" (non-zero on month-end days). New section "Value capture (Transit Improvement District)": "N tracts within ½ mi of a served station. 25% of the extra property tax from rising land values is paid to the authority at each month end. Last month: $X · projected this month: $Y". The chart's revenue line becomes "Revenue (fares + value capture)". |
| **Month report → City** | Month-end modal (non-sandbox; sandbox gets a toast) | Esc closes | Rows: Value capture, Residents (+N, +x%), Jobs (+N), Commuters now. "Boomtowns" list of 5 (name, +x%/mo, +y% since 2030). Button **Show growth map** sets the overlay. |
| **City growth pace** | Menu (☰) → new section "City growth" with segmented Off / Steady / Boom | — | Off: "Frozen city, no value capture (v1 rules)". Steady: "Realistic: well-served areas grow about 5% a year". Boom: "3× faster growth and land-value capture: easier money". Takes effect at the next month end. A toast confirms. |
| **Goals** | Goals panel (flag) | — | "Boomtown: grow a neighbourhood 25% since 2030" · "Land value pays: collect $10M of value capture in one month" |

The first month report after a v2 save is loaded shows a one-time hint: "Living City: your city
now grows around good transit. Menu → City growth."

### 2.3 Visual design
- Growth overlay colour comes from a new diverging ramp `RAMP_DIVERGE`. Decline runs from magenta
  to dusk violet, a transparent neutral sits in the middle, and growth runs from deep teal to ice.
  This keeps clear of the green/amber/red signal hues, following the rule in `colorRamp.ts`. Tracts
  with |Δ| < 0.2% are not drawn.
- District rings: a stroked `ScatterplotLayer` (no fill) in `[231,235,239,90]`, 1 px.
- 3D (V): a `ColumnLayer` of hexagonal columns at growing tracts. The height is
  `added people × MAP.growthColumnMetresPerPerson` (0.08 m, so +2,500 people is a 200 m tower).
  The radius is `min(250, 0.6 × tract radius)` and the colour is the top of the ramp. Columns are
  depth-tested like `elevated3d.ts`.

### 2.4 Names for tracts (toasts, reports, hover)
There is no neighbourhood dataset, so `tractName(i)` tries three sources in order:
1. **Map place labels seen this session.** `PlaceNames` collects OpenMapTiles `place` features
   (`neighbourhood | quarter | suburb`) on every map `idle`. It uses the same query as the fallback
   in `naming.ts:96–111`. The nearest label within 1.2 km on land wins.
2. The **nearest served station** within 1.2 km, as "around 36 St".
3. The existing panel format: "Queens tract 57" (`inspectPanels.ts:67`).

---

## 3. Model and algorithms

All of the model runs in the worker (`src/sim/growth.ts`, orchestrated by `Engine`). It is pure
arithmetic with no RNG. Units are people, minutes of generalised cost and dollars. Tract base values
`R0[i] = tracts[i].residents` and `J0[i] = tracts[i].jobs` equal the OD row and column sums exactly
(checked on the committed data: 2,853,194 each, zero mismatch). 20 tracts have `J0 = 0`.

### 3.1 State (per tract, T = 2,324)

| Field | Type | Meaning |
|---|---|---|
| `mRes`, `mJobs` | Float32Array(T) | Target residents and jobs as multiples of 2030 |
| `fHome`, `fWork` | Float32Array(T) | Furness balancing factors: `OD'_hw = OD_hw·fHome[h]·fWork[w]` |
| `premium` | Float32Array(T) | Capitalised land-value premium (0..`premiumMax`) |
| `appliedThroughDay` | number | Last month-close day applied (−1 = none) |
| `months` | number | Month closes applied |
| `sbar` | [number, number] | Last month's mean attractiveness (residents, jobs), used for projected rates |
| `history` | `{day, q: Uint16Array(2T)}[]` | Snapshots, `q = round(m × 10000)`, thinned to ≤ 60 |
| `city` | `{day, residents, jobs, valueCapture}[]` | One row per month close (≤ 600) |

Initial state is all ones and zero premium, so `OD' = OD` and the agents are exactly v1's groups.

### 3.2 Commute benefit (accessibility)
The sim already computes, per group `g = (home, work, band)`, the generalised cost of walk, drive
and transit (`modeChoice.ts:59 generalisedCosts`). Transit uses observed time, transfers, crowding
minutes and the fare in minutes for the band. The **logsum** `LS = −(1/θ)·ln Σ_m exp(−θ·C_m)` is the
expected best cost. With θ = `COMMUTERS.logitScale`, the benefit of transit has a closed form:

```
LS_no   = logsum([C_walk, C_drive])                 // precomputed per group at generation
benefit = LS_no − LS_with = (1/θ)·ln(1 + exp(θ·(LS_no − C_transit)))     // softplus, ≥ 0
```

This needs one `exp` and one `log1p` per group, about 15–25 ms for 252k groups. It is 0 when the
group has no AM or PM path. Per tract:

```
benefitHome[h] = Σ_{g: home=h} n_g·benefit_g / Σ_{g: home=h} n_g     (minutes per commute)
benefitWork[w] = Σ_{g: work=w} n_g·benefit_g / Σ_{g: work=w} n_g
attractiveness s = b / (b + GROWTH.halfBenefit)                       // 0..1, half at 20 min
```

Why this measure: it is cheap and uses only data the worker already has. It is the textbook way
accessibility capitalises into land values. It rewards reliable, uncrowded, affordable service,
because observed times include waits, left-behinds and crowding. It also covers coverage
automatically: a tract whose residents mostly work where the network does not go gets a low mean.

Measured on the README core network (8 days, scale 10): 704 tracts have a home benefit. Among them
p10 = 16.9 min, p50 = 28.0, p90 = 43.9, max 54.8. Job-side benefit: p50 = 2.3, p90 = 26.4 (Midtown).
City mean is 12.2 min.

### 3.3 Monthly growth step

```ts
// k = GROWTH.paceMultiplier[pace] (steady 1, boom 3). 'off' never calls step.
const gBase = (1 + GROWTH.cityGrowthPerYear) ** (1 / 12) - 1;

function proposal(cur: Float64Array, m: Float32Array, base: Float64Array, s: Float64Array, P: Side, k: number) {
  let tot = 0, sw = 0;
  for (i) { tot += cur[i]; sw += cur[i] * s[i]; }
  const sbar = tot > 0 ? sw / tot : 0;
  for (i) {
    if (base[i] === 0) { next[i] = 0; continue; }          // e.g. the 20 zero-job tracts
    let r = k * (gBase + P.boostPerMonth * (s[i] - P.relocationShare * sbar));
    // Smooth approach to the long-run bounds (logistic-like).
    r *= r > 0 ? clamp01((P.maxMultiple - m[i]) / (P.maxMultiple - 1))
               : clamp01((m[i] - P.minMultiple) / (1 - P.minMultiple));
    r = clamp(r, -k * P.maxDeclinePerMonth, k * P.maxGrowthPerMonth);
    next[i] = cur[i] * (1 + r);
  }
  return { next, sbar };
}

step(day, benefitHome, benefitWork, served):
  sR = attractiveness(benefitHome); sJ = attractiveness(benefitWork)
  Rc = R0 ⊙ mRes;  Jc = J0 ⊙ mJobs
  {next: Rn, sbar: sbarR} = proposal(Rc, mRes, R0, sR, GROWTH.residents, k)
  {next: Jn, sbar: sbarJ} = proposal(Jc, mJobs, J0, sJ, GROWTH.jobs, k)
  total = min(GROWTH.cityMaxMultiple · T0, (ΣRn + ΣJn) / 2)    // residents ≡ jobs ≡ commuters
  fitTotal(Rn, R0, total, GROWTH.residents);  fitTotal(Jn, J0, total, GROWTH.jobs)
  mRes[i] = fround(Rn[i] / R0[i]);  mJobs[i] = fround(Jn[i] / J0[i])  (J0 = 0 → keep 1)
  furness(R0 ⊙ mRes, J0 ⊙ mJobs, GROWTH.balanceIterations)       // §3.4
  updatePremium(sR, sJ, k)                                         // §3.5
  vc = valueCapture(served)                                        // §3.5
  report = buildReport(Rc, Jc, Rn, Jn, vc)                          // §3.6
  history.push(snapshot()); thin(); city.push(...); sbar = [sbarR, sbarJ]
  appliedThroughDay = day; months++
```

`fitTotal(next, base, total, P)` uses water-filling. In each of 3 passes, it scales every tract
that is not at a bound by `(total − Σbound)/Σfree`, clamps to `[P.minMultiple, P.maxMultiple]·base`
and marks clamped tracts as bound. The result: Σ equals `total` within 1e-9 relative, and no tract
exceeds its bound.

Properties (all tested):
- `boostPerMonth·s_i` is extra growth for well-served tracts. `relocationShare·boostPerMonth·s̄` is
  a uniform drain that funds 60% (residents) or 70% (jobs) of the boom by relocation. The rest is
  in-migration: a better network makes the city as a whole grow faster.
- On the core network, unserved tracts end up about −0.4%/yr against baseline (min multiplier 0.996
  after a year). Top tracts reach +4.9%/yr (Steady).
- A tract's monthly growth rate is non-decreasing in its benefit, all else equal (monotone).
- The bounds are hard: `minMultiple ≤ m ≤ maxMultiple`, and the city stays ≤ `cityMaxMultiple`.

### 3.4 OD update (Furness) and agent regeneration

**Furness / IPF.** This is the standard transport-planning balancing. `tot[p] = SE01+SE02+SE03` is
precomputed per OD pair as a Float32Array over 975,954 pairs (3.9 MB, built once in the `Growth`
constructor).

```ts
furness(targetR: Float64Array, targetJ: Float64Array, K: number) {   // warm start from last month
  for (let it = 0; it < K; it++) {
    row.fill(0); for (p) row[home[p]] += tot[p] * fWork[work[p]];
    for (h) if (row[h] > 0) fHome[h] = Math.fround(targetR[h] / row[h]);
    col.fill(0); for (p) col[work[p]] += tot[p] * fHome[home[p]];
    for (w) if (col[w] > 0) fWork[w] = Math.fround(targetJ[w] / col[w]);
  }
}
```

Two warm-started passes cost about 55 ms. In the prototype, three cold passes after 60 months of
drift still left a 0.36% max row error, and monthly warm starts stay below 0.05%. Columns are exact
after each pass. Rows have that small residual. The UI shows the *targets* `R0·mRes`. The agents
follow `OD'`.

**Group rounding with common random numbers.** v1 rounds each non-zero OD cell to agents with one
draw from `Rng(seed·7919+13)` per cell, in file order (`commuters.ts:148–163`). v2 keeps exactly
that stream:

```ts
exact = (c * fHome[h] * fWork[w]) / scale;  n = floor(exact);  if (gen.next() < exact - n) n++;
```

Growth never creates non-zero cells, so the draw sequence stays the same. Each cell's agent count is
therefore **monotone in its factor**: if f' ≥ f then n' ≥ n. Only cells whose fractional threshold
is crossed change. A uniform +1% changes G from 252,543 to 254,589 and A from 285,288 to 287,987
(measured). At factors of 1 the groups are bit-identical to v1, so v2 save keys still match.

**Per-agent seeding.** v1 draws agent positions and times from the same stream after the rounding
(`commuters.ts:215–229`), so adding one group shifts every later agent. v2 seeds each agent from its
identity:

```ts
rng.reseed(hash32x4(seed, h * 3 + b, w, k));   // k-th agent of group (h, w, b)
[hx, hy] = pointInDisc(rng, H.x, H.y, H.radius);  [wx, wy] = pointInDisc(rng, W.x, W.y, W.radius);
depart = clamp(departMean + rng.normal()·departSd);  ret = workDuration + (rng.next()·2 − 1)·returnJitter;
```

Agent k of a group is now a pure function of `(seed, h, w, b, k)`. Regenerating from scratch and
regenerating incrementally give identical arrays, and an unchanged group keeps its agents exactly.
This is a one-time statistical change from v1 placement (§9.4). Measured cost: 109 ms for 285k
agents from scratch. The incremental path copies matched agents and costs about 10 ms.

**Carry-over by `(home, work, band)` (merge-join).** Old and new groups are both sorted by
`key = (home·T + work)·3 + band`, because the OD file is sorted by home then work (verified:
`build-data.ts:488`, zero violations in `od.bin`) and the band loop is innermost.

```ts
function matchGroups(oldKeys: (g) => number, Go, newKeys, Gn): Int32Array {
  const map = new Int32Array(Gn); let i = 0;
  for (let g = 0; g < Gn; g++) {
    const k = newKeys(g);
    while (i < Go && oldKeys(i) < k) i++;
    map[g] = i < Go && oldKeys(i) === k ? i : -1;
  }
  return map;   // if the keys are ever not sorted (custom data), fall back to a Map<key, g>
}
// Pair match for unmatched groups: scan old i−2..i+2 for the same floor(key/3).
```

Per new group g:
- **Exact match o.** Copy `shares[3]`, `obsTime`, `obsCrowd`, `pathAM`, `pathPM`, `gGeom`,
  `gWalk`, `gDrive`, `gDriveHome`, `gLsBase` and `gBaseT`.
- **Pair match only** (same home and work, another band). Copy the geometry and paths, which do not
  depend on band. Compute the band-dependent `gLsBase`/`gBaseT`. Mark the group *fresh*.
- **New pair.** Compute the geometry. Mark it *fresh* and *needPath*.
- Groups that vanish are dropped, and their agents disappear with them.

Then: `recomputePaths(needPath)` runs per-origin Dijkstra **only for origins in `needPath`** (§4.1).
Fresh groups start at their **logit target**, `logitShares(generalisedCosts(geom, band,
transitInput(g)))`, with scheduled transit time. The reasoning is that people who move next to a
station know about it. `obsTime` stays 0, so the schedule is used until they ride.

**When.** Regeneration runs inside `Engine.closeDay` at the month-end **midnight**, right after
`dayReport()` and `finishObservations()`, and before `dayEnd` is posted. Three reasons:
1. **Save consistency.** The midnight autosave queries `simState` after this point, so the saved
   growth factors and the saved `ModeState.key` always describe the same groups.
2. **Nobody is travelling.** The latest return trips end around 22:00 (departures ≤ 11:00 +
   8.5 h ± 30 min + trip). Any stragglers are finished and counted as stuck, as the 3 am reset does
   (`commuters.ts:486–504`).
3. The 3 am `dailyModeChoice` of the new month's first day plans trips for the new population. In
   effect the new agents start at the first 3 am of the month.

`regenerate` clears the event heap, the platform queues and every train's `buckets`/`load` through
a shared `resetTrips()`, because agent indices change. If it is forced mid-day (tests or scripts), it
ends with `startDay(t)` so the rest of the day is scheduled.

### 3.5 Value capture (Transit Improvement District, TIF)
This is a real policy: the district's tax increment over a frozen base is pledged to transit.
Examples are Hudson Yards' PILOT/TIF financing of the 7 line extension and London's Crossrail
business-rate supplement.

```ts
// premium (all tracts; capitalisation happens whether or not the authority captures it)
lag = 1 - (1 - VALUE_CAPTURE.premiumLagPerMonth) ** k;
for (i) {
  vr = valuePerResident * R0[i] * mRes[i];  vj = valuePerJob * J0[i] * mJobs[i];
  s  = (vr * sR[i] + vj * sJ[i]) / (vr + vj || 1);           // value-weighted attractiveness
  premium[i] = fround(premium[i] + lag * (premiumMax * s - premium[i]));
}

valueCapture(served: StationPt[]):     // pure: also used live for panels ("projected")
  for (i) {
    nearest served station j; if dist(i, j) > districtRadius + districtTractShare · radius_i → skip
    V0  = valuePerResident·R0[i] + valuePerJob·J0[i]                       // frozen 2030 base
    V   = (valuePerResident·R0[i]·mRes[i] + valuePerJob·J0[i]·mJobs[i]) · (1 + premium[i])
    inc = max(0, V − V0)                                                    // increments floor at 0
    levy = captureShare · taxRate / 12 · inc
    total += levy; increment += inc; byStation[j.id] += levy; district[i] = 1
  }
```

"Served" means a station in `CompiledNetwork.stations` that appears in some compiled route's
`stopStation`. A built but unserved station creates no district, so cheap stub stations cannot farm
baseline growth. That would not pay anyway: about $0.2M/yr of levy against $2.1M/yr of staffing.
If service is cut, `premium` decays and the levy falls. Value capture is booked as its own ledger
line, not as fares.

### 3.6 Month-close sequence (worker)

```
Engine.step → midnight of day d where isNewMonth(d+1) (or tuning monthEvery)
  closeDay(d):
    base = commuters.dayReport(d)            // stats, finishObservations() → fresh obsTime
    growth = monthClose(d):
      if pace = off or d ≤ growth.appliedThroughDay → null
      cb.busy('The city is growing')
      b = commuters.commuteBenefit()         // §3.2   ~20 ms
      rep = growth.step(d, b.home, b.work, servedStations(net))   // §3.3–3.5  ~60 ms
      commuters.regenerate(growth.factors(), time)                // §3.4   ~150–300 ms
      rep.agents = commuters.A; rep.commuters = A·scale
      cb.busy(null)
    report = { ...base, carKm, …, growth }   → cb.dayEnd(report) → main: settleDay(valueCapture)
  03:00 dailyModeChoice (new groups)
```

`GrowthMonth` (the report) contains the month label, city residents and jobs after growth and the
change, agents, value capture, district tract count, assessed increment, `stationLevy` by station
id, the top 5 **boomtowns** (tracts with ≥ 1,000 people in 2030, ranked by month growth rate of
residents + jobs), up to 3 **milestones** (crossings of +10/25/50/100% or −5/−10/−20% since 2030)
and `maxTractGrowth` (for the goal).

---

## 4. Changes to existing files

Line numbers refer to commit `a27dbfa`.

### 4.1 `src/sim/commuters.ts` (largest change, about +230/−60)
- **Fields.** `A`, `G` and `key` (lines 56–57, 115) lose `readonly` and become plain public fields.
  Add `private seed: number`, `gLsBase: Float32Array` (no-transit logsum, minutes) and
  `gBaseT: Float32Array` (expected no-subway one-way minutes, for `baseline`).
- **Constructor** (138–258). Signature
  `opts: { agentScale; seed; fare; modeState?; factors?: OdFactors | null }`. The body becomes:
  1. `const tbl = buildGroups(world.od, scale, seed, factors)`, replacing 147–163.
  2. `this.adoptGroups(tbl, null)`, replacing 164–194 and 230–249. It sets the group arrays,
     `gGeom`, `gWalk`, `gDrive`, `gDriveHome`, no-subway shares, `gLsBase` (`logsum(c)` of the
     `c` already computed at line 240) and `gBaseT`.
  3. `this.buildAgents(null)`, replacing 195–229, with per-agent seeding (§3.4).
  4. `this.key = makeKey(world, scale, seed, A, G, factors?.tag)`. With no tag the format is
     unchanged: `${source}|${tracts}|${pairs}|${scale}|${seed}|${A}|${G}`. With growth it appends
     `|g${months}:${fnv32hex}`.
  5. Restore `modeState` when the key matches (250–254, unchanged).
- **New `export function buildGroups(od, scale, seed, factors): GroupTable`** (module-level, pure).
  One pass into growable typed arrays, CRN rounding (§3.4) and a sortedness check. `GroupTable =
  { home: Int32Array; work: Int32Array; band: Uint8Array; count: Int32Array; start: Int32Array;
  G: number; A: number; sorted: boolean }`.
- **New `private resetTrips(): number`**, extracted from `drawModesAndSchedule` 486–504 (agent
  states, train buckets and loads, queues, heap). It returns the stuck count, and
  `drawModesAndSchedule` calls it.
- **New `regenerate(factors: OdFactors, t: number): { added: number; removed: number; newPairs:
  number }`.** Implements §3.4: `resetTrips`, `buildGroups`, `matchGroups`, copy or compute per
  group, `buildAgents(old)` (copy matched agents with `TypedArray.set` on slices, generate the
  rest), `recomputePaths(needPath)`, fresh shares, `baseline`, `key`, reallocated
  `todayTimeSum/N/CrowdSum` (sized G) and `startDay(t)`. Agent state arrays are reallocated to
  length A (`aMode`, `aState`, `aLeg`, `aLegN`, `aLegs`, `aTripStart`, `aWaitStart`, `aPlat`
  (fill −1), `aCrowd`, `aLeft`, `aPM`, `aBoarded`).
- **`recomputePaths(only?: ArrayLike<number>)`** (332–412). If `only` is given:
  - keep the existing `pathAM`/`pathPM` arrays (do not reallocate at 335–336);
  - build `byHome`/`byWork` from `only` instead of `0..G` (357–362);
  - skip the midtown–JFK block (380–389) and the obs-drop loop (397–405);
  - still recompute `unserved` for all groups (406–411).

  Full recompute (no argument) behaves exactly as v1.
- **New `private transitInput(g): TransitCostInput | null`**, factored out of 458–465 and used by
  `dailyModeChoice` and `commuteBenefit`. This is a refactor with no behaviour change.
- **New `commuteBenefit(): { home: Float64Array; work: Float64Array }`** (§3.2).
- **`tractDetail`** (932–953) adds `benefit: number` (the home mean for that tract, computed in the
  same loop).

### 4.2 `src/sim/modeChoice.ts` (+25)
- `export function transitCost(t: TransitCostInput, band: number): number`, extracted from lines
  64–71. `generalisedCosts` calls it, with no behaviour change.
- `export function logsum(costs: readonly number[], theta = COMMUTERS.logitScale): number` returns
  `min − ln Σ exp(−θ(c−min))/θ`.
- `export function transitBenefit(lsNoTransit: number, transitCostMin: number, theta =
  COMMUTERS.logitScale): number` computes `x = θ(ls − tr)` and returns
  `x > 30 ? x/θ : Math.log1p(Math.exp(x))/θ`.

### 4.3 `src/core/rng.ts` (+20)
- `Rng.reseed(seed: number): void`, which does `this.s = seed >>> 0 || 1`.
- `export function hash32x4(a: number, b: number, c: number, d: number): number`. This is an
  FNV/murmur-style integer mix with no allocation. Unit-tested for no collisions over a 50k-key
  sample.
- `export function fnv32(bytes: Uint8Array, h = 0x811c9dc5): number` for the growth fingerprint.

### 4.4 `src/sim/engine.ts` (+70)
- `EngineOptions` (19–25) adds `growth?: GrowthData | null`, `growthPace?: GrowthPace` and
  `monthEvery?: number`. The last is for tuning only: close a growth month every N days.
- Constructor (34–47):
  `this.growth = world ? Growth.fromData(world, opts.growth ?? null, opts.growthPace ??
  GROWTH.defaultPace) : null;`. Commuters is built with `factors: this.growth?.factors() ?? null`.
  `fromData` drops data whose tract count does not match and logs a warning through `cb.event`.
- `closeDay` (90–106): after `base`, compute
  `const growth = this.isMonthEnd(day) ? this.monthClose(day) : null;` and add `growth: growth ??
  undefined` to the report.
- New public methods:
  - `monthClose(day): GrowthMonth | null` (§3.6; public so tests and scripts can force one);
  - `simState(): SimState`;
  - `growthView(): GrowthView`;
  - `tractGrowth(i): TractGrowth`;
  - `setGrowthPace(p)`;
  - `private isMonthEnd(day)`, which is `monthEvery ? (day+1) % monthEvery === 0 :
    isNewMonth(day+1)`.

### 4.5 `src/sim/protocol.ts` (+70)
See §6. Add `growth?: GrowthMonth` to `DayReport` (147–177), along with the new types, query kinds
and messages.

### 4.6 `src/sim/worker.ts` (+20)
- `init` (27–42) passes `growth: msg.growth, growthPace: msg.growthPace` to the `Engine`.
- `handle` (44–76) adds `case 'growthPace': engine.setGrowthPace(msg.pace); break;`.
- `answer` (78–100) replaces `case 'modeState'` with `case 'simState': return engine!.simState();`
  and adds `case 'growthView': return engine!.growthView();` and `case 'tractGrowth': return
  engine!.tractGrowth(q.tract);`.

### 4.7 `src/sim/client.ts` (+3)
`init(opts)` (51) widens to `{ …; modeState?: ModeState; growth?: GrowthData | null; growthPace:
GrowthPace }`. Add `setGrowthPace(pace)`, which sends `{ type: 'growthPace', pace }`.

### 4.8 `src/sim/headless.ts` (+15)
- `runDays` (163–183): opts add `growthPace?: GrowthPace` (default `game.growthPace`),
  `monthEvery?: number` and `growth?: GrowthData`, all passed to `Engine`. `settleDay` (171) passes
  `valueCapture: r.growth?.valueCapture ?? 0`.
- Export `nearStations(game, radius)`, which returns the tract indices within a radius of built
  stations. It is a test helper.

### 4.9 `src/economy/finance.ts` (+20)
- `DayLedger` (10–25) adds `valueCapture: number`, and `blankDay` (73–89) sets it to 0.
- `DayInputs` (50–58) adds `valueCapture?: number`.
- `settleDay` (169–212): `d.valueCapture = inp.valueCapture ?? 0;`. The cash line (197–199) adds
  `+ d.valueCapture` (sandbox unchanged: no cash change).
- `MonthReport` (27–39) adds `valueCapture: number`. `closeMonth` (214–234) sums
  `h.valueCapture ?? 0`, and `profit = revenue + valueCapture − operatingCosts − interest`.

### 4.10 `src/core/game.ts` (+3)
Add the field `growthPace: GrowthPace = GROWTH.defaultPace` next to `fare`/`sandbox` (50–51).

### 4.11 `src/core/goals.ts` (+8)
- `GOAL_DEFS` (18–27) adds `{ id: 'boomtown', … }` and `{ id: 'value-capture', … }`. Older
  `GoalState`s merge through `{ ...emptyGoals(), ...saved }` as today (`app.ts:144`).
- `checkGoals` report block (83–88) adds
  `mark('boomtown', (report.growth?.maxTractGrowth ?? 0) >= GOALS.boomtownGrowth)` and
  `mark('value-capture', !game.sandbox && (report.growth?.valueCapture ?? 0) >=
  GOALS.valueCaptureMonth)`.

### 4.12 `src/ui/app.ts` (+90)
- Field `lastModeState` (113) is replaced by `private lastSimState: { mode: ModeState | null;
  growth: GrowthData | null } | null`. Add `growthView: GrowthView | null = null` and
  `places: PlaceNames`, constructed with `view.map`.
- Constructor `applySave` block (141–149) keeps `modeState`/`growth` from the result.
  `sim.init(...)` (219) adds `growth, growthPace: this.game.growthPace`.
- Overlay registration (189): `view.addLayers('overlays', () => this.overlays.layers(view.is3D))`.
- `onDayEnd` (412–438):
  - `settleDay` (417) passes `valueCapture: r.growth?.valueCapture ?? 0`;
  - if `r.growth`, call `this.onGrowth(r.growth)` (toasts, `growthView = null`, overlay refresh);
  - `showMonthReport(this, m, r.growth ?? null)` (425);
  - the autosave query (434–437) becomes
    `this.sim.query<SimState>({ kind: 'simState' }).then((st) => { this.lastSimState = st;
    this.save('autosave'); })`.
- New `private onGrowth(gm: GrowthMonth)`:
  - top boomtown toast if `rate ≥ GROWTH.boomToastMonthlyRate`;
  - at most 2 milestone toasts;
  - `checkGoals(r)` already runs.
- New `tractName(i: number): string` (§2.4).
- New `setGrowthPace(p)`: sets `game.growthPace`, calls `sim.setGrowthPace` and shows a toast.
- New `async loadGrowthView(): Promise<GrowthView>`, which queries and caches.
- `loadOverlayData` (536–551): for `growth`, `residents` and `jobs`, call `loadGrowthView()` then
  `overlays.setData({ growth: v })`.
- `buildSave` (711–713) passes `modeState: this.lastSimState?.mode ?? null, growth:
  this.lastSimState?.growth ?? null`. `saveWithFreshModeState` (726–733) queries `simState`.
- `onKey` switch (781–820) adds
  `case 'g': case 'G': this.setOverlay(this.overlays.mode === 'growth' ? 'none' : 'growth');
  break;`.

### 4.13 `src/map/overlays.ts` (+80)
- `OverlayMode` (11) adds `'growth'`, and `OVERLAY_LABELS` (13–20) adds `growth: 'City growth since
  2030'`.
- `OverlayData` (38–42) adds `growth?: GrowthView`. `setData` (67–70) also rebuilds for `residents`,
  `jobs` and `growth`.
- `legend()` (72–105) adds a growth case (§2.2).
- `rebuild()` (107–128):
  - residents and jobs multiply by `mRes`/`mJobs` when present;
  - growth discs use `u = (R0·mR + J0·mJ)/(R0+J0) − 1`, skipping `|u| < 0.002`, with
    `t = 0.5 + 0.5·sign(u)·min(1, |u|/0.2)^0.6`;
  - `districtDiscs` come from `growth.district`;
  - `columns` are the growing tracts with Δ people > 50.
- `layers(is3D = false)` (130–169) draws the growth discs with `RAMP_DIVERGE`, the district rings
  layer `overlay-district`, and, if `is3D`, a `ColumnLayer` `overlay-growth-columns` (§2.3).
- Export `growthT(u: number): number` so tests can check ramp placement.

### 4.14 `src/map/colorRamp.ts` (+3)
Add `export const RAMP_DIVERGE = makeRamp(['#C04FB8', '#5E3B7E', '#20262D', '#1C7A8C', '#BFF4FA'],
[0.85, 0.55, 0.0, 0.6, 0.9]);`. The centre is transparent.

### 4.15 `src/ui/toolbar.ts` (+2)
`OVERLAYS` (20) adds `'growth'` after `'jobs'`. The overlay tip (41) body becomes "Residents, jobs,
city growth (G), unserved demand, crowding, flows".

### 4.16 `src/ui/selectTool.ts` (+12)
In `move` (17–41), before `app.tip(null)`: if `app.overlays.mode === 'growth' && app.growthView`,
find the nearest tract (same test as `click` 51–53) and show the growth tip.

### 4.17 `src/ui/panels/inspectPanels.ts` (+70)
- `TractDetail` (58–63) adds `benefit`.
- `tractPanel` (65–95) appends `section('Growth since Jan 2030')` with a `growthWrap`. It fetches
  `app.sim.query<TractGrowth>({ kind: 'tractGrowth', tract: index })` in `fetch()` and on
  `dayEnd`, and renders the content in §2.2 with `indexChart`. The Residents and Jobs stat cards
  show current values once `TractGrowth` arrives. The title adds the place name (§2.4) when known.
  `destroy` destroys the chart.

### 4.18 `src/ui/panels/stationPanel.ts` (+12)
The station `kv` (79–84) adds `['Value capture nearby', …]` from
`app.growthView?.stationLevy[id]`. On open, call `app.loadGrowthView()` if it is null, then
re-render.

### 4.19 `src/ui/panels/financePanel.ts` (+25)
- Yesterday rows (49–64) add `['Value capture', signed(y.valueCapture ?? 0)]`. The operating result
  includes it.
- Add the "Value capture" section (§2.2). It uses `f.months.at(-1)?.valueCapture` and the projected
  value from `app.growthView` (loaded lazily).
- The chart (80–88) passes `months.map(m => m.revenue + (m.valueCapture ?? 0))`, with the label
  "Revenue (fares + value capture)".

### 4.20 `src/ui/reports.ts` (+45)
`showMonthReport(app, m, growth: GrowthMonth | null)` (9–34):
- `kvs` adds `['Value capture', fmtMoney(m.valueCapture), 'hw-green']` after Fares.
- When `growth` is set, add the City section and the Boomtowns list (names from `app.tractName`)
  and a **Show growth map** button that calls `app.setOverlay('growth')`.
- The sandbox toast body appends `· +N residents`.

### 4.21 `src/ui/charts.ts` (+30)
`export function indexChart(el, labels: string[], res: number[], jobs: number[], width = 330, height
= 150): uPlot` draws two lines in `CHART_TEAL` (residents) and `CHART_ORANGE` (jobs) on a y index
where 2030 = 100. It is styled like `financeChart` (79).

### 4.22 `src/ui/menu.ts` (+25)
Add a "City growth" section after Units (73–100): a `seg` of Off / Steady / Boom calling
`app.setGrowthPace`, with a hint line.

### 4.23 `src/save/format.ts`, `migrate.ts`, `serialize.ts`
See §7.

### 4.24 `scripts/balance.ts` (+30), `scripts/perf.ts` (+8)
- Balance args: `months=N monthDays=K pace=steady|boom|off`. With `months`, call
  `runDays(game, N·K, { monthEvery: K, growthPace })`. The default is `K = 5`, which lets shares
  re-equilibrate (≈ 83% of the gap closes in 5 days at 0.3/day). Print one line per growth month:
  riders, value capture, city ×, top boomtown, agents. This is a tuning tool and does not use real
  calendar months.
- Perf: after the peak hour, time
  `engine.monthClose(dayIndex(engine.time))` and print `month close: X ms (budget 600 ms)`.

### 4.25 `README.md`
Add a "Living City" section (controls, G key, mechanics, balance table §9), update the test count,
re-measure the core and sprawl rows (§9.4) and add the new scripts flags.

---

## 5. New files and their exports

### `src/sim/growth.ts` (about 320 lines, pure, worker and Node)
```ts
export interface StationPt { id: number; x: number; y: number }
export interface OdFactors { home: Float32Array; work: Float32Array; tag: string }
export function attractiveness(benefitMinutes: number): number;          // b / (b + halfBenefit)
export function servedStations(net: CompiledNetwork | null): StationPt[];
export class Growth {
  readonly T: number; pace: GrowthPace;
  mRes: Float32Array; mJobs: Float32Array; fHome: Float32Array; fWork: Float32Array; premium: Float32Array;
  appliedThroughDay: number; months: number; sbar: [number, number];
  history: { day: number; q: Uint16Array }[]; city: GrowthCityPoint[];
  constructor(world: World, pace?: GrowthPace);              // identity state, precomputes tot[p], R0, J0
  static fromData(world: World, d: GrowthData | null, pace: GrowthPace): Growth;
  toData(): GrowthData;                                       // copies (structured-clone safe)
  isIdentity(): boolean;                                      // months === 0
  fingerprint(): string;                                      // '' | `g${months}:${fnv32(fHome,fWork).toString(16)}`
  factors(): OdFactors | null;                                // null when identity (keeps v1 key)
  residents(i: number): number; jobs(i: number): number;      // R0·m, J0·m
  step(day: number, bHome: Float64Array, bWork: Float64Array, served: StationPt[]): GrowthMonth;
  valueCapture(served: StationPt[]): { total: number; increment: number; byStation: Record<number, number>; district: Uint8Array; tracts: number };
  odSums(): { home: Float64Array; work: Float64Array };       // Σ OD' per tract (tests, diagnostics)
  view(served: StationPt[]): GrowthView;
  tract(i: number, served: StationPt[], benefitHome: number, benefitWork: number): TractGrowth;
}
```

### `src/map/placeNames.ts` (about 45 lines, main thread)
```ts
export class PlaceNames {
  constructor(map: maplibregl.Map, isLand: (x: number, y: number) => boolean); // harvests on 'idle' (debounced 500 ms)
  nearest(x: number, y: number, maxD = 1200): string | null;
}
export function tractName(t: Tract, places: PlaceNames, stations: { name: string; x: number; y: number }[]): string;
```

### Tests
`tests/growth.test.ts`, `tests/save.test.ts` (§12).

---

## 6. Worker protocol additions (`src/sim/protocol.ts`)

```ts
import type { GrowthPace } from '../balance';

/** Living City state the agent groups were generated from (save v3 `growth`). */
export interface GrowthData {
  version: 1;
  appliedThroughDay: number;
  months: number;
  mRes: Float32Array; mJobs: Float32Array;
  fHome: Float32Array; fWork: Float32Array;
  premium: Float32Array;
  sbar: [number, number];
  history: { day: number; q: Uint16Array }[];
  city: GrowthCityPoint[];
}
export interface GrowthCityPoint { day: number; residents: number; jobs: number; valueCapture: number }

/** Atomic capture for saving: shares and the growth they belong to, in one reply. */
export interface SimState { mode: ModeState; growth: GrowthData | null }

export interface Boomtown { tract: number; rate: number; dRes: number; dJobs: number; since2030: number }

export interface GrowthMonth {
  day: number; label: string;
  residents: number; jobs: number; dResidents: number; dJobs: number;
  agents: number; commuters: number;
  valueCapture: number; districtTracts: number; districtIncrement: number;
  stationLevy: Record<number, number>;
  boomtowns: Boomtown[];
  milestones: { tract: number; pct: number }[];
  maxTractGrowth: number;
}

export interface GrowthView {
  months: number;
  mRes: Float32Array; mJobs: Float32Array; premium: Float32Array;
  district: Uint8Array;
  stationLevy: Record<number, number>;
  projectedValueCapture: number;     // this month at current values
  city: GrowthCityPoint[];
}

export interface TractGrowth {
  residents0: number; jobs0: number; residents: number; jobs: number;
  history: { day: number; residents: number; jobs: number }[];
  benefitHome: number; benefitWork: number; cityBenefit: number;   // minutes
  projectedRateRes: number; projectedRateJobs: number;               // per month, with stored sbar
  premium: number; inDistrict: boolean; nearestStation: number | null; levy: number;
}
```

Changes to existing unions:

```ts
ToWorker:
  | { type: 'init'; …; modeState?: ModeState; growth?: GrowthData | null; growthPace: GrowthPace }
  | { type: 'growthPace'; pace: GrowthPace }
Query:   // 'modeState' → 'simState'
  | { kind: 'simState' } | { kind: 'growthView' } | { kind: 'tractGrowth'; tract: number }
DayReport: + growth?: GrowthMonth     // present only on month-close days
```

Payloads: `GrowthView` is 4 × 9.3 KB typed arrays plus up to 300 levy entries. It is sent on demand.
`GrowthMonth` is under 2 KB. `SimState` adds about 47 KB of growth arrays plus history (≤ 560 KB at
60 snapshots) to the existing ≈ 5 MB `ModeState`. All of it is structured-clone friendly.

---

## 7. Save format v3 and migration

### `src/save/format.ts`
```ts
export const SAVE_VERSION = 3;
export interface SavedGrowth {
  version: 1;
  appliedThroughDay: number;
  months: number;
  sbar: [number, number];
  /** base64 Float32Array, one value per tract */
  mRes: string; mJobs: string; fHome: string; fWork: string; premium: string;
  /** base64 Uint16Array(2T): round(multiplier × 10000), residents then jobs */
  history: { day: number; q: string }[];
  city: [day: number, residents: number, jobs: number, valueCapture: number][];
}
SaveFile.game.growthPace: GrowthPace;          // new
SaveFile.growth: SavedGrowth | null;           // new, sibling of modeState
export function bytesToB64(v: ArrayBufferView): string;   // f32ToB64 becomes a wrapper
export function b64ToU16(s: string): Uint16Array;
```
Size: about 62 KB plus 12.4 KB per stored month, so ≤ 0.8 MB after thinning. That is under 15% of
the existing mode-state payload.

### `src/save/migrate.ts`: new step `2:`
```ts
2: (s) => {
  const game = (s.game ?? {}) as Record<string, unknown>;
  game.growthPace ??= 'steady';                 // v2 games join Living City (menu can turn it off)
  const fin = game.finance as { history?: Record<string, unknown>[]; months?: Record<string, unknown>[]; today?: Record<string, unknown> } | undefined;
  for (const h of fin?.history ?? []) h.valueCapture ??= 0;
  for (const m of fin?.months ?? []) m.valueCapture ??= 0;
  if (fin?.today) fin.today.valueCapture ??= 0;
  s.growth ??= null;                            // identity city: v2 ModeState key still matches
  s.game = game;
  s.version = 3;
  return s;
},
```
v2 saves keep their ModeState. With identity growth, `factors()` is null, the key format is
unchanged and G and A are identical, so the shares restore. Agent placement uses the new
per-agent seeding, so walk distances shift slightly once.

### `src/save/serialize.ts`
- `buildSave` (8–39): `extra` adds `growth: GrowthData | null`. Write `game.growthPace` and
  `growth: extra.growth ? encodeGrowth(extra.growth) : null`.
- `applySave` (42–57): set `game.growthPace = g.growthPace ?? 'steady'` and return
  `growth: save.growth ? decodeGrowth(save.growth) : null`.
- Add `encodeGrowth(GrowthData): SavedGrowth` and `decodeGrowth(SavedGrowth): GrowthData`, both
  exported for tests.
- On load, the worker validates array lengths against the tract count (`Growth.fromData`). On a
  mismatch it uses identity growth and shows the toast "City growth was reset (data changed)".

**Agent-scale change** (`menu.ts:57–72` restarts from `buildSave`). Growth is scale-independent and
is always applied. The ModeState key changes with the scale, so shares reset as in v1.

---

## 8. `src/balance.ts`: new section

```ts
// ---------------------------------------------------------------------------
// Living City (v2): transit-oriented growth and value capture
export type GrowthPace = 'off' | 'steady' | 'boom';

export const GROWTH = {
  /** How fast the city reacts (menu → City growth). 'off' = frozen city, no value capture (v1 rules). */
  paceMultiplier: { off: 0, steady: 1, boom: 3 } as Record<GrowthPace, number>,
  defaultPace: 'steady' as GrowthPace,
  /** Natural growth of NYC commuters per year, residents and jobs alike (NYC ≈ +0.8%/yr in the 2010s). */
  cityGrowthPerYear: 0.008,
  /** The city as a whole stays below this multiple of its 2030 commuters (caps agents at ≈ 428k). */
  cityMaxMultiple: 1.5,
  /** Commute benefit (generalised min saved per commute vs no subway) at which attractiveness is 0.5; core p50 ≈ 28. */
  halfBenefit: 20,
  residents: {
    /** Extra growth per month at attractiveness 1: a typical served tract (s ≈ 0.55) grows ≈ 4–5%/yr. */
    boostPerMonth: 0.006,
    /** Share of the boost that is relocation from elsewhere in the city (drained uniformly); the rest moves to NYC. */
    relocationShare: 0.6,
    /** Hard monthly limits before the pace multiplier (building takes time). */
    maxGrowthPerMonth: 0.012,
    maxDeclinePerMonth: 0.004,
    /** Long-run bounds vs 2030 (a tract can at most double); growth slows smoothly toward them. */
    maxMultiple: 2,
    minMultiple: 0.7,
  },
  jobs: {
    /** Employers follow labour-market access more slowly than homes follow commutes. */
    boostPerMonth: 0.004,
    /** Jobs mostly relocate within the city rather than arrive from outside. */
    relocationShare: 0.7,
    maxGrowthPerMonth: 0.01,
    maxDeclinePerMonth: 0.003,
    maxMultiple: 2,
    minMultiple: 0.7,
  },
  /** Furness (IPF) passes per month, warm-started from last month's factors (row error < 0.05%). */
  balanceIterations: 2,
  /** Tract snapshots kept for the tract panel's history chart; older months are thinned to fit. */
  historyMax: 60,
  /** Reports, toasts and goals ignore tracts smaller than this (residents + jobs in 2030). */
  minTractPeople: 1000,
  /** Boomtowns listed in the month report. */
  boomtownsInReport: 5,
  /** Toast the month's top boomtown when it grew at least this much that month (steady best ≈ 0.4–0.5%). */
  boomToastMonthlyRate: 0.004,
  /** Since-2030 thresholds that trigger milestone toasts. */
  milestonesUp: [0.1, 0.25, 0.5, 1],
  milestonesDown: [-0.05, -0.1, -0.2],
};

export const VALUE_CAPTURE = {
  /** Transit Improvement District: tract centres within this distance (+ a share of the tract radius) of a served station (½ mi = the catchment). */
  districtRadius: 800,
  districtTractShare: 0.5,
  /** Assessed market value per commuter living / working in a tract (2030 $; ≈ NYC's ~$1.4T roll over 5.7M home + job places). */
  valuePerResident: 300_000,
  valuePerJob: 150_000,
  /** Land-value premium at attractiveness 1 (studies find +5–25% near rail stations). */
  premiumMax: 0.12,
  /** Share of the gap to the target premium that capitalises each month (≈ 10-month lag). */
  premiumLagPerMonth: 0.1,
  /** Effective property tax on market value per year. */
  taxRate: 0.012,
  /** Share of the district's tax increment pledged to the authority (TIF); core ≈ +$0.36M/day after a year. */
  captureShare: 0.25,
};
```

Additions to existing sections:

```ts
// MAP
  /** 3D growth columns: metres of height per added resident or job (+2,500 people ≈ 200 m). */
  growthColumnMetresPerPerson: 0.08,
// GOALS
  /** Boomtown goal: a tract (≥ GROWTH.minTractPeople) grows this much since 2030. */
  boomtownGrowth: 0.25,
  /** Value-capture goal: one month's payment. */
  valueCaptureMonth: 10e6,
```

---

## 9. Balance impact

### 9.1 Method
I wrote a throwaway prototype (scratchpad, not committed). It ran the README core and sprawl
scenarios headless for 8 or 6 days at scale 10. It then computed the §3.2 benefits from the live
`Commuters` state and stepped the §3.3–3.5 model forward 60 months with the §8 values. This holds
accessibility fixed: no crowding feedback and no new lines. "Transit commuters" is
`Σ_g n_g·share_g·mRes[h]·mJobs[w] / Σ_g n_g·share_g`, which is an upper bound because capacity
limits are ignored.

### 9.2 Results (Steady pace, fare $3, no further building)

| Horizon | Core: value capture | Core: transit commuters | Core: top tract | Core: daily result after interest (README: −$0.28M) | Sprawl: value capture |
|---|---|---|---|---|---|
| Month 1 | $0.90M paid (≈ $0.04M/day) | +0.5% | +0.4% | ≈ −$0.22M | ≈ $0 |
| Month 6 | $4.6M/mo ≈ **$0.21M/day** | +3.3% | +2.5% | ≈ **break-even** | $0.003M/day |
| Year 1 | $7.8M/mo ≈ **$0.36M/day** ($56M in the year) | +6.6% | +4.9% | ≈ **+$0.2 to +0.3M** | $0.005M/day |
| Year 2 | $12.4M/mo ≈ $0.57M/day | +13% | +9.8% | ≈ +$0.6M | $0.009M/day |
| Year 5 | $22.4M/mo ≈ $1.03M/day | +34% (upper bound) | +24% | ≈ +$1.5–1.9M (full debt service ≈ break-even) | $0.019M/day |

The "after interest" column combines the README core (+$1.4M/day operating, −$1.68M/day interest)
with value capture and induced fares at about $3.40M of fares per 1.27M riders. Core city growth is
×1.013 per year, and the most-declined tract is ×0.996 after a year and ×0.981 after 5 years.
**Sprawl keeps losing about $0.8M/day**: its benefit is tiny (mean 0.06 min), so it captures almost
nothing.

**Boom** (×3) roughly compresses three Steady years into one. By the end of year 1 the core sees
value capture of about $0.7M/day and +20% transit commuters. It is labelled "easier money" in the
menu.

### 9.3 Why it does not run away
- The benefit uses observed times. As growth fills trains, crowding minutes and left-behinds raise
  the transit cost, which lowers the benefit and slows growth. The core is already crowded at peak,
  so the real numbers will sit below the upper bound unless the player adds capacity.
- Growth is bounded per month and in the long run, and the city ceiling caps agents at about 428k.
- Value capture floors at the 2030 base and depends on service: cut a line and the premium decays.
- The fare enters the benefit through value of time, so raising fares slows growth. This trade-off
  is intended.

### 9.4 What changes in v1 numbers
- Month-crossing only happens from day 18 (31 Jan 2030), so `npm run balance` (12 days), the
  headless test (3 days) and perf (1 day) never trigger growth.
- Per-agent placement seeding changes where each agent lives inside its tract. G, A, the key and the
  shares are unchanged. Expect noise-level changes (±1–2%) in the README core and sprawl rows.
  Re-run `npm run balance -- scenario=core days=12` and `scenario=sprawl days=8` and update the
  README table as part of the checklist. If the core moves more than 3%, investigate before
  merging.
- Tuning loop for the new values:
  `npm run balance -- scenario=core months=12 monthDays=5` (about 2 min) and `scenario=sprawl`. The
  targets are core value capture of $0.25–0.45M/day at month 12, sprawl below $0.02M/day and core
  riders still rising.

---

## 10. Performance

Budget: 300 stations, 25 routes, 400 trains at 60 fps, sim at 60× with about 5× headroom
(README: one peak game-hour takes about 190 ms against a 1000 ms budget).

**Per step: no change.** Growth adds no work to `Engine.step`, `TrainSim` or the event loop.

**Per month (once every ~21 game days, which is about 8.6 real minutes at 60×):**

| Phase | Measured or estimated (Node, this machine) |
|---|---|
| `commuteBenefit` (softplus per group, 252k groups) | ~20 ms (prototype using full `generalisedCosts`: 67–124 ms) |
| `Growth.step` (T = 2,324, plus Furness 2 passes over 976k pairs) | ~60 ms (3 cold passes measured at 83 ms) |
| `buildGroups` (CRN rounding, 1.27M non-zero cells) | 71–133 ms measured |
| Merge-join plus copies for matched groups and agents | ~30 ms (agents from scratch measured at 109 ms; geometry and logit for all groups 180 ms, about 1% of that for new groups) |
| `recomputePaths(needPath)` (~300–1,000 origins) | core ~40 ms, perf grid ~100–200 ms (full is 168 ms core, about 500 ms perf) |
| **Total** | **≈ 0.25–0.45 s at the month-end midnight** |

During this time the worker stops posting snapshots. The worker loop drops any backlog
(`worker.ts`: `if (acc > speed·baseRate·0.5) acc = 0`), so nothing spirals. At midnight only night
service runs, and the busy pill explains the pause. The main thread is unaffected because its
interpolation simply holds. `scripts/perf.ts` gains a `month close` timing line, with a 600 ms
budget at the perf scale.

**Agent count drift.** Steady adds about 1.3% a year on the core (+3.7k agents a year), so the
event cost goes up by about 7% after 5 years and headroom stays around 4.6×. At the city ceiling
(×1.5, 428k agents) headroom is about 3.4× and agent arrays grow from about 31 MB to about 47 MB.
Pathfinding cost depends on origins, not agents, so it is unchanged.

**Main thread.** The growth overlay rebuilds ≤ 2,324 discs, rings and columns only when data
arrives (on overlay selection and once a month). The tract panel chart has ≤ 60 points. The
`GrowthView` query is about 40 KB.

**Memory.** The `Growth` instance holds `tot[p]` (3.9 MB) plus 5 × 9.3 KB arrays plus history
(≤ 560 KB). Regeneration briefly holds old and new agent arrays (≈ 2 × 31 MB) until GC.

---

## 11. Determinism
- `Growth` uses no RNG. All loops run in fixed index order. State is canonicalised with
  `Math.fround` after every update (`mRes`, `mJobs`, `fHome`, `fWork`, `premium`), so the live
  worker and a reloaded one hold bit-identical Float32 state.
- Agent generation is a pure function of `(OD, fHome, fWork, scale, seed)`: the CRN rounding
  stream plus per-agent `hash32x4` seeding. Incremental regeneration is tested to equal a
  from-scratch build exactly.
- Daily randomness (`this.rng`, mode draws at 3 am) keeps its single seeded stream. After a reload
  it restarts from the seed, as in v1. Two reloads of the same save therefore play out identically,
  and test 14 checks this. A reload and the uninterrupted run agree statistically but not bit for
  bit, which is also v1 behaviour.
- `Math.exp` and `Math.log` (logsum and softplus) can differ in the last bit between JS engines.
  Nothing recomputes past months from scratch (state is saved, never replayed), so saves stay valid
  across browsers.
- The `appliedThroughDay` guard makes month close idempotent. A save taken at 23:59 on the last
  weekday re-runs the close once after loading. A save taken at 00:00 or later (the autosave) does
  not. Finance already de-duplicates the day (`finance.ts:171–172`).

---

## 12. Test plan (Vitest)

`tests/growth.test.ts` is a unit test (picked up by `npm run test:unit`). It uses a tiny synthetic
world from `buildWorld` and `encodeOD` (6 tracts), plus the real world from
`scripts/nodeData.ts` where noted.

1. **logsum / transitBenefit.**
   - `transitBenefit(ls, tr) === logsum([w, d]) − logsum([w, d, tr])` within 1e-9 for random costs.
   - Equal costs give `ln 2 / θ`.
   - The benefit tends to 0 as `tr` tends to ∞ and is linear (`ls − tr`) when `tr ≪ ls`.
   - It is always ≥ 0.
2. **Baseline only.** With zero benefits, every tract with base > 0 grows by exactly
   `(1+g)^(1/12) − 1` per month. Residents total equals jobs total, which equals
   `T0·(1+g)^(n/12)` within 1e-6 after 24 months. Zero-job tracts stay at 0.
3. **Monotone.** With benefits that increase with tract index and equal bases, after 12 months
   `mRes[i] ≤ mRes[i+1]` for all i, and the top tract is above baseline while the zero-benefit
   tract is below.
4. **Bounds.** Maximum benefit for one tract over 600 months, on both Steady and Boom:
   - `max(mRes) ≤ maxMultiple·(1+1e-6)` and `min ≥ minMultiple·(1−1e-6)`;
   - per-month |rate| ≤ caps × pace;
   - the city stays ≤ `cityMaxMultiple·T0·(1+1e-6)`.
5. **Pace.** `off` makes `Engine.monthClose` return null with state unchanged. Boom growth over 6
   months is ≥ 2.5× Steady when the bounds are not binding.
6. **Determinism and save round trip.**
   - Two `Growth`s with identical inputs give byte-identical arrays and equal `fingerprint()`.
   - Running 12 months straight equals 6 months, then
     `decodeGrowth(encodeGrowth(toData()))` → `fromData`, then 6 more, byte for byte.
7. **Furness consistency (real world).** Use 24 months of a deterministic benefit pattern
   (`b = 40·(hash32x4(i,0,0,0) % 100)/100` for Manhattan and Queens tracts, 0 elsewhere). For every
   tract with ≥ 100 people, `odSums().home[h]` is within 0.5% of `R0[h]·mRes[h]` and
   `odSums().work[w]` within 0.5% of `J0[w]·mJobs[w]`. The sum over OD' equals the common total
   within 1e-6.
8. **Value capture.**
   - No served stations: total 0 and an empty district.
   - One station: only tracts within `districtRadius + share·radius` count. `byStation` sums to
     `total`.
   - A declining tract contributes 0 (floor).
   - The premium approaches `premiumMax·s` geometrically at `premiumLagPerMonth`.
9. **History thinning.** After 100 months there are ≤ `historyMax` snapshots, days strictly
   increase, the last one is the latest month and the first one is month 1.
10. **Regeneration equivalence (real world, scale 10).**
    - `a = new Commuters(world, {factors: f0})`, then `a.regenerate(f1, t)`.
    - `b = new Commuters(world, {factors: f1})`.
    - `gHome/gWork/gBand/gCount`, `aHx/aHy/aWx/aWy/aDepart/aReturn` and `key` are identical.
    - `f0` is identity and `f1` is 1.03 on 50 tracts and 0.98 on 50 others.
11. **Identity compatibility.** `new Commuters(world, {factors: null})` has the same G, A and key
    string as the v1 formula. Its groups match `buildGroups(…, null)`.
12. **Carry-over.**
    - After `regenerate`, every matched group has identical `shares`/`obsTime`/`obsCrowd`, and every
      group's shares sum to 1 within 1e-5.
    - With f1 ≥ f0 elementwise, every old group's count is ≤ its new count (CRN monotone).
    - `|A1 − Σ c·f/scale| < 4·√A`.

`tests/headless.test.ts` additions (slow, using the test network):

13. **Month close grows the served city.**
    - `buildTestNetwork`, `runDays(game, 2)`, then `run.engine.monthClose(1)`.
    - The report has a finite `valueCapture > 0`, `dResidents > 0` and
      `residents === jobs` (within 1e-6 relative).
    - The mean `mRes` of tracts within 800 m of a station is above the mean of all other tracts.
    - `engine.commuters.A` equals the new rounding total.
    - Then run 1 more day:
      - `deadlocks === 0`, `stuckCount() === 0` and `inFlight() === 0` at the end;
      - riders ≥ 0.9 × the previous day's (continuity, no reset of shares);
      - `transitShare` stays in (0, 0.5).
14. **Save and load mid-growth.**
    - After 13, `st = engine.simState()`. Build two new engines `B` and `C` with
      `Engine(world, {modeState: st.mode, growth: st.growth, time})` and
      `setNetwork(compileNetwork(game).net)`.
    - Both have the same A, G and key as the original, and identical `shares`, `obsTime` and
      agent arrays.
    - Running `B` and `C` for 1 day gives identical `DayReport`s (`riders`, `fareRevenue`,
      `transitShare`). This is reload determinism.
    - `B`'s riders are within 3% of the uninterrupted engine's. They are not identical because the
      daily mode-draw RNG restarts from the seed after a reload, exactly as in v1.
15. **Finance through runDays.** With `monthEvery: 2` over 4 days, two growth months happen.
    `finance.history` has `valueCapture > 0` on days 1 and 3, and cash reflects it.

`tests/economy.test.ts` additions:

16. `settleDay({…, valueCapture: 5e6})` adds 5e6 to cash and records it on the ledger. The month
    report's `valueCapture` and `profit` include it. In sandbox, cash is unchanged and the ledger
    still records it.

`tests/save.test.ts` (new):

17. **Migration v2 → v3.** A minimal v2 object goes through `migrate()`:
    - `version === 3`, `growth === null` and `game.growthPace === 'steady'`;
    - `valueCapture` is 0 on history, months and today;
    - a v1 object still migrates all the way to v3.
18. **Encode/decode.** `decodeGrowth(encodeGrowth(d))` reproduces every typed array exactly
    (Float32 and Uint16) and the city rows. `applySave(buildSave(…))` returns the same growth and
    pace.

The test count goes from 36 to about 54. The headless additions add about 15 s.

---

## 13. Risks and how to de-risk them

| Risk | Mitigation |
|---|---|
| Stale agent indices after regeneration (train buckets, queues, heap) cause ghost riders or crashes | One `resetTrips()` shared with the 3 am path. Regenerate only at midnight. Tests 13 and 14 assert stuck, inFlight and deadlocks are 0 and check continuity. |
| Ridership drops after a month close (shares lost) | Merge-join carry-over by `(h, w, b)`, pair-level path copy, fresh groups at logit target. Test 13 requires the next day's riders ≥ 0.9×. |
| Save key mismatch resets shares | Growth fingerprint in the key, atomic `simState` query, test 14. Growth is applied even when the key mismatches (agent-scale change). |
| Incremental regeneration differs from a fresh build, so reload diverges | Per-agent seeding plus CRN rounding make both paths pure functions. Test 10 asserts byte equality. |
| Positive feedback runaway (growth → riders → value capture) | Monthly and long-run bounds, city ceiling, crowding feedback through observed times, a `cityMaxMultiple` test, conservative Steady defaults and an Off switch. The balance script `months=` mode supports tuning. |
| Monthly 0.3–0.5 s worker stall | Subset pathfinding, copying matched agents, busy pill, perf script line with a 600 ms budget. Fallback if over budget: split the close across the first two hours after midnight (benefit and step at 00:00, regenerate at 01:00). The 3 am choice still sees the new groups. |
| v1 balance numbers shift (placement RNG) | Noise-level by construction (same G, A and shares). Re-measure and update the README. Investigate if the core moves more than 3%. |
| Unfair-feeling declines ("I did nothing and my area shrank") | `relocationShare < 1`, per-month and long-run floors, decline toasts only at −5/−10/−20% milestones, and the tract panel explains why (no good transit). |
| Toast names wrong or missing | Three-step fallback (map label, station, "Queens tract 57"), never empty. |
| Save size grows | Float32 per tract, Uint16 history with thinning, ≤ 0.8 MB, compared with about 6.7 MB of existing ModeState base64. |
| Custom or synthetic OD not sorted, breaking the merge-join | `buildGroups` checks sortedness. Unsorted data falls back to a `Map` join (slower but correct). Test with a shuffled synthetic OD. |
| Benefit option value (any path gives a few minutes) | `halfBenefit = 20` compresses small benefits. Sprawl numbers confirm it is negligible. |

---

## 14. Implementation checklist (in order)

1. **balance.ts.** Add `GrowthPace`, `GROWTH`, `VALUE_CAPTURE`, `MAP.growthColumnMetresPerPerson`
   and the two `GOALS` entries (§8).
2. **rng.ts.** Add `reseed`, `hash32x4` and `fnv32`, with unit tests (collision sample,
   determinism).
3. **modeChoice.ts.** Add `transitCost` (refactor), `logsum` and `transitBenefit`. Write test 1.
   Run `npm test` and confirm it is still green.
4. **protocol.ts.** Add the new types and union changes (§6). Fix compile errors (`'modeState'` →
   `'simState'`) in worker and app with temporary pass-throughs.
5. **growth.ts.** Implement `Growth` (identity, `step`, `furness`, `fitTotal`, premium,
   `valueCapture`, report, history thinning, `toData`/`fromData`, `fingerprint`, `factors`, `view`,
   `tract`) and `servedStations`. Write tests 2–9 and get them green. This is the core of the
   feature: tune here with synthetic inputs first.
6. **commuters.ts, generation refactor.** Add `buildGroups`, `adoptGroups`, `buildAgents` with
   per-agent seeding, and the `makeKey` tag. Write test 11. Run the headless test and confirm v1
   behaviour holds (riders in range).
7. **commuters.ts, regeneration.** Add `resetTrips`, `matchGroups`, `regenerate`,
   `recomputePaths(only)`, `transitInput`, `commuteBenefit` and `tractDetail.benefit`. Write tests
   10 and 12.
8. **engine.ts and worker.ts.** Growth ownership, `monthClose`, `closeDay` hook, `simState`,
   `growthView`, `tractGrowth`, `setGrowthPace`, `monthEvery`. **headless.ts**: `runDays` options
   and value capture into `settleDay`. Write headless tests 13–15.
9. **finance.ts.** Add the `valueCapture` ledger, month and profit changes. Write test 16.
10. **Save.** `format.ts` (v3, `SavedGrowth`, `bytesToB64`, `b64ToU16`), the `migrate.ts` step,
    and `serialize.ts` encode/decode plus `growthPace`. **game.ts**: `growthPace`. Write tests 17
    and 18.
11. **client.ts and app.ts plumbing.** `init` growth and pace, `lastSimState`, the `simState`
    autosave, `settleDay(valueCapture)`, `setGrowthPace`, `loadGrowthView`, the G key. Manual
    check: `npm run dev`, then sandbox, build a line, and use Skip/60× to the end of January.
12. **Overlay.** `RAMP_DIVERGE`, growth discs, district rings, residents and jobs multipliers,
    legend, toolbar entry and tooltip, selectTool hover.
13. **Panels and reports.** Tract panel growth section with `indexChart`, station panel value
    capture, finance panel rows, section and chart, month report City section and **Show growth
    map**, goals.
14. **Names and toasts.** `placeNames.ts`, `app.tractName` and `onGrowth` toasts with milestones.
15. **Menu.** The City growth segment (Off / Steady / Boom) and the one-time v2-save hint.
16. **Scripts.** `balance.ts` `months/monthDays/pace` and the `perf.ts` month-close timing. Run:
    - `npm run perf`: month close under 600 ms, peak hour unchanged;
    - `npm run balance -- scenario=core months=12`: value capture $0.25–0.45M/day at month 12;
    - `scenario=sprawl months=12`: value capture < $0.02M/day;
    - `scenario=core days=12`: within 3% of the README.
17. **Optional (stretch).** 3D growth columns (`ColumnLayer`, `overlays.layers(is3D)`).
18. **README.** Living City section, controls (G), balance table (§9), test count and the
    re-measured v1 rows. Run `npm run build` (strict typecheck) and `npm test`.

---

## Appendix A: prototype measurements (README core, scale 10, this machine)

```
ran 8 days in 9.2 s; riders 1,267,530 · fare trips 1,132,750 · fares $3.40M/day
G = 252,543 groups · A = 285,288 agents · mean benefit 12.2 min
home benefit (704 tracts > 0): p10 16.9 · p50 28.0 · p90 43.9 · max 54.8 min
job benefit  (685 tracts > 0): p10 0.4 · p50 2.3 · p90 26.4 · max 44.3 min
district: 314 tracts · 587k residents · 1.47M jobs
Commuters ctor 561 ms (rounding 71 · agents 109 · groups 187) · full recomputePaths 168 ms
Furness 3 cold passes 83 ms (max row error 0.36% after 60 months of drift)
uniform +1% factors: G 252,543 → 254,589 · A 285,288 → 287,987
sprawl: mean benefit 0.06 min · district 63 tracts · VC $0.005M/day after a year
```
