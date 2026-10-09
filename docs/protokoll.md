# Technische Notizen: nestris.org

Diese Notizen entstanden durch Analyse des ausgelieferten Frontends
(`https://nestris.org/main.<hash>.js`, Angular-SPA mit `app-root`) und bilden die
Grundlage für das Userscript. **Es gibt keine offizielle öffentliche API** – alles
hier ist beobachtetes Verhalten und kann sich mit jedem Deployment ändern.

Stand: 2026-10-07 (letztes Bundle, das ich analysiert habe).

---

## 1. Architektur der Seite

| Merkmal | Wert |
| --- | --- |
| Framework | Angular (Produktions-Bundle, `data-critters-container`) |
| Einstieg | `app-root`, Skripte `runtime.*.js`, `polyfills.*.js`, `main.*.js` |
| Spiel-Daten lokal | eigener Emulator bzw. OCR/Video-Capture (`Platform.ONLINE` / `Platform.OCR`) |
| Spiel-Daten Gegner | WebSocket-Pakete vom Server |
| Content-Security-Policy | keine (Antwort-Header enthalten kein CSP) → Userscript-Injektion möglich |

## 2. WebSocket

```
wss://nestris.org/ws        (Produktion; sonst ws://<host>/ws)
```

* Beim Verbinden sendet der Client zuerst
  `{type: "on_connect", userid, username, sessionID}`.
* **JSON-Nachrichten** kommen als *String* und haben ein Feld `type`.
* **Binäre Nachrichten** kommen als ArrayBuffer/Blob und enthalten die
  Spielstandspakete (Bit-Protokoll mit Opcode + Bitlängen-Tabelle).

Zum Glück braucht man für den Sprachassistenten nur die JSON-Nachrichten; die
Scores liest man zuverlässiger aus dem DOM (siehe Abschnitt 4).

### 2.1 JSON-Nachrichtentypen (`type`)

```
error_message, on_connect, connection_successful, error_handshake_incomplete,
ping, send_push_notification, friend_update, server_restart_warning,
server_announcement, ME, chat, spectator_count, in_room_status,
room_state_update, client_room_event, num_queuing_players, found_opponent,
go_to_page, invitation, quest_complete, trophy_change,
on_global_chat_message, analytics_event
```

Für uns relevant:

| Typ | Payload | Verwendung |
| --- | --- | --- |
| `in_room_status` | `{status: 'player'\|'spectator'\|'none', roomInfo, roomState, isTVMode}` | Raumbetreten/-verlassen, Startzustand |
| `room_state_update` | `{state: {...}}` | Zustandswechsel mitten im Match |
| `found_opponent` | – | „Gegner gefunden" nach der Warteschlange |
| `trophy_change` | `{startTrophies, trophyDelta, queueType}` | Trophäenbilanz nach Ranked-Match |

### 2.2 Room-State-Felder (`state`)

```
type         "MULTIPLAYER" | "SOLO" | "PUZZLE_RUSH" | "PUZZLE_BATTLES"
status       "BEFORE_GAME" | "IN_GAME" | "AFTER_MATCH" | "ABORTED"
players      [ {username, userid, sessionID, platform, trophies,
                highestTrophies, highscore, flair, lifetimeDollars, leftRoom}, ... ]
ready        [bool, bool]
startLevel   number
ranked       bool
winningScore number        // z. B. 3 = "First to 3", 0.5 = "One game"
levelCap     number|null
points       [ {winner: 0|1|2}, ... ]   // 0 = PLAYER_1, 1 = PLAYER_2, 2 = DRAW
lastGameWinner  0|1|2|null  // Ergebnis des letzten Spiels
matchWinner     0|1|2|null  // nur bei AFTER_MATCH
previousGames   [...]
aborter      0|1|null
wonByResignation bool
```

`points` ist die Quelle für den **Spielstand** (Siege) – dieselbe Berechnung wie
im Frontend (`count(winner === myIndex)`, Remis zählt 0.5 für beide).
Der eigene Index ergibt sich über den Vergleich des Usernamens mit dem DOM.

### 2.3 Binärprotokoll (nur zur Vollständigkeit)

Opcodes (`opcode` = Bitfeld vor dem Paketinhalt):

```
0  LAST_PACKET_OPCODE     6  GAME_ABBR_BOARD
2  GAME_START             7  GAME_RECOVERY
3  GAME_END               9  GAME_COUNTDOWN
4  GAME_PLACEMENT        10  STACKRABBIT_PLACEMENT
5  GAME_FULL_BOARD       11  GAME_FULL_STATE
```

`GAME_FULL_STATE` enthält `delta(12) + board + next + score(26) + level(8) +
lines(16)`. Die Pakete werden pro Spieler als „PacketGroup" mit Player-Index
geliefert.

**Warum wir das nicht auswerten:** Der Client berechnet den gegnerischen Score
nicht aus einem Score-Feld, sondern rekonstruiert ihn aus den Placements
(`replayer.ingestPacket` → NES-Punkteregeln je Level + Pushdown). Einzelne
`GAME_PLACEMENT`-Pakete enthalten nur `nextNextType`, `mtPose`, `pushdown`.
Das nachzubauen wäre deutlich aufwendiger und fehleranfälliger als das Lesen
des bereits fertig berechneten Scores aus dem DOM.

---

## 3. DOM-Struktur eines 1v1-Matches

Seitenkomponente: `app-multiplayer-room`.

```
app-multiplayer-room
└─ div.multiplayer-background          (ngClass: .focused im Fokused-Layout)
   └─ div.side                         (ngClass: Farbe "blue"/"red" + "me"/"opponent")
      └─ div.player
         ├─ app-game-header  (.game-header)
         │   ├─ .identity
         │   │   └─ app-username
         │   │        ├─ h1            (Titel, optional)
         │   │        └─ p             ← Username
         │   └─ p.score                ← Spielstand (nur bei unrated Matches!)
         └─ div.my-game                (nur die eigene Seite)
            └─ app-layout-one
               └─ div.panels
                  └─ app-nes-panel.score-panel
                     ├─ p              „Score"
                     ├─ h1             ← eigener Score, z. B. "012345" / "1234567"
                     └─ h1.diff        ← Vorzeichen-Differenz (me − Gegner), z. B. "+25000"
```

Wichtige Details:

* **`.side.me` / `.side.opponent`** – zuverlässigste Unterscheidung, unabhängig
  von der Reihenfolge der Spieler (`getPlayerIndices()` vertauscht sie je nach
  eigener Seite) und unabhängig vom Layout.
* Der Score ist ein **nullgepaddeter String** (`padStart(6, "0")`), ab 1.000.000
  siebenstellig (CSS-Klasse `seven-digit`), bei fehlenden Daten `"------"`.
* `h1.diff` wird nur gerendert, wenn ein Gegner-Score bekannt ist
  (`opponentScore !== null`).
* Beide Seiten rendern `app-layout-one`; die Gegnerseite hängt an einem
  `ng-container` statt an `.my-game`.
* `.focused .side.opponent` ist nur skaliert (`transform: scale(.4)`), nicht
  aus dem DOM entfernt – Lesen funktioniert also auch im Fokused-Layout.
* Im **Zuschauermodus** trägt keine Seite `me` (beide `opponent`) → sinnvolles
  Erkennungsmerkmal dafür, dass nicht angesagt werden soll.

### Status-Overlays

`app-nes-board` rendert `h1.countdown` mit:

| Text | Bedeutung |
| --- | --- |
| `READY` / `NOT READY` | vor dem Spiel (`BEFORE_GAME`) |
| `Aborting in <n>…` | Countdown bis zum Abbruch |
| `LEFT ROOM` | Gegner hat das Zimmer verlassen |
| Zahl (`3,2,1`) | Countdown zum Spielstart |
| (nichts) | laufendes Spiel |

Daraus lässt sich der Spielstatus ohne WebSocket grob rekonstruieren
(Implemented als Fallback in `guessStatusFromDom()`).

---

## 4. Was das Userscript daraus macht

1. **`@run-at document-start`** installiert einen `Proxy` um `window.WebSocket`,
   bevor die Seite ihren Socket aufbaut. Eigene `message`-Listener hängen sich
   unauffällig daneben (JSON-Strings werden gelesen, binäre geraten ignoriert).
2. **Statusmaschine** aus `in_room_status` / `room_state_update`
   (`BEFORE_GAME → IN_GAME → BEFORE_GAME|AFTER_MATCH|ABORTED`).
3. **Alle 400 ms** werden die Scores aus `.side.me` bzw. `.side.opponent`
   gelesen; Differenz und Führungswechsel werden daraus abgeleitet.
4. **Sprachausgabe** über die Web Speech API mit einer Warteschlange
   (periodische Ansagen können verdrängt werden, Events haben Vorrang).

## 5. Wartung / Was bei Änderungen zu prüfen ist

Nach einem Redeploy von nestris.org gilt:

1. Bundle-Hash aus `index.html` auslesen, bei Bedarf erneut durchsuchen.
2. Selektoren sind zentral in `DOM_SEL` im Userscript gebündelt.
3. Prüfen in der Browserkonsole (Skript muss geladen sein):
   ```js
   NestrisHomie.readScores()      // {myScore, oppScore, diff, myName, oppName, …}
   NestrisHomie.state             // roomStatus, status, scores …
   NestrisHomie.previewAnnouncement()
   ```
4. Falls die JSON-Typen sich ändern: im Bundle nach `t.PING="ping"` suchen –
   dort steht die vollständige Enum-Liste.

## 6. Rechtlicher/Hinweis

Es handelt sich um eine private Lesehilfe ohne schreibenden Zugriff auf das Spiel
(keine gesendeten Nachrichten, keine Spielvorteile). Die Analyse diente
ausschließlich der Feature-Implementierung.
