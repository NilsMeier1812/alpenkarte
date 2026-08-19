// Kleiner Zwischenspeicher (IndexedDB) für Overpass-Antworten. Spart Wartezeit
// beim erneuten Besuch einer Gegend und schont die freien Overpass-Server.
// Fällt still auf "kein Cache" zurück, wenn IndexedDB nicht verfügbar ist.

const DB_NAME = 'alpenkarte-tiles';
const STORE = 'tiles';
// Wird hochgezählt, wenn ältere Einträge nicht mehr vertrauenswürdig sind.
const CACHE_VERSION = 2;
const MAX_AGE = 14 * 24 * 60 * 60 * 1000; // 14 Tage
// Leere Antworten kürzer behalten: entweder ist dort wirklich nichts, oder es
// war doch eine Störung beim Abruf.
const EMPTY_MAX_AGE = 24 * 60 * 60 * 1000;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (!globalThis.indexedDB) return resolve(null);
    let request;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return dbPromise;
}

export async function cacheGet(key) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => {
        const row = req.result;
        if (!row || row.v !== CACHE_VERSION) return resolve(null);
        const maxAge = row.elements?.length ? MAX_AGE : EMPTY_MAX_AGE;
        if (Date.now() - row.time > maxAge) return resolve(null);
        resolve(row.elements);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function cachePut(key, elements) {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ key, elements, time: Date.now(), v: CACHE_VERSION });
  } catch {
    /* Speicher voll o. Ä. – dann eben ohne Cache */
  }
}

/** Einzelne Kacheln aus dem Zwischenspeicher werfen (für „neu laden“). */
export async function cacheDelete(keys) {
  const db = await openDb();
  if (!db) return;
  try {
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    for (const key of keys) store.delete(key);
  } catch {
    /* egal */
  }
}

export async function cacheClear() {
  const db = await openDb();
  if (!db) return;
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
  } catch {
    /* egal */
  }
}
