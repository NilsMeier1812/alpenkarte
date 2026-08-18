// Verwaltung der gegangenen Teilstücke eines OSM-Weges.
//
// Gespeichert wird pro Weg eine Liste von "Runs": [startKnotenId, endKnotenId].
// Erst beim Zeichnen werden diese Knoten-IDs gegen die aktuelle Knotenliste des
// Weges aufgelöst. Dadurch bleibt eine Markierung auch dann korrekt, wenn der
// Weg später feiner in Abschnitte zerlegt wird, weil eine weitere Kreuzung
// dazugeladen wurde.
//
// Intervalle sind Indexpaare [i, j] mit i < j und stehen für die Teilstrecke
// von Knoten i bis Knoten j (also die Kanten i … j-1).

/** Sucht ein passendes Indexpaar für zwei Knoten-IDs in der Knotenliste. */
export function locate(nodes, a, b) {
  const ai = nodes.indexOf(a);
  if (ai < 0) return null;
  let bi = nodes.indexOf(b, ai + 1);
  if (bi < 0) bi = nodes.indexOf(b);
  if (bi < 0 || bi === ai) return null;
  return ai < bi ? [ai, bi] : [bi, ai];
}

/** Runs → normalisierte, disjunkte Intervalle (aufsteigend sortiert). */
export function runsToIntervals(runs, nodes) {
  const out = [];
  for (const run of runs || []) {
    const iv = locate(nodes, run[0], run[1]);
    if (iv) out.push(iv);
  }
  return normalize(out);
}

/** Intervalle → Runs (Knoten-IDs) für die dauerhafte Speicherung. */
export function intervalsToRuns(intervals, nodes) {
  return intervals.map(([a, b]) => [nodes[a], nodes[b]]);
}

/** Sortiert, verschmilzt überlappende und aneinandergrenzende Intervalle. */
export function normalize(intervals) {
  const sorted = intervals
    .filter((iv) => iv && iv[0] !== iv[1])
    .map((iv) => (iv[0] < iv[1] ? [iv[0], iv[1]] : [iv[1], iv[0]]))
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

export function addInterval(intervals, iv) {
  return normalize([...intervals, iv]);
}

export function removeInterval(intervals, [from, to]) {
  const out = [];
  for (const [a, b] of intervals) {
    if (b <= from || a >= to) {
      out.push([a, b]); // gar keine Überschneidung
      continue;
    }
    if (a < from) out.push([a, from]);
    if (b > to) out.push([to, b]);
  }
  return normalize(out);
}

/** Ist die Teilstrecke [from, to] vollständig als gegangen gespeichert? */
export function covers(intervals, [from, to]) {
  return intervals.some(([a, b]) => a <= from && b >= to);
}

/** Summe der Streckenlänge aller Intervalle in Metern. */
export function intervalsLength(intervals, latlngs, pathLength) {
  let sum = 0;
  for (const [a, b] of intervals) {
    if (a >= 0 && b < latlngs.length) sum += pathLength(latlngs, a, b);
  }
  return sum;
}
