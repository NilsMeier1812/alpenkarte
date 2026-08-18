// Kleine Geo-Helfer ohne Abhängigkeiten (auch außerhalb des Browsers nutzbar).

const R = 6371008.8; // mittlerer Erdradius in Metern
const rad = (d) => (d * Math.PI) / 180;

/** Entfernung zweier [lat, lon]-Punkte in Metern (Haversine). */
export function distance(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const lat1 = rad(a[0]);
  const lat2 = rad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Länge eines Linienzugs [[lat, lon], ...] in Metern. */
export function pathLength(points, from = 0, to = points.length - 1) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += distance(points[i], points[i + 1]);
  return sum;
}

export function formatKm(meters) {
  const km = meters / 1000;
  const digits = km >= 100 ? 0 : 1;
  return km.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatLength(meters) {
  if (meters < 950) return `${Math.round(meters / 10) * 10} m`;
  return `${formatKm(meters)} km`;
}
