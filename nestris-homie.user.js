// ==UserScript==
// @name         NestrisHomie – Sprachassistent für nestris.org
// @namespace    nestris-homie
// @version      0.2.0
// @description  Sprachansagen während 1v1-Matches auf nestris.org: alle 30 Sekunden Vorsprung/Rückstand,
//               plus Events (Spielstart, Führungswechsel, Spiel-/Matchende, Trophäen).
// @author       NestrisHomie
// @match        https://nestris.org/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Aufbau des Skripts:
 *   1. Einstellungen (localStorage)
 *   2. Sprachausgabe (Web Speech API) inkl. Sprechwarteschlange
 *   3. Textbausteine + deutsche Zahlwörter
 *   4. WebSocket-Mitschnitt (JSON-Events des Spiels)
 *   5. DOM-Zugriff (Scores, Namen, Spielstand)
 *   6. Matchzustand + Zustandsmaschine
 *   7. Ansage-Logik (Intervall + Events)
 *   8. Bedienoberfläche
 *
 * Die Reverse-Engineering-Notizen (Selector, Nachrichtentypen) stehen in docs/protokoll.md.
 * Sollte sich die Seite ändern, sind vor allem die Konstanten in Abschnitt 5 zu prüfen.
 */

(() => {
  'use strict';

  const LOG = '[NestrisHomie]';

  /* ============================================================
   * 1. Einstellungen
   * ============================================================ */

  const SETTINGS_KEY = 'nestris-homie.settings.v1';

  const DEFAULTS = {
    enabled: true,
    intervalSec: 30,      // Grundintervall der Statusansage
    language: 'de',       // 'de' | 'en'
    voiceURI: '',         // leer = automatisch passend zur Sprache wählen
    rate: 1.0,
    pitch: 1.0,
    volume: 1.0,
    announceScores: true,     // absolute Punktestände mit ansagen
    announceSeries: false,    // Spielstand (Siege) mit ansagen
    announceLeadChange: true, // sofort ansagen, wenn sich die Führung dreht
    announceStartEnd: true,   // Spielstart, Spielende, Matchende, Trophäen
    eventGapSec: 6,           // Mindestabstand zwischen Event-Ansagen
  };

  /** @type {typeof DEFAULTS} */
  let settings = { ...DEFAULTS, ...readJson(SETTINGS_KEY) };

  const settingsListeners = [];

  function readJson(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      console.warn(LOG, 'Einstellungen konnten nicht gelesen werden', err);
      return {};
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.warn(LOG, 'Einstellungen konnten nicht gespeichert werden', err);
    }
  }

  function updateSettings(patch) {
    settings = { ...settings, ...patch };
    writeJson(SETTINGS_KEY, settings);
    settingsListeners.forEach((fn) => {
      try {
        fn(settings);
      } catch (err) {
        console.warn(LOG, err);
      }
    });
  }

  function onSettingsChanged(fn) {
    settingsListeners.push(fn);
  }

  /* Platzhalter für die UI-Brücke – muss vor der Sprachausgabe existieren,
     weil deren Stimmlisten-Callback die UI sofort anspricht. */
  const ui = {
    /** @type {null | ((voices: SpeechSynthesisVoice[]) => void)} */
    refreshVoices: null,
    /** @type {null | ((text: string) => void)} */
    updateStatus: null,
  };

  /* ============================================================
   * 2. Sprachausgabe
   * ============================================================ */

  const TTS = (() => {
    const supported = typeof window.speechSynthesis !== 'undefined';

    /** @type {Array<{text:string, kind:string}>} */
    let queue = [];
    let busy = false;
    let startedAt = 0;
    let current = null;
    let voices = [];
    /** Zeitpunkt des letzten cancel() – schützt vor Chromes speak()-Race. */
    let lastCancelAt = 0;
    /** Letzter Sprachfehler des Browsers, z. B. 'not-allowed' oder 'no-match'. */
    let lastError = null;
    /** Annage, die nach einer Nutzergeste automatisch wiederholt wird. */
    let retryItem = null;
    /** true, solange der Browser Sprache ohne Nutzergeste blockiert. */
    let needsGesture = false;

    function refreshVoices() {
      if (!supported) return;
      try {
        voices = speechSynthesis.getVoices() || [];
      } catch (err) {
        voices = [];
      }
      if (typeof ui.refreshVoices === 'function') ui.refreshVoices(voices);
    }

    function pickVoice() {
      if (!voices.length) return null;
      if (settings.voiceURI) {
        const exact = voices.find((v) => v.voiceURI === settings.voiceURI);
        if (exact) return exact;
      }
      const base = (settings.language || 'de').toLowerCase().split(/[-_]/)[0];
      const candidates = voices.filter((v) =>
        String(v.lang || '').toLowerCase().replace('_', '-').startsWith(base),
      );
      const rank = (v) => (/natural|neural|siri/i.test(v.name) ? 4 : 0) + (/google/i.test(v.name) ? 2 : 0);
      candidates.sort((a, b) => rank(b) - rank(a));
      return candidates[0] || null;
    }

    /**
     * Legt eine Ansage in die Warteschlange.
     * kind: 'periodic' (wird bei Bedarf verdrängt) | 'event' (springt vor)
     */
    function say(text, { kind = 'event', interrupt = false } = {}) {
      if (!supported || !text) return;
      if (kind === 'periodic') {
        // Nur die neueste Statusansage behalten – nie einen Rückstau aufbauen.
        queue = queue.filter((item) => item.kind !== 'periodic');
        queue.push({ text, kind });
      } else {
        queue = queue.filter((item) => item.kind !== 'periodic');
        queue.unshift({ text, kind });
      }
      if (interrupt) {
        if (speechSynthesis.speaking) {
          try {
            speechSynthesis.cancel();
          } catch (err) {
            /* ignorieren */
          }
          busy = false;
          current = null;
        }
        // Chrome verschluckt speak(), das direkt auf cancel() folgt – auch wenn
        // speechSynthesis.speaking bereits wieder false meldet. Deshalb immer
        // kurz warten, wenn unterbrochen wird.
        lastCancelAt = Date.now();
        setTimeout(pump, 80);
        return;
      }
      // Kurz nach einem cancel() ebenfalls verzögern (defensiv).
      if (Date.now() - lastCancelAt < 120) {
        setTimeout(pump, 80);
        return;
      }
      pump();
    }

    function clearPending(kind) {
      queue = kind ? queue.filter((item) => item.kind !== kind) : [];
    }

    function stop() {
      queue = [];
      if (supported) {
        try {
          speechSynthesis.cancel();
        } catch (err) {
          /* ignorieren */
        }
      }
      busy = false;
      current = null;
    }

    function pump() {
      if (!supported || busy || queue.length === 0) return;
      const item = queue.shift();
      const utter = new SpeechSynthesisUtterance(item.text);
      const voice = pickVoice();
      if (voice) utter.voice = voice;
      utter.lang = voice ? voice.lang : settings.language === 'de' ? 'de-DE' : 'en-US';
      utter.rate = clamp(settings.rate, 0.5, 2);
      utter.pitch = clamp(settings.pitch, 0.5, 2);
      utter.volume = clamp(settings.volume, 0, 1);

      busy = true;
      startedAt = Date.now();
      current = utter;
      const done = () => {
        if (current !== utter) return;
        busy = false;
        current = null;
        setTimeout(pump, 60);
      };
      utter.onstart = () => {
        // Sprache funktioniert – etwaige Sperre ist behoben.
        needsGesture = false;
      };
      utter.onend = done;
      utter.onerror = (ev) => {
        const name = (ev && ev.error) || 'unbekannt';
        lastError = { name, text: item.text, at: Date.now() };
        console.warn(LOG, `Sprachfehler "${name}" bei Ansage:`, item.text);
        if (name === 'not-allowed' || name === 'forbidden') {
          // Browser-Autoplay-Sperre: Ansage merken und nach der nächsten
          // Nutzergeste automatisch erneut versuchen.
          needsGesture = true;
          retryItem = item;
        }
        done();
      };
      speechSynthesis.speak(utter);
    }

    if (supported) {
      refreshVoices();
      // Chrome liefert die Stimmliste erst asynchron.
      speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
      setTimeout(refreshVoices, 500);
      setTimeout(refreshVoices, 2500);

      // Workaround: Chrome "vergisst" das Sprechen nach einiger Zeit und
      // onend feuert nie. Aufsichts-Timer hält die Warteschlange am Laufen.
      setInterval(() => {
        if (!busy) return;
        const speaking = speechSynthesis.speaking;
        if (speaking && speechSynthesis.paused) {
          speechSynthesis.resume();
          return;
        }
        if (!speaking && Date.now() - startedAt > 900) {
          busy = false;
          current = null;
          pump();
        }
      }, 1000);
    }

    /** Kurzdiagnose für Statuszeile und Konsole. */
    function getInfo() {
      return {
        supported,
        voiceCount: voices.length,
        voice: pickVoice(),
        lastError,
        needsGesture,
        busy,
        queueLength: queue.length,
        speaking: supported ? speechSynthesis.speaking : false,
        paused: supported ? speechSynthesis.paused : false,
      };
    }

    /** Nach einer Nutzergeste: gescheiterte Ansage erneut versuchen. */
    function retryFailed() {
      if (!needsGesture || !retryItem) return false;
      const item = retryItem;
      retryItem = null;
      needsGesture = false;
      console.log(LOG, 'Versuche gescheiterte Ansage erneut:', item.text);
      say(item.text, { kind: item.kind });
      return true;
    }

    return { say, clearPending, stop, refreshVoices, pickVoice, getVoices: () => voices, getInfo, retryFailed, supported };
  })();

  function clamp(n, min, max) {
    const v = Number(n);
    if (!Number.isFinite(v)) return min;
    return Math.min(max, Math.max(min, v));
  }

  /* ============================================================
   * 3. Textbausteine + deutsche Zahlwörter
   * ============================================================ */

  // @test-helpers:start
  const ONES = [
    'null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun',
    'zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn',
    'achtzehn', 'neunzehn',
  ];
  const TENS = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];

  function deUnder100(n) {
    if (n < 20) return ONES[n];
    const t = Math.floor(n / 10);
    const o = n % 10;
    // "einundzwanzig" – im Verbund wird aus "eins" immer "ein".
    const unit = o === 1 ? 'ein' : ONES[o];
    return o === 0 ? TENS[t] : `${unit}und${TENS[t]}`;
  }

  function deUnder1000(n) {
    const h = Math.floor(n / 100);
    const r = n % 100;
    if (h === 0) return deUnder100(n);
    return `${h === 1 ? 'ein' : ONES[h]}hundert${r ? deUnder100(r) : ''}`;
  }

  /** Wandelt eine ganze Zahl (0 … 999.999.999) in deutsche Wörter um. */
  function deWords(value) {
    const n = Math.round(Math.abs(Number(value)));
    if (!Number.isFinite(n)) return '';
    if (n >= 1e9) return String(value); // Fallback: Ziffern, TTS spricht es selbst
    if (n >= 1e6) {
      const m = Math.floor(n / 1e6);
      const r = n % 1e6;
      const mio = m === 1 ? 'eine Million' : `${deWords(m)} Millionen`;
      return r ? `${mio} ${deWords(r)}` : mio;
    }
    if (n >= 1000) {
      const th = Math.floor(n / 1000);
      const r = n % 1000;
      const prefix = th === 1 ? 'eintausend' : `${deUnder1000(th)}tausend`;
      return r ? `${prefix}${deUnder1000(r)}` : prefix;
    }
    return deUnder1000(n);
  }
  // @test-helpers:end

  function fmt(n) {
    return settings.language === 'de' ? deWords(n) : String(Math.round(Math.abs(Number(n))));
  }

  /** Spielstände können 0,5 ergeben (Remis-Spiel) – dort keine Rundung. */
  function fmtSeries(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '';
    if (Number.isInteger(v)) return fmt(v);
    return settings.language === 'de'
      ? `${deWords(Math.floor(v))} Komma fünf`
      : String(v);
  }

  const TEXTS = {
    de: {
      started: (opponent) => (opponent ? `Spiel gegen ${opponent} gestartet.` : 'Spiel gestartet.'),
      foundOpponent: () => 'Gegner gefunden.',
      ahead: (d) => `Du liegst vorn mit ${fmt(d)} Punkten Vorsprung.`,
      behind: (d) => `Du liegst hinten mit ${fmt(d)} Punkten Rückstand.`,
      tied: (score) => `Gleichstand bei ${fmt(score)} Punkten.`,
      scores: (me, opp, name) => `Punkte: du ${fmt(me)}, ${name || 'Gegner'} ${fmt(opp)}.`,
      series: (me, opp) => `Spielstand ${fmtSeries(me)} zu ${fmtSeries(opp)}.`,
      leadTaken: () => 'Du übernimmst die Führung!',
      leadLost: () => 'Du hast die Führung abgegeben.',
      gameWon: (me, opp) => `Spiel gewonnen. ${fmt(me)} zu ${fmt(opp)} Punkten.`,
      gameLost: (me, opp) => `Spiel verloren. ${fmt(opp)} zu ${fmt(me)} Punkte.`,
      gameTied: (me) => `Spiel unentschieden bei ${fmt(me)} Punkten.`,
      matchWon: (me, opp) => `Match gewonnen, ${fmtSeries(me)} zu ${fmtSeries(opp)}.`,
      matchLost: (me, opp) => `Match verloren, ${fmtSeries(opp)} zu ${fmtSeries(me)}.`,
      matchTied: () => 'Match unentschieden.',
      aborted: () => 'Match abgebrochen.',
      trophies: (delta) =>
        delta > 0 ? `Plus ${fmt(delta)} Trophäen.` : `Minus ${fmt(-delta)} Trophäen.`,
      noData: () => 'Keine Spieldaten.',
      test: () => 'Sprachassistent ist bereit.',
    },
    en: {
      started: (opponent) => (opponent ? `Game against ${opponent} started.` : 'Game started.'),
      foundOpponent: () => 'Opponent found.',
      ahead: (d) => `You are ahead by ${fmt(d)} points.`,
      behind: (d) => `You are behind by ${fmt(d)} points.`,
      tied: (score) => `Tied at ${fmt(score)} points.`,
      scores: (me, opp, name) => `Scores: you ${fmt(me)}, ${name || 'opponent'} ${fmt(opp)}.`,
      series: (me, opp) => `Series ${fmtSeries(me)} to ${fmtSeries(opp)}.`,
      leadTaken: () => 'You take the lead!',
      leadLost: () => 'You lost the lead.',
      gameWon: (me, opp) => `Game won, ${fmt(me)} to ${fmt(opp)}.`,
      gameLost: (me, opp) => `Game lost, ${fmt(opp)} to ${fmt(me)}.`,
      gameTied: (me) => `Game tied at ${fmt(me)}.`,
      matchWon: (me, opp) => `Match won, ${fmtSeries(me)} to ${fmtSeries(opp)}.`,
      matchLost: (me, opp) => `Match lost, ${fmtSeries(opp)} to ${fmtSeries(me)}.`,
      matchTied: () => 'Match tied.',
      aborted: () => 'Match aborted.',
      trophies: (delta) => (delta > 0 ? `Plus ${fmt(delta)} trophies.` : `Minus ${fmt(-delta)} trophies.`),
      noData: () => 'No game data.',
      test: () => 'Voice assistant is ready.',
    },
  };

  function t(key, ...args) {
    const table = TEXTS[settings.language] || TEXTS.de;
    const fn = table[key] || TEXTS.de[key];
    return typeof fn === 'function' ? fn(...args) : String(fn ?? '');
  }

  /* ============================================================
   * 4. WebSocket-Mitschnitt
   * ============================================================ */

  const bus = new Map(); // type -> [handler]

  function onServerMessage(type, handler) {
    if (!bus.has(type)) bus.set(type, []);
    bus.get(type).push(handler);
  }

  function dispatch(msg) {
    const handlers = bus.get(msg.type);
    if (!handlers) return;
    handlers.forEach((fn) => {
      try {
        fn(msg);
      } catch (err) {
        console.warn(LOG, 'Fehler im Nachrichten-Handler', err);
      }
    });
  }

  /**
   * Hängt sich an den WebSocket der Seite, ohne die Kommunikation anzutasten.
   * Muss vor dem Seitenaufruf installiert werden (@run-at document-start).
   */
  function installWebSocketHook() {
    const Native = window.WebSocket;
    if (!Native || Native.__nestrisHomieHooked) return;

    const hooked = new Proxy(Native, {
      construct(target, args) {
        const socket = new target(...args);
        try {
          attachSocket(socket);
        } catch (err) {
          console.warn(LOG, 'WebSocket konnte nicht beobachtet werden', err);
        }
        return socket;
      },
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    Object.defineProperty(hooked, '__nestrisHomieHooked', { value: true });
    window.WebSocket = hooked;
    console.log(LOG, 'WebSocket-Mitschnitt aktiv');
  }

  function attachSocket(socket) {
    socket.addEventListener('message', (event) => {
      const data = event.data;
      // Binäre Pakete (Spielstand/Board) brauchen wir nicht – dort steckt der
      // Score in einem bitgenauen Protokoll. Die JSON-Ereignisse reichen uns.
      if (typeof data !== 'string') return;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch (err) {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;
      dispatch(msg);
    });
  }

  /* ============================================================
   * 5. DOM-Zugriff
   * ============================================================ */

  // Siehe docs/protokoll.md – diese Selektoren bilden die Angular-Komponenten
  // app-multiplayer-room / app-layout-one ab.
  const DOM_SEL = {
    sideMe: '.side.me',
    sideOpponent: '.side.opponent',
    scorePanel: 'app-nes-panel.score-panel',
    diff: 'h1.diff',
    username: 'app-username p',
    series: 'p.score',
    countdown: 'h1.countdown',
  };

  function qs(root, selector) {
    return root && typeof root.querySelector === 'function' ? root.querySelector(selector) : null;
  }

  function parseScoreText(text) {
    if (!text) return null;
    const digits = String(text).replace(/[^\d]/g, '');
    if (!digits) return null;
    const v = Number(digits);
    return Number.isFinite(v) ? v : null;
  }

  /** Eigenen bzw. gegnerischen Score aus dem Score-Panel lesen. */
  function readSideScore(side) {
    const panel = qs(side, DOM_SEL.scorePanel);
    if (!panel) return null;
    for (const h of panel.querySelectorAll('h1')) {
      if (h.classList.contains('diff')) continue;
      const v = parseScoreText(h.textContent);
      if (v !== null) return v;
    }
    return null;
  }

  /** Vorzeichenbehaftete Differenz "mein Score − Gegner-Score" (z. B. "+12345"). */
  function readDiff(side) {
    const el = qs(side, `${DOM_SEL.scorePanel} ${DOM_SEL.diff}`);
    if (!el) return null;
    const text = el.textContent.trim();
    if (!/^[+-]?\d+$/.test(text)) return null;
    return Number.parseInt(text, 10);
  }

  function readUsername(side) {
    const el = qs(side, DOM_SEL.username);
    if (!el) return null;
    const name = el.textContent.trim();
    return name ? name.replace(/\s*\(Aborted\)\s*$/i, '') : null;
  }

  /** Spielstand im Header (nur bei unrated Matches angezeigt – sekundär). */
  function readSeries(side) {
    const el = qs(side, DOM_SEL.series);
    if (!el) return null;
    const text = el.textContent.trim();
    if (!/^\d+(\.5)?$/.test(text)) return null;
    return Number.parseFloat(text);
  }

  function readCountdownText() {
    const el = document.querySelector(`${DOM_SEL.sideMe} h1.countdown`);
    return el ? el.textContent.trim() : null;
  }

  /** Liest alle sichtbaren Spieldaten; gibt null zurück, wenn wir nicht mitspielen. */
  function readScores() {
    const me = document.querySelector(DOM_SEL.sideMe);
    if (!me) return null;
    const opp = document.querySelector(DOM_SEL.sideOpponent);

    const myScore = readSideScore(me);
    let oppScore = readSideScore(opp);
    const diff = readDiff(me);

    // Fallback: der Gegner-Score steckt auch in der Differenz des eigenen Panels.
    if (oppScore === null && myScore !== null && diff !== null) oppScore = myScore - diff;

    return {
      myScore,
      oppScore,
      diff: diff !== null ? diff : myScore !== null && oppScore !== null ? myScore - oppScore : null,
      myName: readUsername(me),
      oppName: readUsername(opp),
      mySeries: readSeries(me),
      oppSeries: readSeries(opp),
    };
  }

  /* ============================================================
   * 6. Matchzustand
   * ============================================================ */

  const STATUS = {
    BEFORE_GAME: 'BEFORE_GAME',
    IN_GAME: 'IN_GAME',
    AFTER_MATCH: 'AFTER_MATCH',
    ABORTED: 'ABORTED',
  };

  const state = {
    roomStatus: null,        // 'player' | 'spectator' | 'none'
    roomState: null,         // Rohzustand des Servers
    status: null,            // BEFORE_GAME | IN_GAME | AFTER_MATCH | ABORTED
    isTVMode: false,
    wsSeen: false,
    scores: null,            // Ergebnis von readScores()
    lastSign: 0,             // Führungssituation der letzten Messung
    inGameSince: null,
    endedAt: null,           // Zeitpunkt der letzten Match-END-Ansage
    lastEventAt: 0,
    pendingTrophy: null,
    periodicTimer: null,
  };

  function isPlaying() {
    return state.roomStatus === 'player' && state.status === STATUS.IN_GAME;
  }

  function inRoom() {
    return state.roomStatus === 'player' || state.roomStatus === 'spectator';
  }

  function myIndexIn(roomState) {
    if (!roomState) return null;
    const players = Array.isArray(roomState.players)
      ? roomState.players
      : Object.values(roomState.players || {});
    if (players.length !== 2) return null;
    const me = state.scores && state.scores.myName;
    if (!me) return null;
    const idx = players.findIndex((p) => p && p.username === me);
    return idx >= 0 ? idx : null;
  }

  /** aktueller Spielstand (Siege) aus dem Serverzustand */
  function seriesFrom(roomState) {
    const idx = myIndexIn(roomState);
    if (idx === null || !Array.isArray(roomState.points)) return null;
    const DRAW = 2;
    let me = 0;
    let opp = 0;
    for (const game of roomState.points) {
      if (!game) continue;
      if (game.winner === idx) me += 1;
      else if (game.winner === DRAW) {
        me += 0.5;
        opp += 0.5;
      } else opp += 1;
    }
    return { me, opp };
  }

  function applyRoomState(next) {
    if (!next) return;
    const prevStatus = state.status;
    state.roomState = next;
    state.status = next.status || null;
    if (prevStatus === state.status) return;
    onStatusChange(prevStatus, state.status, next);
  }

  function onStatusChange(prev, next, roomState) {
    if (next === STATUS.IN_GAME) {
      state.inGameSince = Date.now();
      state.endedAt = null;
      state.lastSign = 0;
      state.scores = readScores();
      schedulePeriodic(settings.intervalSec * 1000);
      if (settings.announceStartEnd && prev !== STATUS.IN_GAME) {
        emitEvent(t('started', state.scores && state.scores.oppName));
      }
      return;
    }

    if (prev === STATUS.IN_GAME) {
      clearTimeout(state.periodicTimer);
      state.periodicTimer = null;
      TTS.clearPending('periodic');
      state.endedAt = Date.now();

      if (next === STATUS.AFTER_MATCH) {
        announceMatchEnd(roomState);
      } else if (next === STATUS.ABORTED) {
        emitEvent(t('aborted'));
      } else {
        announceGameEnd();
      }
    }
  }

  function resetRoom() {
    clearTimeout(state.periodicTimer);
    state.periodicTimer = null;
    state.roomStatus = null;
    state.roomState = null;
    state.status = null;
    state.isTVMode = false;
    state.scores = null;
    state.lastSign = 0;
    state.inGameSince = null;
    state.endedAt = null;
    state.pendingTrophy = null;
    TTS.clearPending('periodic');
    // Laufende Ansagen bewusst NICHT abbrechen: Das Ergebnis eines gerade
    // beendeten Matches soll noch zu Ende gesprochen werden.
  }

  /* ============================================================
   * 7. Ansage-Logik
   * ============================================================ */

  function emitEvent(text, { interrupt = false, requireGap = true } = {}) {
    if (!settings.enabled || !text) return;
    const now = Date.now();
    if (requireGap && now - state.lastEventAt < settings.eventGapSec * 1000) return;
    state.lastEventAt = now;
    TTS.say(text, { kind: 'event', interrupt });
  }

  /** Periodische Statusansage alle n Sekunden. */
  function schedulePeriodic(delayMs) {
    clearTimeout(state.periodicTimer);
    state.periodicTimer = null;
    if (!settings.enabled || !isPlaying()) return;
    state.periodicTimer = setTimeout(periodicTick, delayMs);
  }

  function periodicTick() {
    state.periodicTimer = null;
    if (!settings.enabled || !isPlaying()) return;
    TTS.say(periodicText(), { kind: 'periodic' });
    schedulePeriodic(Math.max(5, settings.intervalSec) * 1000);
  }

  function periodicText() {
    const s = state.scores || readScores();
    if (!s || s.diff === null) return t('noData');

    let text;
    if (s.diff > 0) text = t('ahead', s.diff);
    else if (s.diff < 0) text = t('behind', -s.diff);
    else text = t('tied', s.myScore ?? 0);

    if (settings.announceScores && s.myScore !== null && s.oppScore !== null) {
      text += ' ' + t('scores', s.myScore, s.oppScore, s.oppName);
    }
    if (settings.announceSeries) {
      const series = seriesFrom(state.roomState);
      if (series) text += ' ' + t('series', series.me, series.opp);
      else if (s.mySeries !== null && s.oppSeries !== null) {
        text += ' ' + t('series', s.mySeries, s.oppSeries);
      }
    }
    return text;
  }

  /** Ergebnis des soeben beendeten Spiels (Score-Vergleich wie auf der Seite). */
  function announceGameEnd() {
    const s = state.scores || readScores();
    if (!settings.announceStartEnd || !s || s.myScore === null || s.oppScore === null) return;
    const text =
      s.myScore > s.oppScore
        ? t('gameWon', s.myScore, s.oppScore)
        : s.myScore < s.oppScore
          ? t('gameLost', s.myScore, s.oppScore)
          : t('gameTied', s.myScore);
    emitEvent(text, { interrupt: true, requireGap: false });
  }

  /** Ende des gesamten Matches: Spielstand (Siege) ist ausschlaggebend. */
  function announceMatchEnd(roomState) {
    if (!settings.announceStartEnd) return;
    const series = seriesFrom(roomState || state.roomState);
    const s = state.scores || readScores();

    let text;
    if (series) {
      text =
        series.me > series.opp
          ? t('matchWon', series.me, series.opp)
          : series.me < series.opp
            ? t('matchLost', series.me, series.opp)
            : t('matchTied');
    } else if (s && s.myScore !== null && s.oppScore !== null) {
      text =
        s.myScore > s.oppScore
          ? t('gameWon', s.myScore, s.oppScore)
          : s.myScore < s.oppScore
            ? t('gameLost', s.myScore, s.oppScore)
            : t('gameTied', s.myScore);
    } else {
      text = t('noData');
    }

    if (series && s && s.myScore !== null && s.oppScore !== null) {
      text += ' ' + t('scores', s.myScore, s.oppScore, s.oppName);
    }
    emitEvent(text, { interrupt: true, requireGap: false });

    if (state.pendingTrophy) {
      const trophy = state.pendingTrophy;
      state.pendingTrophy = null;
      emitEvent(t('trophies', trophy.delta), { requireGap: false });
    }
  }

  /** Führungswechsel während des Spiels erkennen. */
  function handleLeadChange(s) {
    if (!isPlaying() || !s || s.diff === null) return;
    const sign = s.diff > 0 ? 1 : s.diff < 0 ? -1 : 0;
    const prev = state.lastSign;
    state.lastSign = sign;
    // 0 = Gleichstand: kein echter Führungswechsel, nicht ansagen.
    if (sign === 0 || prev === 0 || sign === prev) return;
    if (!settings.announceLeadChange) return;
    emitEvent(sign > 0 ? t('leadTaken') : t('leadLost'));
  }

  /* ============================================================
   * 8. Bedienoberfläche
   * ============================================================ */

  function injectStyles() {
    if (document.getElementById('nestris-homie-style')) return;
    const style = document.createElement('style');
    style.id = 'nestris-homie-style';
    style.textContent = `
      #nestris-homie-root { position: fixed; right: 14px; bottom: 14px; z-index: 2147483647;
        font-family: Montserrat, Roboto, system-ui, sans-serif; font-size: 13px; color: #fff;
        display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
      #nestris-homie-root * { box-sizing: border-box; }
      #nestris-homie-toggle { width: 46px; height: 46px; border-radius: 50%; border: 1px solid #ffffff33;
        background: #1d1c1fcc; color: #fff; font-size: 20px; cursor: pointer; backdrop-filter: blur(6px);
        box-shadow: 0 4px 14px #00000066; transition: transform .15s ease, background .2s ease; }
      #nestris-homie-toggle:hover { transform: scale(1.06); background: #2a292df2; }
      #nestris-homie-root.off #nestris-homie-toggle { opacity: .5; }
      #nestris-homie-panel { display: none; width: 288px; padding: 14px; border-radius: 12px;
        background: #1d1c1ff5; border: 1px solid #ffffff26; box-shadow: 0 10px 30px #00000080;
        backdrop-filter: blur(8px); }
      #nestris-homie-root.open #nestris-homie-panel { display: block; }
      #nestris-homie-panel h4 { margin: 0 0 4px; font-size: 15px; letter-spacing: .4px; }
      #nestris-homie-status { margin: 0 0 10px; font-size: 11px; line-height: 1.5; color: #9fe6a0;
        min-height: 30px; word-break: break-word; }
      #nestris-homie-panel label.row { display: flex; align-items: center; justify-content: space-between;
        gap: 8px; margin: 7px 0; font-size: 12px; color: #e8e8e8; }
      #nestris-homie-panel label.row > span { flex: 1 1 auto; }
      #nestris-homie-panel input[type=checkbox] { width: 16px; height: 16px; accent-color: #58d774; }
      #nestris-homie-panel input[type=range] { width: 118px; accent-color: #58d774; }
      #nestris-homie-panel input[type=number] { width: 62px; background: #00000059; color: #fff;
        border: 1px solid #ffffff33; border-radius: 6px; padding: 3px 6px; }
      #nestris-homie-panel select { max-width: 160px; background: #00000059; color: #fff;
        border: 1px solid #ffffff33; border-radius: 6px; padding: 3px 4px; }
      #nestris-homie-panel .buttons { display: flex; gap: 8px; margin-top: 12px; }
      #nestris-homie-panel button.act { flex: 1; padding: 7px 6px; border-radius: 8px; border: 1px solid #ffffff33;
        background: #ffffff14; color: #fff; cursor: pointer; font-size: 12px; }
      #nestris-homie-panel button.act:hover { background: #ffffff26; }
      #nestris-homie-panel .hint { margin: 8px 0 0; font-size: 10px; color: #8f8f96; line-height: 1.45; }
    `;
    document.documentElement.appendChild(style);
  }

  function buildUi() {
    injectStyles();

    const root = document.createElement('div');
    root.id = 'nestris-homie-root';
    if (!settings.enabled) root.classList.add('off');

    const toggle = document.createElement('button');
    toggle.id = 'nestris-homie-toggle';
    toggle.textContent = '🎙';
    toggle.title = 'NestrisHomie Sprachassistent';
    toggle.addEventListener('click', () => root.classList.toggle('open'));

    const panel = document.createElement('div');
    panel.id = 'nestris-homie-panel';
    panel.innerHTML = `
      <h4>NestrisHomie</h4>
      <p id="nestris-homie-status">Status: –</p>

      <label class="row"><span>Sprachassistent an</span><input type="checkbox" data-key="enabled"></label>
      <label class="row"><span>Intervall</span>
        <input type="number" min="10" max="300" step="5" data-key="intervalSec"> Sek.</label>
      <label class="row"><span>Punktestände ansagen</span><input type="checkbox" data-key="announceScores"></label>
      <label class="row"><span>Führungswechsel ansagen</span><input type="checkbox" data-key="announceLeadChange"></label>
      <label class="row"><span>Spielstart / -ende</span><input type="checkbox" data-key="announceStartEnd"></label>
      <label class="row"><span>Spielstand ansagen</span><input type="checkbox" data-key="announceSeries"></label>
      <label class="row"><span>Sprache</span>
        <select data-key="language">
          <option value="de">Deutsch</option>
          <option value="en">English</option>
        </select></label>
      <label class="row"><span>Stimme</span><select data-key="voiceURI"></select></label>
      <label class="row"><span>Tempo</span><input type="range" min="0.6" max="1.6" step="0.05" data-key="rate"></label>
      <label class="row"><span>Lautstärke</span><input type="range" min="0" max="1" step="0.05" data-key="volume"></label>

      <div class="buttons">
        <button class="act" data-action="test">Ansage testen</button>
        <button class="act" data-action="close">Schließen</button>
      </div>
      <p class="hint">Ansagen starten automatisch, sobald ein Spiel läuft (Status IN_GAME).
         Einstellungen werden lokal im Browser gespeichert.</p>
    `;

    root.append(panel, toggle);
    document.documentElement.appendChild(root);

    // -- Einstellungen binden --
    panel.querySelectorAll('[data-key]').forEach((input) => {
      const key = input.dataset.key;
      const apply = () => {
        let value;
        if (input.type === 'checkbox') value = input.checked;
        else if (input.type === 'number' || input.type === 'range') value = Number(input.value);
        else value = input.value;
        updateSettings({ [key]: value });
      };
      input.addEventListener('change', apply);
      if (input.type === 'range') input.addEventListener('input', apply);
    });

    panel.querySelector('[data-action="close"]').addEventListener('click', () => root.classList.remove('open'));
    panel.querySelector('[data-action="test"]').addEventListener('click', () => {
      unlockSpeech();
      const info = TTS.getInfo();
      if (!info.supported) {
        ui.updateStatus('Status: Sprachausgabe wird von diesem Browser nicht unterstützt.');
        return;
      }
      if (info.voiceCount === 0) {
        ui.updateStatus(
          'Status: Der Browser hat KEINE Sprachstimmen geliefert.\n' +
            'Die Ansage kann deshalb nicht funktionieren.',
        );
        return;
      }
      TTS.say(t('test'), { kind: 'event', interrupt: true });
      // Nach kurzer Zeit zeigen, ob der Browser die Ansage tatsächlich angenommen hat.
      setTimeout(() => {
        const after = TTS.getInfo();
        if (after.lastError && Date.now() - after.lastError.at < 3000) {
          ui.updateStatus(`Status: Testansage fehlgeschlagen (Fehler: ${after.lastError.name}).`);
        } else if (after.needsGesture) {
          ui.updateStatus('Status: Browser hat die Ausgabe noch blockiert – bitte einmal auf die Seite klicken.');
        } else {
          ui.updateStatus(
            `Status: Testansage gesprochen.\n${speechStatusText()}`,
          );
        }
      }, 1200);
    });

    // -- Anzeige --
    const statusEl = panel.querySelector('#nestris-homie-status');
    ui.updateStatus = (text) => {
      statusEl.textContent = text;
      root.classList.toggle('off', !settings.enabled);
    };

    // -- Stimmenliste --
    const voiceSelect = panel.querySelector('select[data-key="voiceURI"]');
    ui.refreshVoices = (voices) => {
      const list = voices && voices.length ? voices : TTS.getVoices();
      const base = (settings.language || 'de').toLowerCase().split(/[-_]/)[0];
      const relevant = list.filter(
        (v) => String(v.lang || '').toLowerCase().replace('_', '-').startsWith(base),
      );
      const fallback = list.filter((v) => !relevant.includes(v));
      voiceSelect.innerHTML = '';
      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = 'Automatisch';
      voiceSelect.appendChild(auto);
      for (const v of [...relevant, ...fallback]) {
        const opt = document.createElement('option');
        opt.value = v.voiceURI;
        opt.textContent = `${v.name} (${v.lang})`;
        voiceSelect.appendChild(opt);
      }
      // Ist die gespeicherte Stimme nicht (mehr) vorhanden, zeigt das Feld
      // automatisch "Automatisch" an – pickVoice() fällt ohnehin zurück.
      voiceSelect.value = settings.voiceURI || '';
    };
    ui.refreshVoices(TTS.getVoices());

    syncInputs();

    // Sprache gezielt geändert -> Stimmliste neu einlesen.
    panel.querySelector('select[data-key="language"]').addEventListener('change', () => {
      setTimeout(() => ui.refreshVoices(TTS.getVoices()), 50);
    });
  }

  function syncInputs() {
    const panel = document.getElementById('nestris-homie-panel');
    if (!panel) return;
    panel.querySelectorAll('[data-key]').forEach((input) => {
      const key = input.dataset.key;
      const value = settings[key];
      if (input.type === 'checkbox') input.checked = Boolean(value);
      else input.value = value ?? '';
    });
  }

  /* ============================================================
   * 9. Initialisierung
   * ============================================================ */

  let speechUnlocked = false;
  /** @type {null | (() => void)} */
  let speechGestureHandler = null;

  function removeSpeechGestureListeners() {
    if (!speechGestureHandler) return;
    ['pointerdown', 'keydown', 'click'].forEach((evt) =>
      window.removeEventListener(evt, speechGestureHandler),
    );
    speechGestureHandler = null;
  }

  /**
   * Chrome blockiert Sprachausgabe ohne vorherige Nutzergeste (Autoplay-Schutz).
   * Wir "entlocken" sie mit einer unhörbaren Ansage und wiederholen danach
   * eine gescheiterte Ansage automatisch.
   */
  function unlockSpeech() {
    if (!TTS.supported) return;
    if (!speechUnlocked) {
      speechUnlocked = true;
      try {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
      } catch (err) {
        /* ignorieren */
      }
      console.log(LOG, 'Sprachausgabe nach Nutzergeste freigeschaltet');
    }
    if (TTS.retryFailed()) updateStatusLine();
    // Läuft die Sprache, brauchen wir die Gesten-Listener nicht mehr.
    const info = TTS.getInfo();
    if (!info.needsGesture && !info.busy) removeSpeechGestureListeners();
  }

  function pollScores() {
    if (!inRoom()) {
      if (state.scores) state.scores = null;
      updateStatusLine();
      return;
    }
    const s = readScores();
    state.scores = s;
    if (s) handleLeadChange(s);
    updateStatusLine();
  }

  /** Kurzbeschreibung des Sprachzustands für die Statuszeile. */
  function speechStatusText() {
    const info = TTS.getInfo();
    if (!info.supported) return 'Sprache: wird vom Browser nicht unterstützt';
    if (info.voiceCount === 0) {
      return 'Sprache: KEINE Stimmen gefunden – Browser-Text-to-Speech prüfen';
    }
    const voice = info.voice ? `${info.voice.name} (${info.voice.lang})` : 'Standardstimme';
    let line = `Sprache: ${voice}`;
    if (info.needsGesture) line += ' · ⚠ bitte einmal klicken (Autoplay-Schutz)';
    else if (info.lastError && Date.now() - info.lastError.at < 15000) {
      line += ` · ⚠ Fehler: ${info.lastError.name}`;
    }
    return line;
  }

  function updateStatusLine() {
    if (!ui.updateStatus) return;
    if (!settings.enabled) {
      ui.updateStatus(`Status: deaktiviert\n${speechStatusText()}`);
      return;
    }
    if (!inRoom()) {
      ui.updateStatus(`Status: kein Match (warte auf Raum)\n${speechStatusText()}`);
      return;
    }
    const s = state.scores;
    const role = state.roomStatus === 'spectator' ? 'Zuschauer' : 'Spieler';
    if (!s) {
      ui.updateStatus(`Status: ${state.status || '–'} · ${role} · keine Spieldaten\n${speechStatusText()}`);
      return;
    }
    const diff = s.diff === null ? '–' : (s.diff > 0 ? '+' : '') + s.diff;
    ui.updateStatus(
      `Status: ${state.status || '–'} · ${role}\n` +
        `Du: ${s.myScore ?? '–'} · Gegner: ${s.oppScore ?? '–'} · Differenz: ${diff}\n` +
        speechStatusText(),
    );
  }

  function registerServerHandlers() {
    // Raum betreten / verlassen
    onServerMessage('in_room_status', (msg) => {
      state.wsSeen = true;
      if (msg.status === 'none') {
        resetRoom();
        updateStatusLine();
        return;
      }
      state.roomStatus = msg.status;
      state.isTVMode = Boolean(msg.isTVMode);
      applyRoomState(msg.roomState);
      updateStatusLine();
    });

    // Zustandswechsel mitten im Match (Spielstart, Spielende, Abbruch …)
    onServerMessage('room_state_update', (msg) => {
      state.wsSeen = true;
      if (state.roomStatus === null) state.roomStatus = 'player';
      applyRoomState(msg.state);
      updateStatusLine();
    });

    // Gegner gefunden (Ende der Warteschlange)
    onServerMessage('found_opponent', () => {
      if (settings.enabled && settings.announceStartEnd) emitEvent(t('foundOpponent'));
    });

    // Trophäenänderung nach einem Ranked-Match
    onServerMessage('trophy_change', (msg) => {
      const delta = Number(msg.trophyDelta);
      if (!Number.isFinite(delta) || delta === 0) return;
      if (state.endedAt && Date.now() - state.endedAt < 60000) {
        emitEvent(t('trophies', delta), { requireGap: false });
      } else {
        state.pendingTrophy = { delta, at: Date.now() };
      }
    });
  }

  /** Notfall-Lösung, falls der WebSocket-Mitschnitt nicht greift (z. B. Reload nötig). */
  function guessStatusFromDom() {
    if (state.wsSeen) return;
    if (!document.querySelector(DOM_SEL.sideMe)) {
      if (state.status !== null) {
        state.status = null;
        state.roomStatus = null;
        updateStatusLine();
      }
      return;
    }
    if (state.roomStatus === null) state.roomStatus = 'player';
    const countdown = readCountdownText();
    let status;
    if (countdown === 'READY' || countdown === 'NOT READY' || /^Aborting in/.test(countdown || '')) {
      status = STATUS.BEFORE_GAME;
    } else if (countdown === 'LEFT ROOM') {
      status = STATUS.ABORTED;
    } else {
      status = STATUS.IN_GAME;
    }
    if (status !== state.status) applyRoomState({ status });
  }

  function start() {
    installWebSocketHook();
    registerServerHandlers();

    onSettingsChanged(() => {
      if (!settings.enabled) {
        clearTimeout(state.periodicTimer);
        state.periodicTimer = null;
        TTS.stop();
      } else if (isPlaying()) {
        schedulePeriodic(settings.intervalSec * 1000);
      }
      updateStatusLine();
      syncInputs();
    });

    const init = () => {
      buildUi();
      updateStatusLine();

      setInterval(pollScores, 400);
      setInterval(guessStatusFromDom, 1000);

      // Bleiben aktiv (statt once), bis die Sprachausgabe tatsächlich läuft:
      // erst dann kann eine nach Autoplay-Sperre gescheiterte Ansage erneut
      // versucht werden.
      speechGestureHandler = () => unlockSpeech();
      ['pointerdown', 'keydown', 'click'].forEach((evt) =>
        window.addEventListener(evt, speechGestureHandler, { passive: true }),
      );

      console.log(LOG, 'gestartet', {
        intervall: settings.intervalSec + 's',
        sprache: settings.language,
        sprachausgabe: TTS.supported,
      });
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }

  // Debug-Hilfe in der Browserkonsole:
  //   NestrisHomie.state, NestrisHomie.say('Hallo')
  window.NestrisHomie = {
    get state() {
      return state;
    },
    get settings() {
      return settings;
    },
    setSettings: updateSettings,
    say: (text, opts = {}) => TTS.say(String(text), { kind: 'event', interrupt: true, ...opts }),
    readScores,
    deWords,
    /** Vorschau der nächsten Statusansage (Konsolen-Hilfe). */
    previewAnnouncement: () => periodicText(),
    /**
     * Sprach-Diagnose für die Browserkonsole:
     *   NestrisHomie.speechInfo()
     * Liefert Stimmenanzahl, gewählte Stimme und den letzten Browserfehler.
     */
    speechInfo: () => {
      const info = TTS.getInfo();
      return {
        ...info,
        voice: info.voice ? `${info.voice.name} (${info.voice.lang})` : null,
        hinweis:
          !info.supported
            ? 'Browser unterstützt speechSynthesis nicht.'
            : info.voiceCount === 0
              ? 'Keine Stimmen vorhanden: im Browser/TTS-System nachsehen (z. B. Sprachausgabe aktiviert?).'
              : info.needsGesture
                ? 'Autoplay-Schutz: einmal auf die Seite klicken.'
                : 'Sprachausgabe sollte funktionieren.',
      };
    },
    /** Test der Wiederholung nach Autoplay-Sperre (siehe speechInfo().needsGesture). */
    retryFailedSpeech: () => TTS.retryFailed(),
  };

  start();
})();
