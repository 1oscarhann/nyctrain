/** Original line icons for the toolbar (24×24, stroke = currentColor). */
export const ICONS = {
  line: '<path d="M4 18 L10 8 L15 14 L20 5"/><circle cx="4" cy="18" r="2" fill="currentColor"/><circle cx="10" cy="8" r="2" fill="currentColor"/><circle cx="15" cy="14" r="2" fill="currentColor"/><circle cx="20" cy="5" r="2" fill="currentColor"/>',
  logo: '<path d="M4 18 L10 7 L14 14 L20 5" stroke="#4CD08A" stroke-width="2.6"/><circle cx="10" cy="7" r="2.2" fill="#E7EBEF" stroke="none"/><circle cx="14" cy="14" r="2.2" fill="#E7EBEF" stroke="none"/>',
  select: '<path d="M6 4 L18 12 L12.5 13.2 L15.5 19.5 L13 20.6 L10.1 14.3 L6 18 Z"/>',
  track: '<path d="M4 19 C 9 19, 9 5, 20 5"/><path d="M6.5 15.5 l2.6 1.3 M9.5 11 l2.8 0.6 M13 7.6 l2.4 -0.4 M17 5.4 l1.4 -1.8" stroke-width="1.5"/>',
  station: '<circle cx="12" cy="12" r="5.5"/><path d="M3 12 H6.5 M17.5 12 H21"/>',
  route: '<circle cx="5.5" cy="17.5" r="2.3"/><circle cx="18.5" cy="6.5" r="2.3"/><path d="M7.5 16 L11 12.5 H14 L17 8.5"/>',
  bulldoze: '<path d="M4 16 H14 V11 H9 L7 13 H4 Z"/><circle cx="6.5" cy="18" r="1.5"/><circle cx="11.5" cy="18" r="1.5"/><path d="M14 13 L19 9 L21 15 L15.5 15.5"/>',
  cube: '<path d="M12 3 L20 7.5 V16.5 L12 21 L4 16.5 V7.5 Z"/><path d="M4 7.5 L12 12 L20 7.5 M12 12 V21"/>',
  layers: '<path d="M12 4 L21 9 L12 14 L3 9 Z"/><path d="M3 13.5 L12 18.5 L21 13.5"/>',
  finance: '<path d="M4 19 V10 M9.5 19 V6 M15 19 V12 M20.5 19 V8"/>',
  goals: '<path d="M6 21 V4"/><path d="M6 4 H18 L15.5 8 L18 12 H6"/>',
  menu: '<path d="M4 7 H20 M4 12 H20 M4 17 H20"/>',
  pause: '<path d="M8 5 V19 M16 5 V19" stroke-width="2.6"/>',
  play: '<path d="M7 5 L19 12 L7 19 Z" fill="currentColor"/>',
  sound: '<path d="M4 9 H8 L13 5 V19 L8 15 H4 Z" fill="currentColor" stroke="none"/><path d="M16 9 Q18.5 12 16 15"/><path d="M18.5 6.5 Q23 12 18.5 17.5"/>',
  soundOff: '<path d="M4 9 H8 L13 5 V19 L8 15 H4 Z" fill="currentColor" stroke="none"/><path d="M16 9 L22 15 M22 9 L16 15"/>',
  skip: '<path d="M5 6 L12 12 L5 18 Z M12 6 L19 12 L12 18 Z" fill="currentColor" stroke="none"/>',
  close: '<path d="M6 6 L18 18 M18 6 L6 18"/>',
  undo: '<path d="M9 7 L4 12 L9 17"/><path d="M4 12 H14 A6 6 0 0 1 14 24"/>',
  routes: '<path d="M4 6 H20 M4 12 H20 M4 18 H20" stroke-width="2.4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5 A2.5 2.5 0 1 1 12 12 V14"/><circle cx="12" cy="17.5" r="0.6" fill="currentColor"/>',
  // City chaos: weather, the Service alerts bell, event tickets.
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2.5V5 M12 19v2.5 M2.5 12H5 M19 12h2.5 M5.3 5.3l1.8 1.8 M16.9 16.9l1.8 1.8 M5.3 18.7l1.8-1.8 M16.9 7.1l1.8-1.8"/>',
  rain: '<path d="M7 15h9.5a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6 1.6A3.2 3.2 0 0 0 7 15Z"/><path d="M8.5 18l-1 2.5 M12.5 18l-1 2.5 M16.5 18l-1 2.5"/>',
  snow: '<path d="M12 3v18 M4.2 7.5l15.6 9 M4.2 16.5l15.6-9"/><path d="M9.5 4.5 12 7l2.5-2.5 M9.5 19.5 12 17l2.5 2.5"/>',
  heat: '<path d="M10 4.5a2 2 0 0 1 4 0v9.3a4 4 0 1 1-4 0Z"/><path d="M12 9v6.5 M17.5 6h2.5 M17.5 9.5h2.5"/>',
  alert: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  // Operations control: timepoint toggles in the route panel's stop list.
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5 V12 L15 14"/>',
  // Cinematic: the timelapse (a film strip), follow-cam (a crosshair), photo mode (a camera).
  film: '<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M4 9h16 M4 15h16 M8 5v4 M12 5v4 M16 5v4 M8 15v4 M12 15v4 M16 15v4" stroke-width="1.4"/>',
  follow: '<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><path d="M12 2.5v3 M12 18.5v3 M2.5 12h3 M18.5 12h3"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z"/>',
  camera: '<path d="M4 8.5h3.2L9 6h6l1.8 2.5H20V18H4Z"/><circle cx="12" cy="13" r="3.2"/>',
  flask: '<path d="M9.5 3.5h5 M10.5 3.5v6L5 19a1.3 1.3 0 0 0 1.1 2h11.8A1.3 1.3 0 0 0 19 19l-5.5-9.5v-6"/><path d="M7.5 15h9"/>',
  download: '<path d="M12 4v11 M7.5 10.5 12 15l4.5-4.5"/><path d="M5 19.5h14"/>',
  ticket: '<path d="M4 8.5V6h16v2.5a2.5 2.5 0 0 0 0 5V18H4v-4.5a2.5 2.5 0 0 0 0-5Z"/><path d="M14 6.5v11" stroke-dasharray="2 2"/>',
};

/** Weather icon by kind. */
export const WEATHER_ICON: Record<'clear' | 'rain' | 'snow' | 'heat', string> = { clear: ICONS.sun, rain: ICONS.rain, snow: ICONS.snow, heat: ICONS.heat };
