// Kachelrechnung im üblichen Karten-Raster (Web Mercator, z/x/y).
//
// Vorher lag ein eigenes Gradraster zugrunde. Das Standardraster hat zwei
// Vorteile: die Kacheln sind überall etwa gleich groß (das Gradraster wird zu
// den Polen hin schmal), und sie decken sich mit der Kachelung der Karte.

/** Zoomstufen, in denen die Daten abgelegt und zwischengespeichert werden. */
export const TRAIL_Z = 13; // ~3,3 km Kantenlänge in den Alpen
export const PEAK_Z = 10; // ~27 km

export function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

export function latToTileY(lat, z) {
  const rad = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
}

function tileYToLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Geografische Grenzen einer Kachel: { south, west, north, east } */
export function tileBounds(z, x, y) {
  return {
    west: (x / 2 ** z) * 360 - 180,
    east: ((x + 1) / 2 ** z) * 360 - 180,
    north: tileYToLat(y, z),
    south: tileYToLat(y + 1, z),
  };
}

/** Alle Kacheln, die einen Kartenausschnitt abdecken – Mitte zuerst. */
export function tilesForBounds(bounds, z, limit = Infinity) {
  const x0 = lonToTileX(bounds.getWest(), z);
  const x1 = lonToTileX(bounds.getEast(), z);
  const y0 = latToTileY(bounds.getNorth(), z);
  const y1 = latToTileY(bounds.getSouth(), z);
  const center = bounds.getCenter();
  const cx = ((center.lng + 180) / 360) * 2 ** z;
  const cy = latToTileY(center.lat, z) + 0.5;

  const tiles = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      tiles.push({ z, x, y, weite: Math.hypot(x + 0.5 - cx, y + 0.5 - cy) });
    }
  }
  return tiles.sort((a, b) => a.weite - b.weite).slice(0, limit);
}

export function tileKey(kind, z, x, y) {
  return `${kind}/${z}/${x}/${y}`;
}
