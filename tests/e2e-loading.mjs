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
  const details = await page.textContent('#issue-list');
  assert.match(details, /Overpass antwortete mit 500/, 'der Grund steht in der Seitenleiste');
  await page.waitForFunction(() => window.alpenkarte.view.graph.size > 0, null, { timeout: 20000 });
  assert.ok(attempts >= 2, 'es wurde erneut versucht');
  console.log(`✓ Nach einem Fehler wird von selbst erneut geladen (Hinweis: „${warnung.trim()}")`);
  console.log('✓ Der Grund steht sichtbar in der Seitenleiste, nicht nur in der Konsole');
});

// 3) Zeitüberschreitung: Teildaten behalten und die Kachel vierteln
await withPage(async (page) => {
  const bboxSpan = (data) => {
    const zahlen = (bboxOf(data).match(/-?[\d.]+/g) || []).map(Number);
    return zahlen.length === 4 ? +(zahlen[2] - zahlen[0]).toFixed(4) : 0;
  };
  const spans = [];
  await page.route('**/api/interpreter', (route) => {
    const data = route.request().postData() || '';
    if (!data.includes('highway')) return route.fulfill(json({ elements: [] }));
    const span = bboxSpan(data);
    spans.push(span);
    // Die volle Kachel läuft in die Zeitüberschreitung und liefert nur einen
    // Teil; die geviertelten Kacheln antworten vollständig.
    if (span > 0.03) {
      return route.fulfill(json({
        elements: [wayFor(3, LAT)],
        remark: 'runtime error: Query timed out in "query" at line 2 after 90 seconds.',
      }));
    }
    return route.fulfill(json({ elements: [wayFor(4, LAT + 0.001), wayFor(5, LAT + 0.002)] }));
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.alpenkarte?.view?.graph?.size >= 3, null, { timeout: 30000 });

  const teildaten = await page.evaluate(() => window.alpenkarte.view.graph.ways.has(3));
  assert.equal(teildaten, true, 'die Teildaten der abgebrochenen Abfrage werden angezeigt');
  console.log('✓ Teildaten einer abgebrochenen Abfrage gehen nicht verloren');

  const klein = () => spans.filter((s) => s > 0 && s < 0.03);
  for (let i = 0; i < 60 && klein().length < 4; i++) await page.waitForTimeout(200);
  const geviertelt = klein();
  assert.ok(geviertelt.length >= 4, `Kachel wurde geviertelt (kleinere Abfragen: ${geviertelt.length})`);
  assert.ok(Math.abs(geviertelt[0] - 0.0204) < 0.002, `halbe Kantenlaenge, war ${geviertelt[0]}`);
  console.log(`✓ Zu große Kachel wird selbsttätig geviertelt (${geviertelt.length} kleinere Abfragen)`);

  const zustand = await page.evaluate(() => ({
    offen: window.alpenkarte.view.loader.failedCount,
    kleineGeladen: [...window.alpenkarte.view.loader.done].filter((k) => k.startsWith('trails/1/')).length,
  }));
  assert.equal(zustand.offen, 0, 'nach dem Vierteln bleibt nichts offen');
  assert.ok(zustand.kleineGeladen >= 4, 'die kleineren Kacheln sind geladen');
  console.log('✓ Danach ist der Bereich vollständig geladen, ohne offene Meldung');

  // Die abgebrochene Antwort darf nicht im Zwischenspeicher liegen
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.alpenkarte?.view?.graph?.size >= 2, null, { timeout: 30000 });
  console.log('✓ Nach dem Neuladen sind die Wege wieder da');
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
