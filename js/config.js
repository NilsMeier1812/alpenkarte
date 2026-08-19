// Zentrale Einstellungen der Alpenkarte.

export const STORAGE_KEY = 'alpenkarte.v1';
export const VIEW_KEY = 'alpenkarte.view';

// Die Kachelrechnung steht in js/tiles.js, die Overpass-Abfrage und das
// kompakte Übertragungsformat in js/osmdata.js. Beides teilen sich der Browser
// und die Serverfunktion api/tiles.js.

// Ab diesen Zoomstufen werden Daten geladen.
export const TRAIL_ZOOM_MIN = 13;
export const PEAK_ZOOM_MIN = 11;

// So viele Kacheln werden pro Ansicht höchstens angefordert – die der
// Bildschirmmitte am nächsten liegenden zuerst, damit dort sofort etwas
// erscheint. Der Rest kommt beim Weiterschieben.
export const MAX_TILES_PER_VIEW = 48;

export const COLORS = {
  visited: '#e8590c',
  unvisited: '#2f6fb8',
  hover: '#111827',
};

export const START_VIEW = { center: [47.4213, 11.0975], zoom: 14 };

export const BASEMAPS = [
  {
    id: 'opentopo',
    name: 'OpenTopoMap (Wandern)',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    options: {
      maxZoom: 17,
      subdomains: 'abc',
      attribution:
        'Karte: © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA) · Daten: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende',
    },
  },
  {
    id: 'osm',
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende',
    },
  },
  {
    id: 'cyclosm',
    name: 'CyclOSM (Gelände)',
    url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    options: {
      maxZoom: 18,
      subdomains: 'abc',
      attribution: 'CyclOSM · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende',
    },
  },
  {
    id: 'esri',
    name: 'Luftbild',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: {
      maxZoom: 18,
      attribution: 'Luftbild: Esri, Maxar, Earthstar Geographics',
    },
  },
];

export const ROUTES_OVERLAY = {
  url: 'https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png',
  options: {
    maxZoom: 18,
    opacity: 0.85,
    attribution: '<a href="https://hiking.waymarkedtrails.org">Waymarked Trails</a> (CC-BY-SA)',
  },
};
