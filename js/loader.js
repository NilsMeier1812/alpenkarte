// Holt Kacheln von der eigenen API (/api/tiles) und reicht sie an die Karte.
//
// Der Browser redet nur noch mit der eigenen Domain. Damit entfallen CORS,
// fremde Ratenlimits und die Warteschlange von Overpass – die Antworten kommen
// aus dem CDN. Gibt es die API nicht (rein statisches Hosting, etwa GitHub
// Pages), fällt der Lader auf direkte Overpass-Abfragen zurück.

import { buildQuery, isPartial, packTile, unpackTile } from './osmdata.js';
import { PEAK_Z, TRAIL_Z, tileBounds, tileKey } from './tiles.js';
import { cacheGet, cachePut } from './tilecache.js';

const CONCURRENCY = 6; // eigene API, dazu darf man freundlich parallel sein
const MAX_TRIES = 5;
const RETRY_DELAYS = [3_000, 10_000, 30_000, 60_000];
// Teildaten sind schnell wieder überholt: der Server hält sie nur kurz.
const PARTIAL_RETRY = 90_000;
const REQUEST_TIMEOUT = 70_000;

const FALLBACK_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export class TileLoader {
  /**
   * @param {(kind: string, items: object[]) => void} onData bekommt bereits
   *        ausgepackte Wege bzw. Gipfel
   * @param {(state: object) => void} onState
   */
  constructor(onData, onState = () => {}) {
    this.onData = onData;
    this.onState = onState;
    this.queue = [];
    this.inFlight = new Set();
    this.done = new Set();
    this.failed = new Map(); // key -> { tries, retryAt, message, partial }
    this.timers = new Map();
    this.enabled = true;
    this.direct = false; // true, sobald die eigene API fehlt
    this.fallbackIndex = 0;
  }

  knows(key) {
    return (
      this.done.has(key) || this.inFlight.has(key) || this.timers.has(key) ||
      this.queue.some((job) => job.key === key)
    );
  }

  request(kind, tiles) {
    const now = Date.now();
    for (const { z, x, y } of tiles) {
      const key = tileKey(kind, z, x, y);
      if (this.knows(key)) continue;
      const failure = this.failed.get(key);
      if (failure && (failure.tries >= MAX_TRIES || failure.retryAt > now)) continue;
      this.queue.push({ kind, z, x, y, key });
    }
    this.#pump();
  }

  /** Noch nicht gestartete Kacheln außerhalb der Ansicht verwerfen. */
  prune(keepKeys) {
    this.queue = this.queue.filter((job) => keepKeys.has(job.key));
    this.#report();
  }

  get failedCount() {
    return this.failed.size;
  }

  get failures() {
    return [...this.failed.entries()].map(([key, f]) => ({
      key,
      message: f.message,
      tries: f.tries,
      partial: Boolean(f.partial),
      aufgegeben: f.tries >= MAX_TRIES,
    }));
  }

  clearFailures() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.failed.clear();
    this.#report();
  }

  /** Kacheln vergessen, damit sie neu geholt werden. Gibt die Schlüssel zurück. */
  forget(tiles) {
    const keys = tiles.map(({ kind, z, x, y }) => tileKey(kind, z, x, y));
    for (const key of keys) {
      this.done.delete(key);
      this.failed.delete(key);
      const timer = this.timers.get(key);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(key);
      }
    }
    return keys;
  }

  #report(extra = {}) {
    this.onState({
      pending: this.queue.length + this.inFlight.size + this.timers.size,
      active: this.inFlight.size,
      loaded: this.done.size,
      failed: this.failed.size,
      direct: this.direct,
      ...extra,
    });
  }

  #pump() {
    this.#report();
    while (this.enabled && this.inFlight.size < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift();
      this.inFlight.add(job.key);
      this.#run(job)
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
    failure.partial = Boolean(err.partial);
    const delay = err.partial
      ? PARTIAL_RETRY
      : RETRY_DELAYS[Math.min(failure.tries - 1, RETRY_DELAYS.length - 1)];
    failure.retryAt = Date.now() + delay;
    this.failed.set(job.key, failure);
    console.warn(`Kachel ${job.key}: ${failure.message} (Versuch ${failure.tries})`);

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
      this.onData(job.kind, unpackTile(job.kind, cached));
      return;
    }

    const { items, partial } = this.direct ? await this.#fetchDirect(job) : await this.#fetchApi(job);

    // Teildaten anzeigen, aber die Kachel offen lassen und nicht ablegen.
    this.onData(job.kind, unpackTile(job.kind, items));
    if (partial) {
      const err = new Error('Server war ausgelastet, Kachel nur teilweise geladen');
      err.partial = true;
      throw err;
    }
    this.done.add(job.key);
    this.failed.delete(job.key);
    await cachePut(job.key, items);
  }

  /** Der Normalfall: die eigene API. */
  async #fetchApi(job) {
    const url = `/api/tiles?kind=${job.kind}&z=${job.z}&x=${job.x}&y=${job.y}`;
    const res = await this.#fetchWithTimeout(url);

    if (res.status === 404 || res.status === 405) {
      // Kein Serverteil vorhanden – ab jetzt direkt bei Overpass fragen.
      console.info('Keine eigene Kachel-API gefunden, frage direkt bei Overpass an.');
      this.direct = true;
      return this.#fetchDirect(job);
    }
    if (!res.ok) {
      const info = await res.json().catch(() => ({}));
      throw new Error(info.details?.[0] || info.error || `Kachel-API antwortete mit ${res.status}`);
    }
    const json = await res.json();
    return { items: json.items || [], partial: Boolean(json.partial) };
  }

  /** Rückfallebene ohne eigenen Server (z. B. GitHub Pages). */
  async #fetchDirect(job) {
    const z = job.kind === 'peaks' ? PEAK_Z : TRAIL_Z;
    const query = buildQuery(job.kind, tileBounds(z, job.x, job.y), 55);
    const url = FALLBACK_ENDPOINTS[this.fallbackIndex % FALLBACK_ENDPOINTS.length];
    const res = await this.#fetchWithTimeout(url, {
      method: 'POST',
      body: new URLSearchParams({ data: query }),
    });
    if (!res.ok) {
      this.fallbackIndex++;
      throw new Error(`${new URL(url).hostname}: ${res.status === 429 ? 'ausgelastet' : 'Fehler'} (${res.status})`);
    }
    const json = await res.json();
    return { items: packTile(job.kind, json.elements || []), partial: isPartial(json) };
  }

  async #fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Zeitüberschreitung beim Laden');
      throw new Error(err.message === 'Failed to fetch' ? 'Keine Verbindung zum Server' : err.message);
    } finally {
      clearTimeout(timer);
    }
  }
}
