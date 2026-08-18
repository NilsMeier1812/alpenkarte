import test from 'node:test';
import assert from 'node:assert/strict';
import { locate, normalize, addInterval, removeInterval, covers, runsToIntervals, intervalsToRuns } from '../js/runs.js';
import { TrailGraph, wayFromOverpass, wayLabel } from '../js/graph.js';
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

test('wayFromOverpass prüft die Daten', () => {
  assert.equal(wayFromOverpass({ type: 'node', id: 1 }), null);
  assert.equal(wayFromOverpass({ type: 'way', id: 1, nodes: [1, 2], geometry: [{ lat: 1, lon: 2 }] }), null);
  const w = wayFromOverpass({ type: 'way', id: 5, nodes: [1, 2], geometry: [{ lat: 47, lon: 11 }, { lat: 47.1, lon: 11 }], tags: { name: 'Steig' } });
  assert.deepEqual(w.latlngs, [[47, 11], [47.1, 11]]);
  assert.equal(wayLabel(w.tags), 'Steig');
  assert.equal(wayLabel({ highway: 'track' }), 'Forstweg');
});

test('Entfernungen stimmen ungefähr', () => {
  const d = distance([47.0, 11.0], [47.01, 11.0]);
  assert.ok(Math.abs(d - 1112) < 5, `1112 m erwartet, war ${d}`);
});
