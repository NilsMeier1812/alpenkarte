// Lädt Wege und Gipfel kachelweise von Overpass nach – mit Warteschlange,
// Zwischenspeicher und Ausweichservern.

import { OVERPASS_ENDPOINTS, TRAIL_HIGHWAYS, TRAIL_TILE, PEAK_TILE } from './config.js';
import { cacheGet, cachePut } from './tilecache.js';

const CONCURRENCY = 2;
const REQUEST_TIMEOUT = 90_000;

export function tileKey(kind, x, y) {
  return `${kind}/${x}/${y}`;
}

/** Alle Kacheln, die den angezeigten Kartenausschnitt abdecken. */
export function tilesForBounds(bounds, size) {
  const x0 = Math.floor(bounds.getWest() / size);
  const x1 = Math.floor(bounds.getEast() / size);
  const y0 = Math.floor(bounds.getSouth() / size);
  const y1 = Math.floor(bounds.getNorth() / size);
  const tiles = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) tiles.push({ x, y });
  }
  return tiles;
}

function bbox(kind, x, y) {
  const size = kind === 'trails' ? TRAIL_TILE : PEAK_TILE;
  const south = y * size;
  const west = x * size;
  // Etwas Überlappung, damit an den Kachelgrenzen keine Lücken entstehen.
  const pad = size * 0.02;
  return [south - pad, west - pad, south + size + pad, west + size + pad]
    .map((v) => v.toFixed(5))
    .join(',');
}

function query(kind, x, y) {
  const box = bbox(kind, x, y);
  if (kind === 'peaks') {
    return `[out:json][timeout:60];\n(\n  node["natural"="peak"](${box});\n  node["natural"="volcano"](${box});\n);\nout body;`;
  }
  return (
    `[out:json][timeout:90];\n` +
    `way["highway"~"^(${TRAIL_HIGHWAYS})$"]["footway"!~"^(sidewalk|crossing)$"]` +
    `["access"!~"^(private|no)$"](${box});\n` +
    `out body geom;`
  );
}

export class OverpassLoader {
  /**
   * @param {(kind: string, elements: object[]) => void} onData
   * @param {(state: object) => void} onState
   */
  constructor(onData, onState = () => {}) {
    this.onData = onData;
    this.onState = onState;
    this.queue = [];
    this.active = 0;
    this.done = new Set();
    this.failed = new Map(); // key -> Anzahl Fehlversuche
    this.endpoint = 0;
    this.enabled = true;
  }

  /** Bereits geladen oder gerade in Arbeit? */
  knows(key) {
    return this.done.has(key) || this.queue.some((job) => job.key === key);
  }

  request(kind, tiles) {
    for (const { x, y } of tiles) {
      const key = tileKey(kind, x, y);
      if (this.knows(key)) continue;
      if ((this.failed.get(key) || 0) >= 3) continue;
      this.queue.push({ kind, x, y, key });
    }
    this.#pump();
  }

  /** Noch nicht gestartete Kacheln außerhalb der Ansicht verwerfen. */
  prune(keepKeys) {
    this.queue = this.queue.filter((job) => keepKeys.has(job.key));
    this.#report();
  }

  #report() {
    this.onState({ pending: this.queue.length + this.active, active: this.active, loaded: this.done.size });
  }

  #pump() {
    this.#report();
    while (this.enabled && this.active < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      this.#run(job)
        .catch((err) => {
          const tries = (this.failed.get(job.key) || 0) + 1;
          this.failed.set(job.key, tries);
          this.endpoint = (this.endpoint + 1) % OVERPASS_ENDPOINTS.length;
          this.onState({ error: err.message || String(err) });
          if (tries < 3) this.queue.push(job); // später nochmal versuchen
        })
        .finally(() => {
          this.active--;
          this.#pump();
        });
    }
  }

  async #run(job) {
    const cached = await cacheGet(job.key);
    if (cached) {
      this.done.add(job.key);
      this.onData(job.kind, cached);
      return;
    }
    const url = OVERPASS_ENDPOINTS[this.endpoint];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query(job.kind, job.x, job.y) }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Overpass antwortete mit ${res.status}`);
      const json = await res.json();
      const elements = json.elements || [];
      this.done.add(job.key);
      this.failed.delete(job.key);
      await cachePut(job.key, elements);
      this.onData(job.kind, elements);
    } finally {
      clearTimeout(timer);
    }
  }
}
