import test from 'node:test';
import assert from 'node:assert/strict';
import { locate, normalize, addInterval, removeInterval, covers, runsToIntervals, intervalsToRuns } from '../js/runs.js';
import { TrailGraph, wayLabel } from '../js/graph.js';
import { buildQuery, packTile, unpackTile, isPartial, TRAIL_HIGHWAYS } from '../js/osmdata.js';
import { TRAIL_Z, lonToTileX, latToTileY, tileBounds, tileKey } from '../js/tiles.js';
import { pathLength, distance } from '../js/geo.js';

const line = (n, lat0 = 47.4) => Array.from({ length: n }, (_, i) => [lat0 + i * 0.001, 11.0]);

test('locate findet Indexpaare, auch rückwärts', () => {
  const nodes = [10, 11, 12, 13, 14];
  assert.deepEqual(locate(nodes, 11, 13), [1, 3]);
  assert.deepEqual(locate(nodes, 13, 11), [1, 3]);
  assert.equal(locate(nodes, 11, 99), null);
  assert.equal(locate(nodes, 12, 12), null);
});

test('locate kommt mit Rundwegen klar (Anfang = Ende)', () => {
  const nodes = [10, 11, 12, 13, 10];
  assert.deepEqual(locate(nodes, 10, 12), [0, 2]);
  assert.deepEqual(locate(nodes, 12, 10), [2, 4]); // zweites Vorkommen von 10
});

test('normalize verschmilzt überlappende und angrenzende Intervalle', () => {
  assert.deepEqual(normalize([[3, 5], [0, 2], [2, 3]]), [[0, 5]]);
  assert.deepEqual(normalize([[0, 2], [4, 6]]), [[0, 2], [4, 6]]);
  assert.deepEqual(normalize([[0, 4], [1, 2]]), [[0, 4]]);
  assert.deepEqual(normalize([[5, 1]]), [[1, 5]]);
});

test('removeInterval schneidet Löcher heraus', () => {
  assert.deepEqual(removeInterval([[0, 10]], [4, 6]), [[0, 4], [6, 10]]);
  assert.deepEqual(removeInterval([[0, 10]], [0, 10]), []);
  assert.deepEqual(removeInterval([[0, 4], [6, 10]], [2, 8]), [[0, 2], [8, 10]]);
  assert.deepEqual(removeInterval([[0, 4]], [4, 8]), [[0, 4]]); // nur Berührung
});

test('covers verlangt vollständige Überdeckung', () => {
  assert.equal(covers([[0, 5]], [1, 3]), true);
  assert.equal(covers([[0, 5]], [0, 5]), true);
  assert.equal(covers([[0, 2], [3, 5]], [1, 4]), false);
  assert.equal(covers([], [0, 1]), false);
});

test('Runs überleben eine feinere Zerlegung des Weges', () => {
  const nodes = [1, 2, 3, 4, 5];
  const runs = [[1, 5]]; // ganzer Weg gegangen
  const intervals = runsToIntervals(runs, nodes);
  // Später wird bei Knoten 3 eine Kreuzung entdeckt -> zwei Abschnitte
  assert.equal(covers(intervals, [0, 2]), true);
  assert.equal(covers(intervals, [2, 4]), true);
});

test('Runs bleiben nach Speichern/Laden stabil', () => {
  const nodes = [1, 2, 3, 4, 5, 6];
  let intervals = addInterval([], [1, 3]);
  const runs = intervalsToRuns(intervals, nodes);
  assert.deepEqual(runs, [[2, 4]]);
  assert.deepEqual(runsToIntervals(runs, nodes), [[1, 3]]);
});

test('TrailGraph trennt an Kreuzungen', () => {
  const g = new TrailGraph();
  g.addWay({ id: 1, nodes: [1, 2, 3, 4, 5], latlngs: line(5), tags: {} });
  assert.equal(g.segments(1).length, 1, 'einzelner Weg ist ein Abschnitt');

  // Zweiter Weg trifft den ersten in der Mitte (Knoten 3)
  const changed = g.addWay({ id: 2, nodes: [3, 20, 21], latlngs: line(3, 47.5), tags: {} });
  assert.deepEqual(changed.sort(), [1, 2], 'Nachbarweg wird neu zerlegt');
  const segs = g.segments(1);
  assert.equal(segs.length, 2);
  assert.deepEqual([segs[0].from, segs[0].to], [0, 2]);
  assert.deepEqual([segs[1].a, segs[1].b], [3, 5]);
  assert.equal(g.segments(2).length, 1);
});

test('TrailGraph trennt an Selbstberührungen (Schleife)', () => {
  const g = new TrailGraph();
  g.addWay({ id: 7, nodes: [1, 2, 3, 4, 2, 9], latlngs: line(6), tags: {} });
  const segs = g.segments(7);
  assert.equal(segs.length, 3);
  assert.deepEqual(segs.map((s) => [s.from, s.to]), [[0, 1], [1, 4], [4, 5]]);
});

test('Abschnitte decken den Weg lückenlos ab', () => {
  const g = new TrailGraph();
  g.addWay({ id: 1, nodes: [1, 2, 3, 4, 5, 6], latlngs: line(6), tags: {} });
  g.addWay({ id: 2, nodes: [2, 30], latlngs: line(2, 47.6), tags: {} });
  g.addWay({ id: 3, nodes: [5, 40], latlngs: line(2, 47.7), tags: {} });
  const segs = g.segments(1);
  const total = segs.reduce((s, x) => s + x.length, 0);
  assert.equal(segs.length, 3);
  assert.ok(Math.abs(total - pathLength(line(6))) < 1e-6, 'Summe = Weglänge');
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].from, segs[i - 1].to);
});

test('derselbe Weg wird nicht doppelt gezählt', () => {
  const g = new TrailGraph();
  const w = { id: 1, nodes: [1, 2, 3], latlngs: line(3), tags: {} };
  g.addWay(w);
  assert.deepEqual(g.addWay(w), []);
  assert.equal(g.nodeUse.get(2), 1);
  assert.equal(g.segments(1).length, 1);
});

test('Kachelrechnung: Punkt liegt in seiner Kachel', () => {
  const [lat, lon] = [47.4213, 11.0975];
  const x = lonToTileX(lon, TRAIL_Z);
  const y = latToTileY(lat, TRAIL_Z);
  const b = tileBounds(TRAIL_Z, x, y);
  assert.ok(lon >= b.west && lon < b.east, 'Länge innerhalb der Kachel');
  assert.ok(lat <= b.north && lat > b.south, 'Breite innerhalb der Kachel');
  assert.equal(tileKey('trails', TRAIL_Z, x, y), `trails/${TRAIL_Z}/${x}/${y}`);
});

test('Kachelrechnung: Nachbarkacheln stoßen lückenlos aneinander', () => {
  const x = lonToTileX(11.0975, TRAIL_Z);
  const y = latToTileY(47.4213, TRAIL_Z);
  const a = tileBounds(TRAIL_Z, x, y);
  const rechts = tileBounds(TRAIL_Z, x + 1, y);
  const unten = tileBounds(TRAIL_Z, x, y + 1);
  assert.ok(Math.abs(a.east - rechts.west) < 1e-9, 'kein Spalt nach rechts');
  assert.ok(Math.abs(a.south - unten.north) < 1e-9, 'kein Spalt nach unten');
});

test('Overpass-Abfrage nutzt Gleichheit statt regulärem Ausdruck', () => {
  const q = buildQuery('trails', tileBounds(TRAIL_Z, 4321, 2876));
  for (const h of TRAIL_HIGHWAYS) assert.match(q, new RegExp(`way\\["highway"="${h}"\\]`));
  assert.doesNotMatch(q, /~/, 'kein regulärer Ausdruck – der umgeht den Tag-Index');
  assert.match(q, /out body geom;/, 'Knoten-IDs und Geometrie werden gebraucht');
});

test('Kompaktformat überlebt Hin- und Rückweg verlustfrei', () => {
  const elements = [{
    type: 'way', id: 42, nodes: [1000000001, 1000000002, 1000000090],
    geometry: [{ lat: 47.421345, lon: 11.097512 }, { lat: 47.42151, lon: 11.09766 }, { lat: 47.4218, lon: 11.0981 }],
    tags: { highway: 'path', name: 'Steig', sac_scale: 'mountain_hiking', ele: '1200', source: 'egal' },
  }];
  const [w] = unpackTile('trails', packTile('trails', elements));
  assert.equal(w.id, 42);
  assert.deepEqual(w.nodes, [1000000001, 1000000002, 1000000090]);
  assert.equal(w.tags.name, 'Steig');
  assert.equal(w.tags.sac_scale, 'mountain_hiking');
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(w.latlngs[i][0] - elements[0].geometry[i].lat) < 1e-6, 'Breite genau genug');
    assert.ok(Math.abs(w.latlngs[i][1] - elements[0].geometry[i].lon) < 1e-6, 'Länge genau genug');
  }
});

test('Kompaktformat spart deutlich Platz', () => {
  const geometry = [];
  const nodes = [];
  for (let i = 0; i < 40; i++) {
    nodes.push(2000000000 + i * 7);
    geometry.push({ lat: 47.4 + i * 0.0002, lon: 11.09 + i * 0.0003 });
  }
  const elements = [{ type: 'way', id: 99, nodes, geometry,
    tags: { highway: 'path', name: 'Langer Steig', surface: 'ground', source: 'survey', 'source:date': '2023' } }];
  const roh = JSON.stringify(elements).length;
  const klein = JSON.stringify(packTile('trails', elements)).length;
  assert.ok(klein < roh * 0.45, `deutlich kleiner: ${klein} statt ${roh} Zeichen`);
});

test('Kaputte Geometrie wird aussortiert', () => {
  assert.deepEqual(packTile('trails', [{ type: 'way', id: 1, nodes: [1, 2], geometry: [{ lat: 1, lon: 2 }] }]), []);
  assert.deepEqual(packTile('trails', [{ type: 'node', id: 1 }]), []);
});

test('Gipfel werden mit Höhe übernommen', () => {
  const [p] = unpackTile('peaks', packTile('peaks', [
    { type: 'node', id: 7, lat: 47.4211, lon: 10.9853, tags: { natural: 'peak', name: 'Zugspitze', ele: '2962' } },
  ]));
  assert.equal(p.name, 'Zugspitze');
  assert.equal(p.ele, 2962);
  assert.ok(Math.abs(p.lat - 47.4211) < 1e-6);
});

test('Abbruchmeldung von Overpass wird erkannt', () => {
  assert.equal(isPartial({ remark: 'runtime error: Query timed out in "query" at line 2 after 22 seconds.' }), true);
  assert.equal(isPartial({ remark: 'runtime error: Query run out of memory' }), true);
  assert.equal(isPartial({ elements: [] }), false);
});

test('Entfernungen stimmen ungefähr', () => {
  const d = distance([47.0, 11.0], [47.01, 11.0]);
  assert.ok(Math.abs(d - 1112) < 5, `1112 m erwartet, war ${d}`);
});
