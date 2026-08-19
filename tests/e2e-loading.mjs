// Prüft das Nachladen über die eigene Kachel-API: keine doppelten Anfragen,
// Verhalten bei Störungen, Teildaten und die Rückfallebene ohne Server.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { packTile } from '../js/osmdata.js';

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const LAT = 47.4213;
const LON = 11.0975;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const wayFor = (id, lat) => ({
  type: 'way', id, nodes: [id * 10, id * 10 + 1, id * 10 + 2], tags: { highway: 'path', name: `Weg ${id}` },
  geometry: [[lat, LON - 0.004], [lat, LON], [lat, LON + 0.004]].map(([la, lo]) => ({ lat: la, lon: lo })),
});

const tile = (kind, elemente, partial = false) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ v: 1, kind, partial, items: packTile(kind, elemente) }),
});
const kindOf = (route) => new URL(route.request().url()).searchParams.get('kind');

async function withPage(fn) {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (err) => { throw err; });
  await page.route(/^https:\/\/.*(tile|arcgis)/i, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.addInitScript(() => { indexedDB.deleteDatabase('alpenkarte-tiles'); localStorage.clear(); });
  try {
    await fn(page);
  } finally {
    await browser.close();
  }
}

// 1) Eine laufende Anfrage darf beim Verschieben nicht erneut starten
await withPage(async (page) => {
  const angefragt = [];
  await page.route('**/api/tiles*', async (route) => {
    const url = new URL(route.request().url());
    if (kindOf(route) === 'trails') angefragt.push(url.search);
    await new Promise((r) => setTimeout(r, 900)); // langsame Antwort
    await route.fulfill(tile(kindOf(route), kindOf(route) === 'peaks' ? [] : [wayFor(1, LAT)]));
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.alpenkarte?.view, null, { timeout: 20000 });
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.alpenkarte.view.map.panBy([4, 0], { animate: false }));
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(2500);
  const doppelt = angefragt.filter((s, i) => angefragt.indexOf(s) !== i);
  assert.deepEqual(doppelt, [], `keine Kachel doppelt angefragt (insgesamt ${angefragt.length})`);
  console.log(`✓ Laufende Anfragen werden beim Verschieben nicht erneut gestartet (${angefragt.length} Kacheln)`);
});

// 2) Serverfehler: Grund sichtbar, danach automatischer neuer Versuch
await withPage(async (page) => {
  let kaputt = true;
  await page.route('**/api/tiles*', (route) => {
    if (kindOf(route) === 'peaks') return route.fulfill(tile('peaks', []));
    if (kaputt) {
      return route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ error: 'Kein Overpass-Server erreichbar', details: ['overpass-api.de: ausgelastet (429)'] }) });
    }
    return route.fulfill(tile('trails', [wayFor(2, LAT)]));
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.alpenkarte?.view?.loader?.failedCount > 0, null, { timeout: 20000 });

  assert.match(await page.textContent('#status'), /nicht geladen/);
  assert.match(await page.textContent('#issue-list'), /ausgelastet \(429\)/, 'der Grund vom Server steht in der Liste');
  console.log('✓ Der Grund des Servers wird durchgereicht und angezeigt');

  kaputt = false;
  await page.waitForFunction(() => window.alpenkarte.view.graph.size > 0, null, { timeout: 30000 });
  await page.waitForFunction(() => window.alpenkarte.view.loader.failedCount === 0, null, { timeout: 30000 });
  console.log('✓ Danach lädt es von selbst nach, die Meldung verschwindet');
});

// 3) Teildaten: anzeigen, aber die Kachel offen halten
await withPage(async (page) => {
  let teilweise = true;
  await page.route('**/api/tiles*', (route) => {
    if (kindOf(route) === 'peaks') return route.fulfill(tile('peaks', []));
    return teilweise
      ? route.fulfill(tile('trails', [wayFor(3, LAT)], true))
      : route.fulfill(tile('trails', [wayFor(3, LAT), wayFor(4, LAT + 0.002)]));
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.alpenkarte?.view?.graph?.size > 0, null, { timeout: 20000 });

  const zustand = await page.evaluate(() => ({
    wege: window.alpenkarte.view.graph.size,
    offen: window.alpenkarte.view.loader.failedCount,
    alsTeilweiseGemerkt: window.alpenkarte.view.loader.failures.every((f) => f.partial),
    imZwischenspeicher: [...window.alpenkarte.view.loader.done].filter((k) => k.startsWith('trails/')).length,
  }));
  assert.ok(zustand.wege > 0, 'die Teildaten sind auf der Karte');
  assert.ok(zustand.offen > 0, 'die Kachel bleibt offen');
  assert.equal(zustand.alsTeilweiseGemerkt, true);
  assert.equal(zustand.imZwischenspeicher, 0, 'Teildaten werden nicht als fertig abgelegt');
  assert.match(await page.textContent('#issue-list'), /nur teilweise/);
  console.log('✓ Teildaten werden angezeigt, die Kachel bleibt offen und wird nicht abgelegt');

  teilweise = false;
  await page.click('.status-btn');
  // Erst auf die neuen Daten warten – der Zähler steht schon beim Klick auf 0.
  await page.waitForFunction(() => window.alpenkarte.view.graph.size >= 2, null, { timeout: 20000 });
  await page.waitForFunction(() => window.alpenkarte.view.loader.failedCount === 0, null, { timeout: 20000 });
  console.log('✓ Beim nächsten Versuch wird vollständig geladen');
});

// 4) Ohne eigenen Server: Rückfall auf direkte Overpass-Abfragen
await withPage(async (page) => {
  let overpassAufrufe = 0;
  await page.route('**/api/tiles*', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Nicht gefunden' }));
  await page.route('**/api/interpreter', (route) => {
    overpassAufrufe++;
    const data = route.request().postData() || '';
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ elements: data.includes('natural') ? [] : [wayFor(5, LAT)] }) });
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.alpenkarte?.view?.graph?.size > 0, null, { timeout: 20000 });
  assert.ok(overpassAufrufe > 0, 'es wurde direkt bei Overpass gefragt');
  assert.equal(await page.evaluate(() => window.alpenkarte.view.loader.direct), true);
  console.log(`✓ Fehlt die eigene API, wird direkt bei Overpass geladen (${overpassAufrufe} Abfragen)`);
});

// 5) „Diesen Ausschnitt neu laden“ holt frisch
await withPage(async (page) => {
  let geliefert = 0;
  await page.route('**/api/tiles*', (route) => {
    if (kindOf(route) === 'trails') geliefert++;
    return route.fulfill(tile(kindOf(route), kindOf(route) === 'peaks' ? [] : [wayFor(6, LAT)]));
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.alpenkarte?.view?.graph?.size > 0, null, { timeout: 20000 });
  const vorher = geliefert;
  await page.evaluate(() => document.body.classList.add('panel-open'));
  await page.click('#reload-area');
  await page.waitForTimeout(1500);
  assert.ok(geliefert > vorher, `neu abgefragt (${vorher} -> ${geliefert})`);
  console.log(`✓ „Diesen Ausschnitt neu laden“ fragt frisch ab (${geliefert - vorher} Kacheln)`);
});

console.log('\nAlle Ladetests bestanden.');
