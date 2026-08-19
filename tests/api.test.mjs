// Prüft die Kachel-API (api/tiles.js) mit vorgetäuschten Overpass-Antworten.
import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/tiles.js';
import { TRAIL_Z, PEAK_Z } from '../js/tiles.js';

/** Minimaler Ersatz für die Antwort, wie Vercel sie durchreicht. */
function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(text) {
      this.body = JSON.parse(text);
    },
  };
}

const wayElement = {
  type: 'way', id: 7, nodes: [11, 12, 13],
  geometry: [{ lat: 47.42, lon: 11.09 }, { lat: 47.421, lon: 11.091 }, { lat: 47.422, lon: 11.092 }],
  tags: { highway: 'path', name: 'Steig', source: 'egal' },
};

const antwort = (body) => ({ ok: true, status: 200, json: async () => body });

function mockFetch(reihe) {
  const aufrufe = [];
  globalThis.fetch = async (url) => {
    aufrufe.push(new URL(url).hostname);
    const naechste = reihe.shift();
    if (typeof naechste === 'function') return naechste();
    return naechste;
  };
  return aufrufe;
}

const original = globalThis.fetch;
test.after(() => { globalThis.fetch = original; });

const req = (query) => ({ url: `/api/tiles?${query}` });

test('liefert kompakte Wege und lange CDN-Haltbarkeit', async () => {
  const aufrufe = mockFetch([antwort({ elements: [wayElement] })]);
  const res = fakeRes();
  await handler(req(`kind=trails&z=${TRAIL_Z}&x=4321&y=2876`), res);

  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.partial, false);
  assert.equal(res.body.items[0].t.n, 'Steig', 'Name bleibt erhalten');
  assert.equal(res.body.items[0].t.source, undefined, 'unnötige Tags fallen weg');
  assert.match(res.headers['Cache-Control'], /s-maxage=1209600/, 'zwei Wochen im CDN');
  assert.match(res.headers['Cache-Control'], /stale-while-revalidate/);
  assert.equal(aufrufe.length, 1, 'ein Server genügt');
});

test('weicht bei Serverfehler auf den nächsten Server aus', async () => {
  const aufrufe = mockFetch([
    { ok: false, status: 429 },
    antwort({ elements: [wayElement] }),
  ]);
  const res = fakeRes();
  await handler(req(`kind=trails&z=${TRAIL_Z}&x=4321&y=2876`), res);
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  assert.deepEqual(aufrufe, ['overpass-api.de', 'overpass.kumi.systems']);
});

test('bei Abbruch wird ein anderer Server versucht', async () => {
  const aufrufe = mockFetch([
    antwort({ elements: [wayElement], remark: 'runtime error: Query timed out after 22 seconds.' }),
    antwort({ elements: [wayElement, { ...wayElement, id: 8 }] }),
  ]);
  const res = fakeRes();
  await handler(req(`kind=trails&z=${TRAIL_Z}&x=4321&y=2876`), res);
  assert.equal(res.body.partial, false, 'der zweite Server war vollständig');
  assert.equal(res.body.items.length, 2);
  assert.equal(aufrufe.length, 2);
});

test('Teildaten werden geliefert, aber nur kurz zwischengespeichert', async () => {
  const teil = antwort({ elements: [wayElement], remark: 'runtime error: Query timed out' });
  mockFetch([teil, teil, teil]);
  const res = fakeRes();
  await handler(req(`kind=trails&z=${TRAIL_Z}&x=4321&y=2876`), res);

  assert.equal(res.status, 200);
  assert.equal(res.body.partial, true);
  assert.equal(res.body.items.length, 1, 'die Teildaten kommen trotzdem an');
  assert.match(res.headers['Cache-Control'], /s-maxage=120/, 'nur zwei Minuten');
});

test('fällt kein Server aus, gibt es 503 ohne Zwischenspeichern', async () => {
  mockFetch([
    () => { throw new Error('overpass-api.de: ausgelastet (504)'); },
    () => { throw new Error('kumi: Fehler (500)'); },
    () => { throw new Error('private.coffee: Fehler (502)'); },
  ]);
  const res = fakeRes();
  await handler(req(`kind=trails&z=${TRAIL_Z}&x=4321&y=2876`), res);
  assert.equal(res.status, 503);
  assert.equal(res.headers['Cache-Control'], 'no-store', 'ein Fehler darf nie im CDN landen');
  assert.equal(res.body.details.length, 3, 'alle Gründe werden gemeldet');
});

test('Gipfelkacheln funktionieren', async () => {
  mockFetch([antwort({ elements: [
    { type: 'node', id: 5, lat: 47.4211, lon: 10.9853, tags: { natural: 'peak', name: 'Zugspitze', ele: '2962' } },
  ] })]);
  const res = fakeRes();
  await handler(req(`kind=peaks&z=${PEAK_Z}&x=540&y=359`), res);
  assert.equal(res.body.items[0].n, 'Zugspitze');
  assert.equal(res.body.items[0].e, 2962);
});

test('fremde Zoomstufen werden abgelehnt', async () => {
  mockFetch([]);
  for (const q of [`kind=trails&z=8&x=1&y=1`, `kind=trails&z=${TRAIL_Z}&x=-1&y=1`, 'kind=trails']) {
    const res = fakeRes();
    await handler(req(q), res);
    assert.equal(res.status, 400, `abgelehnt: ${q}`);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
});
