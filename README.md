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
| „Der Gegner ist raus!" (Sieg sofort oder Chasedown mit Lücke) | wenn die Gegneranzeige einfriert, während du spielst |
| Natürliche Stimme über einen lokalen TTS-Server (Supertonic) | optional, Auto-Erkennung; ohne Server übernimmt die Browser-Stimme |

Die genannte **Differenz wird auf ganze Tausender gerundet**, damit die
Ansprache nicht in Einzelpunkten herumhackt: Vorsprung abwärts, Rückstand
aufwärts.

| Situation | Angesagt |
| --- | --- |
| 25 432 Punkte Vorsprung | „fünfundzwanzigtausend Punkte Vorsprung" (abgerundet) |
| 999 Punkte Vorsprung | „Du liegst knapp vorn." (keine Zahl) |
| 1 000 Punkte Vorsprung | „eintausend Punkte Vorsprung" (erst ab 1000 mit Zahl) |
| 1 Punkt Rückstand | „eintausend Punkten Rückstand" (aufgerundet) |
| 1 000 Punkte Rückstand | „eintausend Punkten Rückstand" |
| 1 001 Punkte Rückstand | „zweitausend Punkten Rückstand" (aufgerundet) |

Beide Seiten runden auf den nächsten Tausender, nur in entgegengesetzter
Richtung – Vorsprung abwärts, Rückstand aufwärts. Dadurch liegt die Stufe
beim Rückstand eine Einheit früher:

| Differenz | Vorsprung | Rückstand |
| --- | --- | --- |
| 1 … 999 | „knapp" | 1 000 |
| 1 000 | 1 000 | 1 000 |
| 1 001 … 1 999 | 1 000 | 2 000 |
| 2 000 | 2 000 | 2 000 |

Vorsprung wird nie überzeichnet (1 999 heißt noch „eintausend"), Rückstand
nie beschönigt (1 001 heißt schon „zweitausend").

Ein Führungswechsel unter 1000 Punkten klingt entsprechend abgeschwächt:
„Du übernimmst knapp die Führung!" bzw. „Du hast die Führung knapp
abgegeben." Absolute Punktestände (die optionalen) bleiben ungerundet –
dort zählt der genaue Wert.

### Chasedown / früher Sieg

nestris.org zeigt Victory/Defeat erst, wenn **beide** Spieler raus sind –
ein Topout des Gegners wird vorher nirgends gemeldet (siehe
`docs/protokoll.md`). NestrisHomie erkennt es deshalb selbst: Solange ein
Spieler noch spielt, ändern sich seine Anzeigedaten ständig (Board-Minos,
Next Piece, Drought-Counter, Score, Lines). Nach dem Topout friert die
ganze Gegnerseite ein, während deine weiterläuft. Das ist der Moment, in
dem die Assistentin „Der Gegner ist raus!" ruft:

| Situation | Angesagt |
| --- | --- |
| Du führst | „Der Gegner ist raus! Du gewinnst das Spiel." (Sieg ist dann sicher) |
| Du liegst zurück | „Der Gegner ist raus! Du musst noch … Punkte aufholen." (Lücke aufgerundet) |
| Gleichstand | „Der Gegner ist raus! Gleichstand, du musst ihn noch überholen." |

Danach liefern die Intervallansagen das Präfix „Gegner ist raus." mit, und
sobald du im Chasedown die Führung übernimmst, wird der Sieg bestätigt.

Details und Hürden der Erkennung:

* Grundlage sind nur **schnelle Signale** (Board-Pixel, Next Piece,
  Drought-Counter) – reine Score-/Lines-Stillstände reichen nicht, denn bei
  einer Dürre ändern die sich legitimerweise langsam.
* Ein **Start-Grace** (6–15 s, je nach Schwelle) überspringt den
  Spielstart-Countdown; früher kann niemand topouten.
* Ist die eigene Seite ebenfalls eingefroren (ich bin selbst tot), wird
  nichts gemeldet – dann entscheidet das normale Spielende.
* „LEFT ROOM" (Gegner hat den Raum verlassen) wird nicht als Topout gewertet.
* Die Schwelle „Topout erkennen nach" (Standard 5 Sek.) lässt sich bei
  wackligen Verbindungen erhöhen.

Diagnose in der Browserkonsole: `NestrisHomie.topoutInfo()` zeigt das Alter
beider Lebenszeichen, ob ein schnelles Signal erkannt wurde und ob der
Gegner bereits als raus gemeldet ist.

### Events

| Event | Auslöser |
| --- | --- |
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

Damit die Seite trotz der Grants (für den optionalen TTS-Server) in Ruhe
gelassen wird, erzwingt der Skript-Kopf den Seitenkontext:
`@sandbox MAIN_WORLD` (Tampermonkey) bzw. `@inject-into page`
(Violentmonkey). Beachtet der Manager das nicht, hängt sich der Hook per
Inline-Skript direkt in der Seite ein und holt die Nachrichten über ein
CustomEvent zurück (Issue #6). Die Statuszeile im Dialog zeigt den
gewählten Weg: `Mitschnitt: aktiv (Seitenkontext)` bzw. `(Injektion)` –
`inaktiv` heißt, die Injektion wurde blockiert, die Seite läuft aber
unberührt weiter.

Danach erscheint unten rechts eine 🎙-Schaltfläche mit dem Einstellungsdialog.

### Einstellungen

| Einstellung | Standard | Bedeutung |
| --- | --- | --- |
| Sprachassistent an | ein | Gesamtschalter |
| Intervall | 30 s | Abstand der Statusansage (10–300 s) |
| Punktestände ansagen | an | absolute Scores zusätzlich zur Differenz |
| Führungswechsel ansagen | an | sofortige Meldung bei Führungswechsel |
| Spielstart / -ende | an | Start, Spielergebnis, Matchende, Trophäen |
| Chasedown / Sieg ansagen | an | „Gegner ist raus!" beim Topout des Gegners |
| Topout erkennen nach | 5 Sek. | Stillstand der Gegneranzeige, der als Topout gilt (3–60 s) |
| Spielstand ansagen | aus | Siege-Serie in der Intervallansage |
| Sprache | Deutsch | Ansagetexte `de` / `en` |
| Stimme | Automatisch | konkrete Systemstimme |
| Tempo / Lautstärke | 1,0 / 1,0 | `SpeechSynthesisUtterance.rate/.volume` |
| Sprach-Backend | Auto | `Auto` = lokaler TTS-Server, sonst Browser; `Server` erzwingt, `browser` schließt den Server aus |
| TTS-Server | `http://127.0.0.1:8099` | Basis-URL des audio.cpp-Dienstes |
| Server-Stimme | `M1` | Supertonic-Stimme des Servers |
| Abspieltempo WAV (`serverRate`) | 1,2 | nur Server-Backend, per Konsole: `NestrisHomie.setSettings({ serverRate: 1.1 })` |
| Server-Timeout (`ttsTimeoutSec`) | 4 s | Antwortfrist des Servers, per Konsole änderbar |

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
                         └──────┬───────┬────────┘
                                │       │
                Browser-Stimme  │       │  Server (optional):
         speechSynthesis.speak()│       │  GM_xmlhttpRequest
                                ▼       ▼  → 127.0.0.1:8099
                                       WAV-Blob → <audio>
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
├─ 2a. Lokaler TTS-Server (audio.cpp + Supertonic, optional)
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
NestrisHomie.topoutInfo()           // Chasedown-Diagnose (Lebenszeichen beider Seiten)
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
| `server` | Zustand des lokalen TTS-Servers: `ready`, `mode` (`ready`/`failed`), `latencyMs`, `cacheSize`, `failures` (siehe Abschnitt „Sprachausgabe über einen lokalen TTS-Server") |

Die häufigsten Ursachen:

1. **Autoplay-Schutz** (`needsGesture: true`): Chrome blockiert Sprache ohne
   Interaktion. Einmal klicken oder eine Taste drücken – NestrisHomie wiederholt
   die betroffene Ansage automatisch.
2. **Keine Stimmen** (`voiceCount: 0`): Das System liefert dem Browser keine
   Text-to-Speech-Stimme. Auf Linux ist das der häufigste Fall – siehe unten.
   Ohne Server-Backend gibt es hier keine Abhilfe im Skript; mit Server-Backend
   ist `voiceCount` ohne Belang, entscheidend ist `server.ready`.
3. **Falsche Stimme/Sprache im Panel**: `no-match` – im Panel Stimme auf
   *Automatisch* stellen oder eine passende wählen.
4. **Server nicht erreichbar** (`server.wanted: true`, `server.ready: false`):
   Der audio.cpp-Dienst läuft nicht (oder Port/URL stimmen nicht). NestrisHomie
   spricht dann still mit der Browser-Stimme weiter; Dienst starten oder das
   Backend auf *Browser* stellen, um den Hinweis loszuwerden.

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

### Sprachausgabe über einen lokalen TTS-Server

Wer den Dienst aus
[kdeconnect-battery](https://github.com/jayp33/kdeconnect-battery) kennt
([audio.cpp](https://github.com/0xShug0/audio.cpp) + **Supertonic 3**,
`kdeconnect-tts.service` auf Port 8099), kann denselben Server auch für
NestrisHomie nutzen – Installation und Modell liegen bereits vor, NestrisHomie
braucht nichts Neues auf der Platte. Die Klangqualität liegt Welten über
`espeak-ng`, und `--enable-speech-dispatcher` ist dann nicht mehr nötig.

Gemessene Syntheselatenz für unsere typischen Sätze (CPU, Modell resident):
**rund 1,3–1,5 Sekunden** für 3–5 Sekunden Audio – machbar, weil die Sätze
kurz sind und die Warteschlange (`eventGapSec: 6`) Staus verhindert.

So verhält sich das Backend:

* **Auto-Erkennung (Standard `ttsBackend: 'auto'`):** beim Laden wird
  `GET /health` geprüft; antwortet der Dienst mit `"status":"ok"`, spricht
  Server. Ein gerade erst startender Dienst bekommt drei Anläufe (der Port
  öffnet sich erst nach dem Modellladen, gemessen bei ~4,8 s).
* **Mixed Content Umgehung:** nestris.org ist HTTPS, der Server HTTP. Ein
  normales `fetch()` würde der Browser blockieren, deshalb läuft jeder
  Zugriff privilegiert über `GM_xmlhttpRequest` (`@connect 127.0.0.1`).
  Deshalb braucht das Skript jetzt Tampermonkey mit Grants – wer es ohne
  Tampermonkey betreibt, verliert automatisch die Server-Option, die
  Browser-Stimme bleibt unverändert.
* **Circuit Breaker:** scheitern zwei Ansagen in Folge (Timeout, HTTP-Fehler),
  übernimmt für die Sitzung die Browser-Stimme; `speechInfo().server`
  meldet `mode: 'failed'`.
* **Cache:** synthetisierte WAVs liegen im Speicher (Schlüssel: Stimme,
  Sprache, Text). Unsere Texte wiederholen sich stark (gerundete
  Tausenderdifferenzen), Wiederholungen sind deshalb sofort zu hören.
* **Unterbrechung:** Events verdrängen Intervallansagen wie bisher; eine
  bereits gestartete WAV wird gestoppt, eine laufende Synthese kann der
  Server nicht abbrechen – ihr Ergebnis wird verworfen, bevor es zu hören
  wäre.
* **Autoplay-Sperre** meldet sich wie bei der Browser-Stimme als
  `needsGesture` und wird nach einem Klick wiederholt.

Prüfen und Diagnose:

```js
NestrisHomie.speechInfo().server   // {mode, ready, wanted, failures, latencyMs, cacheSize}
NestrisHomie.setSettings({ ttsBackend: 'browser' })   // bewusst abschalten
```

Die Stimme (`M1` … `M6`, ggf. `F*`) und das Abspieltempo (`serverRate`,
Standard 1,2) lassen sich im Panel bzw. per Konsole wählen. Lizenzen: audio.cpp
Apache-2.0, Supertonic 3 BigScience OpenRAIL-M – beide werden wie in der
kdeconnect-Doku beschrieben getrennt installiert und nicht mit NestrisHomie
ausgeliefert.

## Einschränkungen

* Die Selektoren richten sich an der aktuellen nestris.org-Oberfläche. Ändert
  sich das Frontend, sind vor allem die Konstanten `DOM_SEL` (Abschnitt 5) zu
  prüfen – Anleitung in [docs/protokoll.md](docs/protokoll.md), Abschnitt 5.
* Kein schreibender Zugriff auf das Spiel: NestrisHomie sendet keine
  WebSocket-Nachrichten und verändert den Spielverlauf nicht.
* Der Statusfallback ohne WebSocket (`guessStatusFromDom`) greift nur, wenn der
  Mitschnitt nicht aktiv ist – in dem Fall Seite neu laden.
* Die Server-Option braucht Tampermonkey (Grants `GM_xmlhttpRequest` und
  `unsafeWindow`). Läuft das Skript ohne Grants in einem anderen
  Userscript-Manager, spricht automatisch die Browser-Stimme; der
  WebSocket-Mitschnitt greift dann auf `window` statt `unsafeWindow` zurück.
