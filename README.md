# NestrisHomie – Sprachassistent für nestris.org

Ein Tampermonkey-Userscript, das dich während deiner **1v1-Matches auf
[nestris.org](https://nestris.org)** per Sprachausgabe auf dem Laufenden hält:

> *„Du liegst vorn mit fünfundzwanzigtausend Punkten Vorsprung.
> Punkte: du einhundertzwanzigtausend, gegner fünfundneunzigtausend."*

Standardmäßig wird das **alle 30 Sekunden** angesagt, während ein Spiel läuft.
Zusätzlich kommen Events, wenn sich etwas Wesentliches tut.

---

## Funktionen

| Was | Wann |
| --- | --- |
| Vorsprung / Gleichstand / Rückstand (+ Differenz) | alle 30 s (Intervall frei wählbar) |
| Beide Punktestände | optional, zusammen mit der Intervallansage |
| „Du übernimmst die Führung!" / „… Führung abgegeben" | sofort beim Führungswechsel |

Die genannte **Differenz wird auf ganze Tausender gerundet**, damit die
Ansprache nicht in Einzelpunkten herumhackt: Vorsprung abwärts, Rückstand
aufwärts.

| Situation | Angesagt |
| --- | --- |
| 25 432 Punkte Vorsprung | „fünfundzwanzigtausend Punkte Vorsprung" (abgerundet) |
| 500 Punkte Vorsprung | „Du liegst knapp vorn." (keine Zahl) |
| 1 000 Punkte Vorsprung | „eintausend Punkte Vorsprung" (erst ab 1000 mit Zahl) |
| 1 Punkt Rückstand | „eintausend Punkten Rückstand" (aufgerundet) |
| 1 501 Punkte Rückstand | „zweitausend Punkten Rückstand" (aufgerundet) |

Ein Führungswechsel unter 1000 Punkten klingt entsprechend abgeschwächt:
„Du übernimmst knapp die Führung!" bzw. „Du hast die Führung knapp
abgegeben." Absolute Punktestände (die optionalen) bleiben ungerundet –
dort zählt der genaue Wert.
| Spielstart (inkl. Gegnername) | bei Statuswechsel auf `IN_GAME` |
| Spielergebnis (Sieg / Niederlage / Remis mit Endstand) | wenn ein Spiel im Match endet |
| Matchergebnis + Spielstand (z. B. „zwei zu eins") | bei `AFTER_MATCH` |
| Trophäenänderung („Plus drei Trophäen.") | kurz nach einem Ranked-Match |
| „Gegner gefunden." | nach der Warteschlange |

Nicht angesagt wird im **Zuschauermodus** – NestrisHomie erkennt über die
CSS-Klasse `.side.me`, ob du selbst spielst.

## Installation

1. [Tampermonkey](https://www.tampermonkey.net/) installieren (Chrome/Firefox/Edge).
2. Datei [`nestris-homie.user.js`](nestris-homie.user.js) öffnen
   (Rechtsklick → *Speichern unter…*) oder den Inhalt kopieren.
3. In Tampermonkey: **Neues Skript** → Inhalt ersetzen → **Strg+S**.
4. **Seite neu laden** – der WebSocket-Mitschnitt muss vor dem Seitenstart
   installiert werden (`@run-at document-start`).

Danach erscheint unten rechts eine 🎙-Schaltfläche mit dem Einstellungsdialog.

### Einstellungen

| Einstellung | Standard | Bedeutung |
| --- | --- | --- |
| Sprachassistent an | ein | Gesamtschalter |
| Intervall | 30 s | Abstand der Statusansage (10–300 s) |
| Punktestände ansagen | an | absolute Scores zusätzlich zur Differenz |
| Führungswechsel ansagen | an | sofortige Meldung bei Führungswechsel |
| Spielstart / -ende | an | Start, Spielergebnis, Matchende, Trophäen |
| Spielstand ansagen | aus | Siege-Serie in der Intervallansage |
| Sprache | Deutsch | Ansagetexte `de` / `en` |
| Stimme | Automatisch | konkrete Systemstimme |
| Tempo / Lautstärke | 1,0 / 1,0 | `SpeechSynthesisUtterance.rate/.volume` |

Alle Einstellungen liegen lokal in `localStorage` unter
`nestris-homie.settings.v1` – keine Daten verlassen den Browser.

## Architektur

```
nestris.org (Angular-SPA)
│
├─ wss://nestris.org/ws ──────────────┐  JSON-Ereignisse:
│   in_room_status, room_state_update │  Matchstatus, Spielstand,
│   found_opponent, trophy_change     │  Trophäen
│                                     ▼
│                        ┌─────────────────────────┐
│   Proxy um WebSocket   │  Statusmaschine          │
│   (@run-at             │  BEFORE_GAME / IN_GAME / │
│    document-start) ───►│  AFTER_MATCH / ABORTED   │
│                        └───────────┬─────────────┘
│                                    │ Zustandswechsel
├─ DOM ──────────────────────────┐   │
│   .side.me  /  .side.opponent  │   │
│   app-nes-panel.score-panel    ▼   ▼
│   h1 (Score), h1.diff   ┌──────────────────────┐
│                         │  Ansage-Logik        │
│                         │  • Intervall-Timer   │
│                         │  • Lead-Change-Flow  │
│                         │  • Start/End/Events  │
│                         └──────────┬───────────┘
│                                    ▼
│                        ┌──────────────────────┐
└───────────────────────►│  Sprachausgabe (TTS)  │
                         │  Warteschlange,       │
                         │  Events vor periodisch│
                         └───────────────────────┘
```

Warum **hybrid**? Die JSON-Ereignisse liefern den exakten Matchstatus, den man
aus dem DOM nur schwer sicher ableiten kann. Die Scores stecken bei den
Gegnerdaten im binären Bit-Protokoll (Opcodes `GAME_FULL_STATE` etc.), das der
Client zusätzlich aus den Placements rekonstruiert – das DOM zeigt bereits den
fertig berechneten Score inkl. Differenz an. Details: [docs/protokoll.md](docs/protokoll.md).

### Aufbau des Userscripts

```
nestris-homie.user.js
├─ 1. Einstellungen (localStorage)
├─ 2. Sprachausgabe (Warteschlange, Stimmenwahl, Chrome-Watchdog)
├─ 3. Textbausteine + deutsche Zahlwörter
├─ 4. WebSocket-Mitschnitt (Proxy + JSON-Dispatcher)
├─ 5. DOM-Zugriff (Scores, Namen, Spielstand)
├─ 6. Matchzustand (Zustandsmaschine)
├─ 7. Ansage-Logik (Intervall + Events)
└─ 8. Bedienoberfläche (Floating-Panel)
```

## Entwicklung

Ohne Abhängigkeiten, nur Node:

```bash
npm test
# = node test/zahlen.test.js && node test/userscript.test.js
```

* `test/zahlen.test.js` – Regressionstest der deutschen Zahlwörter
  (35 Fälle, u. a. „einundzwanzig" statt „einsundzwanzig").
* `test/userscript.test.js` – lädt das komplette Userscript in einer
  Node-`vm`-Umgebung mit Fake-DOM, Fake-WebSocket und Fake-Sprachausgabe und
  spielt einen kompletten Matchablauf durch (Start → Intervallansage →
  Führungswechsel → Matchende → Trophäen → Raumverlassen).

Der Test-Hilfsblock ist im Userscript mit `// @test-helpers:start / :end`
markiert und wird vom Zahlentest direkt aus der Quelle extrahiert.

### Debugging in der Browserkonsole

```js
NestrisHomie.state                  // Statusmaschine
NestrisHomie.settings               // aktuelle Einstellungen
NestrisHomie.readScores()           // Rohwerte aus dem DOM
NestrisHomie.previewAnnouncement()  // Text der nächsten Intervallansage
NestrisHomie.say('Test')            // sofort sprechen
NestrisHomie.setSettings({ intervalSec: 20 })
NestrisHomie.speechInfo()           // Sprach-Diagnose (siehe unten)
NestrisHomie.retryFailedSpeech()    // nach Klick gescheiterte Ansage wiederholen
```

### Wenn keine Sprache zu hören ist

Die Statuszeile im Panel zeigt unterhalb der Spieldaten immer eine
**Sprach-Diagnosezeile**, z. B. `Sprache: Anna (de-DE)` oder einen konkreten
Hinweis. In der Konsole liefert `NestrisHomie.speechInfo()` dieselben Daten:

| Feld | Bedeutung |
| --- | --- |
| `voiceCount` | Anzahl gefundener Systemstimmen. `0` heißt: der Browser kann gar nicht sprechen. Auf Linux prüfe `pacman -Q speech-dispatcher` (siehe Abschnitt „Sprachausgabe unter Linux"). |
| `voice` | Gewählte Stimme, z. B. `Anna (de-DE)` |
| `lastError` | Letzter Browserfehler, z. B. `not-allowed` (Autoplay-Schutz) oder `no-match` (keine passende Stimme) |
| `needsGesture` | `true`, solange der Browser die Ausgabe noch blockiert – einmal auf die Seite klicken genügt |
| `hinweis` | Klartext-Empfehlung für die aktuelle Situation |

Die häufigsten Ursachen:

1. **Autoplay-Schutz** (`needsGesture: true`): Chrome blockiert Sprache ohne
   Interaktion. Einmal klicken oder eine Taste drücken – NestrisHomie wiederholt
   die betroffene Ansage automatisch.
2. **Keine Stimmen** (`voiceCount: 0`): Das System liefert dem Browser keine
   Text-to-Speech-Stimme. Auf Linux ist das der häufigste Fall – siehe unten.
3. **Falsche Stimme/Sprache im Panel**: `no-match` – im Panel Stimme auf
   *Automatisch* stellen oder eine passende wählen.

### Sprachausgabe unter Linux

Linux-Browser haben kein eigenes Sprachmodul, sondern binden an
`speech-dispatcher` (SSIP) an. Ist das nicht installiert, ist `voiceCount: 0` –
das Skript kann daran nichts ändern, die Stimme fehlt dem Browser schlicht.

```bash
# pacman -Q speech-dispatcher || sudo pacman -S speech-dispatcher
```

Danach verhalten sich die Browser unterschiedlich:

* **Firefox** verhandelt ohne weiteres Zutun mit `speech-dispatcher` und ist
  damit der unkomplizierte Weg. Nach der Installation einmal neu starten.
* **Chromium-Browser** (Chromium, Vivaldi, Chrome, Brave) haben die Anbindung
  zwar eingebaut, halten sie aber per Command-Line-Flag versteckt. Ohne Flag
  bleibt `getVoices()` leer, auch wenn `spd-say` im Terminal läuft – ein
  bekanntes Chromium-Verhalten, siehe
  [Chromium #1057775](https://bugs.chromium.org/p/chromium/issues/detail?id=1057775).

  **Getestet (CachyOS, `espeak-ng` als Synthese):** Mit dem Flag spricht
  Chromium sauber – nur der Browserstart muss das Flag tragen:

  ```bash
  chromium --enable-speech-dispatcher
  ```

  Voraussetzung ist ein vollständiger Neustart des Browsers. Für einen
  dauerhaften Autostart einen Desktop-Eintrag im Benutzerverzeichnis anlegen
  (`~/.local/share/applications/`, überschreibt den Systemeintrag, kein
  Eingriff in `/usr` nötig) und dort `Exec=` um das Flag ergänzen:

  ```ini
  Exec=/usr/bin/chromium --enable-speech-dispatcher %U
  ```

Unabhängig vom Browser: `NestrisHomie.speechInfo()` mit `voiceCount > 0`
prüfen – das ist das Zeichen, dass der Browser überhaupt sprechen kann.

## Einschränkungen

* Die Selektoren richten sich an der aktuellen nestris.org-Oberfläche. Ändert
  sich das Frontend, sind vor allem die Konstanten `DOM_SEL` (Abschnitt 5) zu
  prüfen – Anleitung in [docs/protokoll.md](docs/protokoll.md), Abschnitt 5.
* Kein schreibender Zugriff auf das Spiel: NestrisHomie sendet keine
  WebSocket-Nachrichten und verändert den Spielverlauf nicht.
* Der Statusfallback ohne WebSocket (`guessStatusFromDom`) greift nur, wenn der
  Mitschnitt nicht aktiv ist – in dem Fall Seite neu laden.
