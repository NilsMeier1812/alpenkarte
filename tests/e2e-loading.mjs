// Prüft das Nachladen von Overpass: keine doppelten Abfragen, Wiederholung
// nach Störungen, und dass Serverfehler nicht als "geladen" verbucht werden.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const LAT = 47.4213;
const LON = 11.0975;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const wayFor = (id, lat) => ({
  type: 'way', id, nodes: [id * 10, id * 10 + 1, id * 10 + 2], tags: { highway: 'path', name: `Weg ${id}` },
  geometry: [[lat, LON - 0.004], [lat, LON], [lat, LON + 0.004]].map(([la, lo]) => ({ lat: la, lon: lo })),
});

const json = (body) => ({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
const bboxOf = (data) => (decodeURIComponent(data).match(/\(([\d.,-]+)\)/) || [])[1] || '?';

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

// 1) Eine laufende Abfrage darf beim Verschieben der Karte nicht erneut starten
await withPage(async (page) => {
  const requests = [];
  await page.route('**/api/interpreter', async (route) => {
    const data = route.request().postData() || '';
    if (!data.includes('highway')) return route.fulfill(json({ elements: [] }));
    requests.push(bboxOf(data));
    await new Promise((r) => setTimeout(r, 1200)); // langsame Antwort
    await route.fulfill(json({ elements: [wayFor(1, LAT)] }));
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.alpenkarte?.view, null, { timeout: 20000 });
  // Karte mehrfach leicht bewegen, während die Abfragen noch laufen
  for (let i = 0; i < 5; i++) {
    await page.evaluate((n) => window.alpenkarte.view.map.panBy([n, 0], { animate: false }), 4);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(2500);
  const doppelt = requests.filter((b, i) => requests.indexOf(b) !== i);
  assert.deepEqual(doppelt, [], `keine Kachel doppelt angefragt (angefragt: ${requests.length})`);
  console.log(`✓ Laufende Abfragen werden beim Verschieben nicht erneut gestartet (${requests.length} Abfragen)`);
});

// 2) Nach einem Serverfehler wird von selbst erneut versucht
await withPage(async (page) => {
  let attempts = 0;
  await page.route('**/api/interpreter', (route) => {
    const data = route.request().postData() || '';
    if (!data.includes('highway')) return route.fulfill(json({ elements: [] }));
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'kaputt' });
    return route.fulfill(json({ elements: [wayFor(2, LAT)] }));
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.alpenkarte?.view?.loader?.failedCount > 0, null, { timeout: 20000 });
  const warnung = await page.textContent('#status');
  assert.match(warnung, /nicht geladen/);
  await page.waitForFunction(() => window.alpenkarte.view.graph.size > 0, null, { timeout: 20000 });
  assert.ok(attempts >= 2, 'es wurde erneut versucht');
  console.log(`✓ Nach einem Fehler wird von selbst erneut geladen (Hinweis: „${warnung.trim()}")`);
});

// 3) Overpass-Zeitüberschreitung (HTTP 200 mit "remark") gilt nicht als geladen
await withPage(async (page) => {
  // Solange 'gestoert' gesetzt ist, antwortet der Server auf *jede* Wegeabfrage
  // mit einer Zeitüberschreitung – sonst hinge das Ergebnis davon ab, welche
  // Kachel zuerst drankommt.
  let gestoert = true;
  await page.route('**/api/interpreter', (route) => {
    const data = route.request().postData() || '';
    if (!data.includes('highway')) return route.fulfill(json({ elements: [] }));
    if (gestoert) {
      return route.fulfill(json({ elements: [], remark: 'runtime error: Query timed out in "query" at line 2 after 60 seconds.' }));
    }
    return route.fulfill(json({ elements: [wayFor(3, LAT)] }));
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.alpenkarte?.view?.loader?.failedCount > 0, null, { timeout: 20000 });
  const state = await page.evaluate(() => ({
    alsGeladenVerbucht: [...window.alpenkarte.view.loader.done].some((k) => k.startsWith('trails/')),
    fehler: [...window.alpenkarte.view.loader.failed.values()][0]?.message,
  }));
  assert.equal(state.alsGeladenVerbucht, false, 'Zeitüberschreitung gilt nicht als geladen');
  assert.match(state.fehler, /timed out/);
  console.log('✓ Zeitüberschreitung wird als Fehler erkannt, nicht als leere Gegend');

  // Über den Knopf in der Statusleiste sofort erneut versuchen
  gestoert = false;
  await page.click('.status-btn');
  await page.waitForFunction(() => window.alpenkarte.view.graph.size > 0, null, { timeout: 20000 });
  console.log('✓ Der Knopf „Jetzt nochmal" lädt die fehlenden Bereiche nach');

  // Nichts Kaputtes im Zwischenspeicher: nach dem Neuladen sind die Wege da
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.alpenkarte?.view?.graph?.size > 0, null, { timeout: 20000 });
  console.log('✓ Die gestörte Antwort ist nicht im Zwischenspeicher gelandet');
});

// 4) „Diesen Ausschnitt neu laden" holt trotz Zwischenspeicher frisch
await withPage(async (page) => {
  let served = 0;
  await page.route('**/api/interpreter', (route) => {
    const data = route.request().postData() || '';
    if (!data.includes('highway')) return route.fulfill(json({ elements: [] }));
    served++;
    return route.fulfill(json({ elements: [wayFor(4, LAT)] }));
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.alpenkarte?.view?.graph?.size > 0, null, { timeout: 20000 });
  const vorher = served;
  await page.evaluate(() => document.body.classList.add('panel-open'));
  await page.click('#reload-area');
  await page.waitForTimeout(1500);
  assert.ok(served > vorher, `Ausschnitt wurde neu abgefragt (${vorher} -> ${served})`);
  console.log(`✓ „Diesen Ausschnitt neu laden" fragt frisch ab (${served - vorher} Abfragen)`);
});

console.log('\nAlle Ladetests bestanden.');
