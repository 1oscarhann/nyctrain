/**
 * The running game on the main thread: wires the map, the sim worker, tools, panels, overlays,
 * goals, saving and keyboard shortcuts together. The main thread only renders and handles input;
 * the simulation lives in the worker.
 */
import { researchDef, TRAIN_MARKS_BY_RESEARCH } from '../core/research';
import { researchPanel } from './panels/researchPanel';
import { ArcLayer, ScatterplotLayer, TextLayer, PathLayer } from '@deck.gl/layers';
import { PathStyleExtension, type PathStyleExtensionProps } from '@deck.gl/extensions';
import type { Layer } from '@deck.gl/core';
import { BONDS, CHAOS, CINEMATIC, COMMUTERS, ECONOMY, MAP, STATION_CROWD, TIME, TRAINS, type ChaosLevel, type GrowthPace, type StockId, type TrackLevel } from '../balance';
import { city, cityBalance } from '../cities';
import { Game, newChaosSeed, type Selection } from '../core/game';
import { toLocal, toLonLat } from '../core/geo';
import { dayIndex, isNewMonth, monthKey, SECONDS_PER_DAY, timeOfDay, yearOf } from '../core/calendar';
import { fmtCount, fmtDensity, fmtMoney, setUnits } from '../core/units';
import { defaultFares, fareSummary, type FarePolicy } from '../economy/fares';
import { dayKpi } from '../economy/finance';
import { yearsWithData } from '../economy/yearReview';
import { carSaleValue, fleetPlan, sellIdleCars, sellSpareCars } from '../routes/fleet';
import { checkGoals, emptyGoals, goalTitle, type GoalState } from '../core/goals';
import { placeAirportStations, placeHubs } from '../core/hubs';
import type { Company } from '../core/company';
import { JunctionTool } from '../construction/junctionTool';
import { LineTool } from '../construction/lineTool';
import { SchoolLayers } from '../map/schoolLayers';
import { DestinationLayers } from '../map/destinationLayers';
import { zoneLayers } from '../map/zoneLayers';
import { tunnelZone } from '../core/zones';
import { StationAudio } from './stationAudio';
import { foundCompany } from './founding';
import { randomLogo, suggestName } from './logo';
import { nextTier } from '../construction/stationTiers';
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
import { ChaosLayers } from '../map/chaosLayers';
import { nameStationAt } from '../map/naming';
import { PlaceNames, tractName } from '../map/placeNames';
import { compileNetwork, type CompileResult } from '../routes/compile';
import { RouteTool } from '../routes/routeTool';
import { stationsAlongRoute, type AlongStation } from '../routes/express';
import { constructionLabelEdges } from './express';
import { hexRgb } from '../map/networkLayers';
import { SimClient } from '../sim/client';
import { servedStations } from '../sim/growth';
import type { Alert, CRoute, DayReport, GrowthData, GrowthMonth, GrowthView, ModeState, ServiceOverride, SimState, Snapshot } from '../sim/protocol';
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
import { Busy, confirmDialog, Legend, modal, Toasts, Tooltip } from './widgets';
import type { Panel } from './panels/common';
import { stationPanel } from './panels/stationPanel';
import { routeEditor, routePanel } from './panels/routePanel';
import { edgePanel, tractPanel, trainPanel } from './panels/inspectPanels';
import { networkPanel } from './panels/networkPanel';
import { financePanel, type FinanceTab, type PnlRange } from './panels/financePanel';
import { goalsPanel } from './panels/goalsPanel';
import { alertsPanel } from './panels/alertsPanel';
import { AlertFeed, describeAlert, eventWhen, fmtK, isIncident, LEVEL_HINT, LEVEL_LABEL, outcomeText, plainDetail, wrapUpToasts, type RouteRef } from './alertFeed';
import { openMenu } from './menu';
import { Tutorial } from './tutorial';
import { showGameOver, showMonthReport, showYearReview } from './reports';
import { fareToastBody, fmtMoneyFine, fmtRate, holdingToast, prepayOptions, refinanceText, saleText } from './opsMoney';
import { districtWord, growthToasts, GROWTH_PACE_HINT, GROWTH_PACE_LABEL } from './livingCity';
import { Cinematic } from '../cinematic';

export interface AppOptions {
  sandbox: boolean;
  save: SaveFile | null;
  /** City chaos level for a new game (default CHAOS.defaultLevel; a save keeps its own). */
  chaos?: ChaosLevel;
  /** The company founded on the title screen (a new game). */
  company?: Omit<Company, 'founded'>;
  settings: SaveSettings;
  tutorial: boolean;
  /** Return to the title screen. */
  exit: () => void;
  /** Start again from a save (load, import, settings change). */
  restart: (save: SaveFile) => void;
}

const DEPTH = { depthCompare: 'always', depthWriteEnabled: false } as const;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
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
  /** Real schools (Overlays menu → Schools): loaded in the background, shown when switched on. */
  readonly schools = new SchoolLayers();
  /** Airports and universities on the map. */
  readonly destinations = new DestinationLayers();
  /** Station sounds (crowd murmur and arrival chimes). */
  readonly audio = new StationAudio();
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
  /** City chaos: alerts, today's info and announced events; markers on the map. */
  readonly feed: AlertFeed;
  readonly chaosLayers = new ChaosLayers();
  /** Cinematic (v2): day and night, the night glow, the follow-cam, photo mode and the timelapse. */
  readonly cinematic: Cinematic;
  private chaosAnim: (() => void) | null = null;
  private lastIncidentToast = -Infinity;
  private focusEvent: number | null = null;
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
  /** Mode shares and the growth state their groups belong to, from the last dayEnd message (or a simState reply before a manual save). */
  private lastSimState: { mode: ModeState | null; growth: GrowthData | null } | null = null;
  /** Living City: the last month close's report (the month report's City section, toasts), and the growth overlay's data (lazy, see loadGrowthView). */
  lastGrowth: GrowthMonth | null = null;
  /** The tract the last "is booming" toast named (this session): it is not toasted again until another tract tops a month. */
  private lastBoomToast: number | null = null;
  growthView: GrowthView | null = null;
  private growthViewPending: Promise<GrowthView | null> | null = null;
  /** Bumped whenever the cached growth view is dropped, so a reply to an older query isn't cached. */
  private growthViewGen = 0;
  /** Map place labels seen this session (tract names, §2.4). */
  readonly places: PlaceNames;
  /** A save from before Living City: the first month report shows a one-time hint. */
  livingHintPending = false;
  private servedCache: { version: number; list: { id: number; name: string; x: number; y: number; region: number }[]; lonLat: [number, number][] } | null = null;
  private stopAnim: (() => void) | null = null;
  private renderPending = false;
  private panelTimer = 0;
  private destroyed = false;
  private intervals: number[] = [];
  private gameOver = false;
  private stationCap = new Map<number, number>();
  /** Selection the side panel shows (its scroll position is kept when it is rebuilt). */
  private panelKey = '';
  /** Finances tab open this session (not saved). */
  financeTab: FinanceTab = 'overview';
  /** Finances → Profit & loss range (session only). */
  pnlRange: PnlRange = 'fortnight';
  /** Fares tab: "Same fare all day" unticked while the fares are still equal (session only). */
  fareSplit = false;

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
    this.terrain = new WorldTerrain(new LandMask(land, MAP.landCell, MAP.landClose), this.tractIndex, world.relief ?? null);
    this.game = new Game(world, this.terrain, { sandbox: opts.sandbox, fares: defaultFares() });
    this.goals = emptyGoals();
    this.tutorialDone = !opts.tutorial;
    let modeState: ModeState | undefined;
    let growth: GrowthData | null = null;
    if (opts.save) {
      const r = applySave(this.game, opts.save);
      this.goals = { ...emptyGoals(), ...r.goals };
      this.report = r.lastReport;
      modeState = r.modeState;
      growth = r.growth;
      this.lastSimState = { mode: r.modeState ?? null, growth: r.growth };
      this.tutorialDone = r.tutorialDone || !opts.tutorial;
    } else {
      // A new game draws its own seed: city chaos (calendar, weather, incidents) and the bond
      // market's walk both derive from it.
      this.game.setGameSeed(newChaosSeed());
      if (opts.chaos) this.game.chaos.level = this.game.chaos.levelToday = opts.chaos;
      // Intertown: the London terminal (Victoria) is there from day one.
      placeHubs(this.game);
      // Airports: their stations are built from the start, waiting for a line.
      placeAirportStations(this.game);
      // Your company, and the government's start-up grant as the opening balance.
      if (opts.company) {
        this.game.company = { ...opts.company, founded: this.game.day };
        if (!opts.sandbox && opts.company.grant > 0) this.game.finance.cash = opts.company.grant;
      }
    }
    this.feed = new AlertFeed(this.game);

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
    this.schools.onChange = () => this.view.invalidate();
    this.schools.load(new URL(city().dataPath, document.baseURI).href).then(() => { this.toolbar?.update(); this.refreshPanel(); });
    this.elevated = new Elevated3D(view.map);
    this.overlays = new Overlays(world.tracts, fmtDensity);
    this.overlays.setRelief(world.relief ?? null);
    this.overlays.districtWord = districtWord;
    this.overlays.growthOff = () => this.game.growthPace === 'off';
    this.places = new PlaceNames(view.map, (x, y) => !this.terrain.isWater(x, y), (x, y) => this.terrain.borough(x, y));

    // ---- tools
    this.tools = new ToolManager(view);
    this.trackTool = new TrackTool(this);
    this.stationTool = new StationTool(this);
    this.routeTool = new RouteTool(this);
    this.tools.register(new SelectTool(this));
    this.tools.register(new LineTool(this));
    this.tools.register(this.trackTool);
    this.tools.register(new JunctionTool(this));
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
      // A building tool needs the map: a full-screen screen steps aside.
      if (id !== 'select' && this.panel?.full) this.game.select(null);
      // The tunnel-only zone shows stronger while building.
      this.view.invalidate();
    };

    // ---- deck.gl layers, bottom to top
    view.addLayers('overlays', () => this.overlays.layers(view.is3D));
    view.addLayers('crowding', () => this.crowdLayers());
    view.addLayers('elevated', () => this.elevated.layers(this.network, view.is3D, view.map.getZoom(), this.cinematic.glow));
    view.addLayers('venues', () => this.chaosLayers.venueLayers(this.cinematic.glow));
    view.addLayers('flows', () => this.flowLayers());
    view.addLayers('trains', () => this.trainLayers());
    view.addLayers('schools', () => this.schools.layers(view.map.getZoom()));
    view.addLayers('tunnel-zone', () => zoneLayers(['track', 'line', 'station'].includes(this.tools.active?.id ?? ''), this.cinematic.prefs.dayNight === 'light'));
    view.addLayers('destinations', () => this.destinations.layers(view.map.getZoom(), this.cinematic.prefs.dayNight === 'light'));
    view.addLayers('stations', () => this.stations.layers(view.map.getZoom(), performance.now(), this.cinematic.glow));
    view.addLayers('route-pattern', () => this.routePatternLayers());
    view.addLayers('venue-labels', () => this.chaosLayers.venueLabelLayers(view.map.getZoom()));
    view.addLayers('incidents', () => this.chaosLayers.incidentLayers(performance.now()));
    view.addLayers('construction', () => this.constructionLabels());
    view.addLayers('tool', () => this.tools.layers());
    // (Cinematic adds the timelapse player's layers last; while it plays they are the only ones.)
    this.cinematic = new Cinematic(this);

    // ---- events
    const g = this.game;
    g.events.on('network', () => this.onDesignChange());
    g.events.on('routes', () => this.onDesignChange());
    g.events.on('money', () => {
      this.blueprintBar.update();
      if (this.game.selection?.kind === 'finance') this.refreshPanel();
    });
    g.events.on('toast', (t) => this.toast(t.title, t.body, t.tone));
    // Research in force changes speeds, dwells and costs: re-time the network and redraw panels.
    g.events.on('research', () => {
      this.scheduleRecompile();
      this.topbar.update();
      if (this.game.selection) this.refreshPanel();
    });
    g.events.on('select', (sel) => this.onSelect(sel));
    g.events.on('chaos', () => {
      this.feed.touch();
      this.refreshChaos();
    });
    view.events.on('view3d', () => this.scheduleRender());
    this.sim.events.on('ready', (r) => {
      this.baseline = r.baseline;
      this.topbar.update();
    });
    this.sim.events.on('snapshot', (s) => this.onSnapshot(s));
    this.sim.events.on('dayEnd', ({ report, state }) => this.onDayEnd(report, state));
    this.sim.events.on('busy', (l) => this.busy.set(l));
    this.sim.events.on('event', (e) => this.toast(e.title, e.body, e.tone));
    this.sim.events.on('error', (m) => this.toast('Simulation error', m, 'red'));
    this.sim.events.on('alert', (a) => this.onAlert(a));
    this.sim.events.on('dayChaos', (info) => {
      // Kept for saves: a mid-day load plans the rest of today at this level, from this exposure.
      this.game.setChaosToday(info);
      this.feed.setInfo(info);
      // Event service that ended overnight goes now, not at midnight.
      this.game.pruneService(Math.max(this.game.time, info.day * SECONDS_PER_DAY + TIME.modeChoiceAt));
      this.dropOrphanService();
      this.refreshChaos();
    });

    this.sim.init({
      agentScale: this.settings.agentScale,
      seed: this.settings.seed,
      time: this.game.time,
      fares: this.game.fares,
      modeState,
      chaos: this.game.chaosInit(),
      service: this.game.chaos.service,
      growth,
      growthPace: this.game.growthPace,
    });
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
        // Day and night (paint pushed only when the palette moved), the photo caption, the follow chip.
        this.cinematic.tick();
        if (++this.panelTimer % 2 === 0) this.panel?.update?.();
      }, CINEMATIC.tickMs),
    );
    if (!this.tutorialDone) setTimeout(() => this.startTutorial(), 600);
    // A save from before city chaos: say once what's new.
    if (!opts.save && this.game.company) {
      const c = this.game.company;
      const airports = [...this.game.network.stations.values()].filter((st) => /Airport/.test(st.name)).length;
      setTimeout(() => this.toasts.show(`${c.name} is open for business`, `${c.grant > 0 ? `The government's start-up grant of ${fmtMoney(c.grant)} is in the bank. ` : ''}${airports ? `${airports} airport station${airports > 1 ? 's are' : ' is'} built and waiting for a line. ` : ''}${tunnelZone() ? `${tunnelZone()!.name} is tunnels only.` : ''}`, 'green', 11000), 1200);
    }
    if (opts.save?.migratedFrom !== undefined && opts.save.migratedFrom < 3) {
      setTimeout(() => this.toasts.show('New: city events, disruptions and weather', 'Change the chaos level in Service alerts (A).', 'green', 9000, () => this.openAlerts()), 1500);
    }
    // A save from before operations control: its routes keep their fleets (holding off, no recovery).
    if (opts.save?.migratedFrom !== undefined && opts.save.migratedFrom < 4) {
      setTimeout(() => this.toasts.show('New: operations control, fares and the bond market', 'Holding, timepoints and recovery are in each route panel (off for your existing routes). Fares, borrowing and car sales are in Finances (M).', 'green', 9000, () => this.openFinance('overview')), 1800);
    }
    // A save from before Living City: the city starts growing (Steady) from the next month end.
    if (opts.save?.migratedFrom !== undefined && opts.save.migratedFrom < 5) {
      this.livingHintPending = true;
      setTimeout(() => this.toasts.show('New: the city grows around good transit', 'Each month end, well-served neighbourhoods grow and a value-capture district pays the authority. G shows the growth map; Menu → City growth sets the pace.', 'green', 9000, () => this.setOverlay('growth')), 2100);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.places.destroy();
    this.save('autosave');
    this.sim.terminate();
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('pagehide', this.onHide);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.intervals.forEach((i) => clearInterval(i));
    this.cinematic.destroy();
    this.stopAnim?.();
    this.chaosAnim?.();
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
    return nameStationAt(this.view.map, x, y, taken, (px, py) => !this.terrain.isWater(px, py), (px, py) => city().regions.find((r) => r.code === this.terrain.borough(px, py))?.name ?? null);
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
    // Event service on a deleted route would still be saved and listed: drop it.
    if (this.game.pruneServiceRoutes().length) this.sim.setService(this.game.chaos.service);
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
    this.stations.update(this.view.is3D, this.network.quadOffsets);
    this.tools.refreshXray();
    this.view.invalidate();
  }

  /** Edits come in bursts: compile once they pause. The client sends it before any skip or speed change. */
  private scheduleRecompile(): void {
    this.sim.setNetworkSoon(() => {
      if (!this.destroyed) this.recompile();
    });
  }

  private recompile(): void {
    const c = compileNetwork(this.game);
    const prev = this.compiled;
    // opsKey: holding, timepoints and short turns reach the worker only through a recompile.
    const sig = (x: CompileResult | null) => (x ? JSON.stringify(x.net.routes.map((r) => [r.id, r.fleet, r.cars, r.headways, r.dirs[0].length, r.dirs[0].stopS.length, r.color, r.name, r.opsKey])) + x.net.stations.length + '|' + x.net.stations.map((s) => `${s.parking ?? 0}/${s.capacity ?? 0}/${s.tier ?? 0}`).join(',') : '');
    if (prev && sig(prev) === sig(c)) return;
    this.compiled = c;
    this.compiledByVersion.set(c.net.version, c);
    if (this.compiledByVersion.size > 4) this.compiledByVersion.delete(this.compiledByVersion.keys().next().value!);
    // Comfortable waiting capacity per station (platform length × upgrade tier).
    this.stationCap.clear();
    for (const st of c.net.stations) if (st.capacity) this.stationCap.set(st.id, st.capacity);
    this.sim.setNetwork(c.net);
    // The value-capture district follows the served stations: the growth view is redrawn.
    this.dropGrowthView();
    const m = this.overlays.mode;
    if (m === 'growth' || m === 'residents' || m === 'jobs') this.loadOverlayData(m);
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
    const day = dayIndex(s.time);
    if (day !== this.feed.day) this.onNewDay(day, s.time);
    this.applyStationStats();
    this.stations.refreshStats();
    this.updateAudio(s);
    if (this.speedIndex < 0) this.view.invalidate();
  }

  /** Listen to the selected station, else the one under the map centre when zoomed right in. */
  private updateAudio(s: Snapshot): void {
    const c = this.compiledForSnapshot();
    let focus = -1;
    if (c) {
      const sel = this.game.selection;
      let id = sel?.kind === 'station' ? sel.id : -1;
      if (id < 0 && this.view.map.getZoom() >= 15) {
        const ctr = this.view.map.getCenter();
        const [x, y] = toLocal(ctr.lng, ctr.lat);
        let best = 350;
        for (const st of this.game.network.stations.values()) {
          const p = this.game.network.stationPos(st);
          const d = Math.hypot(p.x - x, p.y - y);
          if (d < best) ((best = d), (id = st.id));
        }
      }
      if (id >= 0) focus = c.net.stations.findIndex((st) => st.id === id);
    }
    this.audio.setFocus(focus);
    this.audio.update(s, c?.net ?? null, this.speedIndex < 0);
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

  /** Comfortable waiting capacity of a built station (0 if not compiled yet). */
  stationCapacity(stationId: number): number {
    return this.stationCap.get(stationId) ?? 0;
  }

  stationCrowding(stationId: number): number {
    return this.stations.stats.get(stationId)?.crowding ?? 0;
  }

  private onDayEnd(r: DayReport, st: SimState): void {
    const g = this.game;
    // The worker is already past midnight; move the mirrored clock too, so the autosave below
    // can't hold a time from before the day it has settled.
    g.setTime(Math.max(g.time, (r.day + 1) * SECONDS_PER_DAY));
    // The mode shares and growth right after this day, in the same message as its report: any
    // save from here on (the midnight autosave, or one on quit or tab hide) holds this day's
    // finances (and a month close's value capture) with the growth and groups they belong to.
    this.lastSimState = st;
    g.finance.settleDay({ day: r.day, riders: r.riders, revenue: r.fareRevenue, carKm: r.carKm, stationsOpen: r.stationsOpen, kpi: dayKpi(r), ...(r.growth ? { valueCapture: r.growth.valueCapture } : {}) });
    this.report = r;
    if (r.growth) this.onGrowth(r.growth);
    // Rating changes and bond market shocks from this settle's month-end review.
    for (const ev of g.finance.events) this.toasts.show(ev.title, ev.body, ev.tone, 7000, () => this.openFinance('borrowing'));
    g.events.emit('money', undefined);
    this.checkGoals(r);
    // Station crowding: point at the worst overcrowded station that can still be upgraded.
    if (r.stationPeak) {
      // The worst: most people turned away, else the fullest.
      let worst: { id: number; peak: number; turned: number } | null = null;
      for (const [k, v] of Object.entries(r.stationPeak)) {
        const st = g.network.stations.get(Number(k));
        if (!st || v < STATION_CROWD.warnAt || nextTier(st) === null) continue;
        const turned = r.stationTurnedAway?.[st.id] ?? 0;
        if (!worst || turned > worst.turned || (turned === worst.turned && v > worst.peak)) worst = { id: st.id, peak: v, turned };
      }
      if (worst) {
        const st = g.network.stations.get(worst.id)!;
        const body = worst.turned
          ? `Its gates shut and ${fmtCount(worst.turned)} people were turned away yesterday. Upgrade it (N → Stations) to hold more people.`
          : `${Math.round(worst.peak * 100)}% full at its busiest yesterday. Upgrade it (N → Stations) to hold more people and board faster.`;
        this.toasts.show(`${st.name} is overcrowded`, body, worst.turned ? 'red' : 'amber', 9000, () => g.select({ kind: 'station', id: st.id }));
      }
    }
    // Research: a weekday's work; finished projects are in force now (re-time the network).
    const finished = g.advanceResearch();
    if (finished.length) {
      for (const id of finished) {
        const d = researchDef(id);
        const refit = TRAIN_MARKS_BY_RESEARCH.get(id);
        this.toasts.show(`Research done: ${d.name}`, refit ? `${d.blurb}. Refit routes to it in Routes & stations (N); new trains come as it.` : d.blurb, 'green', 10000, () => this.openResearch());
      }
      this.scheduleRecompile();
    }
    this.panel?.dayEnd?.();
    this.applyStationStats();
    this.stations.update(this.view.is3D, this.network.quadOffsets);
    if (this.overlays.mode !== 'none') this.loadOverlayData(this.overlays.mode);
    // Cinematic: the network at every month close goes into the timelapse (saved below).
    if (isNewMonth(r.day + 1)) this.cinematic.recordMonth(r.day);
    if (isNewMonth(r.day + 1) && g.finance.months.length) {
      // The first weekday of January brings the year in review instead of December's report.
      if (monthKey(r.day + 1).endsWith('-01')) showYearReview(this, yearOf(r.day), r.growth ?? null);
      else showMonthReport(this, g.finance.months[g.finance.months.length - 1], r.growth ?? null);
    }
    if (g.finance.bankrupt && !this.gameOver) {
      this.gameOver = true;
      this.setSpeedIndex(-1);
      showGameOver(this);
      return;
    }
    if (g.finance.negativeDays === 1 && !g.sandbox) this.toast('Cash is negative', `Issue a bond or cut costs. ${ECONOMY.bankruptcyDays} days in the red with no bond room means bankruptcy.`, 'red');
    this.feed.endDay(r.chaos, g.time);
    // Event service that has ended is dropped before the autosave.
    g.pruneService(g.time);
    // Autosave at midnight with the state that came with the report (no round trip).
    this.save('autosave');
  }

  // ------------------------------------------------------------------ Living City (plumbing; the UI reads these)
  /**
   * A growth month closed (DayReport.growth): keep its report for the month report and toasts, and
   * drop the cached overlay data. (The value capture is already on the ledger, the goals are
   * checked with the report.)
   */
  private onGrowth(gm: GrowthMonth): void {
    this.lastGrowth = gm;
    this.dropGrowthView();
    // Up to three toasts: the month's top boomtown when it is news, then milestones (§2.1). A click shows the tract.
    for (const t of growthToasts(gm, (i) => this.tractName(i), this.lastBoomToast)) {
      if (t.kind === 'boom') this.lastBoomToast = t.tract;
      this.toasts.show(t.title, t.body, t.tone, 8000, () => this.showTract(t.tract));
    }
  }

  /** Forget the cached growth view (a month closed, the network or the pace changed). */
  private dropGrowthView(): void {
    this.growthView = null;
    this.growthViewPending = null;
    this.growthViewGen++;
  }

  /** The growth overlay's and panels' data: queried once and cached until the next month close or network change. */
  loadGrowthView(): Promise<GrowthView | null> {
    if (this.growthView) return Promise.resolve(this.growthView);
    const gen = this.growthViewGen;
    this.growthViewPending ??= this.sim.query<GrowthView | null>({ kind: 'growthView' }).then((v) => {
      if (gen === this.growthViewGen) {
        this.growthView = v;
        this.growthViewPending = null;
      }
      return v;
    });
    return this.growthViewPending;
  }

  /** Living City pace (menu → City growth): saved with the game, applied by the worker at the next month close. */
  setGrowthPace(p: GrowthPace): void {
    this.game.growthPace = p;
    this.sim.setGrowthPace(p);
    this.dropGrowthView();
    this.toast(`City growth: ${GROWTH_PACE_LABEL[p]}`, `${GROWTH_PACE_HINT[p]}. From the next month end.`, 'amber');
    const m = this.overlays.mode;
    if (m === 'growth' || m === 'residents' || m === 'jobs') this.loadOverlayData(m);
    if (this.panel) this.refreshPanel();
  }

  /** Served stations (of the compiled network on screen) with their names, cached per compile. */
  servedList(): { id: number; name: string; x: number; y: number }[] {
    return this.served()?.list ?? [];
  }

  private served(): { list: { id: number; name: string; x: number; y: number; region: number }[]; lonLat: [number, number][] } | null {
    const c = this.compiled;
    if (!c) return null;
    if (this.servedCache?.version !== c.net.version) {
      const byId = new Map(c.net.stations.map((st) => [st.id, st]));
      const list = servedStations(c.net).map((p) => ({ id: p.id, name: byId.get(p.id)?.name ?? '', x: p.x, y: p.y, region: this.terrain.borough(p.x, p.y) }));
      this.servedCache = { version: c.net.version, list, lonLat: list.map((p) => toLonLat(p.x, p.y)) };
    }
    return this.servedCache;
  }

  /** A tract's name for toasts, reports and hover (§2.4): a map label, "around <station>", or its formal name. */
  tractName(i: number): string {
    const t = this.world.tracts[i];
    // Labels and stations in the tract's own borough only (not across a river).
    return t ? tractName(t, this.places, this.servedList(), this.terrain.borough(t.x, t.y)) : `Tract ${i}`;
  }

  /** Open a tract's panel and fly there. */
  showTract(i: number): void {
    const t = this.world.tracts[i];
    if (!t) return;
    this.game.select({ kind: 'tract', index: i });
    this.flyTo(t.x, t.y);
  }

  private checkGoals(report: DayReport | null): void {
    const done = checkGoals(this.game, this.goals, report ?? this.report, (x, y) => this.terrain.borough(x, y));
    for (const id of done) this.toast('Goal complete', goalTitle(id), 'green');
    if (done.length && this.game.selection?.kind === 'goals') this.refreshPanel();
  }

  // ------------------------------------------------------------------ selection & panels
  private onSelect(sel: Selection | null): void {
    this.network.highlight(sel);
    this.view.invalidate();
    this.tools.refreshXray();
    this.toolbar.updateAlerts();
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
    this.nextPanelKey = JSON.stringify(sel);
    switch (sel.kind) {
      case 'station':
        return this.showPanel(this.withBack(stationPanel(this, sel.id), 'stations'));
      case 'route':
        return this.showPanel(this.withBack(routePanel(this, sel.id), 'routes'));
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
        return this.showPanel(networkPanel(this, sel.tab));
      case 'alerts':
        return this.showPanel(alertsPanel(this, sel.focus, sel.event));
      case 'research':
        return this.showPanel(researchPanel(this));
    }
  }

  /** A link back to the Routes & stations screen at the top of a route or station panel. */
  private withBack(p: Panel, tab: 'routes' | 'stations'): Panel {
    const body = p.el.querySelector('.side-body');
    body?.prepend(h('button', { class: 'hw-btn ghost small back-link', onclick: () => this.game.select({ kind: 'routes', tab }) }, tab === 'routes' ? '← All routes' : '← All stations'));
    return p;
  }

  private nextPanelKey = '';
  private showPanel(p: Panel | null): void {
    // A rebuild of the same panel (after a change, a day end, a money change) keeps its scroll position.
    const key = this.nextPanelKey;
    this.nextPanelKey = '';
    const same = !!p && !!key && key === this.panelKey;
    const keep = same ? (this.side.querySelector('.side-body')?.scrollTop ?? 0) : 0;
    // ...and keyboard focus, on a control that names itself (data-focus), e.g. a fare slider.
    const active = document.activeElement;
    const focusKey = same && active instanceof HTMLElement && this.side.contains(active) ? active.dataset.focus : undefined;
    this.panelKey = p ? key : '';
    this.panel?.destroy?.();
    this.panel = p;
    // A tooltip from a button in the old panel would otherwise stay up (its mouseleave never fires).
    this.tooltip.show(null);
    this.side.replaceChildren();
    if (p) this.side.append(p.el);
    if (focusKey) {
      const el = [...this.side.querySelectorAll<HTMLElement>('[data-focus]')].find((x) => x.dataset.focus === focusKey);
      if (el && !(el as HTMLInputElement).disabled) el.focus({ preventScroll: true });
    }
    if (keep) {
      const body = this.side.querySelector('.side-body');
      if (body) body.scrollTop = keep;
    }
    this.side.classList.toggle('open', !!p);
    this.side.classList.toggle('full', !!p?.full);
    document.body.classList.toggle('fs-open', !!p?.full);
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
      this.routeTool.click({ x: p.x, y: p.y, lngLat: [lon, lat], px: [0, 0], shift: false, alt: false });
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
    if (mode === 'growth' || mode === 'residents' || mode === 'jobs') {
      // Residents and jobs as they are now, and growth since the start (and the district's rings).
      this.loadGrowthView().then((v) => {
        if (this.destroyed) return;
        // The same objects until a month closes or the network changes: the overlay rebuilds only then.
        this.overlays.setData({ growth: v, served: this.served()?.lonLat ?? [] });
        this.legend.set(this.overlays.legend());
        this.view.invalidate();
      });
    } else if (mode === 'demand' || mode === 'demandWork') {
      this.sim.query<Float32Array>({ kind: 'modes' }).then((m) => {
        this.overlays.setData({ modes: m });
        this.legend.set(this.overlays.legend());
        this.view.invalidate();
      });
    } else if (mode === 'unserved') {
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
    return this.trains.layers(zoom, (id) => this.game.select({ kind: 'train', id }), this.cinematic.glow);
  }

  private patternCache: { along: AlongStation[]; color: string; data: [number, number][] } | null = null;

  /**
   * Express service (v2): while a route is selected, the stations its line runs past without
   * stopping get hollow rings in the route colour (the route tool draws its draft's own).
   */
  private routePatternLayers(): Layer[] {
    const sel = this.game.selection;
    if (sel?.kind !== 'route' || this.tools.active?.id === 'route') return [];
    const r = this.game.routes.get(sel.id);
    if (!r) return [];
    const net = this.game.network;
    const path = this.game.routes.path(net, r);
    if (!path.ok) return [];
    const along = stationsAlongRoute(net, r.id, r.stops, path);
    if (this.patternCache?.along !== along || this.patternCache.color !== r.color) {
      const lo = (path.stopS[0] ?? 0) - 1, hi = (path.stopS[path.stopS.length - 1] ?? Infinity) + 1;
      const data: [number, number][] = [];
      for (const a of along) {
        if (a.served || a.s < lo || a.s > hi) continue;
        const st = net.stations.get(a.station);
        if (!st) continue;
        const q = net.stationPos(st);
        data.push(toLonLat(q.x, q.y));
      }
      this.patternCache = { along, color: r.color, data };
    }
    const data = this.patternCache.data;
    if (!data.length) return [];
    const rgb = hexRgb(r.color);
    return [
      new ScatterplotLayer<[number, number]>({
        id: 'route-pattern-skips',
        data,
        getPosition: (d) => d,
        getRadius: 9,
        radiusUnits: 'pixels',
        filled: false,
        stroked: true,
        getLineColor: [rgb[0], rgb[1], rgb[2], 255],
        getLineWidth: 2.5,
        lineWidthUnits: 'pixels',
        parameters: DEPTH,
        updateTriggers: { getLineColor: r.color },
      }),
    ];
  }

  private constructionLabels(): Layer[] {
    const net = this.game.network;
    const data: { pos: [number, number]; text: string }[] = [];
    // (One label per four-track section's pair of edges: constructionLabelEdges.)
    for (const id of constructionLabelEdges(net)) {
      const e = net.edges.get(id)!;
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
  /** Change the fare policy (normalized to the city's range and step); billing changes at once, choices at 3 am. */
  setFares(p: Partial<FarePolicy>): void {
    const fares = this.game.setFares(p);
    this.sim.setFares(fares);
    this.toast('Fares changed', fareToastBody(fareSummary(fares)), 'amber');
    // (game.setFares emits 'money', which rebuilds an open Finances panel.)
  }

  // ------------------------------------------------------------------ city chaos
  /** Chaos level for this game; the sim applies it from the next 3 am. */
  setChaosLevel(level: ChaosLevel): void {
    this.game.setChaosLevel(level);
    this.sim.setChaosLevel(level);
    // Events a new level reveals aren't announcements.
    this.feed.markSeen();
    this.toast(`City chaos: ${LEVEL_LABEL[level]} from 3 am`, `${LEVEL_HINT[level]}.`, 'amber');
    // The announced days are redrawn at the new level: service for events that vanished goes.
    this.dropOrphanService();
  }

  /**
   * Cancel event service planned for an event that is no longer on the calendar (today's
   * events as the worker planned them, then the announced days at the player's level). It would
   * otherwise run and be billed with no event card to show or remove it.
   */
  private dropOrphanService(): void {
    const gone = this.feed.orphanService(this.game.chaos.service);
    if (!gone.length) return;
    for (const o of gone) this.game.removeService(o.id);
    this.sim.setService(this.game.chaos.service);
    const routes = [...new Set(gone.map((o) => this.routeRef(o.routeId)?.bullet ?? '?'))].join(' ');
    this.toast('Event service cancelled', `${routes}: its event is no longer on the calendar at this chaos level.`, 'amber');
  }

  openAlerts(f: { focus?: number; event?: number } = {}): void {
    this.game.select({ kind: 'alerts', ...(f.focus !== undefined ? { focus: f.focus } : {}), ...(f.event !== undefined ? { event: f.event } : {}) });
  }

  /** Service alerts is on screen (the route tool takes the side panel while it is active). */
  alertsShowing(): boolean {
    return this.game.selection?.kind === 'alerts' && this.tools.active?.id !== 'route';
  }

  /** Rebrand the company (or found one, for a game from before companies). */
  async openCompany(): Promise<void> {
    const cur = this.game.company;
    const r = await foundCompany(this.root, { sandbox: this.game.sandbox, edit: cur ?? { name: suggestName(city().name), logo: randomLogo(), grantKind: 'standard', grant: 0, founded: this.game.day } });
    if (!r) return;
    this.game.company = { ...r.company, grantKind: cur?.grantKind ?? 'standard', grant: cur?.grant ?? 0, founded: cur?.founded ?? this.game.day };
    this.topbar.renderBrand();
    this.toast(cur ? 'Rebranded' : 'Company founded', this.game.company.name, 'green');
  }

  /** Routes & stations manager (N). */
  /** Research (full screen). */
  openResearch(): void {
    this.game.select({ kind: 'research' });
  }

  toggleResearch(): void {
    if (this.game.selection?.kind === 'research') this.game.select(null);
    else this.openResearch();
  }

  toggleNetwork(tab?: 'routes' | 'stations'): void {
    if (this.game.selection?.kind === 'routes' && (!tab || this.game.selection.tab === tab)) this.game.select(null);
    else this.game.select({ kind: 'routes', tab: tab ?? 'routes' });
  }

  toggleAlerts(): void {
    if (this.alertsShowing()) this.game.select(null);
    else this.openAlerts();
  }

  /** Ease the map to a point (local metres), zooming in to at least 13.5. */
  flyTo(x: number, y: number): void {
    const map = this.view.map;
    map.easeTo({ center: toLonLat(x, y), zoom: Math.max(map.getZoom(), 13.5), duration: 700 });
  }

  /** The event whose venue ring shows on the map (its card is focused), or null. */
  setFocusEvent(id: number | null): void {
    if (id === this.focusEvent) return;
    this.focusEvent = id;
    this.chaosLayers.setEvents(this.feed.events(), this.feed.day, id);
    this.view.invalidate();
  }

  /** Route bullet, colour and name by id (game routes, else the compiled ones). */
  routeRef = (id: number): RouteRef | undefined => {
    const r = this.game.routes.get(id);
    if (r) return { id, bullet: r.bullet, color: r.color, shape: r.shape, name: r.name, ...(r.express ? { express: true } : {}) };
    const c = this.compiled?.net.routes.find((x) => x.id === id);
    return c ? { id, bullet: c.bullet, color: c.color, shape: c.shape, name: c.name, ...(c.express ? { express: true } : {}) } : undefined;
  };

  private onAlert(a: Alert): void {
    const isNew = this.feed.upsert(a) === 'new';
    this.refreshChaos();
    // Alerts from skipped hours arrive in one burst after the skip: they go in the feed, not in toasts.
    if (!isNew || this.sim.skipping) return;
    if (isIncident(a) && a.status === 'active') {
      // Incident toasts at 1×/5× (or severity 3), at most one per toastMinGapMs; the ticker and badge always.
      const t = performance.now();
      if ((this.speedIndex <= CHAOS.toastMaxSpeedIndex || a.severity === 3) && t - this.lastIncidentToast >= CHAOS.toastMinGapMs) {
        this.lastIncidentToast = t;
        const d = describeAlert(a, this.routeRef);
        this.toasts.show(d.title, `${plainDetail(d)} · ${d.when}`, a.severity === 3 ? 'red' : 'amber', 6000, () => this.openAlerts({ focus: a.id }));
      }
    } else if (wrapUpToasts(a, this.compiled?.net)) {
      // Wrap-ups toast only where fans could come by train; the rest go to the feed.
      const d = describeAlert(a, this.routeRef);
      this.toasts.show(d.title, d.detail, 'event', 6000, () => this.openAlerts({ focus: a.id }));
    }
  }

  /** First snapshot of a game day: roll the feed, and announce events that just entered the window. */
  private onNewDay(day: number, now: number): void {
    const fresh = this.feed.rollDay(day, now);
    const venues = cityBalance().chaos.venues;
    for (const ev of fresh.slice(0, 3)) {
      this.toasts.show(`Announced: ${ev.label}`, `${eventWhen(ev, day)} · ${venues[ev.venue].name} · ${fmtCount(ev.attendance)} expected`, 'green', 6000, () => this.openAlerts({ event: ev.id }));
    }
    this.refreshChaos();
  }

  /** Push the feed to the map (closed stations, alerted trains, markers), the bell and the pulse. */
  private refreshChaos(): void {
    const f = this.feed;
    this.stations.setClosed(f.closedStations());
    this.trains.setAlerted(f.alertedTrains());
    this.chaosLayers.setAlerts(f.active());
    this.chaosLayers.setEvents(f.events(), f.day, this.focusEvent);
    this.toolbar.updateAlerts();
    // Markers pulse even while paused.
    const want = this.chaosLayers.hasIncidents;
    if (want && !this.chaosAnim) this.chaosAnim = this.view.beginAnimation();
    else if (!want && this.chaosAnim) {
      this.chaosAnim();
      this.chaosAnim = null;
    }
    this.view.invalidate();
  }

  /** Tooltip for an incident or venue marker under the pointer, or null. */
  chaosTip(px: [number, number]): string | null {
    const inc = this.view.pick(px, ['chaos-incidents']);
    const a = inc !== null ? this.feed.get(inc) : undefined;
    if (a) {
      const d = describeAlert(a, this.routeRef);
      return `<div class="title">${esc(d.title)}</div><div class="hw-muted">${esc(plainDetail(d))} · ${esc(d.when)}</div><div class="hw-muted">Click for Service alerts</div>`;
    }
    const ven = this.view.pick(px, ['chaos-venues']);
    const ev = ven !== null ? this.feed.events().find((e) => e.id === ven) : undefined;
    if (ev) {
      const venue = cityBalance().chaos.venues[ev.venue].name;
      // After the event: its wrap-up (or just "over" until the wrap-up comes).
      const outcome = this.feed.outcome(ev.id);
      const over = this.sim.time() >= ev.day * SECONDS_PER_DAY + ev.end;
      const by = ev.split && ev.split.byTransit > 0 ? ` · ~${fmtK(ev.split.byTransit)} by ${city().transitWord}` : '';
      const when = eventWhen(ev, this.feed.day);
      const line = outcome ? `${when} · ${outcomeText(outcome)}` : over ? `${when} · over${by}` : `${when} · ${fmtCount(ev.attendance)} expected${by}`;
      return `<div class="title">${esc(ev.label)}</div><div class="hw-muted">${esc(venue)} · ${esc(line)}</div><div class="hw-muted">Click for Service alerts</div>`;
    }
    return null;
  }

  /** Plan event service (one override per route and window) and send the full list to the sim. */
  addEventService(list: Omit<ServiceOverride, 'id'>[]): ServiceOverride[] {
    const added = list.map((o) => this.game.addService(o));
    this.sim.setService(this.game.chaos.service);
    return added;
  }

  removeEventService(id: number): void {
    if (this.game.removeService(id)) this.sim.setService(this.game.chaos.service);
  }

  issueBond(): void {
    const b = this.game.finance.issueBond(this.game.day);
    if (!b) this.toast('No bond room left', `The limit is ${fmtMoney(ECONOMY.bondMax)}`, 'red');
    else this.toast('Bond issued', `${fmtMoney(b.principal)} at ${fmtRate(b.rate)} · ${fmtMoneyFine(b.monthlyPayment)}/month`, 'amber');
    this.game.events.emit('money', undefined);
  }

  /** Open Finances at a tab. */
  openFinance(tab?: FinanceTab): void {
    if (tab) this.financeTab = tab;
    // Over the route tool (Finances may still be the selection under its editor), selecting
    // again switches back to Select, as any other panel does; refreshing would redraw the editor.
    if (this.game.selection?.kind === 'finance' && this.tools.active?.id !== 'route') this.refreshPanel();
    else this.game.select({ kind: 'finance' });
  }

  toggleFinance(): void {
    if (this.game.selection?.kind === 'finance' && this.tools.active?.id !== 'route') this.game.select(null);
    else this.openFinance();
  }

  /** Prepay part or all of a bond: a small dialog with the choices, their penalty and the new payment. */
  prepayBond(id: number): void {
    const f = this.game.finance;
    const b = f.bonds.find((x) => x.id === id);
    if (!b) return;
    if (this.game.sandbox) {
      this.toast('Sandbox — borrowing is off', undefined, 'amber');
      return;
    }
    let close: () => void = () => {};
    const opts = h('div', { class: 'prepay-opts' });
    for (const o of prepayOptions(b, f.cash)) {
      opts.append(
        h(
          'button',
          {
            class: 'hw-btn',
            disabled: !o.ok,
            onclick: () => {
              close();
              const res = f.prepayBond(id, o.amount, this.game.day);
              if (!res.ok) this.toast("Couldn't prepay", res.reason, 'red');
              else this.toast(`Prepaid ${fmtMoney(o.amount)} on bond ${id}`, `fee ${fmtMoneyFine(res.fee)}${o.newPayment ? ` · now ${fmtMoneyFine(o.newPayment)}/month` : ' · bond repaid'}`, 'amber');
              this.game.events.emit('money', undefined);
            },
          },
          h('b', null, o.label),
          h('span', { class: 'hw-muted' }, o.ok ? `fee ${fmtMoneyFine(o.fee)} · ${o.newPayment ? `then ${fmtMoneyFine(o.newPayment)}/month` : 'repays the bond'}` : `${o.reason} (needs ${fmtMoney(o.amount + o.fee)})`),
        ),
      );
    }
    const content = h(
      'div',
      null,
      h('h2', null, `Prepay bond ${id}`),
      h('div', { class: 'hw-muted', style: 'line-height:1.5' }, `${fmtMoney(b.balance)} left at ${fmtRate(b.rate)} · ${fmtMoneyFine(b.monthlyPayment)}/month. A ${Math.round(BONDS.prepayPenalty * 100)}% penalty applies to the amount prepaid; the bond keeps its maturity with a lower payment, and bond room is freed at once. Cash ${fmtMoney(f.cash)}.`),
      opts,
      h('div', { class: 'actions' }, h('button', { class: 'hw-btn', onclick: () => close() }, 'Cancel')),
    );
    close = modal(this.root, content);
  }

  /** Refinance a bond at today's new-bond rate (confirm with the fee, the saving and the payback). */
  async refinanceBond(id: number): Promise<void> {
    const f = this.game.finance;
    const q = f.refinanceQuote(id);
    if (!q) return;
    if (!q.ok) {
      this.toast("Can't refinance", q.reason, 'amber');
      return;
    }
    if (!(await this.confirm(`Refinance bond ${id} at ${fmtRate(q.rate)}?`, `${refinanceText(q)}. The remaining term is kept.`, 'Refinance'))) return;
    const res = f.refinanceBond(id, this.game.day);
    if (!res.ok) this.toast("Couldn't refinance", res.reason, 'red');
    else this.toast(`Refinanced bond ${id} at ${fmtRate(q.rate)}`, `saves ${fmtMoneyFine(res.saving)}/month · fee ${fmtMoneyFine(res.fee)}`, 'green');
    this.game.events.emit('money', undefined);
  }

  /** Sell the spare pool's cars of a class (confirmed). */
  async sellSpareCars(cls: StockId): Promise<void> {
    const n = this.game.routes.spareCars[cls];
    if (!n) return;
    if (!(await this.confirm(`Sell ${n} spare ${TRAINS[cls].name} cars for ${fmtMoneyFine(carSaleValue(cls, n))}?`, saleText(cls, n), 'Sell'))) return;
    const res = sellSpareCars(this.game, cls);
    if (res.ok) this.toast(`Sold ${res.cars} cars for ${fmtMoneyFine(res.proceeds)}`, this.game.sandbox ? 'Sandbox: money is unlimited' : undefined, 'green');
    else this.toast("Couldn't sell", res.reason, 'amber');
  }

  /** Sell a route's idle cars (beyond its plan; confirmed). The fleet shrinks on the next compile. */
  async sellIdleCars(routeId: number): Promise<void> {
    const r = this.game.routes.get(routeId);
    if (!r) return;
    const n = fleetPlan(this.game, r).idleCars;
    if (!n) return;
    if (!(await this.confirm(`Sell ${n} idle cars from ${r.bullet} ${r.name} for ${fmtMoneyFine(carSaleValue(r.stock, n))}?`, saleText(r.stock, n), 'Sell'))) return;
    const res = sellIdleCars(this.game, r);
    if (res.ok) this.toast(`Sold ${res.cars} cars for ${fmtMoneyFine(res.proceeds)}`, `${r.bullet} ${r.name}${this.game.sandbox ? ' · sandbox: money is unlimited' : ''}`, 'green');
    else this.toast("Couldn't sell", res.reason, 'amber');
  }

  /** H: switch holding on or off for a route (applies at once; the worker gets it with the recompile). */
  toggleHolding(routeId: number): void {
    const r = this.game.routes.get(routeId);
    if (!r) return;
    const on = !r.control.hold;
    this.game.routes.update(r.id, { control: { ...r.control, hold: on } });
    this.game.events.emit('routes', undefined);
    this.toast(holdingToast(on, r.bullet, r.name), on ? 'Trains wait for an even gap at the first stop and at timepoints.' : 'Trains leave as soon as their slot comes up.', on ? 'green' : 'amber');
  }

  /** The year in review: a given year, else the last finished one (or this year so far). */
  showYearReview(year?: number): void {
    const years = yearsWithData(this.game.finance);
    const now = yearOf(this.game.day);
    const y = year ?? [...years].reverse().find((v) => v < now) ?? years[years.length - 1] ?? now;
    showYearReview(this, y);
  }

  // ------------------------------------------------------------------ saving
  buildSave(name = 'Autosave'): SaveFile {
    return buildSave(this.game, { name, goals: this.goals, lastReport: this.report, tutorialDone: this.tutorialDone, settings: this.settings, modeState: this.lastSimState?.mode ?? null, growth: this.lastSimState?.growth ?? null });
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
      this.lastSimState = await this.sim.query<SimState>({ kind: 'simState' });
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
    // Cinematic first: the timelapse takes every key, photo mode its own (P, L, C, F, Esc) and
    // Space, 1–4 and V; P, F (a train selected) and Esc while following otherwise.
    if (this.cinematic.key(e)) return;
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
        // A focused toolbar button would otherwise also "click" on keyup.
        if ((e.target as HTMLElement)?.tagName === 'BUTTON') (e.target as HTMLElement).blur();
        if (!e.repeat) this.togglePause();
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
      case 'l':
      case 'L':
        this.setTool('line');
        break;
      case 't':
      case 'T':
        this.setTool('track');
        break;
      case 'j':
      case 'J':
        this.setTool('junction');
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
      case 'a':
      case 'A':
        this.toggleAlerts();
        break;
      case 'm':
      case 'M':
        this.toggleFinance();
        break;
      case 'n':
      case 'N':
        this.toggleNetwork();
        break;
      case 'u':
      case 'U':
        this.toggleResearch();
        break;
      case 'g':
      case 'G':
        // City growth overlay (G again goes back to none).
        this.setOverlay(this.overlays.mode === 'growth' ? 'none' : 'growth');
        break;
      case 'h':
      case 'H': {
        const sel = this.game.selection;
        if (sel?.kind === 'route' && this.tools.active?.id !== 'route') this.toggleHolding(sel.id);
        break;
      }
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
