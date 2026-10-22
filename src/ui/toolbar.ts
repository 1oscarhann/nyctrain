/**
 * Left toolbar: tools with shortcut tooltips, the 3D toggle, the overlay picker and panel
 * shortcuts. Also hosts the tool options panel next to it.
 */
import { OVERLAY_LABELS, type OverlayMode } from '../map/overlays';
import type { App } from './app';
import { h, svgIcon } from './dom';
import { ICONS } from './icons';
import type { ToolId } from './toolTypes';
import { attachTip } from './widgets';

const TOOLS: { id: ToolId; icon: string; title: string; key: string; body: string }[] = [
  { id: 'select', icon: ICONS.select, title: 'Inspect', key: 'Esc', body: 'Click stations, trains, track or neighbourhoods' },
  { id: 'track', icon: ICONS.track, title: 'Track', key: 'T', body: 'Plan track: click points, double-click to finish' },
  { id: 'station', icon: ICONS.station, title: 'Station', key: 'S', body: 'Place a station on straight, level track' },
  { id: 'route', icon: ICONS.route, title: 'Route', key: 'R', body: 'Click stations in order to make a route' },
  { id: 'bulldoze', icon: ICONS.bulldoze, title: 'Bulldoze', key: 'B', body: 'Remove blueprints free, demolish built items for a 20% refund' },
];

const OVERLAYS: OverlayMode[] = ['none', 'residents', 'jobs', 'growth', 'unserved', 'crowding', 'flows'];

export class Toolbar {
  readonly el: HTMLElement;
  readonly options: HTMLElement;
  private toolBtns = new Map<ToolId, HTMLElement>();
  private viewBtn: HTMLElement;
  private overlayBtn: HTMLElement;
  private overlayMenu: HTMLElement;
  private alertsBtn: HTMLElement;
  private finBtn: HTMLElement;
  private badge = h('span', { class: 'badge num', style: 'display:none' });

  constructor(private app: App) {
    const btns: HTMLElement[] = [];
    for (const t of TOOLS) {
      const b = h('button', { class: 'hw-btn ghost tool-btn', 'data-tool': t.id, onclick: () => app.setTool(t.id) }, svgIcon(t.icon));
      attachTip(b, app.tooltip, t.title, t.key, t.body);
      this.toolBtns.set(t.id, b);
      btns.push(b);
    }
    this.viewBtn = h('button', { class: 'hw-btn ghost tool-btn', id: 'btn-3d', onclick: () => app.view.toggleView3D() }, svgIcon(ICONS.cube));
    attachTip(this.viewBtn, app.tooltip, 'Flat / 3D view', 'V', 'Tilt the camera and raise the skyline');
    this.overlayBtn = h('button', { class: 'hw-btn ghost tool-btn', id: 'btn-overlays', onclick: () => this.toggleOverlayMenu() }, svgIcon(ICONS.layers));
    attachTip(this.overlayBtn, app.tooltip, 'Overlays', undefined, 'Residents, jobs, city growth (G), unserved demand, crowding, flows');
    // Cinematic (v2): the timelapse and photo mode.
    const timelapse = h('button', { class: 'hw-btn ghost tool-btn', id: 'btn-timelapse', onclick: () => app.cinematic.openTimelapse() }, svgIcon(ICONS.film));
    attachTip(timelapse, app.tooltip, 'Timelapse', undefined, 'Replay your network growing, month by month, from the start to now');
    const photo = h('button', { class: 'hw-btn ghost tool-btn', id: 'btn-photo', onclick: () => app.cinematic.photo.toggle(true) }, svgIcon(ICONS.camera));
    attachTip(photo, app.tooltip, 'Photo mode', 'P', 'Hide the interface; L letterbox, C caption'); 
    const routes = h('button', { class: 'hw-btn ghost tool-btn', onclick: () => app.game.select({ kind: 'routes' }) }, svgIcon(ICONS.routes));
    attachTip(routes, app.tooltip, 'Routes', undefined, 'All routes and their ridership');
    const fin = (this.finBtn = h('button', { class: 'hw-btn ghost tool-btn', id: 'btn-finance', onclick: () => app.toggleFinance() }, svgIcon(ICONS.finance)));
    attachTip(fin, app.tooltip, 'Finances', 'M', 'Income, costs, bonds, fares, fleet');
    const goals = h('button', { class: 'hw-btn ghost tool-btn', onclick: () => app.game.select({ kind: 'goals' }) }, svgIcon(ICONS.goals));
    attachTip(goals, app.tooltip, 'Goals', undefined, 'Milestones to aim for');
    this.alertsBtn = h('button', { class: 'hw-btn ghost tool-btn', id: 'btn-alerts', onclick: () => app.toggleAlerts() }, svgIcon(ICONS.alert), this.badge);
    attachTip(this.alertsBtn, app.tooltip, 'Service alerts', 'A', 'Incidents, weather, events and event service');
    const help = h('button', { class: 'hw-btn ghost tool-btn', onclick: () => app.startTutorial() }, svgIcon(ICONS.help));
    attachTip(help, app.tooltip, 'Tutorial', undefined, 'A quick walkthrough of the basics');
    this.overlayMenu = h('div', { class: 'hw-panel', style: 'position:absolute;left:66px;display:none;flex-direction:column;padding:6px;gap:2px;z-index:25;min-width:200px' });
    for (const m of OVERLAYS) {
      this.overlayMenu.append(
        h(
          'button',
          { class: 'hw-btn ghost', 'data-overlay': m, style: 'justify-content:flex-start', onclick: () => { app.setOverlay(m); this.toggleOverlayMenu(false); } },
          OVERLAY_LABELS[m],
          m === 'growth' ? h('span', { class: 'kbd', style: 'margin-left:auto' }, 'G') : null,
        ),
      );
    }
    this.el = h('div', { id: 'toolbar', class: 'hw-panel' }, ...btns, h('div', { class: 'tool-sep' }), this.viewBtn, this.overlayBtn, timelapse, photo, h('div', { class: 'tool-sep' }), routes, fin, goals, this.alertsBtn, help);
    this.options = h('div', { id: 'tool-options', class: 'hw-panel' });
    app.root.append(this.overlayMenu);
    app.view.events.on('view3d', () => this.update());
    window.addEventListener('mousedown', (e) => {
      if (!this.overlayMenu.contains(e.target as Node) && !this.overlayBtn.contains(e.target as Node)) this.toggleOverlayMenu(false);
    });
  }

  private toggleOverlayMenu(force?: boolean): void {
    const wasOpen = this.overlayMenu.style.display !== 'none';
    const open = force ?? !wasOpen;
    // No re-render when nothing changes: rebuilding the tool options between mousedown and
    // mouseup would swallow clicks on them.
    if (open === wasOpen) return;
    this.overlayMenu.style.display = open ? 'flex' : 'none';
    if (open) {
      const r = this.overlayBtn.getBoundingClientRect();
      this.overlayMenu.style.top = `${r.top}px`;
    }
    this.update();
  }

  update(): void {
    const active = this.app.tools.active?.id ?? 'select';
    for (const [id, b] of this.toolBtns) b.classList.toggle('active', id === active);
    this.viewBtn.classList.toggle('active', this.app.view.is3D);
    this.overlayBtn.classList.toggle('active', this.app.overlays.mode !== 'none');
    for (const b of this.overlayMenu.querySelectorAll<HTMLElement>('[data-overlay]')) b.classList.toggle('active', b.dataset.overlay === this.app.overlays.mode);
    this.updateAlerts();
    const content = this.app.tools.active?.options?.() ?? null;
    this.options.replaceChildren();
    if (content) this.options.append(content);
    this.options.classList.toggle('open', !!content);
  }

  /** Bell state: open when Service alerts shows; the badge counts active incidents. */
  updateAlerts(): void {
    const n = this.app.feed.activeCount();
    this.badge.textContent = n > 9 ? '9+' : String(n);
    this.badge.style.display = n > 0 ? '' : 'none';
    this.alertsBtn.classList.toggle('active', this.app.alertsShowing());
    this.finBtn.classList.toggle('active', this.app.game.selection?.kind === 'finance' && this.app.tools.active?.id !== 'route');
  }
}
