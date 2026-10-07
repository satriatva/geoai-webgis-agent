/* global L */
/**
 * Leaflet map: basemap, point selection, the map collar (cursor position and zoom)
 * and rendering of the GeoJSON layers returned by the agent.
 */
import { escapeHtml } from './format.js';

// Standard OpenStreetMap tiles need no API key. The dark theme inverts them with CSS
// (see .leaflet-tile-pane in style.css), so one tile source serves both themes.
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const MAX_ZOOM = 19;

// NOTE: change the start view here. Default: Yogyakarta, Indonesia.
const START_VIEW = { center: [-7.7829, 110.3671], zoom: 12 };

const FIT_PADDING = [48, 48];
const FIT_MAX_ZOOM = 16;
const FOCUS_ZOOM = 17;
const COORD_DECIMALS = 6;

const KIND_LABEL = { place: 'Place', poi: 'Result', center: 'Search centre' };
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const round = (n) => +n.toFixed(COORD_DECIMALS);

/**
 * Create the map inside #map.
 *
 * @param {object}   handlers
 * @param {Function} handlers.onPointSelected  Called with { lat, lon } when the user clicks the map.
 * @param {Function} [handlers.onCursorMove]   Called with { lat, lon } as the pointer moves.
 * @param {Function} [handlers.onZoom]         Called with the zoom level after each zoom.
 */
export function createMap({ onPointSelected, onCursorMove = () => {}, onZoom = () => {} }) {
  const map = L.map('map', { zoomControl: true }).setView(START_VIEW.center, START_VIEW.zoom);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: MAX_ZOOM }).addTo(map);
  L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);

  const results = L.featureGroup().addTo(map);
  const index = new Map(); // feature id -> Leaflet layer
  let shown = null;        // layers array currently drawn
  let selected = null;     // marker of the user-selected point

  // ---- Map collar and point selection ----
  map.on('mousemove', (e) => onCursorMove({ lat: e.latlng.lat, lon: e.latlng.lng }));
  map.on('zoomend', () => onZoom(map.getZoom()));

  map.on('click', (e) => {
    const lat = round(e.latlng.lat);
    const lon = round(e.latlng.lng);
    if (selected) selected.setLatLng(e.latlng);
    else {
      selected = L.circleMarker(e.latlng, {
        radius: 8, color: '#fff', weight: 2, fillColor: cssVar('--sym-selected'), fillOpacity: 1,
      }).addTo(map);
    }
    selected.bindTooltip(`${lat}, ${lon}`).openTooltip();
    onPointSelected({ lat, lon });
  });

  function clearSelection() {
    if (selected) map.removeLayer(selected);
    selected = null;
  }

  // ---- Styling of agent layers ----
  // Points keep their own clicks (bubblingMouseEvents: false), so clicking a result opens its
  // popup instead of selecting a point. Buffers and lines are not interactive, so a click
  // inside a buffer still selects a point.
  function styleFor(feature) {
    const kind = feature.properties?.kind;
    if (kind === 'buffer') {
      const color = cssVar('--sym-buffer');
      return { color, weight: 1.5, fillColor: color, fillOpacity: 0.08, dashArray: '4 4', interactive: false };
    }
    if (kind === 'line') return { color: cssVar('--sym-line'), weight: 3, dashArray: '8 6', interactive: false };
    return {};
  }

  function pointToLayer(feature, latlng) {
    const kind = feature.properties?.kind;
    const base = { bubblingMouseEvents: false, color: '#fff', fillOpacity: 1 };
    if (kind === 'place') return L.circleMarker(latlng, { ...base, radius: 9, weight: 2, fillColor: cssVar('--sym-place') });
    if (kind === 'center') return L.circleMarker(latlng, { ...base, radius: 5, weight: 2, color: cssVar('--sym-place'), fillColor: '#fff' });
    return L.circleMarker(latlng, { ...base, radius: 7, weight: 1.5, fillColor: cssVar('--sym-poi') });
  }

  function popupHtml(p, latlng) {
    const rows = [];
    if (p.description) rows.push(`<div>${escapeHtml(p.description)}</div>`);
    if (p.category) rows.push(`<div class="pp-muted">${escapeHtml(String(p.category).replace(/[_/]/g, ' '))}</div>`);
    rows.push(`<div class="pp-coords">${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}</div>`);
    if (p.osm) {
      rows.push(`<a href="https://www.openstreetmap.org/${escapeHtml(p.osm)}" target="_blank" rel="noopener noreferrer">Open in OpenStreetMap</a>`);
    }
    const dot = p.kind === 'place' ? 'place' : '';
    return `<div class="pp">
      <div class="pp-kind"><span class="dot ${dot}"></span>${escapeHtml(KIND_LABEL[p.kind] ?? 'Feature')}</div>
      <div class="pp-title">${escapeHtml(p.title)}</div>${rows.join('')}</div>`;
  }

  function onEachFeature(feature, layer) {
    const p = feature.properties ?? {};
    if (p.fid) index.set(p.fid, layer);
    if (!p.title || !layer.getLatLng) return;
    layer.bindPopup(() => popupHtml(p, layer.getLatLng()), { maxWidth: 300 });
    layer.bindTooltip(escapeHtml(p.title), { direction: 'top', offset: [0, -6] });
  }

  /** Replace the drawn results with `layers` and, by default, zoom to them. */
  function showLayers(layers = [], { fit = true } = {}) {
    results.clearLayers();
    index.clear();
    shown = layers;
    for (const { geojson } of layers) {
      L.geoJSON(geojson, { style: styleFor, pointToLayer, onEachFeature }).addTo(results);
    }
    const bounds = results.getBounds();
    if (fit && bounds.isValid()) map.fitBounds(bounds, { padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM, animate: !reducedMotion() });
    return layers.length > 0;
  }

  /** Fly to one feature (re-drawing its answer's layers if another answer is shown) and open its popup. */
  function focusFeature(layers, fid) {
    if (shown !== layers) showLayers(layers, { fit: false });
    const layer = index.get(fid);
    if (!layer?.getLatLng) return false;
    const target = layer.getLatLng();
    const zoom = Math.max(map.getZoom(), FOCUS_ZOOM);
    if (reducedMotion()) {
      map.setView(target, zoom);
      layer.openPopup();
    } else {
      map.once('moveend', () => layer.openPopup());
      map.flyTo(target, zoom, { duration: 0.6 });
    }
    return true;
  }

  function clearResults() {
    results.clearLayers();
    index.clear();
    shown = null;
  }

  /** Map state sent with each question, so the agent knows what "here" means. */
  function context() {
    const c = map.getCenter();
    const point = selected?.getLatLng();
    return {
      center: { lat: round(c.lat), lon: round(c.lng) },
      zoom: map.getZoom(),
      selectedPoint: point ? { lat: round(point.lat), lon: round(point.lng) } : undefined,
    };
  }

  /** Re-apply theme colours to drawn layers (symbology comes from CSS variables). */
  function refreshStyles() {
    if (shown) showLayers(shown, { fit: false });
  }

  return {
    showLayers,
    focusFeature,
    clearResults,
    clearSelection,
    context,
    refreshStyles,
    invalidate: () => map.invalidateSize(),
  };
}
