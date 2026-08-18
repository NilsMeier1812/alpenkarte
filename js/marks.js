// Verbindet Wegenetz und Speicher: markieren, entmarkieren, Zustand abfragen.

import { pathLength } from './geo.js';
import { wayLabel } from './graph.js';
import {
  addInterval,
  covers,
  intervalsLength,
  intervalsToRuns,
  removeInterval,
  runsToIntervals,
} from './runs.js';

function intervalsOf(store, way) {
  return runsToIntervals(store.runs(way.id), way.nodes);
}

/** Ist dieser Abschnitt als gegangen gespeichert? */
export function isSegmentVisited(store, way, segment) {
  return covers(intervalsOf(store, way), [segment.from, segment.to]);
}

/** Ist der komplette Weg gegangen? */
export function isWayVisited(store, way) {
  return covers(intervalsOf(store, way), [0, way.nodes.length - 1]);
}

function write(store, way, intervals) {
  const first = intervals[0];
  const center = first ? way.latlngs[Math.floor((first[0] + first[1]) / 2)] : null;
  store.setRuns(way.id, intervalsToRuns(intervals, way.nodes), {
    meters: intervalsLength(intervals, way.latlngs, pathLength),
    name: wayLabel(way.tags),
    center,
  });
}

/** Schaltet einen Abschnitt um. Rückgabe: true = jetzt gegangen. */
export function toggleSegment(store, way, segment) {
  const range = [segment.from, segment.to];
  const intervals = intervalsOf(store, way);
  const nowVisited = !covers(intervals, range);
  write(store, way, nowVisited ? addInterval(intervals, range) : removeInterval(intervals, range));
  return nowVisited;
}

/** Schaltet den kompletten OSM-Weg um. Rückgabe: true = jetzt gegangen. */
export function toggleWay(store, way) {
  const range = [0, way.nodes.length - 1];
  const nowVisited = !isWayVisited(store, way);
  write(store, way, nowVisited ? [range] : []);
  return nowVisited;
}
