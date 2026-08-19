// Kachel-API der Alpenkarte (läuft als Vercel-Funktion).
//
// Warum es diese Zwischenschicht gibt: Overpass ist ein Analysedienst, keine
// Karten-API. Fragt jedes Handy bei jedem Verschieben selbst dort an, zahlt
// jede Anfrage die Wartezeit auf einen freien Slot (zwei pro IP), und die
// Ratenbegrenzung greift – im Browser sichtbar als "Failed to fetch".
//
// Hier fragt stattdessen der Server, und zwar einmal pro Kachel. Die Antwort
// legt das CDN von Vercel ab und liefert sie allen weiteren Aufrufen in
// Millisekunden aus. Overpass sieht dadurch einen Bruchteil der Last, und der
// Browser redet nur noch mit der eigenen Domain – ohne CORS, ohne Ratenlimit.

import { buildQuery, isPartial, packTile } from '../js/osmdata.js';
import { PEAK_Z, TRAIL_Z, tileBounds } from '../js/tiles.js';

export const config = { maxDuration: 60 };

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Pro Versuch knapp bemessen, damit für den nächsten Server noch Zeit bleibt.
const VERSUCH_MS = 25_000;
const OVERPASS_TIMEOUT = 22; // Sekunden, serverseitiges Budget der Abfrage

const ZOOM = { trails: TRAIL_Z, peaks: PEAK_Z };

function send(res, status, body, cacheControl) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(text);
}

async function askOverpass(url, query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERSUCH_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Overpass bittet darum, sich zu erkennen zu geben.
        'User-Agent': 'Alpenkarte/1.0 (OSM-Wanderkarte; https://github.com/NilsMeier1812/alpenkarte)',
      },
      body: new URLSearchParams({ data: query }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const grund = res.status === 429 || res.status === 504 ? 'ausgelastet' : 'Fehler';
      throw new Error(`${new URL(url).hostname}: ${grund} (${res.status})`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const kind = params.get('kind') === 'peaks' ? 'peaks' : 'trails';
  const z = Number(params.get('z'));
  const x = Number(params.get('x'));
  const y = Number(params.get('y'));

  // Nur das feste Raster bedienen – sonst könnte jemand beliebig große
  // Ausschnitte anfordern und damit Overpass belasten.
  const erwartet = ZOOM[kind];
  const gueltig =
    z === erwartet && Number.isInteger(x) && Number.isInteger(y) &&
    x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z;
  if (!gueltig) {
    return send(res, 400, { error: `Erwartet wird z=${erwartet} mit gültigem x/y.` }, 'no-store');
  }

  const bounds = tileBounds(z, x, y);
  const query = buildQuery(kind, bounds, OVERPASS_TIMEOUT);
  const probleme = [];

  for (const url of ENDPOINTS) {
    try {
      const json = await askOverpass(url, query);
      const items = packTile(kind, json.elements || []);
      const teilweise = isPartial(json);

      if (teilweise && url !== ENDPOINTS[ENDPOINTS.length - 1]) {
        // Ein anderer Server ist vielleicht weniger ausgelastet.
        probleme.push(`${new URL(url).hostname}: abgebrochen`);
        continue;
      }

      return send(
        res,
        200,
        { v: 1, kind, tile: [z, x, y], partial: teilweise, items },
        teilweise
          ? // Teildaten nur kurz halten, damit bald ein vollständiger Versuch folgt.
            'public, max-age=0, s-maxage=120'
          : 'public, max-age=600, s-maxage=1209600, stale-while-revalidate=2592000',
      );
    } catch (err) {
      probleme.push(err.name === 'AbortError' ? `${new URL(url).hostname}: zu langsam` : err.message);
    }
  }

  return send(res, 503, { error: 'Kein Overpass-Server erreichbar', details: probleme }, 'no-store');
}
