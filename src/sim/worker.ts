/// <reference lib="webworker" />
/**
 * Simulation worker: owns the clock, trains and commuters. Steps the engine on fixed timesteps
 * decoupled from rendering and posts compact snapshots ~10× per second.
 */
import { TIME } from '../balance';
import { applyCity } from '../cities';
import { fetchWorld } from '../data/world';
import { Engine } from './engine';
import { SKIP_LABEL, type FromWorker, type ToWorker } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let engine: Engine | null = null;
let speed = 0;
let acc = 0;
let last = performance.now();
let lastSnap = 0;
let simSeconds = 0;
let rateWindowStart = performance.now();
let simRate = 0;
/** A skip is running: busy labels from inside it (growth month, route updates) hand the pill back to the skip's. */
let skipping = false;
const queued: ToWorker[] = [];

function post(msg: FromWorker, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

async function init(msg: Extract<ToWorker, { type: 'init' }>) {
  // Before any data is built: the city's balance values, projection origin and currency.
  applyCity(msg.city);
  const world = await fetchWorld(msg.dataBase);
  engine = new Engine(
    world,
    {
      agentScale: msg.agentScale,
      seed: msg.seed,
      time: msg.time,
      fares: msg.fares,
      modeState: msg.modeState,
      chaos: msg.chaos,
      service: msg.service,
      growth: msg.growth ?? null,
      growthPace: msg.growthPace,
    },
    {
      dayEnd: (report) => {
        // The state right after the day (fresh copies: the mode arrays are transferred, not cloned).
        const state = engine!.simState();
        post({ type: 'dayEnd', report, state }, [state.mode.shares.buffer, state.mode.obsTime.buffer, state.mode.obsCrowd.buffer]);
      },
      busy: (label) => post({ type: 'busy', label: label === null && skipping ? SKIP_LABEL : label }),
      event: (title, body, tone) => post({ type: 'event', title, body, tone }),
      alert: (alert) => post({ type: 'alert', alert }),
      dayChaos: (info) => post({ type: 'dayChaos', info }),
    },
  );
  const c = engine.commuters!;
  post({ type: 'ready', agents: c.A, groups: c.G, baseline: c.baseline });
  for (const m of queued.splice(0)) handle(m);
  sendSnapshot();
}

function handle(msg: ToWorker) {
  if (msg.type === 'init') {
    init(msg).catch((err) => post({ type: 'error', message: String(err?.message ?? err) }));
    return;
  }
  if (!engine) {
    queued.push(msg);
    return;
  }
  switch (msg.type) {
    case 'network':
      engine.setNetwork(msg.net);
      sendSnapshot();
      break;
    case 'speed':
      speed = msg.speed;
      acc = 0;
      last = performance.now();
      break;
    case 'skipTo':
      post({ type: 'busy', label: SKIP_LABEL });
      skipping = true;
      try {
        engine.skipTo(msg.time);
      } finally {
        skipping = false;
      }
      post({ type: 'busy', label: null });
      sendSnapshot();
      break;
    case 'fares':
      engine.setFares(msg.fares);
      break;
    case 'query':
      post({ type: 'reply', id: msg.id, data: answer(msg.q) });
      break;
    case 'chaosLevel':
      engine.setChaosLevel(msg.level);
      break;
    case 'service':
      engine.setService(msg.overrides);
      break;
    case 'growthPace':
      engine.setGrowthPace(msg.pace);
      break;
  }
}

function answer(q: Extract<ToWorker, { type: 'query' }>['q']): unknown {
  const c = engine!.commuters!;
  switch (q.kind) {
    case 'simState':
      return engine!.simState();
    case 'growthView':
      return engine!.growthView();
    case 'tractGrowth':
      return engine!.tractGrowth(q.tract);
    case 'station':
      return c.stationDetail(q.station);
    case 'route': {
      const d = c.routeDetail(q.route);
      if (!d) return null;
      const ri = engine!.net?.routes.findIndex((r) => r.id === q.route) ?? -1;
      return { ...d, inService: ri >= 0 ? engine!.trains.inService(ri) : 0, regularity: engine!.trains.regularityDetail(q.route) };
    }
    case 'tract':
      return c.tractDetail(q.tract);
    case 'unserved':
      return c.unserved.slice();
    case 'flows':
      return c.flows(q.limit);
    case 'segmentLoads':
      return null;
    case 'chaos':
      return engine!.chaos.state();
  }
}

function sendSnapshot() {
  if (!engine) return;
  const snap = engine.snapshot(simRate);
  post({ type: 'snapshot', snap }, [snap.trains.buffer, snap.waiting.buffer]);
}

function loop() {
  const now = performance.now();
  const realDt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (engine && speed > 0) {
    acc += realDt * speed * TIME.baseRate;
    const deadline = now + TIME.workerSliceMs;
    let steps = 0;
    while (acc >= TIME.simStep && performance.now() < deadline) {
      engine.step(TIME.simStep);
      acc -= TIME.simStep;
      simSeconds += TIME.simStep;
      steps++;
    }
    // If we can't keep up, drop the backlog rather than spiralling.
    if (acc > speed * TIME.baseRate * 0.5) acc = 0;
    void steps;
  }
  if (now - rateWindowStart > 1000) {
    simRate = simSeconds / ((now - rateWindowStart) / 1000);
    simSeconds = 0;
    rateWindowStart = now;
  }
  if (now - lastSnap >= 1000 / TIME.snapshotHz) {
    lastSnap = now;
    sendSnapshot();
  }
  setTimeout(loop, 4);
}

self.onmessage = (e: MessageEvent<ToWorker>) => handle(e.data);
loop();
