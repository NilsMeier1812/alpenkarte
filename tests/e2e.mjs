// Integrationstest im echten Browser mit erfundenen Overpass-Antworten.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { packTile } from '../js/osmdata.js';

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const LAT = 47.4213;
const LON = 11.0975;
const d = 0.004;

// Weg 1001 verläuft von West nach Ost, Weg 1002 stößt in der Mitte (Knoten 3)
// dazu -> daraus müssen zwei Abschnitte werden.
const way = (id, nodes, coords, tags) => ({
  type: 'way', id, nodes, tags,
  geometry: coords.map(([lat, lon]) => ({ lat, lon })),
});

const WAYS = [
  way(1001, [1, 2, 3, 4, 5],
    [[LAT, LON - 2 * d], [LAT, LON - d], [LAT, LON], [LAT, LON + d], [LAT, LON + 2 * d]],
    { highway: 'path', name: 'Teststeig', sac_scale: 'mountain_hiking' }),
  way(1002, [3, 10, 11],
    [[LAT, LON], [LAT + d, LON], [LAT + 2 * d, LON]],
    { highway: 'path', name: 'Nordanstieg' }),
  way(1003, [20, 21, 22],
    [[LAT - d, LON - d], [LAT - d, LON], [LAT - d, LON + d]],
    { highway: 'track', name: 'Forstweg' }),
];

const PEAKS = [
  { type: 'node', id: 2001, lat: LAT + 2 * d, lon: LON, tags: { natural: 'peak', name: 'Testspitze', ele: '2500' } },
];

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (err) => errors.push(String(err)));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

await page.route('**/api/tiles*', async (route) => {
  const kind = new URL(route.request().url()).searchParams.get('kind');
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ v: 1, kind, partial: false, items: packTile(kind, kind === 'peaks' ? PEAKS : WAYS) }),
  });
});
await page.route(/^https:\/\/.*(tile|arcgis)/i, (route) =>
  route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: PNG }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.alpenkarte?.view?.graph?.size >= 3, null, { timeout: 20000 });

// 1) Kreuzungserkennung
const segs = await page.evaluate(() => window.alpenkarte.view.graph.segments(1001).map((s) => [s.from, s.to]));
assert.deepEqual(segs, [[0, 2], [2, 4]], 'Weg wird an der Kreuzung getrennt');
console.log('✓ Wege werden an Kreuzungen in Abschnitte zerlegt');

// Hilfsfunktion: Bildschirmposition einer Koordinate
const point = (lat, lon) => page.evaluate(([la, lo]) => {
  const p = window.alpenkarte.view.map.latLngToContainerPoint([la, lo]);
  return { x: p.x, y: p.y };
}, [lat, lon]);

// 2) Klick auf den westlichen Abschnitt markiert genau diesen Abschnitt
const west = await point(LAT, LON - 1.5 * d);
await page.mouse.click(west.x, west.y);
await page.waitForFunction(() => window.alpenkarte.store.data.ways['1001'], null, { timeout: 5000 });
let runs = await page.evaluate(() => window.alpenkarte.store.data.ways['1001'].r);
assert.deepEqual(runs, [[1, 3]], 'nur der Abschnitt von Knoten 1 bis 3 ist markiert');
const km = await page.textContent('#stat-km');
assert.notEqual(km, '0,0', 'Kilometerzähler läuft mit');
console.log(`✓ Klick markiert den Abschnitt von Kreuzung zu Kreuzung (${km} km)`);

// 3) Der andere Abschnitt desselben Weges bleibt unmarkiert
const east = await point(LAT, LON + 1.5 * d);
await page.mouse.click(east.x, east.y);
runs = await page.evaluate(() => window.alpenkarte.store.data.ways['1001'].r);
assert.deepEqual(runs, [[1, 5]], 'zweiter Abschnitt kommt dazu und wird verschmolzen');
console.log('✓ Zweiter Abschnitt wird ergänzt und mit dem ersten verschmolzen');

// 4) Nochmal klicken nimmt die Markierung zurück
await page.mouse.click(east.x, east.y);
runs = await page.evaluate(() => window.alpenkarte.store.data.ways['1001'].r);
assert.deepEqual(runs, [[1, 3]], 'Abschnitt wieder freigegeben');
console.log('✓ Erneuter Klick entfernt die Markierung');

// 5) Rückgängig
await page.click('#undo-btn');
runs = await page.evaluate(() => window.alpenkarte.store.data.ways['1001'].r);
assert.deepEqual(runs, [[1, 5]], 'Rückgängig stellt den Zustand wieder her');
console.log('✓ Rückgängig funktioniert');

// 6) Modus „Ganzer Weg"
await page.click('.seg[data-mode="way"]');
const forest = await point(LAT - d, LON + 0.5 * d);
await page.mouse.click(forest.x, forest.y);
await page.waitForFunction(() => window.alpenkarte.store.data.ways['1003'], null, { timeout: 5000 });
assert.deepEqual(await page.evaluate(() => window.alpenkarte.store.data.ways['1003'].r), [[20, 22]]);
console.log('✓ Modus „Ganzer Weg" markiert den kompletten OSM-Weg');

// 7) Gipfel abhaken
const peakMarker = page.locator('.peak-marker').first();
await peakMarker.waitFor({ timeout: 10000 });
await peakMarker.click();
await page.waitForFunction(() => window.alpenkarte.store.data.peaks['2001'], null, { timeout: 5000 });
assert.equal(await page.textContent('#stat-peaks'), '1');
assert.equal(await page.locator('#peak-list li').first().textContent().then((t) => t.includes('Testspitze')), true);
console.log('✓ Gipfel lässt sich abhaken und erscheint in der Liste');

// 8) Nach dem Neuladen ist alles noch da
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.alpenkarte?.view?.graph?.size >= 3, null, { timeout: 20000 });
assert.deepEqual(await page.evaluate(() => window.alpenkarte.store.data.ways['1001'].r), [[1, 5]]);
assert.equal(await page.textContent('#stat-peaks'), '1');
const visited = await page.evaluate(() => {
  const way = window.alpenkarte.view.graph.ways.get(1001);
  const group = window.alpenkarte.view.wayLayers.get(1001);
  return group.getLayers().map((l) => l._visited);
});
assert.deepEqual(visited, [true, true], 'beide Abschnitte werden als gegangen gezeichnet');
console.log('✓ Markierungen überleben das Neuladen und werden farbig gezeichnet');

// 9) Export liefert gültiges JSON
const exported = await page.evaluate(() => window.alpenkarte.store.export());
const parsed = JSON.parse(exported);
assert.ok(parsed.ways['1001'] && parsed.peaks['2001'], 'Export enthält Wege und Gipfel');
console.log('✓ Export enthält alle Markierungen');

await page.screenshot({ path: process.env.SHOT || 'tests/screenshot.png' });
if (errors.length) {
  console.error('\nFehler in der Browserkonsole:\n' + errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('\nAlle Browsertests bestanden.');
}
await browser.close();
