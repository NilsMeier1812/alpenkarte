# Alpenkarte

Eine Website, auf der du festhältst, **welche Bergwege du schon gegangen bist und welche Gipfel du bestiegen hast**.

Die Wege kommen direkt aus OpenStreetMap. Dort sind in den Alpen deutlich mehr Steige, Steigspuren und
Forstwege erfasst als bei Google Maps – inklusive Angaben zur SAC-Schwierigkeit. Ein Klick auf einen Weg
markiert genau den Abschnitt **von einer Kreuzung bis zur nächsten**.

## Bedienung

| Aktion | Wirkung |
| --- | --- |
| Klick/Tipp auf einen Weg | Wegabschnitt zwischen zwei Kreuzungen wird als gegangen markiert (orange) |
| Nochmal klicken | Markierung wieder weg |
| Rechtsklick auf einen Weg | markiert den kompletten OSM-Weg auf einmal |
| Klick-Modus „Ganzer Weg“ | dasselbe per Linksklick – praktisch am Handy |
| Klick auf ein Gipfeldreieck | Gipfel abhaken (wird orange mit Haken) |
| <kbd>Strg</kbd>+<kbd>Z</kbd> | letzte Markierung rückgängig |

Wege erscheinen ab **Zoomstufe 13**, Gipfel ab Zoomstufe 11 (bei kleinem Zoom nur die hohen, sonst wird es zu voll).
Oben laufen Kilometer, Anzahl der Abschnitte und Gipfel mit.

### Am Handy

Eine Wanderweg-Linie ist nur wenige Pixel breit – mit dem Finger ist das nicht zu treffen. Deshalb muss man
sie gar nicht genau treffen: Die Karte sucht den Weg, der dem Tipp **am nächsten** liegt (bis zu 32 px, am
Rechner 14 px). Liegen zwei Wege in Reichweite, gewinnt der nähere.

Auf reinen Touchgeräten ist der **Doppeltipp-Zoom abgeschaltet**, sonst würde er beim schnellen Markieren
mehrerer Abschnitte hintereinander dazwischenfunken. Gezoomt wird mit zwei Fingern oder über die +/−-Knöpfe.

## Starten

Es gibt keinen Build-Schritt. Der Entwicklungsserver liefert die Seite aus und bedient dieselbe Kachel-API,
die später bei Vercel läuft:

```bash
npm start
# danach http://localhost:8080 im Browser öffnen
```

## Im Netz veröffentlichen (Vercel)

Die Seite ist statisch, es gibt also nichts zu bauen. `vercel.json` stellt das schon richtig ein:
kein Build-Schritt, kein `npm install` (sonst würde Vercel die Playwright-Browser aus den Testabhängigkeiten
herunterladen), ausgeliefert wird das Repository-Verzeichnis selbst.

1. Auf [vercel.com](https://vercel.com) → *Add New… → Project* → dieses Repository importieren.
2. Alle Vorgaben so lassen (Framework *Other*, Root Directory `./`) → *Deploy*.
3. Fertig – Vercel baut bei jedem Push auf den Produktions-Branch neu.

Den Ordner `api/` erkennt Vercel von selbst und stellt ihn als Funktion bereit; Abhängigkeiten braucht sie
keine. Ohne diesen Serverteil läuft die Karte auch, fragt dann aber direkt bei Overpass an (siehe
*Woher die Wege kommen*).

Wichtig: Vercel nimmt als Produktions-Branch den **Standard-Branch des Repositories**. Der sollte auf GitHub
unter *Settings → General → Default branch* auf `main` stehen (oder in Vercel unter
*Settings → Git → Production Branch* umgestellt werden).

**Alternative GitHub Pages:** Der Workflow `.github/workflows/pages.yml` liegt weiterhin bei. Er läuft nur von
Hand (*Actions → Deploy auf GitHub Pages → Run workflow*) und braucht einmalig *Settings → Pages → Source:
„GitHub Actions“*.

## Wo liegen meine Daten?

Alles bleibt **lokal im Browser** (`localStorage`), es gibt keinen Server und kein Benutzerkonto.
Das heißt auch: andere Geräte sehen die Markierungen nicht, und wer die Browserdaten löscht, löscht sie mit.

Deshalb gibt es unter *Daten* einen **Export** als `.json` und einen **Import** (wahlweise dazumischen oder
ersetzen). Damit kommst du auch aufs Handy oder machst eine Sicherungskopie.

## Wie das Markieren funktioniert

Der interessante Teil ist, dass OSM-Wege nicht bei jeder Kreuzung enden – ein einzelner Weg kann über mehrere
Abzweigungen laufen. Die Karte baut deshalb selbst ein Wegenetz auf:

1. **Kreuzungen finden:** Ein Knoten, der von mindestens zwei geladenen Wegen benutzt wird (oder zweimal vom
   selben Weg, z. B. bei einer Schleife), ist eine Kreuzung. Weganfang und -ende zählen immer dazu.
2. **Zerlegen:** Jeder Weg wird an diesen Stellen in Abschnitte geschnitten – das sind die anklickbaren Stücke.
3. **Speichern:** Gespeichert wird *nicht* „Abschnitt Nr. 3“, sondern die Strecke als Knotenpaar
   `[Startknoten, Endknoten]`. Aufgelöst wird das erst beim Zeichnen.

Punkt 3 ist wichtig: Wird beim Weiterscrollen ein Nachbarweg nachgeladen, entsteht mitten in einem bereits
markierten Abschnitt eine neue Kreuzung. Der Abschnitt zerfällt dann in zwei – und beide bleiben korrekt als
gegangen markiert, weil die gespeicherte Strecke gegen die *aktuelle* Knotenliste aufgelöst wird.

## Woher die Wege kommen

Das ist der Punkt, an dem die erste Fassung dieser Karte gescheitert ist, deshalb ausführlicher:

**Der naheliegende Weg funktioniert nicht.** Overpass ist ein Analysedienst für gelegentliche Abfragen, keine
Karten-API – die Betreiber bitten ausdrücklich darum, ihn nicht für interaktives Kartenblättern zu benutzen.
Fragt der Browser bei jedem Verschieben selbst dort an, dann

- wartet jede einzelne Abfrage auf einen freien Slot (zwei pro IP), was in der Praxis die Ladezeit dominiert –
  eine Kachel kann eine Minute brauchen, obwohl die Rechenzeit Sekunden beträgt;
- greift irgendwann die Ratenbegrenzung, im Browser sichtbar als nichtssagendes `Failed to fetch`;
- zahlt jedes Gerät und jeder Besuch den vollen Preis erneut, weil nichts geteilt zwischengespeichert wird.

Kleinere Kacheln machen das **schlimmer**, nicht besser: mehr Abfragen heißt mehr Wartezeit in der Schlange.

**Deshalb liegt zwischen Browser und Overpass eine eigene API** (`api/tiles.js`, bei Vercel eine Funktion):

```
Browser ──► /api/tiles?kind=trails&z=13&x=…&y=… ──► Vercel-CDN ──► Overpass
             (eigene Domain, kein CORS)              (Zwischenspeicher)   (einmal pro Kachel)
```

Was das bringt:

- **Overpass wird höchstens einmal pro Kachel gefragt**, danach antwortet das CDN in Millisekunden – für alle
  Geräte und alle Besuche. Zwei Wochen frisch, danach noch 30 Tage „stale-while-revalidate“.
- **Kein fremdes Ratenlimit und kein CORS**, weil der Browser nur mit der eigenen Domain spricht.
- **Kleinere Übertragung:** Der Server wirft unnötige Tags weg und schreibt Koordinaten und Knoten-IDs als
  Differenzen in Festkomma. Das spart über die Hälfte – spürbar auf dem Handy.
- **Störungen werden an einer Stelle behandelt:** drei Overpass-Server nacheinander, Abbrüche erkannt, und ein
  Fehler landet nie im Zwischenspeicher (`no-store`), eine Teilantwort nur für zwei Minuten.

Das Kachelraster ist das übliche `z/x/y` (Wege bei z13 ≈ 3,3 × 3,3 km, Gipfel bei z10). Ganz ohne Serverteil
läuft die Karte trotzdem: Fehlt `/api/tiles` (etwa auf GitHub Pages), merkt der Lader das an der 404 und fragt
direkt bei Overpass an – mit allen oben genannten Nachteilen, aber es funktioniert.

## Wenn in einer Gegend Wege fehlen

- Offene Bereiche stehen **oben in der Statusleiste** und mit Grund und Position in der Seitenleiste unter
  *Nicht geladene Bereiche*; ein Klick auf den Eintrag springt dorthin. Eine stille Lücke soll es nicht geben.
- Die Karte versucht es selbst erneut, mit wachsender Wartezeit (3 s bis 60 s).
- Meldet Overpass einen Abbruch, werden die **Teildaten trotzdem angezeigt**; die Kachel bleibt offen und wird
  nicht abgelegt.
- *Karte → Diesen Ausschnitt neu laden* holt den sichtbaren Bereich am Zwischenspeicher vorbei frisch.

## Aufbau

```
index.html          Grundgerüst und Seitenleiste
vercel.json         Hosting-Einstellungen (kein Build, Cache-Regeln)
api/tiles.js        Kachel-API: fragt Overpass, kürzt die Antwort, lässt das CDN sie behalten
scripts/dev-server.mjs  lokaler Server: statische Dateien + dieselbe Kachel-API
css/style.css       Gestaltung
js/config.js        Einstellungen: Zoomstufen, Kartenhintergründe, Farben
js/tiles.js         Kachelrechnung im z/x/y-Raster
js/osmdata.js       Overpass-Abfrage und kompaktes Format – von Browser und Server geteilt
js/loader.js        holt Kacheln von der eigenen API (mit Rückfall auf Overpass)
js/tilecache.js     Zwischenspeicher im Browser (IndexedDB, 14 Tage)
js/graph.js         Wegenetz: Kreuzungserkennung und Zerlegung in Abschnitte
js/runs.js          Intervall-Rechnung für die gegangenen Teilstücke
js/marks.js         markieren / entmarkieren
js/store.js         Speicherung, Statistik, Rückgängig, Import/Export
js/map-view.js      Leaflet-Karte, Zeichnen der Wege und Gipfel
js/ui.js            Seitenleiste, Suche, Listen
vendor/leaflet/     Leaflet 1.9.4 (lokal, kein CDN nötig)
```

## Tests

```bash
npm test              # Logik und Kachel-API (Node): Kreuzungen, Intervalle,
                      # Kachelrechnung, Kompaktformat, Ausweichserver, Cache-Vorgaben
npm start             # in einem zweiten Terminal, dann:
npm run test:e2e      # Klicks im echten Browser
npm run test:touch    # dasselbe als Handy mit Fingertipps
npm run test:loading  # Nachladen: doppelte Anfragen, Störungen, Teildaten, Rückfallebene
npm run test:all      # alles nacheinander
```

Der Browsertest prüft die ganze Kette: Zerlegen an Kreuzungen, Markieren, Verschmelzen benachbarter Abschnitte,
Entmarkieren, Rückgängig, Gipfel abhaken, Neuladen und Export. Der Touch-Test misst zusätzlich, wie weit man
danebentippen darf, dass der nähere von zwei Wegen gewinnt und dass bei zu kleinem Zoom ein Hinweis erscheint.

## Grenzen und Stolpersteine

- **Die erste Fahrt durch eine neue Gegend ist die langsame.** Dort muss der Server noch bei Overpass fragen;
  danach liegt die Kachel im CDN und ist sofort da – auch für jedes andere Gerät.
- **Kreuzungen entstehen nur aus geladenen Wegen.** Am Rand des geladenen Bereichs kann ein Abschnitt daher
  länger sein als er sein müsste. Sobald der Nachbarbereich nachgeladen ist, stimmt die Zerlegung – die
  Markierungen bleiben dabei erhalten (siehe oben).
- **Wird ein Weg in OpenStreetMap neu aufgeteilt**, ändert sich seine ID und die Markierung dieses Weges geht
  verloren. Das passiert selten, ist aber nicht zu verhindern.
- Geladen werden Wege mit `highway=path|footway|track|bridleway|steps|via_ferrata` – auch als privat getaggte,
  weil in den Alpen viele Forst- und Almwege so erfasst sind. Anpassen lässt sich das in `js/config.js`.

## Datenquellen

Kartendaten © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende (ODbL) ·
Kartenbilder: [OpenTopoMap](https://opentopomap.org) (CC-BY-SA), CyclOSM, Esri ·
Routen-Overlay: [Waymarked Trails](https://hiking.waymarkedtrails.org) ·
Ortssuche: [Nominatim](https://nominatim.openstreetmap.org) ·
Karte: [Leaflet](https://leafletjs.com) (BSD-2-Clause)
