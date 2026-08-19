// Wegenetz: sammelt geladene OSM-Wege, erkennt Kreuzungen und zerlegt jeden Weg
// in Abschnitte von Kreuzung zu Kreuzung.
//
// Kreuzung = ein Knoten, der von mindestens zwei Wegen benutzt wird (oder von
// demselben Weg zweimal, z. B. bei einer Schleife). Weganfang und -ende sind
// immer Abschnittsgrenzen.

import { pathLength } from './geo.js';

export class TrailGraph {
  constructor() {
    this.ways = new Map(); // wayId -> { id, nodes, latlngs, tags }
    this.nodeUse = new Map(); // knotenId -> Anzahl Verwendungen
    this.nodeOwner = new Map(); // knotenId -> erster Weg, der ihn benutzt
    this.segmentCache = new Map(); // wayId -> Abschnitte
  }

  /**
   * Nimmt einen Weg auf. Rückgabe: Liste der Weg-IDs, deren Abschnitte sich
   * dadurch geändert haben (der neue Weg selbst plus Nachbarn, bei denen ein
   * Knoten neu zur Kreuzung geworden ist).
   */
  addWay(way) {
    if (this.ways.has(way.id)) return [];
    this.ways.set(way.id, way);
    const changed = new Set([way.id]);
    for (const node of way.nodes) {
      const count = (this.nodeUse.get(node) || 0) + 1;
      this.nodeUse.set(node, count);
      if (count === 1) {
        this.nodeOwner.set(node, way.id);
      } else if (count === 2) {
        // Aus einem Durchgangsknoten wird jetzt eine Kreuzung: der bisherige
        // Besitzer muss neu zerlegt werden.
        const owner = this.nodeOwner.get(node);
        if (owner !== undefined) changed.add(owner);
      }
    }
    for (const id of changed) this.segmentCache.delete(id);
    return [...changed];
  }

  isJunction(nodeId) {
    return (this.nodeUse.get(nodeId) || 0) > 1;
  }

  /** Indizes, an denen ein Weg getrennt wird. */
  splitIndices(way) {
    const last = way.nodes.length - 1;
    const marks = [0];
    for (let i = 1; i < last; i++) {
      if (this.isJunction(way.nodes[i])) marks.push(i);
    }
    marks.push(last);
    return marks;
  }

  /** Abschnitte eines Weges: [{ wayId, from, to, a, b, latlngs, length }] */
  segments(wayId) {
    const cached = this.segmentCache.get(wayId);
    if (cached) return cached;
    const way = this.ways.get(wayId);
    if (!way || way.nodes.length < 2) return [];

    const marks = this.splitIndices(way);
    const segments = [];
    for (let k = 0; k < marks.length - 1; k++) {
      const from = marks[k];
      const to = marks[k + 1];
      if (to <= from) continue;
      const latlngs = way.latlngs.slice(from, to + 1);
      segments.push({
        wayId,
        from,
        to,
        a: way.nodes[from],
        b: way.nodes[to],
        latlngs,
        length: pathLength(latlngs),
      });
    }
    this.segmentCache.set(wayId, segments);
    return segments;
  }

  get size() {
    return this.ways.size;
  }
}

/** Anzeigename eines Weges aus den OSM-Tags. */
export function wayLabel(tags = {}) {
  return (
    tags.name ||
    tags['name:de'] ||
    tags.ref ||
    tags.description ||
    ({
      path: 'Pfad',
      footway: 'Fußweg',
      track: 'Forstweg',
      bridleway: 'Reitweg',
      steps: 'Treppe',
      via_ferrata: 'Klettersteig',
    })[tags.highway] ||
    'Weg'
  );
}
