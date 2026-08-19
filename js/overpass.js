// Lädt Wege und Gipfel kachelweise von Overpass nach – mit Warteschlange,
// Zwischenspeicher, Ausweichservern und Wiederholversuchen.

import { OVERPASS_ENDPOINTS, TRAIL_HIGHWAYS, TRAIL_TILE, PEAK_TILE } from './config.js';
import { cacheGet, cachePut } from './tilecache.js';

const CONCURRENCY = 2;
const REQUEST_TIMEOUT = 75_000;
const MAX_TRIES = 6;
// Wartezeit vor dem nächsten Versuch – wächst, damit ein überlasteter Server
// nicht weiter bedrängt wird.
const RETRY_DELAYS = [2_000, 6_000, 15_000, 30_000, 60_000];
// Bei Überlastung (429) oder Zeitüberschreitung des Servers mindestens so lange warten.
const BUSY_DELAY = 12_000;

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
  // Bewusst ohne Filter auf "access": In den Alpen sind viele Forst- und
  // Almwege als privat getaggt – gegangen ist man sie trotzdem.
  return (
    `[out:json][timeout:60];\n` +
    `way["highway"~"^(${TRAIL_HIGHWAYS})$"]["footway"!~"^(sidewalk|crossing)$"](${box});\n` +
    `out body geom;`
  );
}

/** Fehler, bei denen es sich lohnt, später schonend nochmal zu versuchen. */
class BusyError extends Error {}

export class OverpassLoader {
  /**
   * @param {(kind: string, elements: object[]) => void} onData
   * @param {(state: object) => void} onState
   */
  constructor(onData, onState = () => {}) {
    this.onData = onData;
    this.onState = onState;
    this.queue = [];
    this.inFlight = new Set(); // laufende Abfragen – sonst würde jedes
    this.done = new Set(); // Verschieben der Karte sie erneut anstoßen
    this.failed = new Map(); // key -> { tries, retryAt, message }
    this.timers = new Map(); // key -> geplanter Wiederholversuch
    this.endpoint = 0;
    this.enabled = true;
  }

  /** Bereits geladen, in Arbeit oder eingeplant? */
  knows(key) {
    return this.done.has(key) || this.inFlight.has(key) || this.timers.has(key) ||
      this.queue.some((job) => job.key === key);
  }

  request(kind, tiles) {
    const now = Date.now();
    for (const { x, y } of tiles) {
      const key = tileKey(kind, x, y);
      if (this.knows(key)) continue;
      const failure = this.failed.get(key);
      if (failure && (failure.tries >= MAX_TRIES || failure.retryAt > now)) continue;
      this.queue.push({ kind, x, y, key });
    }
    this.#pump();
  }

  /** Noch nicht gestartete Kacheln außerhalb der Ansicht verwerfen. */
  prune(keepKeys) {
    this.queue = this.queue.filter((job) => keepKeys.has(job.key));
    this.#report();
  }

  /** Anzahl der Kacheln, die gerade nicht geladen werden konnten. */
  get failedCount() {
    return this.failed.size;
  }

  /** „Nochmal versuchen“: alle Fehlschläge zurücksetzen. */
  clearFailures() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.failed.clear();
    this.#report();
  }

  /** Kacheln vergessen, damit sie neu geladen werden. */
  forget(keys) {
    for (const key of keys) {
      this.done.delete(key);
      this.failed.delete(key);
      const timer = this.timers.get(key);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(key);
      }
    }
  }

  #report(extra = {}) {
    this.onState({
      pending: this.queue.length + this.inFlight.size + this.timers.size,
      active: this.inFlight.size,
      loaded: this.done.size,
      failed: this.failed.size,
      ...extra,
    });
  }

  #pump() {
    this.#report();
    while (this.enabled && this.inFlight.size < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift();
      this.inFlight.add(job.key);
      this.#run(job)
        .then(() => {
          this.failed.delete(job.key);
        })
        .catch((err) => this.#handleFailure(job, err))
        .finally(() => {
          this.inFlight.delete(job.key);
          this.#pump();
        });
    }
  }

  #handleFailure(job, err) {
    const failure = this.failed.get(job.key) || { tries: 0, retryAt: 0 };
    failure.tries++;
    failure.message = err.message || String(err);
    const base = RETRY_DELAYS[Math.min(failure.tries - 1, RETRY_DELAYS.length - 1)];
    const delay = err instanceof BusyError ? Math.max(base, BUSY_DELAY) : base;
    failure.retryAt = Date.now() + delay;
    this.failed.set(job.key, failure);

    // Beim nächsten Versuch einen anderen Server nehmen.
    this.endpoint = (this.endpoint + 1) % OVERPASS_ENDPOINTS.length;
    console.warn(`Kachel ${job.key} fehlgeschlagen (Versuch ${failure.tries}): ${failure.message}`);

    if (failure.tries < MAX_TRIES) {
      const timer = setTimeout(() => {
        this.timers.delete(job.key);
        if (!this.done.has(job.key) && !this.inFlight.has(job.key)) {
          this.queue.push(job);
          this.#pump();
        }
      }, delay);
      this.timers.set(job.key, timer);
    }
    this.#report({ error: failure.message });
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
      if (res.status === 429 || res.status === 504) {
        throw new BusyError(`Server ausgelastet (${res.status})`);
      }
      if (!res.ok) throw new Error(`Overpass antwortete mit ${res.status}`);

      const json = await res.json();
      // Overpass meldet Zeitüberschreitungen und Speichergrenzen mit HTTP 200
      // und einem "remark" – das darf nie als geladen gelten oder gar im
      // Zwischenspeicher landen, sonst bleibt die Gegend dauerhaft leer.
      if (json.remark && /error|timed? out|exceeded|memory/i.test(json.remark)) {
        throw new BusyError(`Overpass: ${json.remark}`);
      }
      if (!Array.isArray(json.elements)) throw new Error('Unerwartete Antwort von Overpass');

      this.done.add(job.key);
      await cachePut(job.key, json.elements);
      this.onData(job.kind, json.elements);
    } finally {
      clearTimeout(timer);
    }
  }
}
