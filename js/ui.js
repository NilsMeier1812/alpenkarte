// Seitenleiste: Statistik, Listen, Suche, Datenverwaltung.

import { BASEMAPS, PEAK_TILE, TRAIL_TILE, TRAIL_ZOOM_MIN } from './config.js';
import { formatKm } from './geo.js';
import { escapeHtml } from './html.js';

const $ = (sel) => document.querySelector(sel);

export class Ui {
  constructor(store, view) {
    this.store = store;
    this.view = view;
    this.toastTimer = null;
    // Auf breiten Bildschirmen ist die Seitenleiste gleich offen.
    if (window.innerWidth >= 900) document.body.classList.add('panel-open');
    this.#buildBasemaps();
    this.#bind();
    this.store.onChange(() => this.refresh());
    this.refresh();
  }

  #buildBasemaps() {
    const select = $('#basemap-select');
    select.innerHTML = BASEMAPS.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
    select.value = this.view.currentBase;
  }

  #bind() {
    $('#panel-toggle').addEventListener('click', () => {
      document.body.classList.toggle('panel-open');
      setTimeout(() => this.view.map.invalidateSize(), 250);
    });

    $('#mode-switch').addEventListener('click', (ev) => {
      const button = ev.target.closest('.seg');
      if (!button) return;
      for (const el of $('#mode-switch').children) el.classList.toggle('active', el === button);
      this.view.setMode(button.dataset.mode);
    });

    $('#basemap-select').addEventListener('change', (ev) => this.view.setBasemap(ev.target.value));
    $('#routes-overlay').addEventListener('change', (ev) => this.view.setRoutesOverlay(ev.target.checked));
    $('#show-unvisited').addEventListener('change', (ev) => this.view.setShowUnvisited(ev.target.checked));
    $('#auto-load').addEventListener('change', (ev) => this.view.setAutoLoad(ev.target.checked));

    $('#undo-btn').addEventListener('click', () => this.undo());
    document.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !/input|textarea/i.test(ev.target.tagName)) {
        ev.preventDefault();
        this.undo();
      }
    });

    $('#search-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      this.search($('#search-input').value.trim());
    });

    $('#reload-area').addEventListener('click', async () => {
      const count = await this.view.reloadArea();
      this.toast(`${count} Bereich${count === 1 ? '' : 'e'} werden frisch geladen`);
    });

    $('#export-btn').addEventListener('click', () => this.exportData());
    $('#import-btn').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', (ev) => this.importData(ev.target.files[0]));
    $('#reset-btn').addEventListener('click', () => this.reset());

    $('#peak-list').addEventListener('click', (ev) => this.#listClick(ev));
    $('#way-list').addEventListener('click', (ev) => this.#listClick(ev));
    $('#issue-list').addEventListener('click', (ev) => this.#listClick(ev));
  }

  #listClick(ev) {
    const item = ev.target.closest('[data-lat]');
    if (!item) return;
    this.view.flyTo(parseFloat(item.dataset.lat), parseFloat(item.dataset.lon), 15);
    if (window.innerWidth < 900) document.body.classList.remove('panel-open');
  }

  undo() {
    if (!this.store.canUndo) return;
    this.store.undo();
    this.toast('Letzte Markierung rückgängig gemacht');
  }

  // — Anzeige aktualisieren ————————————————————————————

  refresh() {
    const stats = this.store.stats();
    $('#stat-km').textContent = formatKm(stats.meters);
    $('#stat-seg').textContent = String(stats.ways);
    $('#stat-peaks').textContent = String(stats.peaks);
    $('#undo-btn').disabled = !this.store.canUndo;

    const peaks = this.store.peakList();
    $('#peak-count').textContent = String(peaks.length);
    $('#peak-list').innerHTML = peaks.length
      ? peaks
          .map(
            (p) => `<li data-lat="${p.la}" data-lon="${p.lo}">
              <span class="li-main">${escapeHtml(p.n)}</span>
              <span class="li-side">${p.e ? `${p.e} m` : ''}</span>
            </li>`,
          )
          .join('')
      : '<li class="empty">Noch keine Gipfel abgehakt.</li>';

    const ways = this.store.wayList();
    $('#way-count').textContent = String(ways.length);
    $('#way-list').innerHTML = ways.length
      ? ways
          .slice(0, 100)
          .map(
            (w) => `<li${w.c ? ` data-lat="${w.c[0]}" data-lon="${w.c[1]}"` : ''}>
              <span class="li-main">${escapeHtml(w.n || 'Weg')}</span>
              <span class="li-side">${formatKm(w.m || 0)} km</span>
            </li>`,
          )
          .join('')
      : '<li class="empty">Noch keine Wege markiert. Zoom auf die Berge und klick einen Weg an.</li>';
  }

  status({ zoom, pending, failed, failures = [], needZoom, autoLoad }) {
    this.#showIssues(failures);
    const el = $('#status');
    let text = '';
    let warn = false;
    let retry = false;

    if (needZoom) {
      text = `Noch ${TRAIL_ZOOM_MIN - zoom}× hineinzoomen, dann kannst du Wege markieren`;
      warn = true;
    } else if (failed > 0) {
      // Lieber ein sichtbarer Hinweis als eine stille Lücke in der Karte.
      const grund = failures[0]?.message || '';
      text = `${failed} Bereich${failed === 1 ? '' : 'e'} nicht geladen${grund ? `: ${grund}` : ''}`;
      warn = true;
      retry = true;
    } else if (pending > 0) {
      text = `Lade Wege und Gipfel … (${pending})`;
    } else if (!autoLoad) {
      text = 'Nachladen ist pausiert';
    }

    el.textContent = text;
    if (retry) {
      const button = document.createElement('button');
      button.className = 'status-btn';
      button.textContent = 'Jetzt nochmal';
      button.addEventListener('click', () => {
        this.view.reloadFailed();
        this.toast('Fehlende Bereiche werden neu geladen');
      });
      el.append(' ', button);
    }
    el.classList.toggle('warn', warn);
    el.hidden = !text;
  }

  /** Liste der gescheiterten Bereiche in der Seitenleiste. */
  #showIssues(failures) {
    const card = $('#issues-card');
    const list = $('#issue-list');
    card.hidden = failures.length === 0;
    if (!failures.length) {
      list.innerHTML = '';
      return;
    }
    list.innerHTML = failures
      .map((f) => {
        const [art, stufe, x, y] = f.key.split('/');
        // Aus der Kachel die Mitte in Koordinaten – damit man weiß, wo es klemmt.
        const size = (art === 'peaks' ? PEAK_TILE : TRAIL_TILE) / 2 ** Number(stufe);
        const lat = (Number(y) + 0.5) * size;
        const lon = (Number(x) + 0.5) * size;
        const ort = `${lat.toFixed(3).replace('.', ',')} / ${lon.toFixed(3).replace('.', ',')}`;
        return `<li class="issue" data-lat="${lat}" data-lon="${lon}" title="Dorthin springen">
          <span class="li-main">${art === 'peaks' ? 'Gipfel' : 'Wege'} bei ${ort}</span>
          <span class="li-sub">${escapeHtml(f.message || 'unbekannter Fehler')}${f.endpoint ? ` · ${escapeHtml(f.endpoint)}` : ''} · ${f.tries} Versuch${f.tries === 1 ? '' : 'e'}${f.aufgegeben ? ', aufgegeben' : ''}</span>
        </li>`;
      })
      .join('');
  }

  toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 2600);
  }

  // — Suche ——————————————————————————————————————————

  async search(query) {
    const list = $('#search-results');
    if (!query) {
      list.innerHTML = '';
      return;
    }
    list.innerHTML = '<li class="empty">Suche …</li>';
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=de&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Suche antwortete mit ${res.status}`);
      const results = await res.json();
      if (!results.length) {
        list.innerHTML = '<li class="empty">Nichts gefunden.</li>';
        return;
      }
      list.innerHTML = results
        .map(
          (r) => `<li data-lat="${r.lat}" data-lon="${r.lon}" data-bbox="${(r.boundingbox || []).join(',')}">
            <span class="li-main">${escapeHtml(r.display_name.split(',')[0])}</span>
            <span class="li-sub">${escapeHtml(r.display_name.split(',').slice(1, 3).join(',').trim())}</span>
          </li>`,
        )
        .join('');
      list.onclick = (ev) => {
        const item = ev.target.closest('[data-lat]');
        if (!item) return;
        const box = item.dataset.bbox.split(',').map(Number);
        if (box.length === 4 && box.every(Number.isFinite)) {
          this.view.fitBounds([[box[0], box[2]], [box[1], box[3]]]);
        } else {
          this.view.flyTo(parseFloat(item.dataset.lat), parseFloat(item.dataset.lon), 14);
        }
        if (window.innerWidth < 900) document.body.classList.remove('panel-open');
      };
    } catch (err) {
      list.innerHTML = `<li class="empty">Suche fehlgeschlagen: ${escapeHtml(err.message)}</li>`;
    }
  }

  // — Daten ——————————————————————————————————————————

  exportData() {
    this.store.save();
    const blob = new Blob([this.store.export()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `alpenkarte-${date}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.toast('Sicherung heruntergeladen');
  }

  async importData(file) {
    $('#import-file').value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const merge = confirm(
        'Vorhandene Markierungen behalten und die Datei dazumischen?\n\nOK = dazumischen, Abbrechen = alles ersetzen',
      );
      const result = this.store.import(text, merge ? 'merge' : 'replace');
      this.toast(`Import: ${result.ways >= 0 ? '+' : ''}${result.ways} Wege, ${result.peaks >= 0 ? '+' : ''}${result.peaks} Gipfel`);
    } catch (err) {
      alert(`Import fehlgeschlagen: ${err.message}`);
    }
  }

  reset() {
    if (!confirm('Wirklich alle Markierungen löschen? Das lässt sich nicht rückgängig machen.')) return;
    this.store.clear();
    this.toast('Alle Markierungen gelöscht');
  }
}
