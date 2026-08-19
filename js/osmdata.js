// Gemeinsame Sprache von Server und Browser: die Overpass-Abfrage und ein
// kompaktes Format für die Antwort.
//
// Die rohe Overpass-Antwort ist sehr geschwätzig – jede Koordinate als
// {"lat":47.4213456,"lon":11.0975123}, dazu Knoten-IDs mit zehn Stellen und
// Dutzende Tags, die die Karte nie anschaut. Hier wird daraus ein Format mit
// Differenzwerten in Festkomma; das spart in dichten Gegenden gut 70 % und
// entlastet vor allem das Handy beim Auspacken.

export const TRAIL_HIGHWAYS = ['path', 'footway', 'track', 'bridleway', 'steps', 'via_ferrata'];

const SCALE = 1e6; // Koordinaten in Millionstel Grad (~0,1 m)

/**
 * Abfrage für eine Kachel. Bewusst mit einzelnen Gleichheitsabfragen statt
 * eines regulären Ausdrucks: darauf kann Overpass seinen Tag-Index nutzen.
 * Wege, die über den Rand hinausragen, liefert Overpass vollständig – deshalb
 * ist kein Überstand nötig.
 */
export function buildQuery(kind, bounds, timeout = 60) {
  const box = [bounds.south, bounds.west, bounds.north, bounds.east]
    .map((v) => v.toFixed(6))
    .join(',');
  if (kind === 'peaks') {
    return `[out:json][timeout:${timeout}];\n(node["natural"="peak"](${box});node["natural"="volcano"](${box}););\nout body;`;
  }
  const teile = TRAIL_HIGHWAYS.map((h) => `way["highway"="${h}"](${box});`).join('');
  return `[out:json][timeout:${timeout}];\n(${teile});\nout body geom;`;
}

/** Nur die Tags behalten, welche die Karte wirklich anzeigt. */
function slimTags(tags = {}) {
  const out = {};
  if (tags.highway) out.h = tags.highway;
  const name = tags.name || tags['name:de'];
  if (name) out.n = name;
  if (tags.sac_scale) out.s = tags.sac_scale;
  if (tags.trail_visibility) out.v = tags.trail_visibility;
  if (tags.surface) out.u = tags.surface;
  if (tags.ref) out.r = tags.ref;
  return out;
}

const fatTags = (t = {}) => ({
  highway: t.h,
  name: t.n,
  sac_scale: t.s,
  trail_visibility: t.v,
  surface: t.u,
  ref: t.r,
});

/** Overpass-Elemente → kompaktes Kachelformat. */
export function packTile(kind, elements) {
  if (kind === 'peaks') {
    const peaks = [];
    for (const el of elements) {
      if (el.type !== 'node' || el.lat === undefined) continue;
      const ele = parseFloat(String(el.tags?.ele ?? '').replace(',', '.'));
      peaks.push({
        i: el.id,
        la: Math.round(el.lat * SCALE),
        lo: Math.round(el.lon * SCALE),
        e: Number.isFinite(ele) ? Math.round(ele) : null,
        n: el.tags?.name || el.tags?.['name:de'] || '',
      });
    }
    return peaks;
  }

  const ways = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.nodes || !el.geometry) continue;
    if (el.nodes.length !== el.geometry.length || el.nodes.length < 2) continue;
    if (el.geometry.some((p) => !p)) continue; // unvollständige Geometrie

    const nodes = [el.nodes[0]];
    for (let i = 1; i < el.nodes.length; i++) nodes.push(el.nodes[i] - el.nodes[i - 1]);

    let lat = Math.round(el.geometry[0].lat * SCALE);
    let lon = Math.round(el.geometry[0].lon * SCALE);
    const geom = [lat, lon];
    for (let i = 1; i < el.geometry.length; i++) {
      const la = Math.round(el.geometry[i].lat * SCALE);
      const lo = Math.round(el.geometry[i].lon * SCALE);
      geom.push(la - lat, lo - lon);
      lat = la;
      lon = lo;
    }
    ways.push({ i: el.id, n: nodes, g: geom, t: slimTags(el.tags) });
  }
  return ways;
}

/** Kompaktes Kachelformat → das, womit Wegenetz und Karte arbeiten. */
export function unpackTile(kind, items) {
  if (kind === 'peaks') {
    return items.map((p) => ({
      id: p.i,
      name: p.n || 'Gipfel',
      ele: p.e ?? null,
      lat: p.la / SCALE,
      lon: p.lo / SCALE,
    }));
  }

  return items.map((w) => {
    const nodes = [w.n[0]];
    for (let i = 1; i < w.n.length; i++) nodes.push(nodes[i - 1] + w.n[i]);

    let lat = w.g[0];
    let lon = w.g[1];
    const latlngs = [[lat / SCALE, lon / SCALE]];
    for (let i = 2; i < w.g.length; i += 2) {
      lat += w.g[i];
      lon += w.g[i + 1];
      latlngs.push([lat / SCALE, lon / SCALE]);
    }
    return { id: w.i, nodes, latlngs, tags: fatTags(w.t) };
  });
}

/**
 * Meldet Overpass eine Zeit- oder Speichergrenze? Dann kommen HTTP 200, ein
 * "remark" und nur die bis dahin gefundenen Daten.
 */
export function isPartial(json) {
  return Boolean(json?.remark && /error|timed? out|exceeded|memory/i.test(json.remark));
}
