/**
 * The running game on the main thread: wires the map, the sim worker, tools, panels, overlays,
 * goals, saving and keyboard shortcuts together. The main thread only renders and handles input;
 * the simulation lives in the worker.
 */
import { ArcLayer, ScatterplotLayer, TextLayer, PathLayer } from '@deck.gl/layers';
import { PathStyleExtension, type PathStyleExtensionProps } from '@deck.gl/extensions';
import type { Layer } from '@deck.gl/core';
import { COMMUTERS, ECONOMY, TIME, type TrackLevel } from '../balance';
import { Game, type Selection } from '../core/game';
import { toLonLat } from '../core/geo';
import { dayIndex, isNewMonth, SECONDS_PER_DAY, timeOfDay } from '../core/calendar';
import { fmtDensity, fmtMoney, setUnits } from '../core/units';
import { checkGoals, emptyGoals, goalTitle, type GoalState } from '../core/goals';
import { LandMask } from '../data/landMask';
import { TractIndex, type LandCollection, type World } from '../data/world';
import { WorldTerrain } from '../construction/terrain';
import { progress } from '../construction/blueprint';
import { TrackTool } from '../construction/trackTool';
import { StationTool } from '../construction/stationTool';
import { BulldozeTool } from '../construction/bulldozeTool';
import { slicePolyline } from '../map/polyline';
import { MapView } from '../map/mapView';
import { NetworkLayers, lineScale, type RouteDrawInfo } from '../map/networkLayers';
import { StationLayers } from '../map/stationLayers';
import { Elevated3D } from '../map/elevated3d';
import { Overlays, crowdColor, type FlowLine, type OverlayMode } from '../map/overlays';
import { nameStationAt } from '../map/naming';
import { compileNetwork, type CompileResult } from '../routes/compile';
import { RouteTool } from '../routes/routeTool';
import { SimClient } from '../sim/client';
import type { CRoute, DayReport, ModeState, Snapshot } from '../sim/protocol';
import { TrainLayer, samplePath } from '../trains/trainLayer';
import { buildSave, applySave } from '../save/serialize';
import type { SaveFile, SaveSettings } from '../save/format';
import { writeSlot, type SlotId } from '../save/store';
import { BlueprintBar } from './blueprintBar';
import type { AppContext } from './context';
import { h } from './dom';
import { ToolManager } from './toolManager';
import type { ToolId } from './toolTypes';
import { TopBar } from './topbar';
import { Toolbar } from './toolbar';
import { SelectTool } from './selectTool';
import { Busy, confirmDialog, Legend, Toasts, Tooltip } from './widgets';
import type { Panel } from './panels/common';
import { stationPanel } from './panels/stationPanel';
import { routeEditor, routePanel, routesList } from './panels/routePanel';
import { edgePanel, tractPanel, trainPanel } from './panels/inspectPanels';
import { financePanel } from './panels/financePanel';
import { goalsPanel } from './panels/goalsPanel';
import { openMenu } from './menu';
import { Tutorial } from './tutorial';
import { showGameOver, showMonthReport } from './reports';

export interface AppOptions {
  sandbox: boolean;
  save: SaveFile | null;
  settings: SaveSettings;
  tutorial: boolean;
  /** Return to the title screen. */
  exit: () => void;
  /** Start again from a save (load, import, settings change). */
  restart: (save: SaveFile) => void;
}

const DEPTH = { depthCompare: 'always', depthWriteEnabled: false } as const;
const offsetExt = new PathStyleExtension({ offset: true });

interface CrowdSeg {
  path: [number, number, number][];
  lf: number;
  load: number;
  side: number;
}

export class App implements AppContext {
  readonly game: Game;
  readonly terrain: WorldTerrain;
  readonly tractIndex: TractIndex;
  readonly network: NetworkLayers;
  readonly stations: StationLayers;
  readonly trains = new TrainLayer();
  readonly elevated: Elevated3D;
  readonly overlays: Overlays;
  readonly sim = new SimClient();
  readonly tools: ToolManager;
  readonly trackTool: TrackTool;
  readonly stationTool: StationTool;
  readonly routeTool: RouteTool;
  readonly tooltip: Tooltip;
  readonly toasts: Toasts;
  readonly busy: Busy;
  readonly legend: Legend;
  readonly topbar: TopBar;
  readonly toolbar: Toolbar;
  readonly blueprintBar: BlueprintBar;
  readonly side: HTMLElement;
  private panel: Panel | null = null;
  compiled: CompileResult | null = null;
  private compiledByVersion = new Map<number, CompileResult>();
  report: DayReport | null = null;
  baseline = 0;
  speedIndex = -1;
  private lastSpeedIndex = 0;
  readonly settings: SaveSettings;
  goals: GoalState;
  tutorialDone: boolean;
  private tutorial: Tutorial | null = null;
  private stationFlows: { id: number | null; arcs: FlowLine[] } = { id: null, arcs: [] };
  private tractHL: number | null = null;
  private crowdSegs: CrowdSeg[] = [];
  private lastModeState: ModeState | null = null;
  private stopAnim: (() => void) | null = null;
  private renderPending = false;
  private recompileTimer: number | null = null;
  private panelTimer = 0;
  private destroyed = false;
  private intervals: number[] = [];
  private gameOver = false;
  private stationCap = new Map<number, number>();

  get agentScale(): number {
    return this.settings.agentScale;
  }

  constructor(
    readonly root: HTMLElement,
    readonly view: MapView,
    readonly world: World,
    land: LandCollection,
    readonly opts: AppOptions,
  ) {
    this.settings = { ...opts.settings };
    setUnits(this.settings.units);
    this.tractIndex = new TractIndex(world.tracts);
    this.terrain = new WorldTerrain(new LandMask(land), this.tractIndex);
    this.game = new Game(world, this.terrain, { sandbox: opts.sandbox, fare: ECONOMY.fareDefault });
    this.goals = emptyGoals();
    this.tutorialDone = !opts.tutorial;
    let modeState: ModeState | undefined;
    if (opts.save) {
      const r = applySave(this.game, opts.save);
      this.goals = { ...emptyGoals(), ...r.goals };
      this.report = r.lastReport;
      modeState = r.modeState;
      this.lastModeState = r.modeState ?? null;
      this.tutorialDone = r.tutorialDone || !opts.tutorial;
    }

    // ---- UI chrome
    this.tooltip = new Tooltip(root);
    this.toasts = new Toasts(root);
    this.busy = new Busy(root);
    this.legend = new Legend(root);
    this.side = h('div', { id: 'side', class: 'hw-panel' });
    root.append(this.side);

    // ---- map layers
    this.network = new NetworkLayers(view.map, this.game);
    this.stations = new StationLayers(this.game);
    this.elevated = new Elevated3D(view.map);
    this.overlays = new Overlays(world.tracts, fmtDensity);

    // ---- tools
    this.tools = new ToolManager(view);
    this.trackTool = new TrackTool(this);
    this.stationTool = new StationTool(this);
    this.routeTool = new RouteTool(this);
    this.tools.register(new SelectTool(this));
    this.tools.register(this.trackTool);
    this.tools.register(this.stationTool);
    this.tools.register(this.routeTool);
    this.tools.register(new BulldozeTool(this));
    this.tools.xrayExtra = () => this.selectionUnderground();
    this.routeTool.onChange = () => {
      if (this.tools.active?.id === 'route') this.showPanel(routeEditor(this, this.routeTool));
    };
    this.topbar = new TopBar(this);
    this.toolbar = new Toolbar(this);
    this.blueprintBar = new BlueprintBar(this);
    root.append(this.topbar.el, this.toolbar.el, this.toolbar.options, this.blueprintBar.el);
    this.tools.onChange = (id) => {
      this.toolbar.update();
      if (id !== 'route' && this.panel && this.game.selection === null) this.showPanel(null);
    };

    // ---- deck.gl layers, bottom to top
    view.addLayers('overlays', () => this.overlays.layers());
    view.addLayers('crowding', () => this.crowdLayers());
    view.addLayers('elevated', () => this.elevated.layers(this.network, view.is3D, view.map.getZoom()));
    view.addLayers('flows', () => this.flowLayers());
    view.addLayers('trains', () => this.trainLayers());
    view.addLayers('stations', () => this.stations.layers(view.map.getZoom(), performance.now()));
    view.addLayers('construction', () => this.constructionLabels());
    view.addLayers('tool', () => this.tools.layers());

    // ---- events
    const g = this.game;
    g.events.on('network', () => this.onDesignChange());
    g.events.on('routes', () => this.onDesignChange());
    g.events.on('money', () => {
      this.blueprintBar.update();
      if (this.game.selection?.kind === 'finance') this.refreshPanel();
    });
    g.events.on('toast', (t) => this.toast(t.title, t.body, t.tone));
    g.events.on('select', (sel) => this.onSelect(sel));
    view.events.on('view3d', () => this.scheduleRender());
    this.sim.events.on('ready', (r) => {
      this.baseline = r.baseline;
      this.topbar.update();
    });
    this.sim.events.on('snapshot', (s) => this.onSnapshot(s));
    this.sim.events.on('dayEnd', (r) => this.onDayEnd(r));
    this.sim.events.on('busy', (l) => this.busy.set(l));
    this.sim.events.on('event', (e) => this.toast(e.title, e.body, e.tone));
    this.sim.events.on('error', (m) => this.toast('Simulation error', m, 'red'));

    this.sim.init({ agentScale: this.settings.agentScale, seed: this.settings.seed, time: this.game.time, fare: this.game.fare, modeState });
    this.recompile();
    this.render();
    this.tools.set('select');
    this.blueprintBar.update();
    this.toolbar.update();
    this.topbar.update();

    window.addEventListener('keydown', this.onKey);
    window.addEventListener('pagehide', this.onHide);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.intervals.push(
      window.setInterval(() => {
        this.topbar.update();
        if (++this.panelTimer % 2 === 0) this.panel?.update?.();
      }, 250),
    );
    if (!this.tutorialDone) setTimeout(() => this.startTutorial(), 600);
  }

  destroy(): void {
    this.destroyed = true;
    this.save('autosave');
    this.sim.terminate();
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('pagehide', this.onHide);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.intervals.forEach((i) => clearInterval(i));
    this.stopAnim?.();
    this.tutorial?.close();
  }

  // ------------------------------------------------------------------ AppContext
  tip(html: string | null, px?: [number, number]): void {
    this.tooltip.show(html, px);
  }
  toast(title: string, body?: string, tone: 'green' | 'amber' | 'red' = 'green'): void {
    this.toasts.show(title, body, tone);
  }
  confirm(title: string, body: string, ok: string, danger = false): Promise<boolean> {
    return confirmDialog(this.root, title, body, ok, danger);
  }
  tol(px = 10): number {
    return px * this.view.metresPerPixel();
  }
  nameStation(x: number, y: number): string {
    const taken = new Set([...this.game.network.stations.values()].map((s) => s.name));
    return nameStationAt(this.view.map, x, y, taken, (px, py) => !this.terrain.isWater(px, py));
  }
  redraw(): void {
    this.view.invalidate();
  }
  setTool(id: ToolId): void {
    this.tools.set(id);
    if (id === 'route') this.showPanel(routeEditor(this, this.routeTool));
    else if (this.panel && this.game.selection) this.refreshPanel();
    else if (this.panel && !this.game.selection) this.showPanel(null);
  }
  refreshOptions(): void {
    this.toolbar.update();
  }

  // ------------------------------------------------------------------ time controls
  setSpeedIndex(i: number): void {
    if (this.gameOver) return;
    this.speedIndex = i;
    if (i >= 0) this.lastSpeedIndex = i;
    this.sim.setSpeed(i >= 0 ? TIME.speeds[i] : 0);
    if (i >= 0 && !this.stopAnim) this.stopAnim = this.view.beginAnimation();
    if (i < 0 && this.stopAnim) {
      this.stopAnim();
      this.stopAnim = null;
      this.view.invalidate();
    }
    this.topbar.update();
  }

  togglePause(): void {
    this.setSpeedIndex(this.speedIndex >= 0 ? -1 : this.lastSpeedIndex);
  }

  skipTo6am(): void {
    const t = this.sim.time();
    const tod = timeOfDay(t);
    const target = dayIndex(t) * SECONDS_PER_DAY + TIME.skipTo + (tod >= TIME.skipTo ? SECONDS_PER_DAY : 0);
    this.sim.skipTo(target);
  }

  // ------------------------------------------------------------------ design changes
  private onDesignChange(): void {
    this.game.routes.pruneMissing(this.game.network);
    const sel = this.game.selection;
    if (sel?.kind === 'station' && !this.game.network.stations.has(sel.id)) this.game.select(null);
    else if (sel?.kind === 'edge' && !this.game.network.edges.has(sel.id)) this.game.select(null);
    else if (sel?.kind === 'route' && !this.game.routes.get(sel.id)) this.game.select(null);
    this.scheduleRender();
    this.scheduleRecompile();
    this.blueprintBar.update();
    if (this.tools.active?.id === 'route') this.routeTool.recompute();
    else if (sel && sel.kind !== 'train') this.refreshPanel();
  }

  scheduleRender(): void {
    if (this.renderPending) return;
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      this.render();
    });
  }

  private render(): void {
    if (this.destroyed) return;
    const net = this.game.network;
    const infos: RouteDrawInfo[] = this.game.routes.list().map((r) => ({ route: r, operational: this.game.routes.operational(net, r).ok }));
    this.network.update(infos, this.view.is3D);
    this.network.highlight(this.game.selection);
    this.elevated.update(net, this.view.is3D);
    this.applyStationStats();
    this.stations.update(this.view.is3D);
    this.tools.refreshXray();
    this.view.invalidate();
  }

  private scheduleRecompile(): void {
    if (this.recompileTimer !== null) clearTimeout(this.recompileTimer);
    this.recompileTimer = window.setTimeout(() => {
      this.recompileTimer = null;
      this.recompile();
    }, 200);
  }

  private recompile(): void {
    const c = compileNetwork(this.game);
    const prev = this.compiled;
    const sig = (x: CompileResult | null) => (x ? JSON.stringify(x.net.routes.map((r) => [r.id, r.fleet, r.cars, r.headways, r.dirs[0].length, r.dirs[0].stopS.length, r.color, r.name])) + x.net.stations.length : '');
    if (prev && sig(prev) === sig(c)) return;
    this.compiled = c;
    this.compiledByVersion.set(c.net.version, c);
    if (this.compiledByVersion.size > 4) this.compiledByVersion.delete(this.compiledByVersion.keys().next().value!);
    this.stationCap.clear();
    for (const r of c.net.routes) for (const si of r.dirs[0].stopStation) {
      const id = c.net.stations[si].id;
      this.stationCap.set(id, Math.min(this.stationCap.get(id) ?? Infinity, r.capComfort));
    }
    this.sim.setNetwork(c.net);
    if (c.net.routes.length > (prev?.net.routes.length ?? 0)) this.checkGoals(null);
  }

  /** Compiled network that a snapshot's train indices refer to. */
  private compiledForSnapshot(): CompileResult | null {
    const v = this.sim.latest?.netVersion;
    return (v !== undefined && this.compiledByVersion.get(v)) || this.compiled;
  }

  compiledRoute(routeIdx: number): CRoute | null {
    return this.compiledForSnapshot()?.net.routes[routeIdx] ?? null;
  }

  // ------------------------------------------------------------------ sim events
  private onSnapshot(s: Snapshot): void {
    this.game.setTime(s.time);
    this.applyStationStats();
    this.stations.refreshStats();
    if (this.speedIndex < 0) this.view.invalidate();
  }

  private applyStationStats(): void {
    const c = this.compiledForSnapshot();
    const snap = this.sim.latest;
    const stats = this.stations.stats;
    stats.clear();
    for (const s of this.game.network.stations.values()) stats.set(s.id, { boardings: this.report?.stationBoardings[s.id] ?? 0, waiting: 0, crowding: 0 });
    if (c && snap) {
      c.net.stations.forEach((st, i) => {
        const w = snap.waiting[i] ?? 0;
        const e = stats.get(st.id);
        if (e) {
          e.waiting = w;
          e.crowding = w / (this.stationCap.get(st.id) ?? Infinity);
        }
      });
    }
  }

  waitingAt(stationId: number): number {
    return this.stations.stats.get(stationId)?.waiting ?? 0;
  }

  stationCrowding(stationId: number): number {
    return this.stations.stats.get(stationId)?.crowding ?? 0;
  }

  private onDayEnd(r: DayReport): void {
    const g = this.game;
    g.finance.settleDay({ day: r.day, riders: r.riders, fare: g.fare, carKm: r.carKm, stationsOpen: r.stationsOpen });
    this.report = r;
    g.events.emit('money', undefined);
    this.checkGoals(r);
    this.panel?.dayEnd?.();
    this.applyStationStats();
    this.stations.update(this.view.is3D);
    if (this.overlays.mode !== 'none') this.loadOverlayData(this.overlays.mode);
    if (isNewMonth(r.day + 1) && g.finance.months.length) showMonthReport(this, g.finance.months[g.finance.months.length - 1]);
    if (g.finance.bankrupt && !this.gameOver) {
      this.gameOver = true;
      this.setSpeedIndex(-1);
      showGameOver(this);
      return;
    }
    if (g.finance.negativeDays === 1 && !g.sandbox) this.toast('Cash is negative', `Issue a bond or cut costs. ${ECONOMY.bankruptcyDays} days in the red with no bond room means bankruptcy.`, 'red');
    // Autosave at midnight with fresh mode shares.
    this.sim.query<ModeState>({ kind: 'modeState' }).then((ms) => {
      this.lastModeState = ms;
      this.save('autosave');
    });
  }

  private checkGoals(report: DayReport | null): void {
    const done = checkGoals(this.game, this.goals, report ?? this.report, (x, y) => this.terrain.borough(x, y));
    for (const id of done) this.toast('Goal complete', goalTitle(id), 'green');
    if (done.length && this.game.selection?.kind === 'goals') this.refreshPanel();
  }

  // ------------------------------------------------------------------ selection & panels
  private onSelect(sel: Selection | null): void {
    this.network.highlight(sel);
    this.tools.refreshXray();
    if (this.tools.active?.id === 'route' && sel && sel.kind !== 'route') this.tools.set('select');
    this.refreshPanel();
    this.tutorial?.poke();
  }

  refreshPanel(): void {
    const sel = this.game.selection;
    if (this.tools.active?.id === 'route' && this.routeTool.draft) {
      this.showPanel(routeEditor(this, this.routeTool));
      return;
    }
    if (!sel) return this.showPanel(null);
    switch (sel.kind) {
      case 'station':
        return this.showPanel(stationPanel(this, sel.id));
      case 'route':
        return this.showPanel(routePanel(this, sel.id));
      case 'train':
        return this.showPanel(trainPanel(this, sel.id));
      case 'tract':
        return this.showPanel(tractPanel(this, sel.index));
      case 'edge':
        return this.showPanel(edgePanel(this, sel.id));
      case 'finance':
        return this.showPanel(financePanel(this));
      case 'goals':
        return this.showPanel(goalsPanel(this));
      case 'routes':
        return this.showPanel(routesList(this));
    }
  }

  private showPanel(p: Panel | null): void {
    this.panel?.destroy?.();
    this.panel = p;
    this.side.replaceChildren();
    if (p) this.side.append(p.el);
    this.side.classList.toggle('open', !!p);
    this.view.invalidate();
  }

  private selectionUnderground(): boolean {
    const sel = this.game.selection;
    const net = this.game.network;
    const under = (l: TrackLevel) => l === 'deep' || l === 'cut-and-cover';
    if (sel?.kind === 'edge') {
      const e = net.edges.get(sel.id);
      return !!e && (under(net.nodes.get(e.a)!.level) || under(net.nodes.get(e.b)!.level));
    }
    if (sel?.kind === 'station') {
      const s = net.stations.get(sel.id);
      return !!s && under(net.stationLevel(s));
    }
    return false;
  }

  startRouteFrom(stationId: number): void {
    this.routeTool.newDraft();
    this.game.select(null);
    this.setTool('route');
    const s = this.game.network.stations.get(stationId);
    if (s) {
      const p = this.game.network.stationPos(s);
      const [lon, lat] = toLonLat(p.x, p.y);
      this.routeTool.click({ x: p.x, y: p.y, lngLat: [lon, lat], px: [0, 0], shift: false });
    }
  }

  editRouteStops(routeId: number): void {
    const r = this.game.routes.get(routeId);
    if (!r) return;
    this.routeTool.editRoute(r);
    this.game.select(null);
    this.setTool('route');
  }

  // ------------------------------------------------------------------ overlays
  setOverlay(mode: OverlayMode): void {
    this.overlays.setMode(mode);
    this.legend.set(this.overlays.legend());
    this.loadOverlayData(mode);
    this.toolbar.update();
    this.view.invalidate();
    this.tutorial?.poke();
  }

  private loadOverlayData(mode: OverlayMode): void {
    if (mode === 'unserved') {
      this.sim.query<Float32Array>({ kind: 'unserved' }).then((u) => {
        this.overlays.setData({ unserved: u });
        this.view.invalidate();
      });
    } else if (mode === 'flows') {
      this.sim.query<{ home: number; work: number; count: number; transitShare: number }[]>({ kind: 'flows', limit: 400 }).then((list) => {
        const T = this.world.tracts;
        this.overlays.setData({ flows: list.map((f) => ({ from: [T[f.home].lon, T[f.home].lat], to: [T[f.work].lon, T[f.work].lat], count: f.count, transitShare: f.transitShare })) });
        this.view.invalidate();
      });
    } else if (mode === 'crowding') {
      this.loadCrowding();
    }
  }

  private async loadCrowding(): Promise<void> {
    const c = this.compiled;
    if (!c) return;
    const segs: CrowdSeg[] = [];
    for (const r of c.net.routes) {
      const d = await this.sim.query<{ dirs: { load: number[]; capacity: number[] }[] } | null>({ kind: 'route', route: r.id });
      if (!d) continue;
      d.dirs.forEach((dd, di) => {
        const dir = r.dirs[di];
        for (let k = 0; k < dd.load.length; k++) {
          const lf = dd.capacity[k] > 0 ? dd.load[k] / dd.capacity[k] : 0;
          segs.push({ path: samplePath(dir, dir.stopS[k], dir.stopS[k + 1], false), lf, load: dd.load[k], side: 1 });
        }
      });
    }
    this.crowdSegs = segs;
    this.view.invalidate();
  }

  private crowdLayers(): Layer[] {
    if (this.overlays.mode !== 'crowding' || !this.crowdSegs.length) return [];
    const max = this.crowdSegs.reduce((m, s) => Math.max(m, s.load), 1);
    return [
      new PathLayer<CrowdSeg, PathStyleExtensionProps<CrowdSeg>>({
        id: 'crowd-segments',
        data: this.crowdSegs,
        getPath: (d) => d.path,
        getColor: (d) => crowdColor(d.lf, 235),
        getWidth: (d) => 3 + 9 * Math.sqrt(d.load / max),
        widthUnits: 'pixels',
        getOffset: 0.6,
        extensions: [offsetExt],
        capRounded: true,
        parameters: DEPTH,
      }),
    ];
  }

  // ------------------------------------------------------------------ flow lines & highlights
  setStationFlows(id: number | null, from: { tract: number; count: number }[], to: { tract: number; count: number }[]): void {
    if (id === null) {
      this.stationFlows = { id: null, arcs: [] };
      this.view.invalidate();
      return;
    }
    const s = this.game.network.stations.get(id);
    if (!s) return;
    const p = this.game.network.stationPos(s);
    const at = toLonLat(p.x, p.y);
    const T = this.world.tracts;
    this.stationFlows = {
      id,
      arcs: [
        ...from.map((f) => ({ from: [T[f.tract].lon, T[f.tract].lat] as [number, number], to: at, count: f.count, transitShare: 0 })),
        ...to.map((f) => ({ from: at, to: [T[f.tract].lon, T[f.tract].lat] as [number, number], count: f.count, transitShare: 1 })),
      ],
    };
    this.view.invalidate();
  }

  setTractHighlight(i: number | null): void {
    this.tractHL = i;
    this.view.invalidate();
  }

  private flowLayers(): Layer[] {
    const out: Layer[] = [];
    if (this.stationFlows.arcs.length) {
      const max = this.stationFlows.arcs.reduce((m, a) => Math.max(m, a.count), 1);
      out.push(
        new ArcLayer<FlowLine>({
          id: 'station-flows',
          data: this.stationFlows.arcs,
          getSourcePosition: (a) => a.from,
          getTargetPosition: (a) => a.to,
          getSourceColor: (a) => (a.transitShare ? [216, 115, 28, 120] : [0, 163, 176, 60]),
          getTargetColor: (a) => (a.transitShare ? [216, 115, 28, 230] : [0, 163, 176, 230]),
          getWidth: (a) => 1.5 + 6 * Math.sqrt(a.count / max),
          widthUnits: 'pixels',
          getHeight: 0.3,
          parameters: DEPTH,
        }),
      );
    }
    if (this.tractHL !== null) {
      const t = this.world.tracts[this.tractHL];
      out.push(
        new ScatterplotLayer({
          id: 'tract-hl',
          data: [t],
          getPosition: (d) => [d.lon, d.lat],
          getRadius: (d) => d.radius,
          radiusUnits: 'meters',
          getFillColor: [255, 194, 74, 30],
          stroked: true,
          getLineColor: [255, 194, 74, 220],
          getLineWidth: 2,
          lineWidthUnits: 'pixels',
          parameters: DEPTH,
        }),
      );
    }
    return out;
  }

  private trainLayers(): Layer[] {
    const c = this.compiledForSnapshot();
    const zoom = this.view.map.getZoom();
    this.trains.update(c?.net ?? null, this.sim.trains(), this.network.routeOffsets, this.view.is3D, lineScale(zoom));
    return this.trains.layers(zoom, (id) => this.game.select({ kind: 'train', id }));
  }

  private constructionLabels(): Layer[] {
    const net = this.game.network;
    const data: { pos: [number, number]; text: string }[] = [];
    for (const e of net.edges.values()) {
      if (e.status !== 'construction') continue;
      const g = net.geom(e.id);
      const [x, y] = slicePolyline(g.xs, g.ys, g.cum, g.length / 2, g.length / 2 + 0.01)[0];
      data.push({ pos: toLonLat(x, y), text: `${Math.floor(progress(e, this.game.time) * 100)}%` });
    }
    if (!data.length || this.view.map.getZoom() < 11) return [];
    return [
      new TextLayer({
        id: 'construction-labels',
        data,
        getPosition: (d) => d.pos,
        getText: (d) => d.text,
        getSize: 12,
        getColor: [255, 194, 74, 255],
        fontFamily: 'Overpass, sans-serif',
        fontWeight: 800,
        outlineWidth: 3,
        outlineColor: [22, 27, 33, 240],
        fontSettings: { sdf: true, fontSize: 48, buffer: 6 },
        getPixelOffset: [0, -12],
        parameters: DEPTH,
        updateTriggers: { getText: Math.floor(this.game.time / 3600) },
      }),
    ];
  }

  // ------------------------------------------------------------------ money
  setFare(f: number): void {
    this.game.fare = Math.max(ECONOMY.fareMin, Math.min(ECONOMY.fareMax, Math.round(f / ECONOMY.fareStep) * ECONOMY.fareStep));
    this.sim.setFare(this.game.fare);
    this.toast('Fare changed', `$${this.game.fare.toFixed(2)} — commuters reconsider at 3 am`, 'amber');
    this.refreshPanel();
  }

  issueBond(): void {
    const b = this.game.finance.issueBond(this.game.day);
    if (!b) this.toast('No bond room left', `The limit is ${fmtMoney(ECONOMY.bondMax)}`, 'red');
    else this.toast('Bond issued', `${fmtMoney(b.principal)} at ${(ECONOMY.bondRate * 100).toFixed(0)}% · ${fmtMoney(b.monthlyPayment)}/month`, 'amber');
    this.game.events.emit('money', undefined);
  }

  // ------------------------------------------------------------------ saving
  buildSave(name = 'Autosave'): SaveFile {
    return buildSave(this.game, { name, goals: this.goals, lastReport: this.report, tutorialDone: this.tutorialDone, settings: this.settings, modeState: this.lastModeState });
  }

  async save(slot: SlotId, name?: string): Promise<boolean> {
    if (this.gameOver && slot === 'autosave') return false;
    try {
      await writeSlot(slot, this.buildSave(name ?? (slot === 'autosave' ? 'Autosave' : `Slot ${slot.slice(-1)}`)));
      return true;
    } catch (e) {
      console.warn('save failed', e);
      return false;
    }
  }

  async saveWithFreshModeState(slot: SlotId, name?: string): Promise<boolean> {
    try {
      this.lastModeState = await this.sim.query<ModeState>({ kind: 'modeState' });
    } catch {
      /* keep the cached one */
    }
    return this.save(slot, name);
  }

  private onHide = () => {
    this.save('autosave');
  };
  private onVisibility = () => {
    if (document.visibilityState === 'hidden') this.save('autosave');
  };

  openMenu(): void {
    openMenu(this);
  }

  startTutorial(): void {
    this.tutorial?.close();
    this.tutorial = new Tutorial(this, () => {
      this.tutorialDone = true;
      this.tutorial = null;
    });
  }

  exitToTitle(): void {
    this.destroy();
    this.opts.exit();
  }

  // ------------------------------------------------------------------ keyboard
  private onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (document.querySelector('.modal-back')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) this.game.redo();
      else this.game.undo();
      return;
    }
    if (ctrl && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      this.game.redo();
      return;
    }
    if (ctrl || e.altKey) return;
    if (this.tools.key(e)) {
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case ' ':
        e.preventDefault();
        this.togglePause();
        break;
      case '1':
      case '2':
      case '3':
      case '4':
        this.setSpeedIndex(Number(e.key) - 1);
        break;
      case 'v':
      case 'V':
        this.view.toggleView3D();
        break;
      case 't':
      case 'T':
        this.setTool('track');
        break;
      case 's':
      case 'S':
        this.setTool('station');
        break;
      case 'r':
      case 'R':
        this.setTool('route');
        break;
      case 'b':
      case 'B':
        this.setTool('bulldoze');
        break;
      case 'Escape':
        if (this.tools.active?.id !== 'select') {
          if (this.tools.active?.id === 'route') this.routeTool.cancel();
          else this.setTool('select');
        } else this.game.select(null);
        break;
    }
  };
}

export const AGENT_SCALE_DEFAULT = COMMUTERS.agentScale;
