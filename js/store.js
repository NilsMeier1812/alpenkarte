// Dauerhafte Ablage der Markierungen im localStorage.
//
// Struktur:
//   ways:  { wayId: { r: [[knotenA, knotenB], …], m: Meter, n: Name, t: Zeit } }
//   peaks: { knotenId: { n: Name, e: Höhe, la, lo, t: Zeit } }

import { STORAGE_KEY } from './config.js';

const UNDO_LIMIT = 50;

function emptyData() {
  return { version: 1, ways: {}, peaks: {}, updated: null };
}

export class Store {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.data = this.#load();
    this.undoStack = [];
    this.listeners = new Set();
    this.saveTimer = null;
  }

  #load() {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return emptyData();
      const parsed = JSON.parse(raw);
      return { ...emptyData(), ...parsed, ways: parsed.ways || {}, peaks: parsed.peaks || {} };
    } catch (err) {
      console.warn('Gespeicherte Daten konnten nicht gelesen werden:', err);
      return emptyData();
    }
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #changed(detail = {}) {
    this.data.updated = new Date().toISOString();
    this.#saveSoon();
    for (const fn of this.listeners) fn(detail);
  }

  #saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 250);
  }

  save() {
    clearTimeout(this.saveTimer);
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.data));
      return true;
    } catch (err) {
      console.error('Speichern fehlgeschlagen:', err);
      return false;
    }
  }

  // — Wege —————————————————————————————————————————————

  runs(wayId) {
    return this.data.ways[wayId]?.r || [];
  }

  hasWay(wayId) {
    return (this.data.ways[wayId]?.r?.length || 0) > 0;
  }

  /** Setzt die gegangenen Teilstücke eines Weges (leere Liste = Eintrag löschen). */
  setRuns(wayId, runs, { meters = 0, name = '', center = null } = {}) {
    this.#pushUndo({ kind: 'way', id: wayId, prev: this.data.ways[wayId] });
    if (!runs || runs.length === 0) {
      delete this.data.ways[wayId];
    } else {
      this.data.ways[wayId] = {
        r: runs,
        m: Math.round(meters),
        n: name,
        c: center || this.data.ways[wayId]?.c || null,
        t: this.data.ways[wayId]?.t || Date.now(),
      };
    }
    this.#changed({ kind: 'way', id: wayId });
  }

  // — Gipfel ————————————————————————————————————————————

  hasPeak(id) {
    return Boolean(this.data.peaks[id]);
  }

  togglePeak(peak) {
    this.#pushUndo({ kind: 'peak', id: peak.id, prev: this.data.peaks[peak.id] });
    const done = this.hasPeak(peak.id);
    if (done) {
      delete this.data.peaks[peak.id];
    } else {
      this.data.peaks[peak.id] = {
        n: peak.name || 'Gipfel',
        e: peak.ele ?? null,
        la: peak.lat,
        lo: peak.lon,
        t: Date.now(),
      };
    }
    this.#changed({ kind: 'peak', id: peak.id });
    return !done;
  }

  // — Rückgängig ————————————————————————————————————————

  #pushUndo(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    const bucket = entry.kind === 'peak' ? this.data.peaks : this.data.ways;
    if (entry.prev === undefined) delete bucket[entry.id];
    else bucket[entry.id] = entry.prev;
    this.#changed({ kind: entry.kind, id: entry.id, undo: true });
    return entry;
  }

  // — Statistik ————————————————————————————————————————

  stats() {
    const ways = Object.values(this.data.ways);
    return {
      meters: ways.reduce((sum, w) => sum + (w.m || 0), 0),
      ways: ways.length,
      peaks: Object.keys(this.data.peaks).length,
    };
  }

  peakList() {
    return Object.entries(this.data.peaks)
      .map(([id, p]) => ({ id, ...p }))
      .sort((a, b) => (b.e ?? -1) - (a.e ?? -1) || a.n.localeCompare(b.n, 'de'));
  }

  wayList() {
    return Object.entries(this.data.ways)
      .map(([id, w]) => ({ id, ...w }))
      .sort((a, b) => (b.t || 0) - (a.t || 0));
  }

  // — Import / Export ——————————————————————————————————

  export() {
    return JSON.stringify({ ...this.data, exported: new Date().toISOString() }, null, 1);
  }

  /** mode: 'merge' (Standard) oder 'replace'. Gibt eine kurze Bilanz zurück. */
  import(json, mode = 'merge') {
    const incoming = typeof json === 'string' ? JSON.parse(json) : json;
    if (!incoming || typeof incoming !== 'object' || (!incoming.ways && !incoming.peaks)) {
      throw new Error('Das sieht nicht nach einer Alpenkarte-Sicherung aus.');
    }
    const before = this.stats();
    if (mode === 'replace') this.data = emptyData();
    for (const [id, w] of Object.entries(incoming.ways || {})) {
      if (Array.isArray(w?.r)) this.data.ways[id] = w;
    }
    for (const [id, p] of Object.entries(incoming.peaks || {})) {
      if (p && typeof p === 'object') this.data.peaks[id] = p;
    }
    this.undoStack = [];
    this.#changed({ kind: 'import' });
    const after = this.stats();
    return { ways: after.ways - before.ways, peaks: after.peaks - before.peaks, total: after };
  }

  clear() {
    this.data = emptyData();
    this.undoStack = [];
    this.#changed({ kind: 'clear' });
  }
}
