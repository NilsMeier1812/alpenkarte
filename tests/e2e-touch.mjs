// Bedienung per Fingertipp: wie weit darf man danebentippen, und wird der
// nächstgelegene Weg genommen?
import { chromium, devices } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const LAT = 47.4213;
const LON = 11.0975;
const d = 0.004;

const geom = (coords) => coords.map(([lat, lon]) => ({ lat, lon }));
const WAYS = [
  { type: 'way', id: 1001, nodes: [1, 2, 3, 4, 5], tags: { highway: 'path', name: 'Teststeig' },
    geometry: geom([[LAT, LON - 2 * d], [LAT, LON - d], [LAT, LON], [LAT, LON + d], [LAT, LON + 2 * d]]) },
  // zwei eng benachbarte Wege weiter nördlich – dort wird geprüft, dass der
  // nähere von beiden gewinnt (rund 45 px Abstand bei Zoomstufe 13)
  { type: 'way', id: 1003, nodes: [21, 22, 23], tags: { highway: 'path', name: 'Oberer Parallelweg' },
    geometry: geom([[LAT + 0.012, LON - 2 * d], [LAT + 0.012, LON], [LAT + 0.012, LON + 2 * d]]) },
  { type: 'way', id: 1004, nodes: [31, 32, 33], tags: { highway: 'path', name: 'Unterer Parallelweg' },
    geometry: geom([[LAT + 0.0068, LON - 2 * d], [LAT + 0.0068, LON], [LAT + 0.0068, LON + 2 * d]]) },
];
const PEAKS = [{ type: 'node', id: 2001, lat: LAT + 2 * d, lon: LON, tags: { natural: 'peak', name: 'Testspitze', ele: '2500' } }];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ ...devices['iPhone 13'], isMobile: true, hasTouch: true });
const errors = [];
page.on('pageerror', (err) => errors.push(String(err)));

await page.route('**/api/interpreter', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ elements: (route.request().postData() || '').includes('natural') ? PEAKS : WAYS }) }));
await page.route(/^https:\/\/.*(tile|arcgis)/i, (route) =>
  route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.alpenkarte?.view?.graph?.size >= 3, null, { timeout: 20000 });

const setup = await page.evaluate(() => ({
  touch: window.alpenkarte.view.coarsePointer,
  radius: window.alpenkarte.view.tapRadius,
  doppeltippZoom: window.alpenkarte.view.map.doubleClickZoom.enabled(),
}));
assert.equal(setup.touch, true, 'Touchgerät wird erkannt');
assert.equal(setup.doppeltippZoom, false, 'Doppeltipp-Zoom ist am Handy aus');
console.log(`✓ Touchbedienung erkannt (Trefferradius ${setup.radius} px, Doppeltipp-Zoom aus)`);

// Vor jedem Tipp Ansicht und Markierungen zurücksetzen – sonst verschiebt
// sich die Karte zwischen den Messungen.
async function tapOffset(offset) {
  const point = await page.evaluate(([lat, lon, off]) => {
    window.alpenkarte.store.clear();
    window.alpenkarte.view.map.setView([47.4213, 11.0975], 14, { animate: false });
    const p = window.alpenkarte.view.map.latLngToContainerPoint([lat, lon]);
    return { x: Math.round(p.x), y: Math.round(p.y + off) };
  }, [LAT, LON - 0.006, offset]);
  await page.touchscreen.tap(point.x, point.y);
  await page.waitForTimeout(250);
  return page.evaluate(() => Object.keys(window.alpenkarte.store.data.ways));
}

for (const offset of [0, 10, 20, 30]) {
  const marked = await tapOffset(offset);
  assert.deepEqual(marked, ['1001'], `Tipp ${offset} px neben dem Weg markiert ihn`);
}
console.log('✓ Tipp bis 30 px neben dem Weg markiert ihn trotzdem');

const missed = await tapOffset(60);
assert.deepEqual(missed, [], 'weit daneben markiert nichts');
console.log('✓ Weit daneben (60 px) passiert nichts');

// Liegen zwei Wege in Reichweite, gewinnt der nähere.
// Bei Zoomstufe 13 sind die beiden Testwege rund 55 px auseinander.
async function tapBetween(anteil) {
  const point = await page.evaluate((teil) => {
    window.alpenkarte.store.clear();
    const map = window.alpenkarte.view.map;
    map.setView([47.4213 + 0.0094, 11.0915], 13, { animate: false });
    const oben = map.latLngToContainerPoint([47.4213 + 0.012, 11.0915]);
    const unten = map.latLngToContainerPoint([47.4213 + 0.0068, 11.0915]);
    return { x: Math.round(oben.x), y: Math.round(oben.y + (unten.y - oben.y) * teil),
             abstand: Math.round(unten.y - oben.y) };
  }, anteil);
  await page.waitForTimeout(400); // Karte neu zeichnen lassen
  if (process.env.DEBUG) {
    console.log('   Sonde:', await page.evaluate(([x, y]) => {
      const v = window.alpenkarte.view;
      const ll = v.map.containerPointToLatLng([x, y]);
      const hit = v.nearestSegment(ll, v.tapRadius);
      return { gezeichnet: v.wayLayers.size, zoom: v.map.getZoom(),
               treffer: hit ? { weg: hit.way.id, abstand: +hit.distance.toFixed(1) } : null };
    }, [point.x, point.y]));
  }
  await page.touchscreen.tap(point.x, point.y);
  await page.waitForTimeout(250);
  const marked = await page.evaluate(() => Object.keys(window.alpenkarte.store.data.ways));
  return { marked, abstand: point.abstand };
}
const nachOben = await tapBetween(0.4);
assert.deepEqual(nachOben.marked, ['1003'], 'oberhalb der Mitte gewinnt der obere Weg');
const nachUnten = await tapBetween(0.6);
assert.deepEqual(nachUnten.marked, ['1004'], 'unterhalb der Mitte gewinnt der untere Weg');
console.log(`✓ Zwischen zwei Wegen (${nachOben.abstand} px auseinander) wird der nähere markiert`);

// Zu weit herausgezoomt: Hinweis statt stiller Wirkungslosigkeit
await page.evaluate(() => window.alpenkarte.view.map.setView([47.4213, 11.0975], 11, { animate: false }));
await page.waitForTimeout(400);
await page.touchscreen.tap(180, 400);
await page.waitForTimeout(250);
const toast = await page.evaluate(() => {
  const el = document.querySelector('#toast');
  return { hidden: el.hidden, text: el.textContent };
});
assert.equal(toast.hidden, false, 'Es erscheint ein Hinweis');
assert.match(toast.text, /zoom/i);
const status = await page.evaluate(() => ({ hidden: document.querySelector('#status').hidden, text: document.querySelector('#status').textContent }));
assert.equal(status.hidden, false);
console.log(`✓ Zu weit weg: Hinweis „${toast.text}"`);

// Gipfel per Fingertipp
await page.evaluate(() => window.alpenkarte.view.map.setView([47.4213 + 0.008, 11.0975], 14, { animate: false }));
await page.waitForTimeout(600);
const peak = page.locator('.peak-marker').first();
await peak.waitFor({ timeout: 10000 });
const box = await peak.boundingBox();
await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(300);
assert.equal(await page.textContent('#stat-peaks'), '1', 'Gipfel per Tipp abgehakt');
console.log('✓ Gipfel lässt sich mit dem Finger abhaken');

await page.screenshot({ path: 'tests/screenshot-mobile.png' });
if (errors.length) {
  console.error('\nFehler in der Browserkonsole:\n' + errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('\nAlle Touch-Tests bestanden.');
}
await browser.close();
