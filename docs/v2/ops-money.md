# v2 design: operations control and the money market

Status: design, ready to implement · Target: one focused session, about 1,500 lines of source plus
about 550 lines of tests · Depends on: v1 as committed (`a27dbfa`). It touches the train sim,
commuters, finance, save format (v2 → v3) and UI.

## 0. Summary

This feature adds dispatching and treasury management on top of v1.

1. **Headway control.** Dispatchers can hold a train at its first stop. They can also hold it at
   *timepoint* stations the player picks along the route. A train is held when its gap to the
   train ahead is shorter than a set share of the scheduled headway (70% by default). A hold at a
   timepoint lasts at most 90 s, and the train leaves at once if another route's train is queued
   behind it. Timetables get **recovery time** at the terminals, which makes the fleet a little
   bigger. Crews whose next departure is already due turn the train in 2 minutes instead of 3.
   The route panel shows **service regularity**: headway variation, the share of trains that are
   bunched, the extra wait that bunching costs riders, holds, and a chart of variation stop by stop.
2. **Car sales.** Cars that a route no longer needs, and cars in the spare pool, can be sold for
   40% of their new price. They also leave the maintenance base.
3. **Bond market.** The base rate for *new* bonds moves each month as a seeded, mean-reverting
   random walk around 2.5%, with occasional shocks. A **credit rating** from AAA to CCC is set at
   each month end from four ratios: farebox recovery, interest coverage, leverage and liquidity.
   The rating adds a spread. Each bond keeps its own coupon. Players can **prepay** a bond (1%
   penalty) or **refinance** it at today's rate for a 1% fee, keeping the remaining term.
4. **Fare policy.** There are separate peak fares (AM and PM periods) and off-peak fares. An
   optional **low-income fare** (half or free) applies to the lowest earnings band. Fares are
   billed at first boarding, at the fare for that band and period. They feed mode choice through a
   per-group expected fare, plus a per-agent odds adjustment for agents who travel off-peak.
5. **Year in review.** A modal at each year end covers ridership, money, rating changes, the bond
   market, service regularity and goals. It can be reopened from the finance panel.
6. **Finance panel with tabs** (Overview · Fares · Borrowing · Fleet). It includes a uPlot chart of
   rate history and a credit scorecard.

**Evidence from a prototype.** Before writing this design I put the holding and recovery rules
into a scratch copy of `src/sim/trainSim.ts` and ran it (prototype code is not committed).

*Synthetic busy line.* 16 stops, 1 km apart, 3-minute headway, with dwell driven by the gap
(boarders ∝ time since the last train, 0.5 people/s/stop, plus seeded noise). These are the
numbers for v2 with every rule switched off, then with each rule alone, then with all of them:

| Variant | Headway CV | Bunched (< ½ headway) | Trains through in 4 h | Avg lateness |
|---|---|---|---|---|
| Off: 19 trains, short turn only | 0.89 | 31.8% | 134 | 215 s |
| Recovery 10% only (20 trains) | 0.90 | 38.8% | 145 | 214 s |
| Terminal holding only (19 trains) | 0.88 | 28.9% | 134 | 208 s |
| **Holding + recovery 10%** | **0.25** | **4.7%** | **164** | **80 s** |
| Holding + recovery + 2 timepoints | 0.22 | 2.0% | 164 | 82 s |

Neither rule helps much on its own. Without slack in the fleet, holding only delays trains. Without
holding, the extra train only repeats the v1 failure: when trains are late, a waiting train leaves
the moment a slot is overdue, right behind the one before it. **Together they remove the
bunching** and carry 22% more trains, because the pool of waiting trains stops running dry.

*Full sim, README core network* (4 deep routes, 10 cars, 2.5-minute peak, 285k agents; day 7 of 8):

| Variant | CV | Bunched | Lateness | Left behind | Riders |
|---|---|---|---|---|---|
| v1 | 0.52 | 10.8% | 105 s | 766k | 1,267,530 |
| v2 defaults (terminal holding, recovery 10%, +1 train/route) | 0.43 | 6.2% | 92 s | 508k | 1,282,600 (+1.2%) |
| + 2 timepoints per route | 0.41 | 3.5% | 101 s | 496k | 1,282,700 |

On the test network (2 interlined routes), bunching on day 1 falls from 11.6% to 4.9% with the
defaults and to 2.6% with timepoints. There are no deadlocks in any run. The headless test in
§13 is based on this.

---

## 1. Goals and non-goals

### Goals
- Make reliability something the player can manage and see. Lateness in v1 builds up on crowded
  lines; in v2 the player gets three tools (holding, timepoints, recovery) and a regularity
  readout that shows whether they work.
- Make debt a living thing. Rates, ratings, prepayment and refinancing reward timing and
  creditworthiness without changing v1's opening: month 1 borrows at exactly 2.5%.
- Add fare levers with real trade-offs: peak or off-peak pricing, and a low-income fare that buys
  ridership among low earners for a modest revenue cost.
- Give the player a yearly story (year in review) and a way out of over-buying cars.
- Keep everything deterministic and in `balance.ts`. The worker stays the only place the sim runs.
- Keep performance unchanged: about O(1) extra work per train event, and no new per-step loops
  over agents.

### Non-goals (v2)
- Trains are not tied to individual trip rosters. The sim keeps v1's pooled dispatch: any ready
  train takes the next slot. Recovery works through the size of that pool.
- No schedule-based holding (holding to a timetable minute). Holding is by headway only.
- No changes to when people travel. Peak pricing does not move departure times; it only changes
  mode choice and revenue.
- No variable bond sizes or terms. Bonds stay at $1B and 30 years. Refinancing keeps the remaining
  term.
- No interest on cash, no city subsidy for the low-income fare, and no market closure at CCC
  (borrowing gets very expensive instead).
- No retiring of running trains when cars are sold. v1's rule for shrinking the fleet applies:
  waiting trains go first (`trainSim.ts:124-137`). See §14.

---

## 2. Player-facing behaviour and UI

### 2.1 Route panel → Operations (new section)

It sits between **Train length** and the fleet line in `routePanel()` (`routePanel.ts:130-136`). Its
controls edit the same `draft` as frequency and cars, and **Apply** commits them all together
(`routePanel.ts:112-127`).

```
Operations
 Holding     [ Off | On ]                 threshold [50 60 70 80 90]% of headway
 Recovery    [ 0% | 5% | 10% | 15% | 20% ]   ≈ 2.1 min per terminal · +1 train
             Suggested: 10% — trains reached terminals 1.4 min late on average yesterday
 Timepoints  2 · 86 St, 137 St     [Suggest] [Clear]
```

- **Holding** tooltip: "Hold a train whose gap to the one ahead is under 70% of the headway. At
  the first stop it waits off the running track. At timepoints it waits up to 90 s, and never while
  another route's train is queued behind it. Shortcut: H with the route selected."
- **Recovery** tooltip: "Extra layover in the timetable at each end, as a share of the one-way run
  time. More trains are needed. Late trains use this slack to get back on schedule."
- **Suggested** recovery comes from yesterday's mean lateness on arrival at the terminals (§4.5).
  It only appears when it is higher than the current setting.
- **Timepoints.** Each intermediate stop in the stop list (`routePanel.ts:88-101`) gets a small
  clock toggle on the right. The toggle is amber when on and shows only while holding is on. Its
  tooltip is "Timepoint: trains may be held here to even out gaps". **Suggest** picks the stops
  nearest ⅓ and ⅔ along the stop list, preferring stops no other route serves (§4.5). **Clear**
  removes them all. Toggles mark the draft as changed, and Apply commits.
- The fleet line (`fleetLine`, `routePanel.ts:51-71`) gets a row `Recovery 2.1 min × 2`. The
  "Round trip" row includes it. When the route owns more cars than its plan needs, it shows
  `Idle: 2 trains (20 cars) · [Sell for $20M]` (§2.4).

### 2.2 Route panel → Service regularity (new section, above the load chart)

Four stat cards come from the `route` query (`regularity`, §7). They show yesterday's values, or
today's so far when there is no yesterday:

| Card | Value | Tone |
|---|---|---|
| Regularity | `Even · CV 0.21` / `Uneven · 0.38` / `Bunched · 0.61` | green / amber / red at `cvGood` 0.25 and `cvFair` 0.45 |
| Bunched | `6%` of headways under half the scheduled one | amber > 10%, red > 25% |
| Extra wait | `+38 s` (excess wait per rider, §4.4) | amber > 60 s, red > 120 s |
| Holds | `142 · avg 37 s` | none |

Below them is the **Headway spread along the line** chart (`regularityChart`, §5). It plots CV
against the stop number for both directions, in the order of direction 0 stops, so the two lines
share an x axis. The legend uses the "Towards X" names, as the load charts do. A muted caption
lists the timepoints, so the player can see the variation drop after each one.

The existing **Avg lateness** card stays. Its tooltip gains: "Holding can raise lateness slightly
while making gaps even; regularity is what riders feel."

### 2.3 Train panel, routes list and map

- **Train panel** (`inspectPanels.ts:9-56`). When the snapshot state is `SNAP_HELD` (4), the
  "Next stop" card reads **Held at 86 St** in amber, with the body "Waiting for an even gap behind
  the train ahead". `t.state === 2` checks (lines 35, 40) become `t.state === 2 || t.state === 4`.
- **Routes list** (`routesList`, `routePanel.ts:265-276`). The sub-line adds `· gaps even`,
  `· uneven` or `· bunching`, taken from `app.report.routeRegularity[id]`.
- The trains layer is unchanged. Held trains are drawn as dwelling.

### 2.4 Finances panel (rewritten, with tabs)

`financePanel()` (`financePanel.ts:17-92`) becomes a `.seg` tab strip: **Overview · Fares ·
Borrowing · Fleet**. `app.financeTab` keeps the open tab for the session (it is not saved).

**Overview**
- Stat grid: Cash, Debt, Bond room, Assets (as in v1), plus **Credit rating** (a big letter in
  the `.rating-badge` tone, with an outlook arrow ↗ → ↘) and **New bonds** `3.12%`.
- The Yesterday ledger (v1 rows) gains two rows: **Financing fees** (prepay penalties and refinance
  fees) and **Bond prepayments**. "Operating result" subtracts the fees.
- This month so far and the monthly revenue vs costs chart are unchanged.
- Button **Year in review** opens §2.5 for the last finished year, or for this year so far if none
  has finished. A small select picks earlier years.

**Fares**
- **Peak fare (6–10 am, 4–8 pm)** slider, $0–$5 in $0.25 steps.
- **Off-peak fare** slider. It is capped at the peak fare. A checkbox **Same fare all day** (on
  for flat policies) locks it to the peak fare.
- **Low-income fare** (earnings band ≤ $1,250/month) as a `.seg`: **Full · Half · Free**. Its
  tooltip is "A 'fair fares' discount for the lowest earners. Billed at boarding; they decide at
  3 am."
- Read-only lines from `app.report.fares` and `bandShare`:
  `Yesterday: 96% of fare trips at peak · average fare $2.98` and
  `Lowest earners: 6.8% of riders · 13% ride transit (all commuters 21%)`.
- A small share bar of yesterday's fare revenue by band (`shareBar`, `common.ts`).
- Changes apply on `change` through `app.setFares()`, which toasts
  `"Fares: $3.50 peak / $2.50 off-peak · low-income half — commuters reconsider at 3 am"`.

**Borrowing**
- Header line: `Market 2.52% · BBB spread +0.60% → new bonds 3.12% for 30 years · next review
  31 Oct`.
- **Issue $1B bond** button (as in v1, `financePanel.ts:43`). Its tooltip names the rate and the
  monthly payment.
- **Credit scorecard**: one row per metric (Farebox recovery, Interest coverage, Leverage,
  Liquidity). Each row has the value, a thin `.score-bar` meter from 0 to 100, and a one-line hint
  from `CreditMetric.hint`, such as "1.5× earns 75 points". Below it:
  `Score 56 → BBB (A needs 67) · outlook stable`, from a live `previewCredit()`.
- **Rate history** chart (`rateChart`, §5), over at most the last 60 months. It has three lines:
  Market base (teal), Your new-bond rate (orange) and Average cost of your debt (grey dashed).
- **Bonds list.** Each bond row reads `Bond 3 · $0.97B · 2.50% · $3.95M/mo · 27 y 4 m left · AAA`
  and has two buttons:
  - **Prepay…** opens a small modal with options **$250M · $500M · All** ($250M steps up to the
    balance). Each option shows the penalty and the new monthly payment. It is disabled when cash
    is short.
  - **Refinance at 3.12%** is enabled only when the current new-bond rate is at least 0.05% below
    the bond's coupon. The confirm dialog reads "Fee $9.7M now · saves $0.4M a month · pays for
    itself in 2 y 1 m".
- Sandbox shows the market and rating for information, with "Sandbox — borrowing is off".

**Fleet**
- A table per class (heavy, light): cars running on routes, cars the plan needs, idle cars, cars
  in the spare pool.
- **Sell spare heavy cars (24) for $24M**, and per route **Sell idle (20 cars) for $20M**. Both
  go through `confirmDialog` with "They cost $60M new. Maintenance falls by $0.6M a year."
- A hint: "Sold cars leave service. If a route needs them back, new ones cost full price."

### 2.5 Year in review (new modal)

`showYearReview(app, year)` in `reports.ts` appears on the first weekday of January. It **replaces**
the December month report, and December's line is shown inside it. Layout:

```
2030 in review                                       7 Jan – 31 Dec · 257 weekdays
[ 1.21M riders/day ] [ 21% transit share ] [ −$0.31B cash ] [ A → BBB ]
Ridership   bar chart: average riders/day by month (barChart, teal)
            Peak day 1.34M (Thu 12 Dec) · up 2,140% on January
Money       Fares $0.88B · Operating −$0.57B · Interest −$0.43B · Fees −$0.01B
            Capital −$23.4B · Profit −$0.12B · Debt $0 → $18.0B · Cash $6.0B → $0.6B
Credit      Jan AAA → Feb A → Apr BBB (2 changes) · ended BBB
Bond market low 2.11% (Jun) · high 3.02% (Oct) · 1 shock (Oct, +0.75%)
Service     Avg lateness 88 s · bunched 6.4% · extra wait +41 s
Goals       ✓ Open your first line · ✓ Cross the East River · ✓ 1M daily riders
                                            [Open finances]  [Continue]
```

In sandbox the Money and Credit sections are replaced by "Sandbox — money unlimited".

### 2.6 Controls and tooltips (README additions)

| Key / control | Action | Where |
|---|---|---|
| **M** | Open / close the Finances panel | global, `app.ts` `onKey` |
| **H** | Toggle holding on the selected route (toast confirms) | global when `selection.kind === 'route'` |
| Finances toolbar button | tooltip "Income, costs, bonds, fares, fleet" with shortcut **M** | `toolbar.ts:45` |
| Clock toggles in the stop list | timepoints | route panel |

`F`, `Q` and `E` are left alone: express-quad uses `F` and `Q` inside the track tool and `E` in
the route tool. `G` is living-city's.

### 2.7 Toasts

- At a monthly review:
  - "Credit rating upgraded to A" (green) or "Credit rating downgraded to BB — new bonds now
    3.80%" (amber or red).
  - "Bond market shock: rates up 0.75%" (amber).
- On prepaying: "Prepaid $250M on bond 3 · fee $2.5M".
- On refinancing: "Refinanced bond 3 at 2.21% · saves $0.4M/month".
- On selling cars: "Sold 20 cars for $20M".
- With the H key: "Holding on for A Lexington".

---

## 3. Data model

```ts
// src/routes/types.ts — Route gains a required field (line 6-20)
export interface RouteControl {
  /** Hold departures whose gap to the train ahead is below holdFraction × scheduled headway. */
  hold: boolean;
  holdFraction: number;            // one of OPS_CONTROL.holdFractionChoices
  /** Station ids where trains may be held mid-route (terminals always count when hold is on). */
  timepoints: number[];
  /** Recovery added to each terminal layover, as a share of the one-way run time. */
  recoveryPct: number;             // one of OPS_CONTROL.recoveryChoices
}
export interface Route { …; control: RouteControl }

// src/sim/protocol.ts — compiled additions (all optional so v1 test fixtures still type-check)
export interface CRouteDir { …; /** 1 where trains may be held (never the first or last stop). */ timepoint?: Uint8Array }
export interface CRoute    { …; /** Hold fraction of the headway, 0 = holding off. */ hold?: number; /** Settings fingerprint for App.recompile. */ opsKey?: string }

// src/economy/fares.ts
export interface FarePolicy { peak: number; offPeak: number; /** multiplier for earnings band 0 */ lowIncome: number }

// src/economy/finance.ts
export interface Bond {
  id: number; principal: number; balance: number; monthlyPayment: number; issuedDay: number;
  /** Annual coupon. */ rate: number;
  /** Level payments still to make. */ monthsLeft: number;
  /** Rating when issued or last refinanced. */ rating?: Rating;
  refinancedDay?: number;
}
export interface DayLedger { …; /** prepay penalties + refinance fees, paid at once */ fees: number; /** principal prepaid at once */ prepaid: number; kpi?: DayKpi }
export interface DayKpi { transitShare: number; lateness: number; bunched: number; ewt: number }
export interface MonthReport { …; interest: number; fees: number; prepaid: number; debtEnd: number; kpi?: DayKpi; rating?: Rating; newRate?: number }
export interface MarketMonth { key: string; label: string; base: number; rating: Rating; newRate: number; avgCost: number; score: number; shock: number }
export interface MarketData { seed: number; base: number; rating: Rating | null; score: number; history: MarketMonth[] }
export interface FinanceData { …; market: MarketData }
export interface FinanceEvent { kind: 'upgrade' | 'downgrade' | 'shock'; title: string; body: string; tone: 'green' | 'amber' | 'red' }

// src/sim/regularity.ts
export interface RegularityStats {
  samples: number;     // headways measured
  cv: number;          // sd ÷ mean of h/H
  bunched: number;     // share with h < bunchFactor·H
  gaps: number;        // share with h > gapFactor·H
  ewt: number;         // excess wait, s per random-arrival rider
  holds: number; holdSec: number;
  termLate: number;    // mean lateness arriving at terminals, s
}
```

`Train` (`trainSim.ts:18-40`) gains `holdCap: number` and `holdStart: number`, both NaN when the
train is not being held. `TrainDayStats` (`trainSim.ts:64-70`) gains `shortTurns: number`.

---

## 4. Algorithms

### 4.1 Terminal holding (in `runDispatch`, `trainSim.ts:238-278`)

v1 pushes a departure slot every headway (at most 2 pending), and dispatches a waiting train as
soon as there is a pending slot and the platform region is free (`:257`). When trains run late,
both pending slots are overdue, so two trains leave back to back. This is the bunching seen at
stop 0 in the prototype, with CV 0.79 at the first stop.

```ts
// after the regionFree check at :257, before shifting the slot at :258
if (r.hold) {
  const H = r.headways[periodIndex(t)];
  const last = this.regFor(r).lastDep[d][0];         // previous departure from stop 0 (§4.4)
  if (H > 0 && t + OPERATIONS.dwellBase - last < r.hold * H) {
    if (isNaN(ds.holdSince[d])) ds.holdSince[d] = t;  // DispatchState gains holdSince: [number, number]
    continue;                                         // try again next step
  }
}
// on dispatch:
if (!isNaN(ds.holdSince[d])) { reg.holds++; reg.holdSec += t - ds.holdSince[d]; ds.holdSince[d] = NaN; }
```

Terminal holds are off the running track (the train is still `Ready`), so they never block
anyone. Each one ends within `hold × H`. Slots keep ticking. If a hold outlasts two slots, the
oldest is dropped by the existing cap (`:251`), which is the same as a cancelled trip.
`tr.late = t − slot` (`:270`) still records the start as late. That is honest, and §2.2
explains it.

### 4.2 Timepoint holding (in `step`, `trainSim.ts:219-221`)

```ts
case TState.Dwelling:
  if (t >= tr.until && !this.holdAtTimepoint(tr, t)) this.leaveStop(tr, t);
  break;

private holdAtTimepoint(tr: Train, t: number): boolean {
  const r = this.net!.routes[tr.route];
  const dir = r.dirs[tr.dir];
  if (!r.hold || !dir.timepoint?.[tr.stop]) return false;      // compile never flags first/last stop
  const H = r.headways[periodIndex(t)];
  const last = this.regFor(r).lastDep[tr.dir][tr.stop];        // train ahead left this stop at `last`
  if (!(H > 0) || !isFinite(last)) return false;
  const target = last + r.hold * H;
  if (isNaN(tr.holdCap)) {                                      // deciding whether to start a hold
    if (t >= target) return false;
    tr.holdCap = t + OPS_CONTROL.maxHoldPerStop;
    tr.holdStart = t;
    this.releaseLocksAhead(tr);                                 // don't sit on a junction claim while waiting
  }
  const end = Math.min(target, tr.holdCap);
  if (t >= end || this.otherRouteQueuedBehind(tr, r)) { this.endHold(tr, r, t); return false; }
  tr.until = Math.min(end, t + TIME.simStep);                   // re-check every step (yield rule)
  return true;
}
private endHold(tr, r, t) { if (isNaN(tr.holdCap)) return; const g = this.regFor(r); g.holds++; g.holdSec += t - tr.holdStart; tr.holdCap = tr.holdStart = NaN; }
```

- **Yield rule.** `otherRouteQueuedBehind` calls the exported pure helper
  `queuedBehind(occ, track, uTail, lookback, route, routeOfOcc)`. The helper takes the element
  that holds the train's tail (it walks `tr.elem` back while `elems[k].s0 > s − L`). It returns
  true if any occupancy entry on that track has `head ∈ [uTail − yieldLookback, uTail]` and
  belongs to a different route index. Occupancy is rebuilt at the top of `step` (`:214`), so the
  check is current. Limit: a train waiting on a *different* feeder track just before a junction
  behind the platform is not seen. The 90 s cap bounds that case.
- **`releaseLocksAhead(tr)`** releases the claims in `tr.locks` whose `s0 > tr.s` (junctions the
  head has not reached). Claims the train is still physically on stay. Without this, a held
  train that claimed a merge during its approach (the lookahead at `:372-389`) would block other
  routes at the junction for the whole hold.
- During the hold, `tr.until` moves forward. `leaveStop` calls `hooks.depart` (`:474`), so people
  who arrive during the hold still board. `toReady` (`:187`) resets `holdCap` and `holdStart`.
- **Snapshot.** `engine.snapshot` (`engine.ts:120`) writes `arr[o+7] = isNaN(t.holdCap) ? t.state :
  SNAP_HELD`.

### 4.3 Recovery and the short turnaround

- **Fleet sizing.** `trainsNeeded` (`compile.ts:177-183`):
  ```ts
  const run = runTimes[0] + runTimes[1];
  const roundTrip = run * (1 + (r.control?.recoveryPct ?? 0)) + 2 * OPERATIONS.turnaround;
  return Math.ceil(roundTrip / minHw) + OPERATIONS.spareTrains;
  ```
  `routePanel.ts:54` uses the same formula. The extra trains wait in the terminal pool, which is
  the recovery time in a pooled-dispatch model (§1 non-goals). The sim needs no other change for
  recovery itself.
- **Short turnaround** (`leaveStop` terminal branch, `trainSim.ts:466-473`) applies on every route:
  ```ts
  const od = tr.dir === 0 ? 1 : 0, ds = this.dispatch[tr.route];
  const due = ds.ready[od].length === 0 && (ds.pending[od].length > 0 || ds.next[od] < t + OPERATIONS.turnaround);
  tr.until = t + (due ? OPS_CONTROL.turnaroundMin : OPERATIONS.turnaround);
  if (due) this.day.shortTurns++;
  ```
  It applies to migrated routes too. It is a small, strictly positive change (§12).

### 4.4 Regularity statistics (`src/sim/regularity.ts`, pure)

`TrainSim.regById: Map<routeId, RouteReg>` holds, per route and direction, typed arrays sized to
the stop count:

- `lastDep[d][k]`: the last departure time from each stop.
- `n`, `sx`, `sxx` per stop.
- Route-level sums `sumH = Σh`, `sumH2 = Σh²`, `sumHS = Σh·H` (seconds).
- Counters `bunched`, `gaps`, `holds`, `holdSec`, `termLateSum` and `termLateN`.

`setNetwork` keeps a route's `RouteReg` when `samePaths(prev, r)` holds (`:104`); otherwise it
creates a new one.

```ts
// leaveStop (non-terminal, including stop 0), after hooks.depart:
recordHeadway(g, tr.dir, tr.stop, t, r.headways[periodIndex(t)], periodIndex(g.lastDep[tr.dir][tr.stop]) === periodIndex(t));

export function recordHeadway(g, d, k, t, H, samePeriod) {
  const last = g.lastDep[d][k]; g.lastDep[d][k] = t;
  if (!isFinite(last) || !(H > 0) || !samePeriod) return;     // first train, no service, or period change
  const h = Math.min(t - last, OPS_CONTROL.maxHeadwayFactor * H);
  const x = h / H;
  g.n[d][k]++; g.sx[d][k] += x; g.sxx[d][k] += x * x;
  g.sumH += h; g.sumH2 += h * h; g.sumHS += h * H;
  if (x < OPS_CONTROL.bunchFactor) g.bunched++; else if (x > OPS_CONTROL.gapFactor) g.gaps++;
}
// arriveAt at the last stop (stopIdx === n − 1): g.termLateSum += max(0, tr.late); g.termLateN++.

export function summarize(g): RegularityStats {
  const N = Σ n, SX = Σ sx, SXX = Σ sxx;                      // pooled over stops and directions
  const mean = SX / N;
  return { samples: N,
    cv: N > 1 ? Math.sqrt(Math.max(0, SXX / N - mean * mean)) / mean : 0,
    bunched: N ? g.bunched / N : 0, gaps: N ? g.gaps / N : 0,
    // Riders arriving at random wait Σh²/(2Σh); a perfect timetable gives ΣhH/(2Σh).
    ewt: g.sumH > 0 ? (g.sumH2 - g.sumHS) / (2 * g.sumH) : 0,
    holds: g.holds, holdSec: g.holdSec, termLate: g.termLateN ? g.termLateSum / g.termLateN : 0 };
}
```

Worked check (it becomes a unit test). Alternating headways of 0.4H and 1.6H give x = 0.4, 1.6.
The mean is 1 and the sd is 0.6, so CV = 0.6. Bunched = 0.5 and gaps = 0.5.
EWT = (0.4H·(−0.6H) + 1.6H·0.6H)/(2·2H) = 0.18H.

`rollDay(g)` stores `summarize(g)` and `cvByStop(g)` as yesterday's values. It then zeroes the
accumulators but keeps `lastDep`, so the first morning headway is measured against last night's
train. The period check then skips it. `poolStats(list)` merges routes into the network-level
figure: it adds up the raw sums and recomputes, which `RouteReg` can do because it keeps the sums.

### 4.5 Recovery advisor and timepoint suggestion

- `suggestRecovery(termLate, runTime) = smallest choice ≥ recoverySuggestFactor · termLate ÷
  runTime` (capped at 20%). The panel shows it when it is above the current `recoveryPct`.
- `suggestTimepoints(route, routes)` lives in `src/routes/control.ts`. It looks at the
  intermediate stops sorted by distance to each target index `round(f · (n−1))` for f in
  `suggestTimepointsAt` [⅓, ⅔], and picks the first stop no other route serves (falling back to
  the nearest one). Each stop is picked once. Routes with fewer than 6 stops get one timepoint at
  the midpoint.

### 4.6 Fares in mode choice and billing (`src/sim/commuters.ts`)

**Peak classification.** `isPeakTime(t)`: the period of `timeOfDay(t)` from `OPERATIONS.periods`
is in `FARES.peakPeriods` (`['am', 'pm']`), which means 6–10 and 16–20.

**Per-agent peak flags.** These are set once in the constructor's agent loop (`commuters.ts:215-229`)
and use no extra RNG draws:
`aPeak[a] = (isPeakTod(aDepart[a]) ? 1 : 0) | (isPeakTod(aDepart[a] + FARES.amTripEstimate + aReturn[a]) ? 2 : 0)`.
The estimate matches the one already at `:522`. `gPeakFrac[g]` is the mean of
`popcount(aPeak)/2` over the group's agents. On the real data, 96.4% of trips start in a peak.

**Group fare (mode choice).** `dailyModeChoice` (`:464`):
`fare: expectedFare(this.fares, band, gPeakFrac[g])`, where

```ts
bandFactor(p, band) = band === FARES.lowIncomeBand ? p.lowIncome : 1
fareAt(p, band, peak) = bandFactor(p, band) * (peak ? p.peak : p.offPeak)
expectedFare(p, band, f) = bandFactor(p, band) * (f * p.peak + (1 - f) * p.offPeak)
```

`generalisedCosts` (`modeChoice.ts:59-73`) already turns the fare into minutes through the band's
value of time, so the fare reaches mode choice by both period and band.

**Per-agent tilt (draw).** In `drawModesAndSchedule` (`:506-516`), when the policy is not flat,
each group computes three odds multipliers, one for agents with 0, 1 or 2 peak trips:

```ts
const gf = expectedFare(p, band, gPeakFrac[g]);
const m = [0, 1, 2].map((k) => fareOddsMultiplier(tripFare(p, band, k) - gf, band)); // exp(−θ·minutes(Δfare))
// per agent: ptA = pt * m[popcount(aPeak[a])]; sum = pw + pd + ptA; draw as before with the same rng.next()
```

This is the exact logit result of shifting one alternative's utility. An off-peak traveller in a
group whose fare is mostly peak is more likely to ride. With a flat policy all multipliers are 1,
so draws match v1 exactly (same RNG sequence, same comparisons).

**Billing at boarding.** `board()` (`:697-698`), with `peak = isPeakTime(t) ? 1 : 0` taken out of
the loop:

```ts
if (!this.aBoarded[a]) {
  const band = this.gBand[this.aGroup[a]];
  const f = fareAt(this.fares, band, peak === 1);
  d.fareRevenue += f; d.fareCellTrips[band * 2 + peak]++; d.fareCellRevenue[band * 2 + peak] += f;
}
```

`newDayStats` (`:1034-1047`) gains `fareCellTrips` and `fareCellRevenue` (each `Float64Array(6)`)
and `bandMode` (`Float64Array(9)`, counted in `drawModesAndSchedule` as `bandMode[band*3+mode]++`).
`dayReport` (`:784-838`) adds `fares: { trips, revenue }` (scaled to people) and
`bandShare[b] = bandMode[b*3+2] / Σ_m bandMode[b*3+m]`.

**Measured trade-offs on the README core** (equilibrium logit, day-10 observations, 1.31M riders):

| Policy | Linked trips/day | Fare revenue/day | Band-0 trips |
|---|---|---|---|
| Flat $3.00 (v1) | 1,220,960 | $3.66M | 82,620 |
| Flat $3.50 | −0.9% | +15.6% | −2.5% |
| Peak $3.25 / off-peak $2.50 | −0.4% | +6.2% | −1.0% |
| Flat $3 + low-income half | +0.6% | −3.1% | **+8.4%** |
| Flat $3 + low-income free | +1.2% | −6.8% | **+17.6%** |
| Peak $3.50 / off $2.50 + half | −0.2% | +10.0% | +7.1% |

Fares are inelastic in v1 because people who choose transit gain a lot from it. The fare levers are
therefore mostly about revenue and equity, not ridership. The UI says so ("Lower earners are most
sensitive").

### 4.7 Bond market walk (`src/economy/credit.ts`, pure)

At each month end (`settleDay` when `isNewMonth(inp.day + 1)`, `finance.ts:182`), after bond
payments:

```ts
export function stepBaseRate(prev: number, seed: number, monthIdx: number): { rate: number; shock: number } {
  const rng = new Rng(mixSeed(seed, monthIdx));            // counter-based: the same month gives the same draw, whenever it is replayed
  let next = prev + BONDS.reversion * (BONDS.mean - prev) + BONDS.volatility * rng.normal();
  let shock = 0;
  if (rng.next() < BONDS.shockChance) { shock = (rng.next() < BONDS.shockUpShare ? 1 : -1) * BONDS.shockSize; next += shock; }
  return { rate: Math.round(clamp(next, BONDS.minRate, BONDS.maxRate) * 1e4) / 1e4, shock };
}
export const mixSeed = (seed: number, k: number) => (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35)) >>> 0 || 1;
```

`monthIdx = monthIndex(lastDay)` is a new calendar helper: `(year − 2030)·12 + month`. The base
starts at `BONDS.start` = 2.5% and is **not** stepped before the first month end, so month 1 is
exactly v1. The stationary sd is σ/√(1−(1−κ)²) ≈ 0.42%, so about 95% of months fall between 1.7%
and 3.3%, with shocks on top.

### 4.8 Credit rating (scorecard)

`Finance.creditInputs()` reads the last `CREDIT.windowDays` (60) settled days of `history`, where
*service days* are those with `riders > 0`:

```ts
revenuePerDay = mean(revenue over service days); opCostPerDay = mean(operating + staffing + maintenance over service days)
debt = Σ balance; annualInterest = Σ balance·rate; monthlyDebtService = Σ monthlyPayment
assets = assetValue; cash = this.cash; newRate = market.base + spreadOf(current rating)
```

`creditScore(inp)` gives each metric 0–100 points by piecewise-linear `interp` over the anchors
in `CREDIT` (§9):

| Metric | Formula | Not rated when |
|---|---|---|
| Farebox recovery R | revenue ÷ op cost | fewer than 10 service days → 80 points |
| Interest coverage C | (revenue − op cost)·261 ÷ (annual interest + $1B × new rate) | same → 80 |
| Leverage L | debt ÷ (assets + max(0, cash)) | never |
| Liquidity Q | cash ÷ (op cost × 21.75 + monthly debt service), in months; 0 if cash ≤ 0; ∞ if nothing is owed | never |

The score is S = 0.30·R + 0.30·C + 0.25·L + 0.15·Q. Notches are AAA ≥ 85, AA ≥ 75, A ≥ 65,
BBB ≥ 52, BB ≥ 40, B ≥ 28 and CCC below that. Coverage counts one new $1B chunk *pro forma*, so
a debt-free authority that loses money (sprawl) still rates poorly.

**Hysteresis.** `ratingFromScore(S, prev)` moves up only if S ≥ threshold + 2 and down only if
S < threshold − 2, so ratings don't flap from month to month. Spreads are AAA 0, AA +0.10%,
A +0.25%, BBB +0.60%, BB +1.25%, B +2.50% and CCC +4.50%.

Results computed with these anchors (same formulas):

| State | R | C | L | Q (mo) | Score | Rating | New bonds |
|---|---|---|---|---|---|---|---|
| New game: no debt, $6B cash | — | — | 0 | ∞ | 88.0 | **AAA** | 2.50% |
| Core under construction, $17B debt, $0.5B cash | — | — | 0.72 | 5.7 | 67.6 | A | 2.75% |
| Core 1.31M riders, $0.5B cash | 1.59 | 0.75 | 0.72 | 4.3 | 56.4 | **BBB** | 3.10% |
| Same, cash ≈ 0 | 1.59 | 0.75 | 0.74 | 0.4 | 48.4 | BB | 3.75% |
| Core 1.5M riders | 1.81 | 1.03 | 0.72 | 4.3 | 63.0 | BBB | 3.10% |
| Core 1.5M at $3.50 | 2.08 | 1.37 | 0.71 | 8.6 | 73.5 | A | 2.75% |
| Core paid down to $12B | 1.81 | 1.44 | 0.48 | 15.7 | 81.1 | AA | 2.60% |
| Sprawl, no debt | 0.05 | −8.4 | 0 | 55 | 40.0 | BB | 3.75% |
| Sprawl with $3B debt | 0.04 | −1.9 | 0.36 | 9.3 | 32.5 | B | 5.00% |
| $20B debt, cash < 0, losing money | 0.80 | −0.25 | 0.91 | 0 | 12.4 | CCC | 7.00% |

**Review** (`Finance.reviewMonth(lastDay)`, called right after `closeMonth` at `finance.ts:209`):

```ts
const res = creditScore(this.creditInputs());
const prev = this.market.rating;
const rating = ratingFromScore(res.score, prev);
const { rate, shock } = stepBaseRate(this.market.base, this.market.seed, monthIndex(lastDay));
this.market.history.push({ key, label, base: this.market.base, rating: prev ?? rating, newRate: this.newBondRate(),
                           avgCost: weightedCoupon(this.bonds), score: res.score, shock });   // cap at BONDS.historyMonths
if (prev && rating !== prev) this.events.push(upgrade or downgrade event);
if (shock) this.events.push(shock event);
this.market.rating = rating; this.market.score = res.score; this.market.base = rate;
// also stamp the month just closed: months.at(-1).rating = rating; .newRate = this.newBondRate()
```

`Finance.events` is cleared at the start of each `settleDay`. App reads it afterwards and shows
toasts. It is not saved.

### 4.9 Bonds: per-bond coupon, payments, prepay, refinance (`src/economy/finance.ts`)

```ts
export function annuityMonthly(P: number, annualRate: number, months: number): number {
  const i = annualRate / 12; if (months <= 0) return P; return i === 0 ? P / months : (P * i) / (1 - Math.pow(1 + i, -months));
}
export const annuityPayment = (P, r, years) => annuityMonthly(P, r, years * 12);       // v1 signature kept
/** Payments left on a level loan (inverse annuity); used to migrate v2 bonds. */
export function remainingPayments(balance: number, payment: number, annualRate: number, term = BONDS.termMonths): number {
  const i = annualRate / 12; if (balance <= 1) return 0; if (i === 0) return Math.ceil(balance / payment);
  const x = 1 - (balance * i) / payment; if (x <= 0) return term;
  return Math.min(term, Math.round(-Math.log(x) / Math.log(1 + i)));
}
```

- **Issue** (`issueBond`, `finance.ts:149-163`): `rate = this.newBondRate()`,
  `monthlyPayment = annuityMonthly(p, rate, BONDS.termMonths)`, `monthsLeft = termMonths`,
  `rating = market.rating ?? 'AAA'`.
- **Payments** (`:183-194`): `interest = b.balance * b.rate / 12 * held`. In the issue month the
  bond pays interest only (as in v1). Otherwise `pay = b.monthsLeft <= 1 ? b.balance + interest :
  Math.min(b.monthlyPayment, b.balance + interest)` and `b.monthsLeft--`. The last payment clears
  any rounding, so re-amortised bonds still mature on time.
- **Prepay** (`prepayBond(id, amount, day)`):
  - Refuse in sandbox. Refuse unless `0 < amount ≤ balance`, or when
    `cash < amount·(1+prepayPenalty)`.
  - Then `cash −= amount + fee`, `today.prepaid += amount`, `today.fees += fee`,
    `balance −= amount`.
  - If `balance ≤ 1`, remove the bond. Otherwise set
    `monthlyPayment = annuityMonthly(balance, rate, monthsLeft)`, so the bond keeps its maturity
    with a lower payment.
  - Bond room is freed at once, because `debt()` falls.
- **Refinance** (`refinanceBond(id, day)`):
  - `r1 = this.newBondRate()`. Refuse if `r1 > b.rate − BONDS.refinanceMinGain` or
    `cash < fee`, where `fee = balance·refinanceFee`.
  - Then `cash −= fee`, `today.fees += fee`, `b.rate = r1`,
    `b.monthlyPayment = annuityMonthly(balance, r1, monthsLeft)`,
    `b.rating = market.rating ?? 'AAA'`, `b.refinancedDay = day`.
  - Debt is unchanged. It returns `{ fee, saving: oldPayment − newPayment, paybackMonths: fee ÷ saving }`.
- **Ledger.** `fees` and `prepaid` are spent at once and so are **not** in the settle cash formula
  (`:197-199`), just as construction spending isn't. `closeMonth` (`:214-234`) sums
  `interest`, `fees` and `prepaid`, records `debtEnd = this.debt()` and `kpi` averages, and uses
  `profit = revenue − operatingCosts − interest − fees`.
- **Bankruptcy** is unchanged (`:204-207`).

### 4.10 Car sales (`src/routes/fleet.ts`)

```ts
export const carSaleValue = (cls: TrackClass, cars: number) => cars * TRAINS[cls].costPerCar * FLEET.resaleFraction;
export function idleCars(game: Game, r: Route): number {          // only for routes with a path
  const plan = fleetPlan(game, r); return plan.runTimes ? Math.max(0, r.ownedCars - plan.carsNeeded) : 0;
}
export function sellIdleCars(game: Game, r: Route): { ok: boolean; cars: number; proceeds: number; reason?: string } {
  const n = idleCars(game, r); if (!n) return { ok: false, cars: 0, proceeds: 0, reason: 'No idle cars' };
  const proceeds = game.finance.refund(n * TRAINS[r.cls].costPerCar, FLEET.resaleFraction);   // drops full cost from assetValue
  r.ownedCars -= n; game.routes.invalidate(); game.events.emit('routes', undefined); game.events.emit('money', undefined);
  return { ok: true, cars: n, proceeds };
}
export function sellSpareCars(game: Game, cls: TrackClass, n = game.routes.spareCars[cls]): … // same, from the pool, no 'routes' emit
```

This reuses `Finance.refund()` (`finance.ts:132-138`), which already books
`cash += cost × fraction` and `assetValue −= cost`. Proceeds show under "Construction & trains"
net of refunds. `purchaseFleet` (`fleet.ts:32-41`) is unchanged: a route that later needs cars
draws on the spare pool and then buys new ones at full price.

### 4.11 Year in review (`src/economy/yearReview.ts`, pure)

`buildYearReview(finance, goals, year)` puts together:
- `finance.months` whose key starts with `${year}-`: riders, revenue, operatingCosts, interest,
  fees, capital, profit, cashEnd, debtEnd and kpi.
- `finance.history` (≤ 400 days, which covers a 261-day year) for the peak day.
- `market.history` for the rating timeline (it compares consecutive months), the low and high base
  rate, and shocks.
- `goals` completed during the year (`dateOfDay(day).getUTCFullYear() === year`).

The year's opening cash and debt come from the previous year's last month, or
`ECONOMY.startingCash` and 0. It returns plain numbers and strings, so it is unit-tested without
a DOM.

---

## 5. Exact changes per existing file

### Simulation (worker side)
- **`src/sim/trainSim.ts`** (+150):
  - `Train` (18-40): add `holdCap` and `holdStart`. `newTrain` (164-185) inits them to NaN, and
    `toReady` (187-198) resets them.
  - `DispatchState` (52-56): add `holdSince: [number, number]`.
  - `TrainDayStats` and `newDayStats` (64-70, 495-497): add `shortTurns`.
  - New fields `regById: Map<number, RouteReg>` and `yesterdayById`.
  - `setNetwork` (102-158): keep or create `RouteReg` per route (§4.4). Initialise
    `holdSince` to NaN.
  - `runDispatch` (238-278): terminal hold (§4.1).
  - `step` (219-221): timepoint hold (§4.2). New private methods `holdAtTimepoint`, `endHold`,
    `otherRouteQueuedBehind` and `releaseLocksAhead`, plus the exported pure `queuedBehind`.
  - `arriveAt` (439-461): add to the terminal lateness sum at the last stop.
  - `leaveStop` (463-478): short turnaround (466-473), `endHold` and `recordHeadway` after
    `hooks.depart` (474).
  - New public methods:
    - `closeDayRegularity(): { routes: Record<number, RegularityStats>; network: RegularityStats }`
      calls `rollDay` on every route.
    - `regularityDetail(routeId)` returns `{ today, yesterday, cvByStop, timepoints,
      suggestRecovery }`.
- **`src/sim/engine.ts`** (+25):
  - `EngineOptions.fare` (23) becomes `fares: FarePolicy`. `setFare` (62-64) becomes
    `setFares(p)`.
  - `closeDay` (90-106): before `this.trains.resetDay()` (104), call
    `const reg = this.trains.closeDayRegularity()` and add `routeRegularity: reg.routes` and
    `regularity: reg.network` to the report.
  - `snapshot` (120): `SNAP_HELD`.
  - `emptyReport` (129-153): add empty `fares`, `bandShare`, `routeRegularity` and `regularity`.
- **`src/sim/commuters.ts`** (+60):
  - Field `fare` (112) becomes `fares: FarePolicy`. Add `aPeak: Uint8Array` and
    `gPeakFrac: Float32Array`.
  - Constructor (138; 141; agent loop 215-229) fills them.
  - `setFare` (260-262) becomes `setFares`. New public `groupFare(g)`, used by the tests and by
    `dailyModeChoice`.
  - `dailyModeChoice` (464), `drawModesAndSchedule` (506-516), `board` (683-708),
    `dayReport` (797-821) and `newDayStats` (1034-1047): as §4.6.
- **`src/sim/modeChoice.ts`** (+6): `export function fareOddsMultiplier(dFare, band, theta =
  COMMUTERS.logitScale) { return Math.exp(-theta * moneyToMinutes(dFare, band)); }`.
- **`src/sim/protocol.ts`** (+45): see §7.
- **`src/sim/worker.ts`** (+10):
  - `init` (31) passes `fares: msg.fares`.
  - `handle` (69-71): `case 'fares': engine.setFares(msg.fares)`.
  - `answer` `route` (85-90) adds `regularity: engine!.trains.regularityDetail(q.route)`.
- **`src/sim/client.ts`** (+4): `init` opts (51) take `fares`. `setFare` (68-70) becomes
  `setFares(fares)`.
- **`src/sim/headless.ts`** (+35):
  - `createHeadlessGame` (23-26) accepts `fares?: FarePolicy` (alongside the legacy `fare?`) and
    `marketSeed?`.
  - `makeRoute` (79-84) accepts `control?: Partial<RouteControl>`.
  - `runDays` (163-183) passes `fares: game.fares` (167). `settleDay` (171) adds
    `kpi: { transitShare, lateness: r.avgLateness, bunched: r.regularity.bunched, ewt: r.regularity.ewt }`.
  - New export `syntheticLine(opts)`, which builds a straight two-track `CompiledNetwork` with real
    `elems` (one element per direction on tracks 0 and 1, `lock: −1`), `runProfile` timetables and
    optional timepoints. It is used by `tests/ops.test.ts` and the balance script.

### Routes and compile
- **`src/routes/types.ts`** (+15): `RouteControl` and `Route.control` (6-20).
- **`src/routes/control.ts`** (new): defaults and suggestion (§6).
- **`src/routes/routeSet.ts`** (+15):
  - `create` (30-35) takes `control?` and fills `defaultControl()`.
  - `load` (122-128) copies `control` with `{ ...legacyControl(), ...r.control, timepoints:
    [...(r.control?.timepoints ?? [])] }`.
  - `pruneMissing` also drops missing station ids from `control.timepoints`.
- **`src/routes/routeTool.ts`** (+1): `asRoute` (93-107) adds
  `control: existing?.control ?? defaultControl()`.
- **`src/routes/compile.ts`** (+20):
  - `trainsNeeded` (177-183): recovery (§4.3).
  - `buildDir` (56-66) gains a `timepoints: Set<number>` parameter. Its return (159-174) adds
    `timepoint: Uint8Array.from(stopIds, (id, k) => (k > 0 && k < stopIds.length − 1 &&
    timepoints.has(id) ? 1 : 0))`.
  - `compileRoute` (222-223 calls; return 225-241) adds
    `hold: r.control.hold ? r.control.holdFraction : 0` and
    `opsKey: `${hold}|${[...tps].sort().join(',')}``.
- **`src/routes/fleet.ts`** (+45): `carSaleValue`, `idleCars`, `sellIdleCars`, `sellSpareCars`
  (§4.10).

### Economy and core
- **`src/economy/finance.ts`** (+170):
  - `Bond` (41-48), `DayLedger` (10-25), `MonthReport` (27-39), `DayInputs` (50-58; add
    `kpi?: DayKpi`) and `FinanceData` (60-71; add `market`) as §3. `blankDay` (73-89) zeroes
    `fees` and `prepaid`.
  - `annuityMonthly` and `remainingPayments` (§4.9).
  - The constructor (112-116) takes a third parameter, `seed = BONDS.defaultSeed`, and builds
    `market = { seed, base: BONDS.start, rating: 'AAA', score: 100, history: [] }`.
  - `issueBond` (149-163), the payment loop (183-194), `closeMonth` (214-234) and `settleDay` (169;
    store `kpi`; `events.length = 0`; call `reviewMonth` after `closeMonth` at 209): as §4.8-4.9.
  - New methods `newBondRate()`, `creditInputs()`, `previewCredit()`, `reviewMonth()`,
    `prepayBond()`, `refinanceBond()`, `weightedCoupon()` and `events: FinanceEvent[]`.
  - `toData` (244-259) adds `market` but not `events`. `fromData` (261-265) runs
    `if (!f.market.rating) f.market.rating = ratingFromScore(creditScore(f.creditInputs()).score,
    null)` for migrated saves.
- **`src/core/game.ts`** (+8): `fare: number` (50) becomes `fares: FarePolicy`. Constructor opts
  (57) become `{ sandbox; fares: FarePolicy; marketSeed?: number }`, and it passes the seed to
  `new Finance(...)` (61).
- **`src/core/calendar.ts`** (+4): `export function monthIndex(day)`, and
  `export const yearOf = (day) => dateOfDay(day).getUTCFullYear()`.
- **`src/core/goals.ts`** (+15):
  - `GOAL_DEFS` (18-27) adds two goals:
    - `{ id: 'rating-a', title: 'Investment grade', detail: 'Hold an A rating or better while
      owing at least $5B.' }`
    - `{ id: 'clockwork', title: 'Clockwork service', detail: 'Under 5% of headways bunched across
      3+ routes on a day with 500k+ riders.' }`
  - `checkGoals` (83-90) marks them from `game.finance.market` and `report.regularity`, with
    `!game.sandbox` for the rating goal.

### UI
- **`src/ui/app.ts`** (+90):
  - The `Game` built at line 138 passes `fares: flatFares(ECONOMY.fareDefault)` and
    `marketSeed: opts.save ? undefined : freshMarketSeed()`, where
    `freshMarketSeed = () => crypto.getRandomValues(new Uint32Array(1))[0] || BONDS.defaultSeed`
    (main thread only, once per new career, then saved).
  - `sim.init` (219) passes `fares: this.game.fares`.
  - `recompile` sig (354) adds `r.opsKey` to each route tuple. Without this, holding changes would
    never reach the worker.
  - `onDayEnd` (412-438):
    - `settleDay` passes `kpi`.
    - Toast every `g.finance.events`.
    - At month end: if `monthKey(r.day + 1).endsWith('-01')`, call
      `showYearReview(this, yearOf(r.day))`; otherwise `showMonthReport`.
  - `setFare` (696-701) becomes `setFares(p: FarePolicy)`, using `normalizeFares` and the toast
    from §2.4.
  - `issueBond` (703-708): the toast uses `b.rate`.
  - New methods: `prepayBond(id)` (opens the modal), `refinanceBond(id)`,
    `sellSpareCars(cls)`, `sellIdleCars(routeId)` (each confirms, then toasts), `toggleHolding(id)`,
    `showYearReview(year?)`, and the field `financeTab`.
  - `onKey` switch (781-820) adds `m`/`M` (toggle `{ kind: 'finance' }`) and `h`/`H` (if a route is
    selected).
- **`src/ui/panels/financePanel.ts`** (rewrite, ≈ 260): the tabs in §2.4. Each tab is a small
  render function in the same file (`overviewTab`, `faresTab`, `borrowingTab`, `fleetTab`). Charts
  are destroyed on re-render and on `destroy` (as in v1).
- **`src/ui/panels/routePanel.ts`** (+150):
  - `draft` (106) adds `control: structuredClone(r.control)`.
  - Operations section (§2.1) after Train length (131-136).
  - Timepoint toggles in stop rows (92-101).
  - Regularity section and chart (§2.2).
  - `renderStats` (158-166) adds the Regularity card.
  - `fetch` (183-190) reads `d.regularity`.
  - Apply (112-127) passes `control: draft.control` to `routes.update`.
  - `fleetLine` (51-71) adds recovery and idle rows and the sell button.
  - `routesList` (265-276) adds the regularity tag.
  - The `RouteDetail` interface (17-24) adds `regularity`.
- **`src/ui/panels/inspectPanels.ts`** (+6): held state (35, 40).
- **`src/ui/charts.ts`** (+60):
  - `export function rateChart(el, labels, base, yours, avgCost, width = 330, height = 160)`: y in
    %, teal/orange/grey dashed (`#C9D1D9`, as `loadChart` uses), live legend, styled like
    `financeChart` (79-100).
  - `export function regularityChart(el, stopLabels, cv0, cv1, names: [string, string], width = 330,
    height = 150)`: two lines (teal, orange), y from 0 to max(1, max·1.1), and a dashed guide series
    at `OPS_CONTROL.cvGood`.
- **`src/ui/reports.ts`** (+120):
  - `showMonthReport` (9-34) adds a row `Credit rating · BBB (was A) · new bonds 3.12%` when
    `m.rating` is set, and a `Financing fees` row.
  - New `showYearReview(app, year)` (§2.5), which uses `buildYearReview` and `barChart`.
- **`src/ui/toolbar.ts`** (+1): the finance tooltip (45) gets key `M` and the body "Income, costs,
  bonds, fares, fleet".
- **`src/ui/icons.ts`** (+1): `clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5 V12 L15
  14"/>'`.
- **`src/ui/styles.css`** (+30):
  - `.rating-badge` (font-weight 800, tones: AAA–A `--green`, BBB `--text`, BB–B `--amber`, CCC
    `--red`).
  - `.score-bar` and `.score-bar > i` (a 4 px meter on `--panel-line`).
  - `.tp-toggle` (an 18 px ghost button; `.on` is amber).
  - `.fin-tabs` (a full-width `.seg` with 8 px bottom margin).

### Save, scripts, docs
- **`src/save/format.ts`, `migrate.ts`, `serialize.ts`**: see §8.
- **`scripts/balance.ts`** (+20):
  - Flags `control=legacy|default|tp`, `peak=`, `off=`, `low=`.
  - Prints a `credit:` line computed by `creditScore` from the scenario's debt needed and an
    assumed $0.5B cash buffer.
  - Prints regularity per day (`CV`, `bunched`, `holds`).
  - `makeRoute` (200) passes `control` by flag.
- **`scripts/perf.ts`** (+8): the `Engine` options (29) pass `fares`. Perf routes use
  `{ hold: true, timepoints: suggestTimepoints(...), recoveryPct: 0 }`, so the fleet stays at 431
  trains while the hold path still runs. It prints `holds` in the peak hour.
- **`README.md`**:
  - Controls: M and H.
  - New "Operations control" and "Money market" sections.
  - Balance rows for OPS_CONTROL, FARES, BONDS and CREDIT. "Bond rate is 2.5%" becomes "the
    market's long-run mean is 2.5%, and month 1 borrows at exactly 2.5%".
  - Remove the known issue "There are no timetable recovery or holding rules".
  - Update the test count and re-measure the core and sprawl rows (§12).

---

## 6. New files and their exports

```ts
// src/sim/regularity.ts (≈110, pure: worker + Node)
export interface RegularityStats { … }                    // §3
export interface RouteReg { routeId: number; lastDep: [Float64Array, Float64Array]; n: [Float64Array, Float64Array];
  sx: [Float64Array, Float64Array]; sxx: [Float64Array, Float64Array]; sumH: number; sumH2: number; sumHS: number;
  bunched: number; gaps: number; holds: number; holdSec: number; termLateSum: number; termLateN: number; termRun: number }
export function newRouteReg(routeId: number, stops0: number, stops1: number, runTime: number): RouteReg;
export function recordHeadway(g: RouteReg, d: 0 | 1, k: number, t: number, H: number, samePeriod: boolean): void;
export function summarize(g: RouteReg): RegularityStats;
export function cvByStop(g: RouteReg): [number[], number[]];   // −1 where no samples; dir 1 reversed to dir-0 order
export function rollDay(g: RouteReg): { stats: RegularityStats; byStop: [number[], number[]] };
export function poolStats(gs: RouteReg[]): RegularityStats;
export function emptyStats(): RegularityStats;
export function grade(cv: number): 'even' | 'uneven' | 'bunched';
export function suggestRecovery(termLate: number, runTime: number): number;

// src/economy/credit.ts (≈130, pure)
export type Rating = (typeof CREDIT.ratings)[number];           // 'AAA' | … | 'CCC'
export interface CreditInputs { revenuePerDay: number; opCostPerDay: number; serviceDays: number; debt: number;
  annualInterest: number; monthlyDebtService: number; assets: number; cash: number; newRate: number }
export interface CreditMetric { id: 'farebox' | 'coverage' | 'leverage' | 'liquidity'; label: string;
  value: number | null; points: number; weight: number; display: string; hint: string }
export interface CreditResult { score: number; rating: Rating; metrics: CreditMetric[] }
export function interp(x: number, xs: readonly number[], ys: readonly number[]): number;
export function creditScore(inp: CreditInputs): CreditResult;         // rating here has no hysteresis
export function ratingFromScore(score: number, prev: Rating | null): Rating;
export function ratingIndex(r: Rating): number;
export function spreadOf(r: Rating): number;
export function nextNotchScore(r: Rating): number | null;            // "A needs 67" in the panel
export function mixSeed(seed: number, k: number): number;
export function stepBaseRate(prev: number, seed: number, monthIdx: number): { rate: number; shock: number };

// src/economy/fares.ts (≈60, pure)
export interface FarePolicy { peak: number; offPeak: number; lowIncome: number }
export function flatFares(f: number): FarePolicy;
export function normalizeFares(p: Partial<FarePolicy> | undefined, fallback = ECONOMY.fareDefault): FarePolicy; // clamp, step, offPeak ≤ peak, lowIncome ∈ choices
export function isFlat(p: FarePolicy): boolean;
export function isPeakTod(secondsOfDay: number): boolean;
export function isPeakTime(t: number): boolean;
export function bandFactor(p: FarePolicy, band: number): number;
export function fareAt(p: FarePolicy, band: number, peak: boolean): number;
export function tripFare(p: FarePolicy, band: number, peakTrips: number): number;   // mean of the two one-way fares
export function expectedFare(p: FarePolicy, band: number, peakFrac: number): number;
export function fareSummary(p: FarePolicy): string;                 // "$3.00" | "$3.50 peak / $2.50 off-peak · low-income half"

// src/economy/yearReview.ts (≈80, pure)
export interface YearReview { year: number; firstDay: number; lastDay: number; weekdays: number;
  riders: { avgDaily: number; peak: { day: number; riders: number } | null; byMonth: { label: string; avg: number }[]; growthPct: number | null };
  share: number; money: { fares: number; operating: number; interest: number; fees: number; capital: number; profit: number;
    cashStart: number; cashEnd: number; debtStart: number; debtEnd: number };
  credit: { start: Rating | null; end: Rating | null; changes: { label: string; from: Rating; to: Rating }[] };
  market: { low: { label: string; rate: number } | null; high: …; shocks: { label: string; size: number }[] };
  service: { lateness: number; bunched: number; ewt: number }; goals: string[] }
export function yearsWithData(f: Pick<FinanceData, 'months'>): number[];
export function buildYearReview(f: Pick<FinanceData, 'months' | 'history' | 'market'>, goals: GoalState, year: number): YearReview;

// src/routes/control.ts (≈40)
export function defaultControl(): RouteControl;        // hold on 0.7, no timepoints, recovery 10%
export function legacyControl(): RouteControl;         // hold off, recovery 0 (migrated routes)
export function suggestTimepoints(r: Route, all: Route[]): number[];
export function controlSummary(c: RouteControl): string;   // "holding 70% · 2 timepoints · recovery 10%"

// tests/ops.test.ts, tests/credit.test.ts, tests/fares.test.ts (§13)
```

---

## 7. Worker protocol additions (`src/sim/protocol.ts`)

```ts
import type { FarePolicy } from '../economy/fares';
import type { RegularityStats } from './regularity';

export const SNAP_HELD = 4;               // Snapshot train state: dwelling, held by the dispatcher

export interface CRouteDir { …; timepoint?: Uint8Array }           // lines 30-48
export interface CRoute    { …; hold?: number; opsKey?: string }   // lines 50-67

export interface FareBreakdown {
  /** Real people / dollars, indexed band * 2 + (peak ? 1 : 0). */
  trips: number[];     // length 6
  revenue: number[];   // length 6
}
export interface RouteRegularityDetail {
  today: RegularityStats;
  yesterday: RegularityStats | null;
  /** Headway CV per stop in direction-0 order; −1 = no data. */
  cvByStop: [number[], number[]];
  /** Stop indices (direction-0 order) that are timepoints. */
  timepoints: number[];
  /** Suggested recovery share from mean terminal lateness. */
  suggestRecovery: number;
}

ToWorker (121-127):
  | { type: 'init'; dataBase: string; agentScale: number; seed: number; time: number; fares: FarePolicy; modeState?: ModeState }  // fare → fares
  | { type: 'fares'; fares: FarePolicy }                                                                                      // replaces 'fare'

DayReport (147-177) adds:
  fares: FareBreakdown;
  /** Transit share by earnings band. */
  bandShare: number[];
  routeRegularity: Record<number, RegularityStats>;
  regularity: RegularityStats;

Query 'route' reply (worker answer 85-90) adds:  regularity: RouteRegularityDetail | null
```

Payloads: the DayReport grows by about 100 bytes per route. `RouteRegularityDetail` is at most a
few hundred numbers and is sent on demand. Snapshots are unchanged in size (`TRAIN_STRIDE` stays
9). All of it is structured-clone friendly. The new DayReport fields are optional when *reading*
`lastReport` from an old save (`app.report?.routeRegularity?.[id]`).

---

## 8. Save format v3 and the v2 → v3 migration

| Field | Where | Absent / v2 means |
|---|---|---|
| `game.fares: FarePolicy` | replaces `game.fare` | `{ peak: fare, offPeak: fare, lowIncome: 1 }` |
| `routes[].control: RouteControl` | `RouteSetData` | `legacyControl()`: hold off, recovery 0, so the fleet is unchanged |
| `bonds[].rate`, `bonds[].monthsLeft`, `bonds[].rating?` | `FinanceData` | 2.5%, `remainingPayments(balance, payment, 2.5%)` |
| `history[].fees`, `history[].prepaid`, `today.*` | `FinanceData` | 0 |
| `months[].interest`, `.fees`, `.prepaid`, `.debtEnd` | `FinanceData` | interest = `revenue − operatingCosts − profit` (exact: v1's profit formula, `finance.ts:229`), others 0 / `null` |
| `finance.market: MarketData` | `FinanceData` | `{ seed: BONDS.defaultSeed, base: BONDS.start, rating: null, score: 0, history: [] }`; rated on load (§5 `fromData`) |
| `lastReport.fares`, `.bandShare`, `.routeRegularity`, `.regularity` | `game.lastReport` | absent (UI shows "—") |

```ts
// src/save/format.ts
export const SAVE_VERSION = 3;                               // line 11
SaveFile.game.fare: number  →  SaveFile.game.fares: FarePolicy   // line 34

// src/save/migrate.ts — STEPS (line 9) gains:
2: (s) => {   // v2 → v3: operations control and the money market
  const game = (s.game ?? {}) as Record<string, any>;
  const fare = typeof game.fare === 'number' ? game.fare : ECONOMY.fareDefault;
  game.fares ??= { peak: fare, offPeak: fare, lowIncome: 1 };
  delete game.fare;
  for (const r of game.routes?.routes ?? []) r.control ??= legacyControl();
  const fin = game.finance ?? {};
  for (const b of fin.bonds ?? []) {
    b.rate ??= ECONOMY.bondRate;
    b.monthsLeft ??= b.balance >= b.principal - 1 ? BONDS.termMonths : remainingPayments(b.balance, b.monthlyPayment, b.rate);
  }
  for (const h of [...(fin.history ?? []), fin.today].filter(Boolean)) { h.fees ??= 0; h.prepaid ??= 0; }
  for (const m of fin.months ?? []) { m.interest ??= (m.revenue ?? 0) - (m.operatingCosts ?? 0) - (m.profit ?? 0); m.fees ??= 0; m.prepaid ??= 0; m.debtEnd ??= null; }
  fin.market ??= { seed: BONDS.defaultSeed, base: BONDS.start, rating: null, score: 0, history: [] };
  game.finance = fin; s.game = game; s.version = 3; return s;
},

// src/save/serialize.ts — buildSave (line 28): fares: { ...game.fares }
//                         applySave (line 46): game.fares = normalizeFares(g.fares)
```

The step only fills defaults (`??=`) and does not depend on order. If another v2 feature claims
the v2 → v3 bump first, these lines merge into that single step. `ModeState` is unaffected, because
agent groups don't change (the peak flags are rebuilt from the seeded agents). A v2 save loads with
v1-identical operations: holding is off, recovery is 0, and only the short-turn rule (§4.3) changes
behaviour.

---

## 9. `balance.ts` section

Insert after `ECONOMY` (`balance.ts:281`), before `GOALS`:

```ts
// ---------------------------------------------------------------------------
// Operations control (v2): holding, timepoints, recovery
export const OPS_CONTROL = {
  /** New routes hold departures at their first stop (migrated v2 routes start with it off). */
  defaultHold: true,
  /** Hold while the gap to the train ahead is under this × the scheduled headway; 0.6–0.8 performed best in the prototype. */
  holdFraction: 0.7,
  holdFractionChoices: [0.5, 0.6, 0.7, 0.8, 0.9],
  /** Longest hold at one timepoint, seconds: long enough to fix a bunch, short enough not to block a trunk. */
  maxHoldPerStop: 90,
  /** A held train leaves at once if another route's train is queued this close behind it, metres (≈ 2½ train lengths). */
  yieldLookback: 400,
  /** Default recovery for new routes: 10% of run time gave +1 train per core route and halved bunching. */
  defaultRecovery: 0.1,
  recoveryChoices: [0, 0.05, 0.1, 0.15, 0.2],
  /** Crews turn a train this fast, seconds, when the next departure is already due (v1 always took 3 min). */
  turnaroundMin: 120,
  /** Headways under this × scheduled count as bunched (the transit-industry "bunch" threshold). */
  bunchFactor: 0.5,
  /** Headways over this × scheduled count as gaps. */
  gapFactor: 1.5,
  /** Headways over this × scheduled are clamped in the statistics, so one service gap doesn't dominate. */
  maxHeadwayFactor: 4,
  /** Regularity grades for the route panel: CV under 0.25 "even", under 0.45 "uneven" (v1 core is 0.52). */
  cvGood: 0.25,
  cvFair: 0.45,
  /** Suggested recovery covers this multiple of the mean terminal lateness (headroom for spread). */
  recoverySuggestFactor: 1.5,
  /** Suggested timepoints: stops nearest these fractions along the route. */
  suggestTimepointsAt: [1 / 3, 2 / 3],
};

// ---------------------------------------------------------------------------
// Fleet sales (v2)
export const FLEET = {
  /** Used cars sell for 40% of new: a cash lever, not free money (maintenance saved is only 1%/yr). */
  resaleFraction: 0.4,
};

// ---------------------------------------------------------------------------
// Fares (v2)
export const FARES = {
  /** Periods (OPERATIONS.periods ids) billed at the peak fare: 96% of commuter trips start in these. */
  peakPeriods: ['am', 'pm'] as readonly string[],
  /** Low-income fare multipliers offered for the lowest earnings band: full, half, free. */
  lowIncomeChoices: [1, 0.5, 0],
  /** Earnings band that gets the low-income fare (SE01, ≤ $1,250/month). */
  lowIncomeBand: 0,
  /** For classifying the trip home as peak or off-peak: morning trip length assumed (as commuters.ts:522). */
  amTripEstimate: 30 * MIN,
};

// ---------------------------------------------------------------------------
// Bond market (v2)
export const BONDS = {
  /** Long-run mean of the base rate: v1's tuned fixed rate, so the economy is centred where it was. */
  mean: 0.025,
  /** Base rate in the first month (month 1 borrowing is exactly v1). */
  start: 0.025,
  /** Share of the gap to the mean closed each month (half-life ≈ 5.4 months). */
  reversion: 0.12,
  /** Monthly σ of the base rate; stationary sd ≈ 0.42%, so most months are between 1.7% and 3.3%. */
  volatility: 0.002,
  /** Hard bounds on the base rate. */
  minRate: 0.01,
  maxRate: 0.06,
  /** About one shock every two years, of 0.75%, three in five upward. */
  shockChance: 0.04,
  shockSize: 0.0075,
  shockUpShare: 0.6,
  /** Market seed for headless games and migrated saves (new careers draw a fresh one). */
  defaultSeed: 20300107,
  /** Bond term in months (= ECONOMY.bondYears × 12). */
  termMonths: 360,
  /** Prepayment penalty on the amount prepaid: small enough to use idle cash, big enough to think about. */
  prepayPenalty: 0.01,
  /** Refinancing fee on the balance: a 0.5% rate cut pays it back in about 2 years. */
  refinanceFee: 0.01,
  /** Refinance only when the new rate is at least this much lower (avoids pointless churn). */
  refinanceMinGain: 0.0005,
  /** Prepayment amounts offered (plus "all"). */
  prepayChoices: [250e6, 500e6],
  /** Months of market history kept for charts and reviews. */
  historyMonths: 360,
};

// ---------------------------------------------------------------------------
// Credit rating (v2). Scores are 0–100 per metric, piecewise-linear between anchors.
export const CREDIT = {
  ratings: ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'CCC'] as const,
  /** Minimum score per notch (AAA … B); below the last is CCC. The README core lands at BBB. */
  thresholds: [85, 75, 65, 52, 40, 28],
  /** Spread over the base rate per notch: AAA borrows at the market rate, CCC at +4.5%. */
  spreads: [0, 0.001, 0.0025, 0.006, 0.0125, 0.025, 0.045],
  /** Score margin needed to move a notch (stops month-to-month flapping). */
  hysteresis: 2,
  /** Settled days used for the review (about 3 months). */
  windowDays: 60,
  /** Fewer service days than this and farebox and coverage are "not rated" (construction phase). */
  minServiceDays: 10,
  /** Points for a metric that is not rated yet: new authorities are trusted until fares flow. */
  notRatedPoints: 80,
  weights: { farebox: 0.3, coverage: 0.3, leverage: 0.25, liquidity: 0.15 },
  /** Fare revenue ÷ operating costs (v1 core: 1.59). */
  farebox: { x: [0.5, 1.0, 1.5, 2.0], y: [0, 50, 80, 100] },
  /** Net operating income ÷ (interest + one new bond's interest) (v1 core: 0.75). */
  coverage: { x: [0, 0.5, 1.0, 1.5, 3.0], y: [0, 30, 55, 75, 100] },
  /** Debt ÷ (assets + cash) (v1 core: 0.72). */
  leverage: { x: [0, 0.3, 0.6, 0.8, 1.0], y: [100, 85, 55, 30, 0] },
  /** Months of operating costs + debt service covered by cash. */
  liquidity: { x: [0, 3, 12], y: [0, 50, 100] },
  /** Weekdays per month for the liquidity denominator. */
  daysPerMonth: 21.75,
};
```

`GOALS` (`balance.ts:285-293`) adds:

```ts
  /** 'rating-a' goal: this rating or better while owing at least this much. */
  ratingGoal: 'A', ratingGoalMinDebt: 5e9,
  /** 'clockwork' goal: network bunched share under this, with this many routes and riders. */
  clockworkBunched: 0.05, clockworkMinRoutes: 3, clockworkMinRiders: 500_000,
```

`ECONOMY.bondRate` and `bondYears` stay. They are the v2-bond migration rate and the term. The
`ECONOMY.bondRate` comment changes to "v1's fixed rate; v2's market mean (BONDS.mean)".

---

## 10. Performance

Target: 300 stations / 25 routes / about 430 trains / 285k agents at 60×. v1 does a peak game-hour
in about 190 ms against a 1,000 ms budget.

| Work | When | Cost |
|---|---|---|
| Terminal hold check | each pending dispatch per route-direction per step (≤ 50) | O(1): one array read and a compare |
| Timepoint hold | only for trains with `t ≥ until` at a flagged stop | O(1). While holding, `queuedBehind` scans one track's occupancy list (≤ 10 entries) once per step per held train. In the core run there were about 800 holds/day × about 23 steps each, about 18k scans/day: negligible |
| `recordHeadway` | each departure (about 25k/day on the perf network) | O(1) on typed arrays |
| Short-turn check | each terminal arrival | O(1) |
| Fare billing | each first boarding (about 1.2M agents' trips/day on the core) | one table lookup + 2 adds; `isPeakTime` taken out of the per-call loop |
| Group fare | 3 am, G ≤ 285k groups | one multiply-add each |
| Agent tilt | 3 am, only for policies that vary by time; 3 `exp` per group + 1 multiply per agent | ≈ 5 ms per day |
| Peak flags | constructor | 285k × 2 compares, < 2 ms |
| Credit review / rate step | main thread, once a month | a 60-day loop |
| Finance panel charts | only while open | as v1 |

Memory: `aPeak` 285 KB, `gPeakFrac` ≤ 1.1 MB, and `RouteReg` ≈ 2 × 12 × 4 × 8 B per route. That
is about 1.4 MB in all, under 3% of the worker's agent arrays. The perf network
(`scripts/perf.ts`) keeps 431 trains (recovery 0) and enables holding with suggested timepoints.
The budget is that the measured peak hour grows by under 3%, which the checklist verifies. Main
thread per-frame work is unchanged: no new layers, and the snapshot stride is unchanged.

## 11. Determinism

- Holding, recovery, short turns and regularity use only sim time and train state. There are no
  RNG draws and no wall-clock reads, so the same save and inputs give identical trains.
- The per-agent fare tilt adds **no** RNG draws: each agent still takes exactly one
  `this.rng.next()` at the draw (`commuters.ts:513`). With flat fares the probability vector is
  bit-identical to v1.
- The bond market uses a counter-based seed `mixSeed(market.seed, monthIndex)`. The rate for any
  month depends only on the seed and the previous rate, not on when the game was saved, loaded or
  replayed. `market.seed` is saved.
- A new career draws its market seed once on the main thread (`crypto.getRandomValues`, outside
  the sim) and saves it. Headless games, tests and migrated saves use `BONDS.defaultSeed`. Mode
  choice and agent seeds are untouched (`settings.seed`).
- Credit reviews are pure functions of the saved finance state. `fromData` rates a migrated save
  the same way every time.

## 12. Balance impact

All fare defaults are flat $3 with no low-income discount, which is v1-identical. New routes get
holding at 70% at the first stop, no timepoints and 10% recovery. Migrated routes get holding off
and 0% recovery.

**README core** (measured with the prototype on the real data, day 7 of 8):
- **Fleet:** +1 train per route (19,19,13,12 → 20,20,14,13). That is +40 cars, **+$100M of
  capital** and +$3.8k/day of maintenance.
- **Service:** bunched headways fall from 10.8% to 6.2%, CV from 0.52 to 0.43, left-behinds from
  766k to 508k and lateness from 105 s to 92 s.
- **Ridership:** **+1.2%** (1.268M → 1.283M), giving fare revenue +$36k/day.
- **Operating:** car-km +2.5% (fewer cancelled slots), so operating costs are +$25k/day.
- **Net:** about +$7k/day, **neutral**.

With 2 timepoints per route, bunching falls to 3.5% and lateness rises to 101 s, with ridership
unchanged.

**Interest.** The opening is unchanged. The market starts at 2.5% and a debt-free authority is AAA
(0 spread), so a core built in month 1 borrows all its $17.2B at **exactly 2.5%**, as in v1. The
README core result (−$0.28M/day after interest at 1.33M riders) therefore stands, plus the +$7k/day
above. At **1.5M riders** fares are about $4.03M/day against costs of about $2.24M/day, giving NOI
of $1.79M/day against $1.66M/day of interest. That is **about +$0.13M/day: still roughly break-even
including interest**.

A player who builds over 3 months instead pays about 2.75% (rating A, construction phase) on later
chunks, plus or minus the market. That is about −$0.03M to −$0.06M/day against v1, and refinancing
in a low-rate month can win it back.

**Ratings in play.** The core settles at BBB, or BB if the player runs its cash to zero, so new
bonds cost about 3.1% and expansion is dearer than the opening. Paying the core down to $12B, or
running it at $3.50, reaches A or AA (2.6–2.75%). Sprawl is BB with no debt and B as soon as it
borrows, so the network that loses money can't borrow its way out cheaply.

**Fare levers** (§4.6): a $3.25/$2.50 peak/off-peak split gives +6% revenue for −0.4% trips. A
half low-income fare costs 3.1% of revenue for +8.4% band-0 trips.

**Car sales:** a cash lever only. Selling 100 spare heavy cars brings in $100M and saves $9.6k/day
of maintenance.

**Sprawl:** unchanged at about −$0.8M/day. Its fleets get +1 train each (+$8–10M capital).

The checklist re-measures both scenarios with `npm run balance` and updates the README table.

---

## 13. Test plan

New: `tests/ops.test.ts`, `tests/credit.test.ts`, `tests/fares.test.ts`. Extended:
`tests/economy.test.ts`, `tests/headless.test.ts`. All 36 existing tests must still pass.
`economy.test.ts:51-65` still holds because month 1 is at 2.5%.

### `tests/ops.test.ts` (TrainSim only, no data files, under 2 s)
Shared fixture: `syntheticLine({ stops: 16, spacing: 1000, headway: 180, cars: 8 })` with
**gap-driven hooks**:
- `arrive` returns `board = 0.5·gap + max(0, normal·40)` and `alight = 0.4·gap`, where `gap` is
  the time since the last train at that stop and direction.
- The noise comes from `new Rng(42)`.
- `depart` logs `(dir, stop, t)`.

Runs go from 05:30 to 10:00 (the AM period, H = 180 s for all periods).

1. **Regularity maths.** Regular departures give cv 0, bunched 0 and ewt 0. Alternating 0.4H/1.6H
   gives cv 0.6, bunched 0.5, gaps 0.5 and ewt 0.18H (§4.4). Departures across a period change
   are skipped. A headway over 4H is clamped.
2. **Holding plus recovery removes bunching on a busy line.**
   - *Off*: `hold: 0`, fleet `trainsNeeded` with recovery 0. Expect `cv > 0.6`,
     `bunched > 0.2`, deadlocks 0.
   - *On*: `hold: 0.7`, timepoints at stops 5 and 11, fleet with recovery 0.1. Expect
     `cv < 0.4`, `bunched < 0.08`, deadlocks 0.
   - Throughput: departures from the second-to-last stop are at least 1.1 × off.
   - The prototype gave off 0.89 / 31.8% / 134 and on 0.22 / 2.0% / 164.
3. **Terminal holding spaces backlogged departures.**
   - Fleet of 6, `setNetwork` at t0, first step at t0 + 2.5H, so both pending slots are overdue.
   - With hold 0 the two stop-0 departures are under 60 s apart. With hold 0.7 they are at least
     0.7H − 2 s apart.
4. **Timepoint holds respect the cap.**
   - On run 2's "on" case: every hold's `holdSec ÷ holds ≤ maxHoldPerStop`.
   - The maximum single hold (logged in a test-only callback through `depart` times) is at most
     `maxHoldPerStop + simStep`.
   - A train never leaves a timepoint less than `dwellBase` after arriving.
5. **Yield rule (pure).**
   - `queuedBehind(occ, …)` is true for an entry of another route 300 m behind the tail.
   - It is false for the same route, for 500 m behind, and for an entry ahead of the head.
6. **Short turnaround.**
   - In run 2's off case `day.shortTurns > 0`.
   - With fleet 2 × `trainsNeeded` and no noise, `shortTurns === 0` and every turnaround is 180 s
     (checked from the depart log).
7. **Determinism.** Run 2 twice gives `toEqual` stats and departure logs.
8. **Recovery sizing.** `trainsNeeded({ headways: am 4 …, control: { recoveryPct: 0.1 } },
   [1200, 1200])` is 14, and 13 with recovery 0.
9. **Compiled timepoints.**
   - Compiling a headless 6-stop line with `timepoints: [first, third, last]` flags only the third
     stop (both directions).
   - `hold` is 0 when `control.hold` is false.
   - `opsKey` changes when a timepoint is toggled. This needs `loadWorldFromDisk`, about 1 s.
10. **Car sales.**
    - On a headless game with one built line, a route with 2 extra trains of cars:
      `idleCars === 2·cars`. `sellIdleCars` gives proceeds of `2·cars·2.5M·0.4`, lowers
      `assetValue` by `2·cars·2.5M`, and leaves `ownedCars` equal to the plan.
    - A second call returns `ok: false`.
    - `sellSpareCars('heavy')` empties the pool with the matching proceeds.
    - A route without a path reports 0 idle cars.

### `tests/credit.test.ts` (pure, under 100 ms)
11. **Scorecard table.** Every row of §4.8 gives the listed rating and a score within ±0.5 (the
    inputs are written out in the test).
12. **Monotonic.** More cash never lowers the score. More debt (with the same cash) never raises
    it. Higher revenue never lowers it.
13. **Hysteresis.**
    - Score 64 with previous A stays A; 62 gives BBB.
    - Score 66 with previous BBB stays BBB; 67 gives A.
    - With `prev === null` there is no hysteresis.
14. **Spreads.** `spreadOf('BBB') === 0.006` and `newBondRate` = base + spread.
15. **Market walk.**
    - 10,000 months of `stepBaseRate` stay within [1%, 6%], with a mean within 2.5% ± 0.25% and
      a lag-1 autocorrelation above 0.8.
    - The same seed gives the same path, and seeds 1 and 2 differ.
    - Replaying month k alone (from the stored previous rate) equals the sequential value.
16. **Bonds keep their coupon.**
    - Issue in January at 2.5%. Set `market.base = 0.04` and issue again.
    - At month end, interest for each bond equals `balance·rate/12` and level payments use each
      bond's own `monthlyPayment`.
17. **Refinance maths.**
    - A $1B bond at 3.5% with 300 months left, refinanced with the market at 2.5% (AAA):
      `rate === 0.025`, `monthsLeft === 300`,
      `monthlyPayment ≈ annuityMonthly(1e9, 0.025, 300)`, cash down by exactly $10M,
      `today.fees === 1e7`, `debt()` unchanged.
    - Simulating 300 month ends brings the balance to 0, and the bond is gone after exactly 300.
    - The sum of payments saved exceeds the fee.
    - Refinance is refused when `newBondRate() > rate − 0.0005` or cash < fee.
18. **Prepay.**
    - $250M off a $1B bond: balance 750M, cash −252.5M, `today.prepaid` 250M, `today.fees` 2.5M,
      `monthsLeft` unchanged, payment `annuityMonthly(750M, r, monthsLeft)`. It still matures on
      schedule.
    - "All" removes the bond and raises `bondRoom` by its balance.
    - Refused when cash is short.
    - Settling the day doesn't subtract the fee or the prepaid amount again.
19. **`remainingPayments`.** After k level payments on a 2.5% 30-year bond it gives 360 − k, for
    k in {0, 1, 59, 359}.
20. **Monthly review.**
    - Settle a month of service-day inputs (revenue 3.5M, riders 1.3M) with $17B of debt.
    - `market.history.length === 1`, `months.at(-1).rating` is set, and `events` includes a
      downgrade from AAA.
    - `profit` subtracts fees, and `debtEnd` equals `debt()`.
21. **Year review.**
    - Build a FinanceData with 12 months of 2030 and 2 months of 2031.
    - `yearsWithData` gives [2030, 2031], and `buildYearReview(…, 2030)` sums match the months.
    - Rating changes are listed in order, the peak day comes from history, and goals are filtered
      by year.
22. **v2 → v3 migration.**
    - A minimal v2 save (fare 3.25, one route, two bonds — one in its issue month, one after 13
      payments — and a history day) migrates to:
      - `fares = {3.25, 3.25, 1}`
      - `control = legacyControl()`
      - `monthsLeft` 360 and 347
      - `fees` and `prepaid` 0
      - `market.rating === null`
    - A v2 month report gets `interest === revenue − operatingCosts − profit`.
    - Applying it to a Game gives a rating that is not null. Migrating twice changes nothing.

### `tests/fares.test.ts`
23. **Fare functions.**
    - `fareAt`/`expectedFare`/`tripFare` for flat, peak/off-peak and low-income policies:
      `expectedFare({3.5, 2.5, 1}, 2, 0.964) = 3.464`, and band 0 at half gives 1.732.
    - `normalizeFares` clamps to [0, 5], snaps to $0.25, enforces off-peak ≤ peak, and snaps
      lowIncome to a choice.
24. **`isPeakTime` edges.** 05:59 off, 06:00 peak, 09:59 peak, 10:00 off, 16:00 peak, 19:59 peak,
    20:00 off. Day offsets are ignored.
25. **Mode choice per band and period** (synthetic world: `buildWorld` + `encodeOD` with 2 tracts
    6 km apart, 400/400/400 commuters by band, and a 2-station compiled route as in `sim.test.ts`):
    - Low-income half: after `dailyModeChoice`, band-0's transit share is above the flat-$3
      instance's and band 2's is identical.
    - Peak $4 / off $2: `c.groupFare(g) === expectedFare(p, band, c.gPeakFrac[g])` and
      `gPeakFrac ∈ (0.9, 1)`. Shares are below a flat $2 instance.
26. **Agent tilt.** `fareOddsMultiplier(+0.5, 0) < 1 < fareOddsMultiplier(−0.5, 0)`. Under peak
    $4 / off $2, an off-peak agent's multiplier is above 1. Under a flat policy all three are
    exactly 1.

### `tests/headless.test.ts` additions (real data, about 2–6 s each)
27. **Billing per band and period at boarding.**
    - Test network, 1 day, fares `{ peak: 3.5, offPeak: 2, lowIncome: 0.5 }`.
    - For each cell, `revenue[i]` equals `trips[i] × fareAt(policy, band, peak)` within 1e-6
      relative.
    - `Σ revenue === report.fareRevenue`, and peak trips are over 80% of all trips.
    - Band-0's average fare is half of band 2's at each period.
    - The ledger revenue equals `fareRevenue`.
28. **Holding evens out gaps with commuters on board.**
    - Test network, 2 days, built twice: `control: legacyControl()` against `{ hold: true,
      timepoints: suggestTimepoints(...), recoveryPct: 0.1 }`.
    - On the first day with riders (index 1), bunched(on) < 0.6 × bunched(off) and
      cv(on) < cv(off). Deadlocks, stuck and inFlight are 0, and `routeRegularity` has both routes.
    - The prototype (timepoints at the stops nearest ⅓ and ⅔) gave bunched 11.6% → 2.6% and CV
      0.48 → 0.33 on that day, and 10.9% → 2.9% and 0.54 → 0.39 the day after.
29. **The existing test (line 12) also checks** that `report.regularity.samples > 0` and that
    `report.fares.trips` adds up to about `fareTrips` (within 2%: in-flight trips at midnight).

## 14. Risks and how they are de-risked

| Risk | De-risk |
|---|---|
| Holding blocks interlined trunks or junctions | Holds are capped at 90 s. The yield rule releases a hold as soon as another route's train queues behind it. `releaseLocksAhead` drops junction claims ahead. Terminal holds are off-track. Test 5 checks the yield rule, and test 28 runs the interlined test network with 0 deadlocks. |
| Holding raises the visible lateness metric and confuses players | Regularity is the headline in the panel. The lateness tooltip explains the trade-off. Default timepoints are none, so terminal-only holding lowered lateness in the prototype (105 → 92 s). |
| Recovery changes fleet sizes for v2 saves | Migrated routes get `recoveryPct: 0` and `hold: false`, so the fleet is unchanged. Only the short-turn rule applies, and it only helps. |
| Selling cars removes a running train during the peak | Only idle cars (beyond the plan, which includes a spare) can be sold, so the pool usually has a waiting train. v1's shrink order (Ready → Turnaround → Dwelling → Running) evacuates anyone on board by cab, as it already does when the train length changes. A deferred "retire at terminal" rule is listed as stretch. |
| Rating harshness makes expansion impossible | Ratings were checked against the scenarios in §4.8. The README core is BBB (+0.6%), and month 1 is always AAA. CCC is expensive but not closed. Hysteresis stops flapping. Every anchor is in `CREDIT`. |
| Market volatility feels random and unfair | σ 0.2%/month with mean reversion and ±0.75% shocks about every 2 years. Each bond keeps its coupon. Refinancing lets players profit from dips. The chart shows the history. |
| Prepay or refinance double-counted in the cash formula | `fees` and `prepaid` are spent at once and left out of the settle formula (§4.9). Test 18 checks that settling doesn't subtract them again. |
| v2 bonds' remaining term cannot be inferred | `remainingPayments` inverts the annuity (test 19). Bonds in their issue month (balance = principal) get 360. |
| Fare policy changes v1 mode-choice results | The flat policy is bit-identical: the multipliers are 1 and the RNG sequence is the same. The flat default is the only policy the migration produces. |
| `App.recompile` skips holding changes | `opsKey` is in the signature (app.ts:354). Test 9 checks that `opsKey` changes. A manual check is in the checklist. |
| Other v2 features also bump the save to v3 | The migration step only fills defaults and does not depend on order (§8). Touchpoints are listed in the summary. |
| The finance panel grows unwieldy | Tabs, with the tab remembered for the session. Each tab is its own render function. |

## 15. Ordered implementation checklist

1. **balance.ts**: add `OPS_CONTROL`, `FLEET`, `FARES`, `BONDS`, `CREDIT` and the `GOALS` additions
   (§9). Run `npm run typecheck`.
2. **Pure modules first**:
   - `src/economy/fares.ts`, `src/economy/credit.ts`, `src/sim/regularity.ts`,
     `src/routes/control.ts`, and `fareOddsMultiplier` in `modeChoice.ts`.
   - `calendar.monthIndex` and `yearOf`.
   - Write tests 1, 5, 11–15, 23, 24 and 26. Green.
3. **Finance**:
   - Bond fields, `annuityMonthly`, `remainingPayments`, the payment loop, `issueBond`,
     prepay/refinance, `fees`/`prepaid`, `kpi`, the market, `reviewMonth`, `events`, and
     `toData`/`fromData`.
   - Tests 16–20. Existing `economy.test.ts` stays green.
4. **Year review**: `src/economy/yearReview.ts` and test 21.
5. **Routes**:
   - `RouteControl` in types, `routeSet` create/load/prune, `routeTool.asRoute`, `compile.ts`
     (trainsNeeded, timepoint, hold, opsKey), and `fleet.ts` sales.
   - Tests 8, 9 and 10.
6. **TrainSim**:
   - Train fields, `RouteReg` wiring, terminal hold, timepoint hold with yield and
     `releaseLocksAhead`, short turnaround, terminal lateness, `closeDayRegularity` and
     `regularityDetail`.
   - `syntheticLine` in `headless.ts`. Tests 2, 3, 4, 6 and 7.
7. **Engine, protocol, worker, client**:
   - `fares` replaces `fare`, plus `SNAP_HELD`, the DayReport fields and the route query
     regularity.
   - `scripts/perf.ts` Engine options.
8. **Commuters**: peak flags, `groupFare`, tilt, billing cells, `bandShare` and `setFares`.
   Test 25, then the headless tests 27 and 29.
9. **Headless harness**:
   - `createHeadlessGame` takes fares and seed, `makeRoute` takes control, `runDays` passes kpi.
   - Test 28. Run `npm test`: everything green.
10. **Save v3**: `format.ts`, migrate step 2 and `serialize.ts`. Test 22.
11. **App wiring**:
    - `setFares`, the bond actions, car sales, `toggleHolding`, and `onDayEnd` (kpi, events, year
      review).
    - The `recompile` sig, keys M and H, and `freshMarketSeed`.
12. **UI**:
    - Finance panel tabs.
    - Route panel: operations, timepoint toggles, regularity and fleet line.
    - Train panel held state and routes-list tag.
    - `rateChart`, `regularityChart`, `showYearReview`, the month-report rating row, toolbar
      tooltip, clock icon and CSS.
13. **Goals**: `rating-a` and `clockwork`.
14. **Scripts and measurement**:
    - `npm run perf`: the peak hour must stay within +3% of the v1 time and print holds > 0.
    - `npm run balance -- scenario=core days=12 control=default` and `control=legacy`, and the
      same for `scenario=sprawl days=8`. Record riders, money, regularity and the credit line.
15. **Manual check in `npm run dev`**:
    - Toggle holding with H and see trains held amber in the train panel.
    - Mark timepoints and Apply; the chart dips after them the next day.
    - Sell idle cars after lowering the frequency.
    - Change fares and see the toast. At 3 am the riders by band shift.
    - Issue a bond, prepay it and refinance it.
    - Skip to a month end for the rating toast and the history chart.
    - Skip to January for the year in review.
    - Save, reload and export/import.
    - Load a v2 autosave: routes have holding off and bonds show 2.50%.
16. **README**: controls, mechanics, balance rows, re-measured core and sprawl table, test count,
    and the removed known issue.

## 16. Size estimate

| Part | Lines |
|---|---|
| `balance.ts` | ≈90 |
| `regularity.ts`, `credit.ts`, `fares.ts`, `yearReview.ts`, `control.ts` | ≈420 |
| `finance.ts` | ≈170 |
| `trainSim.ts`, `engine.ts`, `commuters.ts`, `modeChoice.ts`, `protocol.ts`, `worker.ts`, `client.ts` | ≈300 |
| `compile.ts`, `types.ts`, `routeSet.ts`, `routeTool.ts`, `fleet.ts`, `game.ts`, `calendar.ts`, `goals.ts` | ≈120 |
| `headless.ts`, scripts | ≈60 |
| Save | ≈60 |
| `financePanel.ts` (rewrite), `routePanel.ts`, `inspectPanels.ts`, `reports.ts`, `charts.ts`, `app.ts`, CSS, icons | ≈640 (of which ≈260 replace v1 lines) |
| **Source total (net new)** | **≈1,500** |
| Tests | ≈550 |
| Stretch (not in the estimate) | retire sold trains at the terminal; held-train halo on the map; per-period hold thresholds; "pays for itself" refinance advisor across all bonds |

Difficulty is **medium-high but bounded**. The parts with real risk are in the train sim (holding
next to merge locks) and the finance arithmetic (re-amortisation and migration of old bonds). Both
are pure or self-contained and covered by fast tests. The prototype numbers above show that the
holding mechanism works as designed.
