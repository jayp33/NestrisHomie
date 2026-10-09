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
```

## Hinweise zur Sprachausgabe

* **Browser-Sprache / Sprachpaket**: Für deutsche Ansagen braucht der Browser
  eine deutsche Stimme (macOS/Windows i. d. R. vorhanden; unter Linux
  `speech-dispatcher` + Sprachpaket, Firefox nutzt die Systemstimmen).
* **Erste Ansage**: Chrome kann Sprachausgabe ohne Nutzerinteraktion blockieren.
  NestrisHomie spricht deshalb nach der ersten Klick-/Tastaturinteraktion eine
  stumme Testansage („Freischalten").
* **Kein Ton?** Prüfen, ob im Panel die richtige *Sprache* und *Stimme* gewählt
  ist und die Systemlautstärke stimmt; mit **Ansage testen** direkt testen.

## Einschränkungen

* Die Selektoren richten sich an der aktuellen nestris.org-Oberfläche. Ändert
  sich das Frontend, sind vor allem die Konstanten `DOM_SEL` (Abschnitt 5) zu
  prüfen – Anleitung in [docs/protokoll.md](docs/protokoll.md), Abschnitt 5.
* Kein schreibender Zugriff auf das Spiel: NestrisHomie sendet keine
  WebSocket-Nachrichten und verändert den Spielverlauf nicht.
* Der Statusfallback ohne WebSocket (`guessStatusFromDom`) greift nur, wenn der
  Mitschnitt nicht aktiv ist – in dem Fall Seite neu laden.
