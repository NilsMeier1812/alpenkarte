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

Es gibt keinen Build-Schritt – die Seite ist reines HTML, CSS und JavaScript. Weil ES-Module verwendet werden,
muss sie über einen Webserver laufen (Doppelklick auf `index.html` reicht nicht):

```bash
python3 -m http.server 8080   # oder: npm start
# danach http://localhost:8080 im Browser öffnen
```

## Im Netz veröffentlichen (Vercel)

Die Seite ist statisch, es gibt also nichts zu bauen. `vercel.json` stellt das schon richtig ein:
kein Build-Schritt, kein `npm install` (sonst würde Vercel die Playwright-Browser aus den Testabhängigkeiten
herunterladen), ausgeliefert wird das Repository-Verzeichnis selbst.

1. Auf [vercel.com](https://vercel.com) → *Add New… → Project* → dieses Repository importieren.
2. Alle Vorgaben so lassen (Framework *Other*, Root Directory `./`) → *Deploy*.
3. Fertig – Vercel baut bei jedem Push auf den Produktions-Branch neu.

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

## Aufbau

```
index.html          Grundgerüst und Seitenleiste
vercel.json         Hosting-Einstellungen (kein Build, Cache-Regeln)
css/style.css       Gestaltung
js/config.js        Einstellungen: Server, Zoomstufen, Kachelgrößen, Kartenhintergründe
js/overpass.js      lädt Wege und Gipfel kachelweise nach (Warteschlange, Ausweichserver)
js/tilecache.js     Zwischenspeicher (IndexedDB, 14 Tage) – schont die Overpass-Server
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
npm test              # Logik: Kreuzungserkennung, Intervalle, Längen (Node)
npm run start         # in einem zweiten Terminal, dann:
npm run test:e2e      # Klicks im echten Browser, mit erfundenen Overpass-Antworten
npm run test:touch    # dasselbe als Handy mit Fingertipps
npm run test:loading  # Nachladen: doppelte Abfragen, Wiederholung nach Störungen
npm run test:all      # alles nacheinander
```

Der Browsertest prüft die ganze Kette: Zerlegen an Kreuzungen, Markieren, Verschmelzen benachbarter Abschnitte,
Entmarkieren, Rückgängig, Gipfel abhaken, Neuladen und Export. Der Touch-Test misst zusätzlich, wie weit man
danebentippen darf, dass der nähere von zwei Wegen gewinnt und dass bei zu kleinem Zoom ein Hinweis erscheint.

## Wenn in einer Gegend Wege fehlen

Die Wege werden blockweise geladen (0,04°, rund 4,5 × 3 km). Die Blockgröße ist der wunde Punkt: Ist ein Block
zu groß, schafft Overpass die Abfrage nicht im Zeitbudget – und liefert dann **HTTP 200 mit einem `remark` und
nur den bis dahin gefundenen Wegen**. Genau so entsteht das Bild „hier sind kaum Wege drin“.

Dagegen laufen mehrere Vorkehrungen:

- **Teildaten werden angezeigt**, nicht weggeworfen. Der Block gilt aber nicht als geladen.
- Ein abgebrochener Block wird **selbsttätig geviertelt** und in kleineren Stücken neu geholt, bis zu drei Mal
  (bis rund 550 m Kantenlänge).
- Abgelehnte Abfragen (429/504, Netzfehler) werden mit wachsender Wartezeit (2 s bis 60 s) erneut versucht,
  jeweils über einen anderen Overpass-Server.
- Nichts davon landet im Zwischenspeicher – sonst bliebe die Gegend 14 Tage leer.
- Bleibt etwas offen, steht das **oben in der Statusleiste** und mit Grund, Server und Position in der
  Seitenleiste unter *Nicht geladene Bereiche*. Ein Klick auf den Eintrag springt dorthin.
- *Karte → Diesen Ausschnitt neu laden* holt den sichtbaren Bereich am Zwischenspeicher vorbei frisch vom Server.

Kacheln werden **von der Bildschirmmitte nach außen** angefordert, damit dort zuerst etwas erscheint.

## Grenzen und Stolpersteine

- **Overpass ist ein freier Dienst.** Bei sehr schnellem Herumscrollen kann eine Abfrage abgelehnt werden; die
  Karte wartet dann und versucht es bei einem anderen Server erneut.
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
