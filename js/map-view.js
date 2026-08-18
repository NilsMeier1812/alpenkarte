// Karte, Wegabschnitte und Gipfel.

import {
  BASEMAPS,
  COLORS,
  PEAK_TILE,
  PEAK_ZOOM_MIN,
  ROUTES_OVERLAY,
  START_VIEW,
  TRAIL_TILE,
  TRAIL_ZOOM_MIN,
  MAX_TILES_PER_VIEW,
  VIEW_KEY,
} from './config.js';
import { formatLength } from './geo.js';
import { escapeHtml } from './html.js';
import { TrailGraph, wayFromOverpass, wayLabel } from './graph.js';
import { isSegmentVisited, isWayVisited, toggleSegment, toggleWay } from './marks.js';
import { OverpassLoader, tileKey, tilesForBounds } from './overpass.js';

const SAC = {
  hiking: 'T1 – Wandern',
  mountain_hiking: 'T2 – Bergwandern',
  demanding_mountain_hiking: 'T3 – anspruchsvolles Bergwandern',
  alpine_hiking: 'T4 – Alpinwandern',
  demanding_alpine_hiking: 'T5 – anspruchsvolles Alpinwandern',
  difficult_alpine_hiking: 'T6 – schwieriges Alpinwandern',
};


function parseEle(value) {
  const num = parseFloat(String(value ?? '').replace(',', '.'));
  return Number.isFinite(num) ? Math.round(num) : null;
}

/** Ab welcher Höhe Gipfel gezeigt werden – sonst ist die Karte bei kleinem Zoom zu voll. */
function minEleForZoom(zoom) {
  if (zoom >= 13) return 0;
  if (zoom >= 12) return 1200;
  return 2000;
}

export class MapView {
  constructor(store, { onStatus = () => {}, onToggle = () => {} } = {}) {
    this.store = store;
    this.onStatus = onStatus;
    this.onToggle = onToggle;
    this.graph = new TrailGraph();
    this.peaks = new Map(); // id -> { id, name, ele, lat, lon }
    this.wayLayers = new Map();
    this.wayBounds = new Map();
    this.peakMarkers = new Map();
    this.showUnvisited = true;
    this.autoLoad = true;
    this.mode = 'segment';
    // Finger treffen deutlich ungenauer als ein Mauszeiger.
    this.coarsePointer =
      window.matchMedia?.('(pointer: coarse)').matches ||
      window.matchMedia?.('(hover: none)').matches ||
      navigator.maxTouchPoints > 0 ||
      false;
    // Reines Touchgerät (Handy, Tablet) – dort gibt es keinen Mauszeiger.
    this.touchOnly = window.matchMedia?.('(hover: none)').matches || false;
    this.tapRadius = this.coarsePointer ? 32 : 14;

    this.#initMap();
    this.loader = new OverpassLoader(
      (kind, elements) => this.#ingest(kind, elements),
      (state) => this.#loaderState(state),
    );
    this.store.onChange((detail) => this.#onStoreChange(detail));
    this.refreshData();
  }

  #initMap() {
    const saved = this.#loadView();
    this.map = L.map('map', {
      center: saved.center,
      zoom: saved.zoom,
      zoomControl: true,
      preferCanvas: true,
      worldCopyJump: true,
      // Am Handy würde der Doppeltipp zum Zoomen beim schnellen Markieren
      // mehrerer Abschnitte dazwischenfunken. Zoomen geht dort über die
      // Zwei-Finger-Geste und die +/−-Knöpfe.
      doubleClickZoom: !this.touchOnly,
    });
    // Am Touchgerät übernimmt die Suche nach dem nächstgelegenen Weg
    // (#onMapClick) die Treffererkennung – die ist genauer als ein großer
    // Toleranzradius, der einfach den zuletzt gezeichneten Weg nimmt.
    this.renderer = L.canvas({ padding: 0.35, tolerance: this.coarsePointer ? 2 : 8 });

    this.baseLayers = new Map();
    for (const base of BASEMAPS) {
      this.baseLayers.set(base.id, L.tileLayer(base.url, base.options));
    }
    this.currentBase = saved.base && this.baseLayers.has(saved.base) ? saved.base : BASEMAPS[0].id;
    this.baseLayers.get(this.currentBase).addTo(this.map);

    this.routesOverlay = L.tileLayer(ROUTES_OVERLAY.url, ROUTES_OVERLAY.options);
    this.trailLayer = L.layerGroup().addTo(this.map);
    this.peakLayer = L.layerGroup().addTo(this.map);

    L.control.scale({ imperial: false }).addTo(this.map);

    this.map.on('moveend zoomend', () => {
      this.#saveView();
      this.refreshData();
      this.refreshVisible();
    });
    this.map.on('zoomend', () => {
      this.#applyZoomVisibility();
    });
    // Klicks, die keinen Weg direkt getroffen haben, landen hier.
    this.map.on('click', (ev) => this.#onMapClick(ev));
    this.#applyZoomVisibility();
  }

  // — Ansicht merken ——————————————————————————————————

  #loadView() {
    try {
      const raw = localStorage.getItem(VIEW_KEY);
      if (raw) {
        const v = JSON.parse(raw);
        if (Array.isArray(v.center) && Number.isFinite(v.zoom)) return v;
      }
    } catch {
      /* Standardansicht */
    }
    return { ...START_VIEW, base: null };
  }

  #saveView() {
    const c = this.map.getCenter();
    try {
      localStorage.setItem(
        VIEW_KEY,
        JSON.stringify({ center: [+c.lat.toFixed(5), +c.lng.toFixed(5)], zoom: this.map.getZoom(), base: this.currentBase }),
      );
    } catch {
      /* nicht schlimm */
    }
  }

  // — Daten nachladen ————————————————————————————————

  refreshData() {
    if (!this.autoLoad) return;
    const zoom = this.map.getZoom();
    const bounds = this.map.getBounds().pad(0.1);
    const keep = new Set();

    if (zoom >= PEAK_ZOOM_MIN) {
      const tiles = tilesForBounds(bounds, PEAK_TILE);
      if (tiles.length <= MAX_TILES_PER_VIEW) {
        tiles.forEach((t) => keep.add(tileKey('peaks', t.x, t.y)));
        this.loader.request('peaks', tiles);
      }
    }
    if (zoom >= TRAIL_ZOOM_MIN) {
      const tiles = tilesForBounds(bounds, TRAIL_TILE);
      if (tiles.length <= MAX_TILES_PER_VIEW) {
        tiles.forEach((t) => keep.add(tileKey('trails', t.x, t.y)));
        this.loader.request('trails', tiles);
      }
    }
    this.loader.prune(keep);
    this.#status();
  }

  #ingest(kind, elements) {
    if (kind === 'peaks') {
      let added = 0;
      for (const el of elements) {
        if (el.type !== 'node' || this.peaks.has(el.id)) continue;
        const tags = el.tags || {};
        this.peaks.set(el.id, {
          id: el.id,
          name: tags.name || tags['name:de'] || 'Gipfel',
          ele: parseEle(tags.ele),
          lat: el.lat,
          lon: el.lon,
        });
        added++;
      }
      if (added) this.#renderPeaks();
      return;
    }

    const changed = new Set();
    let unusable = 0;
    for (const el of elements) {
      const way = wayFromOverpass(el);
      if (!way) {
        unusable++;
        continue;
      }
      for (const id of this.graph.addWay(way)) changed.add(id);
    }
    if (unusable && !changed.size) {
      console.warn(
        `${unusable} Wege ohne verwertbare Geometrie erhalten – liefert der Overpass-Server "out body geom"?`,
      );
    }
    // Bereits gezeichnete Wege neu zerlegen, der Rest kommt über refreshVisible.
    for (const id of changed) {
      this.wayBounds.delete(id);
      if (this.wayLayers.has(id)) this.renderWay(id);
    }
    this.refreshVisible();
    this.#status();
  }

  #loaderState(state) {
    if (state.error) this.onStatus({ error: state.error });
    this.#status(state);
  }

  #status(state = null) {
    const zoom = this.map.getZoom();
    this.onStatus({
      zoom,
      pending: state?.pending,
      needZoom: zoom < TRAIL_ZOOM_MIN,
      ways: this.graph.size,
      autoLoad: this.autoLoad,
    });
  }

  // — Wege zeichnen ——————————————————————————————————

  get trailsVisible() {
    return this.map.getZoom() >= TRAIL_ZOOM_MIN - 2;
  }

  #applyZoomVisibility() {
    const zoom = this.map.getZoom();
    document.body.classList.toggle('zoom-far', zoom < 13);
    if (this.trailsVisible) {
      if (!this.map.hasLayer(this.trailLayer)) this.map.addLayer(this.trailLayer);
      this.refreshVisible();
    } else if (this.map.hasLayer(this.trailLayer)) {
      this.map.removeLayer(this.trailLayer);
    }
    this.#renderPeaks();
    this.#status();
  }

  styleFor(visited, tags) {
    if (visited) {
      return { color: COLORS.visited, weight: 5, opacity: 0.95, lineCap: 'round', renderer: this.renderer };
    }
    const dashed = tags.highway === 'steps' || tags.highway === 'via_ferrata';
    return {
      color: COLORS.unvisited,
      weight: this.coarsePointer ? 3.5 : 2.5,
      opacity: 0.6,
      dashArray: dashed ? '4 4' : null,
      lineCap: 'round',
      renderer: this.renderer,
    };
  }

  renderWay(wayId) {
    const previous = this.wayLayers.get(wayId);
    if (previous) {
      this.trailLayer.removeLayer(previous);
      this.wayLayers.delete(wayId);
    }
    const way = this.graph.ways.get(wayId);
    if (!way) return;

    const group = L.layerGroup();
    for (const segment of this.graph.segments(wayId)) {
      const visited = isSegmentVisited(this.store, way, segment);
      if (!visited && !this.showUnvisited) continue;
      const line = L.polyline(segment.latlngs, this.styleFor(visited, way.tags));
      line._segment = segment;
      line._visited = visited;
      line.bindTooltip(() => this.#tooltip(way, segment, line._visited), { sticky: true, direction: 'top', opacity: 0.95 });
      line.on('click', (ev) => {
        L.DomEvent.stop(ev);
        this.toggle(way, segment, this.mode);
      });
      line.on('contextmenu', (ev) => {
        L.DomEvent.stop(ev);
        this.toggle(way, segment, 'way');
      });
      line.on('mouseover', () => line.setStyle({ color: COLORS.hover, weight: line._visited ? 7 : 5, opacity: 1 }));
      line.on('mouseout', () => line.setStyle(this.styleFor(line._visited, way.tags)));
      group.addLayer(line);
    }
    this.wayLayers.set(wayId, group);
    this.trailLayer.addLayer(group);
  }

  /** Bounding-Box eines Weges (gecacht). */
  boundsOf(wayId) {
    let bounds = this.wayBounds.get(wayId);
    if (!bounds) {
      const way = this.graph.ways.get(wayId);
      if (!way) return null;
      bounds = L.latLngBounds(way.latlngs);
      this.wayBounds.set(wayId, bounds);
    }
    return bounds;
  }

  /**
   * Zeichnet die Wege im Blickfeld und entfernt die Linien weit außerhalb.
   * Die Wegdaten selbst bleiben im Speicher, nur die Grafik wird aufgeräumt –
   * so bleibt die Karte auch nach langem Herumschieben flüssig.
   */
  refreshVisible() {
    if (!this.trailsVisible) return;
    const keep = this.map.getBounds().pad(0.8);
    const draw = this.map.getBounds().pad(0.25);

    for (const [wayId, group] of [...this.wayLayers]) {
      const bounds = this.boundsOf(wayId);
      if (bounds && !keep.intersects(bounds)) {
        this.trailLayer.removeLayer(group);
        this.wayLayers.delete(wayId);
      }
    }
    for (const wayId of this.graph.ways.keys()) {
      if (this.wayLayers.has(wayId)) continue;
      const bounds = this.boundsOf(wayId);
      if (bounds && draw.intersects(bounds)) this.renderWay(wayId);
    }
  }

  /**
   * Sucht den Wegabschnitt, der einem Punkt am nächsten liegt – höchstens
   * maxPixels entfernt. Damit lässt sich auch mit dem Finger zuverlässig
   * markieren, ohne die dünne Linie exakt zu treffen.
   */
  nearestSegment(latlng, maxPixels) {
    const map = this.map;
    const target = map.latLngToLayerPoint(latlng);
    const center = map.latLngToContainerPoint(latlng);
    const searchBounds = L.latLngBounds(
      map.containerPointToLatLng([center.x - maxPixels, center.y + maxPixels]),
      map.containerPointToLatLng([center.x + maxPixels, center.y - maxPixels]),
    );

    let best = null;
    for (const wayId of this.wayLayers.keys()) {
      const wayBounds = this.boundsOf(wayId);
      if (!wayBounds || !wayBounds.intersects(searchBounds)) continue;
      const way = this.graph.ways.get(wayId);
      if (!way) continue;

      for (const segment of this.graph.segments(wayId)) {
        if (!segment.bounds) segment.bounds = L.latLngBounds(segment.latlngs);
        if (!segment.bounds.intersects(searchBounds)) continue;
        if (!this.showUnvisited && !isSegmentVisited(this.store, way, segment)) continue;

        for (let i = 0; i < segment.latlngs.length - 1; i++) {
          const p1 = map.latLngToLayerPoint(segment.latlngs[i]);
          const p2 = map.latLngToLayerPoint(segment.latlngs[i + 1]);
          const distance = L.LineUtil.pointToSegmentDistance(target, p1, p2);
          if (!best || distance < best.distance) best = { distance, way, segment };
        }
      }
    }
    return best && best.distance <= maxPixels ? best : null;
  }

  #onMapClick(ev) {
    if (this.map.getZoom() < TRAIL_ZOOM_MIN) {
      this.onToggle({
        text: `Zum Markieren näher heranzoomen – die Wege erscheinen ab Zoomstufe ${TRAIL_ZOOM_MIN}.`,
        hint: true,
      });
      return;
    }
    const hit = this.nearestSegment(ev.latlng, this.tapRadius);
    if (hit) {
      this.toggle(hit.way, hit.segment, this.mode);
      return;
    }
    if (!this.wayLayers.size) {
      this.onToggle({ text: 'Hier sind noch keine Wege geladen – einen Moment warten.', hint: true });
    }
  }

  /** Alles neu zeichnen (nach Import, Zurücksetzen oder Stilwechsel). */
  renderAllWays() {
    for (const group of this.wayLayers.values()) this.trailLayer.removeLayer(group);
    this.wayLayers.clear();
    this.refreshVisible();
  }

  #tooltip(way, segment, visited) {
    const tags = way.tags;
    const rows = [`<b>${escapeHtml(wayLabel(tags))}</b>`];
    const details = [];
    if (tags.sac_scale && SAC[tags.sac_scale]) details.push(escapeHtml(SAC[tags.sac_scale]));
    if (tags.trail_visibility) details.push(`Sichtbarkeit: ${escapeHtml(tags.trail_visibility)}`);
    if (tags.surface) details.push(escapeHtml(tags.surface));
    rows.push(`${formatLength(segment.length)} · Abschnitt`);
    if (details.length) rows.push(details.join(' · '));
    rows.push(
      `<i>${visited ? 'Klick: Markierung entfernen' : 'Klick: als gegangen markieren'}</i>`,
    );
    return `<div class="tt">${rows.join('<br>')}</div>`;
  }

  toggle(way, segment, mode) {
    const nowVisited = mode === 'way' ? toggleWay(this.store, way) : toggleSegment(this.store, way, segment);
    const label = wayLabel(way.tags);
    const what = mode === 'way' ? 'Ganzer Weg' : 'Abschnitt';
    this.onToggle({
      text: `${what} „${label}“ ${nowVisited ? 'als gegangen markiert' : 'wieder freigegeben'}`,
      visited: nowVisited,
    });
  }

  // — Gipfel zeichnen ————————————————————————————————

  #renderPeaks() {
    const zoom = this.map.getZoom();
    const threshold = minEleForZoom(zoom);
    const show = zoom >= PEAK_ZOOM_MIN;

    for (const peak of this.peaks.values()) {
      const climbed = this.store.hasPeak(peak.id);
      const wanted = show && (climbed || (peak.ele ?? 0) >= threshold);
      const existing = this.peakMarkers.get(peak.id);
      if (!wanted) {
        if (existing) {
          this.peakLayer.removeLayer(existing);
          this.peakMarkers.delete(peak.id);
        }
        continue;
      }
      if (existing) {
        if (existing._climbed !== climbed) {
          existing.setIcon(this.#peakIcon(peak, climbed));
          existing._climbed = climbed;
        }
        continue;
      }
      const marker = L.marker([peak.lat, peak.lon], {
        icon: this.#peakIcon(peak, climbed),
        keyboard: false,
        riseOnHover: true,
      });
      marker._climbed = climbed;
      marker.on('click', (ev) => {
        L.DomEvent.stop(ev);
        const nowClimbed = this.store.togglePeak(peak);
        this.onToggle({
          text: `${peak.name}${peak.ele ? ` (${peak.ele} m)` : ''} ${nowClimbed ? 'bestiegen ✓' : 'nicht mehr markiert'}`,
          visited: nowClimbed,
        });
      });
      this.peakLayer.addLayer(marker);
      this.peakMarkers.set(peak.id, marker);
    }
  }

  #peakIcon(peak, climbed) {
    const label = peak.ele ? `${escapeHtml(peak.name)} <b>${peak.ele}</b>` : escapeHtml(peak.name);
    return L.divIcon({
      className: 'peak-marker',
      html: `<i class="tri${climbed ? ' done' : ''}"></i><span class="lbl${climbed ? ' done' : ''}">${label}</span>`,
      iconSize: [18, 18],
      iconAnchor: [9, 16],
    });
  }

  // — Reaktionen auf Änderungen ————————————————————————

  #onStoreChange(detail) {
    if (detail.kind === 'way' && detail.id !== undefined) {
      // Im Speicher sind die IDs Text, im Wegenetz Zahlen.
      const id = this.graph.ways.has(detail.id) ? detail.id : Number(detail.id);
      if (this.graph.ways.has(id)) this.renderWay(id);
    } else if (detail.kind === 'peak') {
      this.#renderPeaks();
    } else {
      this.renderAllWays();
      this.#renderPeaks();
    }
  }

  // — Steuerung von außen ————————————————————————————

  setMode(mode) {
    this.mode = mode;
  }

  setShowUnvisited(value) {
    this.showUnvisited = value;
    this.renderAllWays();
  }

  setAutoLoad(value) {
    this.autoLoad = value;
    this.loader.enabled = value;
    if (value) this.refreshData();
    this.#status();
  }

  setBasemap(id) {
    if (!this.baseLayers.has(id) || id === this.currentBase) return;
    this.map.removeLayer(this.baseLayers.get(this.currentBase));
    this.currentBase = id;
    this.baseLayers.get(id).addTo(this.map).bringToBack();
    this.#saveView();
  }

  setRoutesOverlay(value) {
    if (value) this.routesOverlay.addTo(this.map);
    else this.map.removeLayer(this.routesOverlay);
  }

  flyTo(lat, lon, zoom = 15) {
    this.map.flyTo([lat, lon], Math.max(this.map.getZoom(), zoom), { duration: 0.8 });
  }

  fitBounds(bounds) {
    this.map.fitBounds(bounds, { maxZoom: 15 });
  }
}
