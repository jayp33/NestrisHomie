# Regression seit v0.5.0: Spielstart wird nicht erkannt (Issue #6)

**Stand: 2026-10-10.** Der folgende Text (Abschnitte 1–8) hält den
Diagnosestand zum Zeitpunkt der Recherche fest, damit die Sache ohne erneutes
Bisektieren nachvollziehbar bleibt.

**Update 2026-10-10 (v0.5.3):** Fix implementiert und getestet – der Fix
hebt den Hinweis „Code-Fix bewusst ausstehend" aus dem ursprünglichen Stand
auf. Siehe Abschnitt 9.

Testbedingungen durchgängig: **Chromium (Vivaldi) mit Tampermonkey**,
nestris.org, Ranglisten-1v1 mit Capture/OCR.

---

## 1. Symptom

Seit v0.5.0 hängt das Match beim Start:

* Die Seite zeigt dauerhaft **„Detecting game..."** – laut Bundle genau bei
  `status === IN_GAME && ocrStatus$ === OCR_BEFORE_GAME`.
* Nach ~10 s schickt der eigene `ocrTimer$` der Seite `{type: "ABORT"}`
  → das Ranked-Match bricht automatisch ab (Ban-Risiko!).
* `startGameCapture()` läuft offenbar (Wake-Lock +
  `videoCapture.startCapture()`), aber die OCR-Erkennung sieht kein
  beginnendes Spiel (`PIECE_DROPPING`) im Capture-Feed.

Die Seite bekommt ihre WS-Nachrichten selbst (den Text „Detecting game..."
gibt es nur mit `status === IN_GAME`) – gestört wird die Erkennung
**downstream** von der Nachrichtenlage.

## 2. Versionsvergleich (Bisekt + Nachlieferungen)

| Version | Commit | Kontext-Kopf | Ergebnis |
| --- | --- | --- | --- |
| v0.4.0 | `fc7359b` | `@grant none` | ✓ funktioniert |
| v0.5.0 | `72879fd` | `GM_xmlhttpRequest` + `unsafeWindow`, GM-Probe auf document-start, TTS-Server-Modul, neue Panel-Zeilen | ✗ Regression |
| v0.5.1 | `68cb69b` | + `@sandbox MAIN_WORLD`, `@inject-into page`, Injektions-Brücke, `state.hook` | ✗, `mode: 'Injektion'` |
| v0.5.2 | `f2b0fbe` | − `@grant unsafeWindow`, `@sandbox raw`, GM-Probe auf DOMContentLoaded verschoben, Welt-Token, dataset-Diagnose | ✗, `modus: 'Injektion'` |

Bisekt in der Session: 0.4.0 lief, 0.5.0 und 0.5.1 identisch defekt;
0.5.2 wurde nachgereicht und am 2026-10-10 ebenfalls als defekt bestätigt.

**Wichtigste Inference zu v0.4.0:** Der direkte `window.WebSocket`-Hook
greift nur im Seitenkontext – und dass bei 0.4.0 die WS-getriebenen
Ankündigungen liefen, belegt: **`@grant none` lief im Seitenkontext.**

## 3. Diagnose-Rohdaten

**v0.5.1** (Konsole):

```js
NestrisHomie.state.hook
// {mode: 'Injektion', installed: true, lastMsgAt: 1791649421684}
```

**v0.5.2**
(`JSON.parse(document.documentElement.dataset.nestrisHomie)`):

```json
{
  "modus": "Injektion",
  "mitschnitt": true,
  "letzteWs": 1791652049410,
  "wsGesehen": true,
  "status": null,
  "raum": null,
  "aktiv": true
}
```

(`status`/`raum` = null: Außerhalb eines Matches gelesen, keine Aussage
zum Defekt. `aktiv` = Skript eingeschaltet.)

**Match-Beobachtung (v0.5.2):** Vor dem Hänger wird die Ansage
**„Spiel gegen ‹Gegner› gestartet."** korrekt ausgegeben. Sie feuert bei
uns am WS-Statuswechsel `→ IN_GAME` (`onStatusChange`, Text
`TEXT.started`). Das belegt:

* WS-Nachrichten des Matches kommen **während des Matches** im Skript an
  (nicht erst beim Seitenladen – `letzteWs` allein hätte das nicht
  bewiesen).
* Unser Status ist mit dem der Seite bis `IN_GAME` **synchron**: Beide
  haben dieselben Raumnachrichten erhalten (die Seite zeigt „Detecting
  game..." ja nur bei `status === IN_GAME`).
* Der Ausfall beginnt danach: Die Seite bestätigt den Spielbeginn in der
  OCR-/Capture-Kette nie (`PIECE_DROPPING` nicht erkannt), ihr `ocrTimer$`
  schickt nach ~10 s `{type: "ABORT"}`.

**Was die Werte belegen:**

* `mitschnitt: true`, `wsGesehen: true`, `letzteWs` gesetzt → Hook und
  CustomEvent-Brücke arbeiten – **unser Mitschnitt ist als Ursache raus.**
* `modus: 'Injektion'` ist in v0.5.2 **keine Heuristik**: das injizierte
  Skript vergleicht einen Welt-Token (`window.__nestrisHomieCtx`) und würde
  `Seitenkontext` melden, sähe es denselben `window`. Es meldete
  `Injektion` → **unsere Welt ist nicht die Seitenwelt** – trotz
  `@sandbox raw` und ohne `@grant unsafeWindow`.

## 4. Was die Tampermonkey-Doku sagt

* FAQ Q404 / `@sandbox`-Doku: Werte `raw` / `JavaScript` / `DOM` (daneben
  die Umgebungen `MAIN_WORLD` / `ISOLATED_WORLD` / `USERSCRIPT_WORLD`,
  ab 4.18).
* `raw` = „always needs to run in page context, the MAIN_WORLD" und sei
  der **Default, wenn `@sandbox` fehlt**; schlägt die MAIN_WORLD-Injektion
  fehl (z. B. CSP), Fallback „according to the order of this list".
* `JavaScript` = Skript braucht `unsafeWindow` → auf Firefox eigener
  Sonderkontext (`USERSCRIPT_WORLD`, dann sind `cloneInto`/
  `exportFunction` nötig).
* Es gibt eine **TM-Einstellung, die die verfügbaren Sandbox-Modi
  konfiguriert** (FAQ Q404). Die lokale TM-Konfiguration ist **nicht
  notiert** – offene Frage für den nächsten Durchgang.

**Widerspruch zur Beobachtung:** Auf Chromium greifen weder
`@sandbox MAIN_WORLD` (0.5.1) noch `@sandbox raw` ohne unsafeWindow-Grant
(0.5.2). Warum, ist offen (Kandidaten Abschnitt 6).

## 5. Ausgeschlossen

* ✗ Unser Mitschnitt als Ursache (Hook + Brücke funktionieren, Abschnitt 3;
  die Match-Ansage „Spiel gegen ‹Gegner› gestartet." läuft vor dem Hänger
  korrekt – die WS-Ereignisse kommen also zur Matchzeit an).
* ✗ CSS-Leak: alle Style-Selektoren unter `#nestris-homie-*`, auch im Diff
  0.4.0 → 0.5.0 geprüft.
* ✗ `@grant unsafeWindow` als *alleinige* Sandbox-Ursache (0.5.2 entfernt →
  auf Chromium weiterhin Sandbox).
* ✗ Firefox-Mechanismen (`USERSCRIPT_WORLD`, `cloneInto`): die Tests
  liefen **immer auf Chromium**.
* ✗ CSP als Injektions-Hemmnis: nestris.org sendet kein CSP (Header und
  `<meta>` geprüft).
* ✗ Globale Seiten-Selektoren, die unser Panel-PDOM mitläsen (Bundel hat
  kein `querySelector('video'|'canvas'|'select'|'input')`).
* ✗ Doppelte Zuständigkeit im Hook: Seiten- und Injektionsweg werden über
  Marker/Welt-Token exakt einmal pro Welt aktiv (Testabschnitt 12).

## 6. Offener Mechanismus / Hypothesen

**Noch unbekannt ist, was die Seiten-Erkennung konkret stört.** Bekannt
ist nur die Korrelation: Seitenkontext (0.4.0) ↔ funktioniert, Sandbox
(0.5.x auf Chromium) ↔ defekt. Aus der Sandbox berührt unsere Code die
Seite nur über:

1. DOM-Anhänge (Panel/Style, vollständig unter `#nestris-homie-*` gescopt)
2. `localStorage` (eigener Namespace `nestris-homie.*`)
3. CustomEvents am gemeinsamen `document`
4. lesende Canvas-Zugriffe (`getImageData`) alle 400 ms
5. GM-Anfragen an 127.0.0.1:8099 (ab DOMContentLoaded)
6. World-lokale `window`-Zuweisungen (bleiben in der eigenen Welt)

Kandidaten, keiner bewiesen:

* **(A)** Fremde Ausführungswelt per se – aber **kein bekannter
  Mechanismus**: Chromium-Isolated-Worlds sollten DOM-Lesezugriffe für die
  Seite unschädlich machen.
* **(B)** GM-Probe/TTS-Serverbetrieb neben der Seite (Delta von 0.5.0).
* **(C)** Die neuen Panel-Knoten, die 0.5.0 ergänzt hat.
* **(D)** Ein bisher übersehener Delta der 0.5.0er Diff (431 + / 40 −
  Zeilen; ServerTTS-Modul dominiert).
* **(E)** TM selbst verändert die Seite, z. B. halb angewandter
  Seitenkontext (GM-Shims ins Seitenfenster injiziert, Skript aber in der
  Sandbox) – käme mit der `@sandbox`-Ablehnung zusammen.

## 7. Nächste Schritte (nach Ban-Risiko sortiert)

1. **0 Matches – TM-Umfeld festhalten:** TM-Version, Config Mode
   („Advanced"), Sandbox-Optionen (FAQ Q404) notieren; danach neu laden und
   `modus` im dataset prüfen. Steht dort `Seitenkontext`, war es die
   Einstellung.
2. **0 Matches – `@grant none`-Testbuild:** Variante ohne GM-Grants (nur
   Browser-Stimme). Zeigt sie `modus: 'Seitenkontext'`, erzwingen die
   **Grants** bei TM/Chromium die Sandbox → dann GM-Zugriff anders lösen
   oder ohne Seitenkontext weitermachen.
3. **1 Match – GM-Probe aus:** Einstellung Sprach-Backend „Browser"
   (liefert 0 GM-Anfragen). Defekt weg → Kandidat (B) bestätigt.
4. **0 Matches – Konsole des gescheiterten Matches** (falls der Tab noch
   offen ist): rote Fehler sowie Zeilen mit `capture`/`ocr`/`abort`.
5. **0 Matches – ranglisten-freier OCR-Testweg** klären (Übungs-/Privatraum
   mit gleichem Capture-Flow?) – spart künftige Ban-Risiken.
6. Danach: Fixvariante bauen, **Ergebnis in Issue #6 nachtragen** (die
   Rohdaten dieses Stands sind dort noch nicht kommentiert).

## 8. Fundstellen

* Issue: <https://github.com/jayp33/NestrisHomie/issues/6>
* Commits: `fc7359b` (0.4.0) → `72879fd` (0.5.0) → `68cb69b` (0.5.1) →
  `f2b0fbe` (0.5.2)
* Seiten-/Protokoll-Notizen: [protokoll.md](protokoll.md)
* Diagnose im Skript: `state.hook`, `hookStatusText()`,
  `document.documentElement.dataset.nestrisHomie`, Log `Startkontext:`

---

## 9. Fix (v0.5.3, Commit nach `f2b0fbe`)

### Ursache bestätigt
Der **Canvas-Zugriff aus der Sandbox** war der Auslöser. Im Sandbox-Modus
(Chromium + Tampermonkey + `@grant GM_xmlhttpRequest`) läuft das Skript in
einer Isolated World. Der 400-ms-Polling-Zyklus (`pollScores` →
`sideSignature` → `canvasHash` → `canvas.getContext('2d').getImageData()`)
erzeugt dabei einen **zweiten 2D-Kontext** auf den Board-Canvasseiten. Das
stört die `videoCapture`/`OCR`-Pipeline der Seite: sie sieht keine
`PIECE_DROPPING`-Events mehr, `ocrStatus$` bleibt auf `OCR_BEFORE_GAME`,
nach ~10 s feuert `ocrTimer$` ein `ABORT` → Match-Abflug.

Beweis: v0.4.0 (`@grant none`) lief im **Seitenkontext** – dort teilt sich das
Skript den *einzigen* Canvas-Kontext mit der Seite, keine Störung.

### Lösung
**Allen Seiten-Zugriff (DOM + Canvas) in die injizierte Seiten-Welt verlegen.**
Die Injektion (`PAGE_HOOK_SNIPPET`) enthielt bereits den WebSocket-Hook; sie
wurde um den kompletten Polling-Code erweitert:

| Komponente | Wo sie jetzt läuft |
|------------|-------------------|
| WebSocket-Hook (`Proxy` um `WebSocket`) | Injektions-Skript (Seitenwelt) |
| `readScores()` / `sideSignature()` / `canvasHash()` | Injektions-Skript (Seitenwelt) |
| Chasedown-Erkennung (`watchTopout`) | Injektions-Skript (Seitenwelt) |
| DOM-Status-Fallback (`guessStatusFromDom`) | Injektions-Skript (Seitenwelt) |
| CustomEvent-Brücke (`WS_EVENT`, `HOOK_OK_EVENT`) | Injektions-Skript → Sandbox |
| **Neu:** `PAGE_STATE_EVENT` (Scores, Signaturen, DOM-Status) | Injektions-Skript → Sandbox |
| Settings, TTS (GM_xmlhttpRequest), Speech-Queue, UI | Sandbox-Hauptskript (unverändert) |

Im Sandbox-Hauptskript (`start()`) werden die Polling-Intervalle **nur noch
im Seitenkontext-Modus** gestartet:

```js
if (state.hook.mode === 'Seitenkontext') {
  setInterval(pollScores, 400);
  setInterval(guessStatusFromDom, 1000);
}
```

Im Injektions-Modus läuft das Polling ausschließlich im Injektions-Skript
(Seitenwelt), die Sandbox empfängt die Daten per `PAGE_STATE_EVENT`.

### Technische Details
- `PAGE_HOOK_SNIPPET` wird zur Laufzeit per `buildPageHookSnippet()` gebaut,
  um Template-Literal-Nesting-Probleme (innere Backticks in `canvasHash` etc.)
  zu vermeiden.
- `PAGE_FN_DEFS` (gemeinsame Helper-Funktionen) bleibt als Template-Literal,
  wird in `PAGE_HOOK_SNIPPET` interpoliert.
- Test-Abschnitt 12 (`userscript.test.js`) deckt den Injektions-Pfad ab:
  Sandbox mit `cloneInto` → Injektions-Skript wird in `pageWindow` ausgeführt
  → `setInterval`/`CustomEvent` funktionieren → `IN_GAME` kommt über Brücke an.

### Ergebnis
- **Sandbox-Modus (Chromium/Tampermonkey):** Kein Canvas/DOM-Zugriff mehr aus
  der Sandbox → „Detecting game...“ funktioniert, Match startet normal.
- **Seitenkontext-Modus (Firefox/Violentmonkey/@grant none):** Unverändert,
  direktes Polling wie vor v0.5.0.
- Alle Tests (inkl. Sandbox-Test) laufen grün.
