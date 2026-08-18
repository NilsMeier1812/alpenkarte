// Alpenkarte – Einstiegspunkt.

import { Store } from './store.js';
import { MapView } from './map-view.js';
import { Ui } from './ui.js';

const store = new Store();

let ui;
const view = new MapView(store, {
  onStatus: (state) => {
    if (state.error) console.warn('Overpass:', state.error);
    ui?.status(state);
  },
  onToggle: ({ text }) => ui?.toast(text),
});

ui = new Ui(store, view);
view.refreshData();

// Vor dem Schließen sicherheitshalber speichern.
window.addEventListener('beforeunload', () => store.save());

// Für Fehlersuche in der Browserkonsole erreichbar.
window.alpenkarte = { store, view };
