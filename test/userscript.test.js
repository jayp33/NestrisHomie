#!/usr/bin/env node
/*
 * Integrationstest: Lädt nestris-homie.user.js in einer isolierten Node-vm-Umgebung
 * mit Fake-DOM, Fake-WebSocket und Fake-Sprachausgabe und prüft den Ablauf:
 *
 *   1. Skript lässt sich laden (kein Laufzeitfehler beim Start)
 *   2. WebSocket-Mitschnitt wird installiert
 *   3. room/in_room_status -> IN_GAME löst die Startansage aus
 *   4. readScores() liest Scores/Differenz/Namen korrekt aus dem DOM
 *   5. previewAnnouncement() liefert den erwarteten deutschen Text
 *   6. Führungswechsel wird erkannt und angesagt
 *   6c. Chasedown: Gefriert die Gegneranzeige während das eigene Spiel
 *       weiterläuft, wird "Der Gegner ist raus!" angesagt (Sieg bzw. Lücke)
 *   7. AFTER_MATCH erzeugt die Match-Ende-Ansage (über den Spielstand)
 *   8. trophy_change wird angesagt
 *   11. Lokales TTS-Backend (Issue #4): Server-Aktivierung per /health,
 *       WAV-Wiedergabe, Cache, Unterbrechung, Autoplay-Sperre,
 *       Circuit-Breaker und Umschaltung auf die Browser-Stimme
 *   12. Sandbox-Fall (Issue #6): die Seite wird nur über ein injiziertes
 *       Hook-Skript erreicht (der Welt-Token meldet den Modus "Injektion"),
 *       die Nachrichten laufen über ein CustomEvent zurück bis in den
 *       Skriptkontext; das Seitenfenster bleibt bis dahin unberührt
 *
 * Aufruf: node test/userscript.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = path.join(__dirname, '..', 'nestris-homie.user.js');
const code = fs.readFileSync(SCRIPT, 'utf8');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------
 * Mini-DOM: reicht für die Selektoren des Userscripts
 * --------------------------------------------------------------- */

function matchesSimple(el, sel) {
  const tagMatch = sel.match(/^[a-zA-Z][\w-]*/);
  const tag = tagMatch ? tagMatch[0] : null;
  const classes = (sel.match(/\.[\w-]+/g) || []).map((c) => c.slice(1));
  if (tag && el.tag !== tag) return false;
  return classes.every((c) => el.classes.has(c));
}

function descendants(node) {
  const out = [];
  for (const child of node.children) {
    out.push(child, ...descendants(child));
  }
  return out;
}

function findAll(nodes, tokens) {
  const [first, ...rest] = tokens;
  const result = [];
  for (const node of nodes) {
    if (!matchesSimple(node, first)) continue;
    if (rest.length === 0) result.push(node);
    else result.push(...findAll(descendants(node), rest));
  }
  return result;
}

function gameNode(tag, classes = [], children = [], text = '') {
  const node = {
    tag,
    classes: new Set(classes),
    children,
    textContent: text,
    get classList() {
      const set = node.classes;
      return {
        contains: (c) => set.has(c),
        add: (c) => set.add(c),
        remove: (c) => set.delete(c),
        toggle: (c) => (set.has(c) ? set.delete(c) : set.add(c)),
      };
    },
    querySelector(sel) {
      return findAll(descendants(node), sel.trim().split(/\s+/))[0] || null;
    },
    querySelectorAll(sel) {
      return findAll(descendants(node), sel.trim().split(/\s+/));
    },
  };
  return node;
}

/* ---------------------------------------------------------------
 * UI-Stubs: nie leer, damit BuildUi() nicht auf null greift
 * --------------------------------------------------------------- */

function uiNode(tag = 'div') {
  const node = {
    tag,
    style: {},
    dataset: {},
    children: [],
    title: '',
    value: '',
    checked: false,
    _html: '',
    _text: '',
    classList: {
      _set: new Set(),
      add(c) {
        this._set.add(c);
      },
      remove(c) {
        this._set.delete(c);
      },
      toggle(c, force) {
        const on = force === undefined ? !this._set.has(c) : force;
        on ? this._set.add(c) : this._set.delete(c);
        return on;
      },
      contains(c) {
        return this._set.has(c);
      },
    },
    get innerHTML() {
      return this._html;
    },
    set innerHTML(v) {
      this._html = v;
    },
    get textContent() {
      return this._text;
    },
    set textContent(v) {
      this._text = v;
    },
    appendChild(child) {
      child._parent = node;
      node.children.push(child);
      return child;
    },
    append(...kids) {
      for (const kid of kids) kid._parent = node;
      node.children.push(...kids);
    },
    remove() {
      const parent = node._parent;
      if (!parent) return;
      const i = parent.children.indexOf(node);
      if (i >= 0) parent.children.splice(i, 1);
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() {
      return null;
    },
    querySelector() {
      return uiNode();
    },
    querySelectorAll() {
      return [];
    },
  };
  return node;
}

/* ---------------------------------------------------------------
 * Fake-WebSocket & Fake-Sprachausgabe
 * --------------------------------------------------------------- */

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.listeners = {};
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  fire(data) {
    for (const fn of this.listeners.message || []) fn({ data });
  }
}

class FakeCustomEvent {
  constructor(type, opts) {
    this.type = type;
    this.detail = opts ? opts.detail : undefined;
  }
}

const spoken = [];

class FakeUtterance {
  constructor(text) {
    this.text = text;
    this.rate = 1;
    this.pitch = 1;
    this.volume = 1;
    this.lang = 'de-DE';
    this.voice = null;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
  }
}

const fakeSpeech = {
  speaking: false,
  paused: false,
  // 'ok' = liefert onend, 'error' = ruft onerror mit errorFlag
  mode: 'ok',
  errorFlag: 'not-allowed',
  getVoices: () => [{ name: 'Teststimme', lang: 'de-DE', voiceURI: 'de-test' }],
  addEventListener() {},
  cancel() {
    this.speaking = false;
  },
  pause() {},
  resume() {},
  speak(utter) {
    spoken.push(utter.text);
    this.speaking = true;
    const mode = this.mode;
    setTimeout(() => {
      this.speaking = false;
      if (mode === 'error') {
        if (utter.onerror) utter.onerror({ error: this.errorFlag });
      } else {
        if (utter.onstart) utter.onstart();
        if (utter.onend) utter.onend();
      }
    }, 5);
  },
  /** Startet eine laufende Ansage nicht – simuliert den Fehlerfall. */
  fireError(flag) {
    this.mode = 'error';
    this.errorFlag = flag;
  },
};

/* ---------------------------------------------------------------
 * Fake lokaler TTS-Server (GM_xmlhttpRequest) & WAV-Wiedergabe
 * --------------------------------------------------------------- */

const gm = {
  mode: 'off', // 'off' = nicht erreichbar, 'ok' = gesunde Antworten
  posts: [],
  healthChecks: 0,
};

function fakeGM(req) {
  const respond = (status, response) =>
    setTimeout(() => req.onload({ status, response, responseText: response }), 5);
  if (gm.mode !== 'ok') {
    setTimeout(() => req.onerror({}), 5);
    return;
  }
  if (req.method === 'GET' && /\/health$/.test(req.url)) {
    gm.healthChecks += 1;
    respond(200, '{"status":"ok"}');
    return;
  }
  if (req.method === 'POST' && /\/v1\/audio\/speech$/.test(req.url)) {
    gm.posts.push(String(req.data));
    respond(200, { size: 410600 }); // WAV-Blob-Platzhalter
    return;
  }
  respond(404, '');
}

const fakeAudioState = {
  instances: [],
  playMode: 'ok', // 'ok' | 'blocked' (Autoplay-Sperre) | 'hang' (spielt nie fertig)
};

class FakeAudio {
  constructor(url) {
    this.url = url;
    this.playbackRate = 1;
    this.volume = 1;
    this.paused = true;
    this.onended = null;
    this.onerror = null;
    fakeAudioState.instances.push(this);
  }
  play() {
    this.paused = false;
    const mode = fakeAudioState.playMode;
    if (mode === 'blocked') {
      return Promise.reject(
        Object.assign(new Error('Autoplay blockiert'), { name: 'NotAllowedError' }),
      );
    }
    if (mode === 'hang') return Promise.resolve();
    return new Promise((resolve) => {
      setTimeout(() => {
        this.paused = true;
        if (this.onended) this.onended();
        resolve();
      }, 5);
    });
  }
  pause() {
    this.paused = true;
  }
}

const fakeURL = {
  createObjectURL: (blob) => `blob:fake-${blob && blob.size}`,
  revokeObjectURL: () => {},
};

/* ---------------------------------------------------------------
 * Spiel-DOM aufbauen (kann im Test verändert werden)
 * --------------------------------------------------------------- */

function scorePanel(score, diff) {
  return gameNode('app-nes-panel', ['score-panel'], [
    gameNode('p', [], [], 'Score'),
    gameNode('h1', [], [], score),
    gameNode('h1', ['prevent-select', 'diff'], [], diff),
  ]);
}

/**
 * DRT/QUAD-Panel wie auf der echten Seite (docs/protokoll.md): die
 * Chasedown-Erkennung braucht ein "schnelles" Signal, das sich pro Spawn
 * ändert – der Drought-Counter zählt jeden Spawn mit.
 */
function droughtPanel(score) {
  return gameNode('app-nes-panel', ['drought-panel'], [
    gameNode('p', [], [], 'DRT'),
    gameNode('h2', [], [], String(Math.abs(score) % 97)),
  ]);
}

function setScores(myScore, oppScore) {
  const diff = myScore - oppScore;
  const pad = (n) => String(n).padStart(6, '0');
  const signed = (n) => `${n >= 0 ? '+' : ''}${n}`;
  const buildSide = (name, score, ownDiff, extraClasses) =>
    gameNode('div', ['side', ...extraClasses], [
      gameNode('div', ['game-header'], [
        gameNode('app-username', [], [gameNode('p', [], [], name)]),
      ]),
      gameNode('div', ['my-game'], [
        gameNode('app-layout-one', [], [
          gameNode('div', ['panels'], [
            scorePanel(pad(score), signed(ownDiff)),
            droughtPanel(score),
          ]),
        ]),
      ]),
    ]);

  documentRoot.children = [
    buildSide('ich', myScore, diff, ['blue', 'me']),
    buildSide('gegner', oppScore, -diff, ['red', 'opponent']),
  ];
}

const documentRoot = { children: [] };

/* Dokument-Events laufen real über dasselbe Dokument – für den
   CustomEvent-Rückweg der Sandbox-Injektion (Issue #6) brauchen wir
   echtes addEventListener/dispatchEvent. */
const docListeners = new Map();

const documentStub = {
  readyState: 'complete',
  documentElement: uiNode('html'),
  getElementById: () => null,
  createElement: (tag) => uiNode(tag),
  addEventListener(type, fn) {
    if (!docListeners.has(type)) docListeners.set(type, []);
    docListeners.get(type).push(fn);
  },
  dispatchEvent(ev) {
    for (const fn of [...(docListeners.get(ev.type) || [])]) fn(ev);
    return true;
  },
  querySelector(sel) {
    return findAll(documentRoot.children, sel.trim().split(/\s+/))[0] || null;
  },
  querySelectorAll(sel) {
    return findAll(documentRoot.children, sel.trim().split(/\s+/));
  },
};

const storage = new Map();
const localStorageStub = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};

const windowStub = {
  WebSocket: FakeSocket,
  speechSynthesis: fakeSpeech,
  SpeechSynthesisUtterance: FakeUtterance,
  addEventListener() {},
  removeEventListener() {},
  location: { href: 'https://nestris.org/online/room' },
};

/* ---------------------------------------------------------------
 * Test ausführen
 * --------------------------------------------------------------- */

const sandbox = {
  window: windowStub,
  document: documentStub,
  localStorage: localStorageStub,
  console,
  speechSynthesis: fakeSpeech,
  SpeechSynthesisUtterance: FakeUtterance,
  GM_xmlhttpRequest: fakeGM,
  Audio: FakeAudio,
  URL: fakeURL,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
vm.createContext(sandbox);

let failed = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}${detail ? ` – ${detail}` : ''}`);
  }
}

async function run() {
  setScores(120000, 95000);

  console.log('1. Skript laden');
  try {
    vm.runInContext(code, sandbox, { filename: 'nestris-homie.user.js' });
    check('lädt ohne Fehler', true);
  } catch (err) {
    check('lädt ohne Fehler', false, err.stack);
    process.exit(1);
  }

  const api = windowStub.NestrisHomie;
  check('window.NestrisHomie ist vorhanden', Boolean(api));
  await sleep(30);

  console.log('2. WebSocket-Mitschnitt');
  const socket = new windowStub.WebSocket('wss://nestris.org/ws');
  check('WebSocket-Proxy liefert die Original-Instanz', socket instanceof FakeSocket);
  check('Hook-Marker gesetzt', Boolean(windowStub.WebSocket.__nestrisHomieHooked));
  check(
    'Hook-Modus "Seitenkontext"',
    api.state.hook.mode === 'Seitenkontext' && api.state.hook.installed === true,
    JSON.stringify(api.state.hook),
  );

  api.setSettings({ eventGapSec: 0, intervalSec: 600 });

  console.log('3. DOM-Auswertung');
  const scores = api.readScores();
  check('eigener Score', scores && scores.myScore === 120000, JSON.stringify(scores));
  check('Gegner-Score', scores && scores.oppScore === 95000);
  check('Differenz', scores && scores.diff === 25000);
  check('eigener Name', scores && scores.myName === 'ich');
  check('Gegner-Name', scores && scores.oppName === 'gegner');
  check('Vorschauansage', api.previewAnnouncement().includes('Du liegst vorn mit fünfundzwanzigtausend'));

  console.log('4. Match-Status über WebSocket');
  socket.fire(
    JSON.stringify({
      type: 'in_room_status',
      status: 'player',
      roomState: {
        type: 'MULTIPLAYER',
        status: 'IN_GAME',
        ranked: true,
        players: [{ username: 'ich' }, { username: 'gegner' }],
        points: [],
      },
    }),
  );
  await sleep(120);
  check('Status IN_GAME', api.state.status === 'IN_GAME', `ist ${api.state.status}`);
  check('Raumrolle "player"', api.state.roomStatus === 'player');
  check('Startansage gesprochen', spoken.some((s) => s.includes('gestartet')), JSON.stringify(spoken));

  console.log('4b. Periodische Ansage (Intervall testweise auf 5 s)');
  api.setSettings({ intervalSec: 5 });
  await sleep(5400);
  const periodic = spoken.filter((s) => s.includes('Punkten Vorsprung'));
  check('periodische Ansage erfolgt', periodic.length >= 1, JSON.stringify(spoken));
  check(
    'periodische Ansage enthält beide Scores',
    periodic.some(
      (s) => s.includes('du einhundertzwanzigtausend') && s.includes('gegner fünfundneunzigtausend'),
    ),
    JSON.stringify(periodic),
  );
  api.setSettings({ intervalSec: 600 });

  console.log('4c. Rundung der Differenz auf Tausender');
  // Vorsprung abwärts, Rückstand aufwärts – siehe roundLeadDown/roundDeficitUp.
  // Achtung: previewAnnouncement() liest state.scores, das erst im 400-ms-
  // Polling nach setScores() nachzieht – deshalb hier je Fall warten.
  setScores(120432, 95000);
  await sleep(500);
  check(
    'Vorsprung wird abwärts gerundet (25432 -> 25000)',
    api.previewAnnouncement().includes('fünfundzwanzigtausend'),
    api.previewAnnouncement(),
  );

  setScores(95500, 95000);
  await sleep(500);
  check(
    'Vorsprung unter 1000 wird ohne Zahl angesagt',
    api.previewAnnouncement().includes('knapp vorn'),
    api.previewAnnouncement(),
  );

  setScores(96000, 95000);
  await sleep(500);
  check(
    'Vorsprung von 1000 wird als Zahl angesagt',
    api.previewAnnouncement().includes('eintausend'),
    api.previewAnnouncement(),
  );

  setScores(95000, 95001);
  await sleep(500);
  check(
    'Rückstand wird aufwärts gerundet (1 -> 1000)',
    api.previewAnnouncement().includes('eintausend Punkten Rückstand'),
    api.previewAnnouncement(),
  );

  setScores(96999, 95000);
  await sleep(500);
  check(
    'Vorsprung von 1999 wird auf 1000 abgerundet',
    api.previewAnnouncement().includes('eintausend Punkten Vorsprung')
      && !api.previewAnnouncement().includes('zweitausend'),
    api.previewAnnouncement(),
  );

  setScores(97000, 95000);
  await sleep(500);
  check(
    'Vorsprung von 2000 wird zu 2000 angesagt',
    api.previewAnnouncement().includes('zweitausend Punkten Vorsprung'),
    api.previewAnnouncement(),
  );

  // Grenze: 1000 Rückstand -> 1000, aber 1001 -> 2000.
  setScores(95000, 96000);
  await sleep(500);
  check(
    'Rückstand von 1000 wird zu 1000 angesagt',
    api.previewAnnouncement().includes('eintausend Punkten Rückstand'),
    api.previewAnnouncement(),
  );

  setScores(95000, 96001);
  await sleep(500);
  check(
    'Rückstand von 1001 wird zu 2000 aufgerundet',
    api.previewAnnouncement().includes('zweitausend Punkten Rückstand'),
    api.previewAnnouncement(),
  );

  console.log('5. Führungswechsel');
  check('Führungslogik initialisiert (Rückstand)', api.state.lastSign === -1, `ist ${api.state.lastSign}`);
  setScores(120000, 95000);
  await sleep(600);
  check(
    'Vorsprung angesagt',
    spoken.some((s) => s.includes('übernimmst die Führung')),
    JSON.stringify(spoken),
  );

  // Knapper Führungswechsel (< 1000 Punkte) soll "knapp" heißen.
  console.log('5b. Knapper Führungswechsel');
  spoken.length = 0;
  setScores(95500, 96000); // 500 Punkte Rückstand -> knapp
  await sleep(600);
  check(
    'knapper Führungsverlust angesagt',
    spoken.some((s) => s.includes('knapp abgegeben')),
    JSON.stringify(spoken),
  );
  spoken.length = 0;
  setScores(96600, 96000); // 600 Punkte Vorsprung -> knapp
  await sleep(600);
  check(
    'knapper Führungswechsel angesagt',
    spoken.some((s) => s.includes('knapp die Führung')),
    JSON.stringify(spoken),
  );

  console.log('5c. Chasedown: Gefriert die Gegneranzeige?');
  api.setSettings({ topoutSec: 3, announceTopout: true });
  spoken.length = 0;

  // Beide Seiten einfrieren: Auch wenn der Gegner stillsteht, darf nichts
  // angesagt werden, solange die eigene Seite ebenfalls nicht spielt
  // (z. B. wenn ich selbst schon tot bin – dann entscheidet das Spielende).
  setScores(90000, 95000);
  await sleep(4000);
  check(
    'kein Alarm, solange beide Seiten stillstehen',
    !spoken.some((s) => s.includes('raus')),
    JSON.stringify(spoken),
  );
  check('kein Alarm ohne eigene Aktivität', api.state.opponentOut === false);

  // Ich spiele weiter (mein Score steigt), der Gegner ist eingefroren ->
  // nach topoutSec Sekunden Stillstand ist er raus.
  for (const mine of [90200, 90400, 90600, 90800]) {
    setScores(mine, 95000);
    await sleep(700);
  }
  check(
    'Chasedown angesagt',
    spoken.some((s) => s.includes('Der Gegner ist raus') && s.includes('aufholen')),
    JSON.stringify(spoken),
  );
  check(
    'aufzuholende Lücke aufwärts gerundet (4800 -> 5000)',
    spoken.some((s) => s.includes('fünftausend Punkte aufholen')),
    JSON.stringify(spoken),
  );
  check('Zustand opponentOut gesetzt', api.state.opponentOut === true);
  check(
    'Periodikansage liefert den Chasedown-Kontext mit',
    api.previewAnnouncement().includes('Gegner ist raus'),
    api.previewAnnouncement(),
  );

  console.log('5d. Sofortiger Sieg beim Topout des Gegners');
  // Neues Spiel: der Zustand muss pro Spiel zurückgesetzt sein.
  socket.fire(
    JSON.stringify({
      type: 'room_state_update',
      state: {
        type: 'MULTIPLAYER',
        status: 'BEFORE_GAME',
        ranked: true,
        players: [{ username: 'ich' }, { username: 'gegner' }],
        points: [],
      },
    }),
  );
  await sleep(120);
  socket.fire(
    JSON.stringify({
      type: 'room_state_update',
      state: {
        type: 'MULTIPLAYER',
        status: 'IN_GAME',
        ranked: true,
        players: [{ username: 'ich' }, { username: 'gegner' }],
        points: [],
      },
    }),
  );
  await sleep(500);
  check(
    'Zustand beim neuen Spiel zurückgesetzt',
    api.state.opponentOut === false,
    JSON.stringify({ opponentOut: api.state.opponentOut }),
  );
  spoken.length = 0;

  // Grace-Phase (Start-Countdown) mit beiden Seiten aktiv überbrücken,
  // dann friert nur noch der Gegner ein – und ich führe.
  for (let i = 0; i < 14; i += 1) {
    setScores(120400 + i * 400, 110000);
    await sleep(600);
  }
  check(
    'Sieg sofort angesagt',
    spoken.some((s) => s.includes('Der Gegner ist raus') && s.includes('gewinnst')),
    JSON.stringify(spoken),
  );
  check('Zustand opponentOut erneut gesetzt', api.state.opponentOut === true);

  console.log('6. Matchende');
  setScores(90000, 95000);
  await sleep(600);
  spoken.length = 0;
  socket.fire(
    JSON.stringify({
      type: 'room_state_update',
      state: {
        type: 'MULTIPLAYER',
        status: 'AFTER_MATCH',
        ranked: true,
        players: [{ username: 'ich' }, { username: 'gegner' }],
        points: [{ winner: 1 }],
        matchWinner: 1,
      },
    }),
  );
  await sleep(120);
  check('Status AFTER_MATCH', api.state.status === 'AFTER_MATCH');
  check(
    'Match-Ergebnis angesagt',
    spoken.some((s) => s.includes('Match verloren')),
    JSON.stringify(spoken),
  );

  console.log('7. Trophäen');
  socket.fire(JSON.stringify({ type: 'trophy_change', trophyDelta: -3, startTrophies: 100 }));
  await sleep(120);
  check(
    'Trophäen angesagt',
    spoken.some((s) => s.includes('Minus drei Trophäen')),
    JSON.stringify(spoken),
  );

  console.log('8. Raum verlassen');
  socket.fire(JSON.stringify({ type: 'in_room_status', status: 'none' }));
  await sleep(80);
  check('Status zurückgesetzt', api.state.status === null);

  console.log('9. Sprach-Diagnose und Fehlerbehandlung');
  const info0 = api.speechInfo();
  check(
    'speechInfo() liefert Stimmenanzahl',
    info0 && typeof info0.voiceCount === 'number',
    JSON.stringify(info0),
  );
  check('speechInfo() meldet keine Sperre', info0.needsGesture === false);
  check('speechInfo() kennt keinen Fehler', info0.lastError === null);
  check(
    'speechInfo()-Hinweis passend zur Situation',
    /funktionieren/.test(info0.hinweis),
    info0.hinweis,
  );

  // Browserfehler "not-allowed" (Autoplay-Schutz) wird erfasst und als
  // Sperre markiert – die Ansage darf dabei nicht verloren gehen.
  // Achtung: Wegen der speak()-Verzögerng (Chrome-Race) muss hier kurz
  // gewartet werden, bis der Fake-Fehler tatsächlich gemeldet ist.
  spoken.length = 0;
  fakeSpeech.fireError('not-allowed');
  api.say('Testansage nach Sperre');
  await sleep(300);
  const infoErr = api.speechInfo();
  check('Browserfehler erfasst', infoErr.lastError && infoErr.lastError.name === 'not-allowed',
    JSON.stringify(infoErr.lastError));
  check('Sperre markiert (needsGesture)', infoErr.needsGesture === true);

  // Nach Nutzergeste wird die Ansage erneut versucht.
  fakeSpeech.mode = 'ok';
  const retried = api.retryFailedSpeech();
  await sleep(300);
  check('Wiederholung nach Geste ausgelöst', retried === true);
  check('Ansage nach Wiederholung gesprochen',
    spoken.some((s) => s.includes('Testansage nach Sperre')), JSON.stringify(spoken));

  console.log('10. Unterbrechung (cancel → speak)');
  // Chrome verschluckt speak(), das direkt auf cancel() folgt – das Skript
  // muss die Wiederholung verzögern (siehe say() mit interrupt: true).
  spoken.length = 0;
  fakeSpeech.mode = 'ok';
  api.say('Erste Ansage');
  await sleep(120); // Ausgabe läuft und ist abgeschlossen
  api.say('Unterbrochene Ansage', { interrupt: true });
  await sleep(200);
  check('Unterbrochene Ansage wird nach Verzögerung gesprochen',
    spoken.includes('Unterbrochene Ansage'), JSON.stringify(spoken));
  check('Kein Rückstau alter Ansagen', spoken.filter((s) => s === 'Erste Ansage').length <= 1,
    JSON.stringify(spoken));

  console.log('11. Lokales TTS-Backend (audio.cpp + Supertonic, Issue #4)');
  // Server läuft: /health beantwortet, WAV-Anfragen werden bedient.
  gm.mode = 'ok';
  api.setSettings({ ttsBackend: 'server' });
  await sleep(80); // /health-Prüfung
  check('Server nach /health-Prüfung aktiv',
    api.speechInfo().server.ready === true, JSON.stringify(api.speechInfo().server));
  check('/health wurde abgefragt', gm.healthChecks > 0);

  gm.posts.length = 0;
  fakeAudioState.instances.length = 0;
  spoken.length = 0;
  api.say('Spiel gewonnen. 320000 zu 280000 Punkten.');
  await sleep(200); // 80 ms Warteschlange + je 5 ms Synthese/Abspielen
  check('Ansage ging als WAV an den Server',
    gm.posts.some((p) => p.includes('Spiel gewonnen')), JSON.stringify(gm.posts));
  check('WAV wurde abgespielt',
    fakeAudioState.instances.length === 1 && fakeAudioState.instances[0].paused === true,
    JSON.stringify(fakeAudioState.instances.map((a) => a.paused)));
  check('Tempo-Einstellung wirkt auf die WAV',
    fakeAudioState.instances[0].playbackRate === 1.2,
    String(fakeAudioState.instances[0].playbackRate));
  check('Browser-Stimme blieb still',
    !spoken.some((s) => s.includes('Spiel gewonnen')), JSON.stringify(spoken));
  check('Syntheselatenz wird gemeldet',
    typeof api.speechInfo().server.latencyMs === 'number',
    JSON.stringify(api.speechInfo().server));

  // Zweite identische Ansage kommt aus dem Sitzungs-Cache.
  api.say('Spiel gewonnen. 320000 zu 280000 Punkten.');
  await sleep(200);
  check('wiederholte Ansage aus dem Cache (kein zweiter POST)',
    gm.posts.filter((p) => p.includes('Spiel gewonnen')).length === 1,
    String(gm.posts.length));
  check('Cache-Größe wird gemeldet', api.speechInfo().server.cacheSize >= 1);

  // Unterbrechung: eine hängengebliebene WAV wird gestoppt und verworfen.
  fakeAudioState.playMode = 'hang';
  api.say('Der Gegner ist raus! Du gewinnst das Spiel.');
  await sleep(150);
  const hanging = fakeAudioState.instances[fakeAudioState.instances.length - 1];
  fakeAudioState.playMode = 'ok';
  api.say('Spiel verloren. 280000 zu 320000 Punkten.', { interrupt: true });
  await sleep(300);
  check('laufende WAV beim Unterbrechen angehalten',
    hanging.paused === true, String(hanging.paused));
  check('unterbrechende Ansage kam dennoch an',
    gm.posts.some((p) => p.includes('Spiel verloren')), JSON.stringify(gm.posts));

  // Autoplay-Sperre: play() verweigert, nach Nutzergeste wird wiederholt.
  fakeAudioState.playMode = 'blocked';
  api.say('Gegner gefunden.');
  await sleep(200);
  check('Autoplay-Sperre des Players erkannt',
    api.speechInfo().needsGesture === true, JSON.stringify(api.speechInfo().needsGesture));
  fakeAudioState.playMode = 'ok';
  const retriedServer = api.retryFailedSpeech();
  await sleep(300);
  check('Wiederholung nach Geste ausgelöst', retriedServer === true);
  check('Ansage nach Geste über den Server gesprochen',
    fakeAudioState.instances.length >= 3, String(fakeAudioState.instances.length));

  // Server fällt aus: nach zwei Fehlern übernimmt die Browser-Stimme.
  gm.mode = 'error';
  spoken.length = 0;
  api.say('Trophäen erhöht.');
  await sleep(500);
  check('Backend als gescheitert markiert',
    api.speechInfo().server.mode === 'failed', JSON.stringify(api.speechInfo().server));
  check('Ansage übernimmt die Browser-Stimme',
    spoken.some((s) => s.includes('Trophäen')), JSON.stringify(spoken));

  // Bewusste Umschaltung: kein Serverzugriff mehr.
  api.setSettings({ ttsBackend: 'browser' });
  await sleep(80);
  const postsBefore = gm.posts.length;
  spoken.length = 0;
  api.say('Zurück zur Browser-Stimme.');
  await sleep(250);
  check('Browser-Stimme spricht',
    spoken.some((s) => s.includes('Browser-Stimme')), JSON.stringify(spoken));
  check('kein Serverzugriff mehr', gm.posts.length === postsBefore);
  check('Backend-Info konsistent', api.speechInfo().server.wanted === false);

  /* ---------------------------------------------------------------
   * 12. Sandbox-Fall (Issue #6): Der Manager sandboxt das Skript (hier
   *     über cloneInto modelliert wie im Firefox-Sonderkontext). Die
   *     Seite darf dann NICHT über window/unsafeWindow verändert werden;
   *     stattdessen wird ein Hook-Skript injiziert (hier von Hand
   *     ausgeführt, wie der Browser es täte), dessen Welt-Token den
   *     Modus "Injektion" bestätigt – und die Nachrichten kommen per
   *     CustomEvent zurück.
   * --------------------------------------------------------------- */
  console.log('12. Sandbox-Fall: Seitenkontext-Injektion statt Fensterzugriff');
  {
    const createdScripts = [];
    const realCreate = documentStub.createElement;
    documentStub.createElement = (tag) => {
      const node = realCreate(tag);
      if (tag === 'script') createdScripts.push(node);
      return node;
    };

    const pageWindow = { WebSocket: FakeSocket };
    const sandboxWindow = {
      WebSocket: FakeSocket,
      speechSynthesis: fakeSpeech,
      SpeechSynthesisUtterance: FakeUtterance,
      addEventListener() {},
      removeEventListener() {},
      location: { href: 'https://nestris.org/online/room' },
    };
    const sandbox2 = {
      window: sandboxWindow,
      // Firefox-Sonderkontext: cloneInto existiert nur in Sandboxes – daran
      // erkennt unser Skript die Welt und meldet den Modus "Injektion".
      cloneInto: (value) => value,
      document: documentStub,
      localStorage: localStorageStub,
      console,
      speechSynthesis: fakeSpeech,
      SpeechSynthesisUtterance: FakeUtterance,
      GM_xmlhttpRequest: fakeGM,
      Audio: FakeAudio,
      URL: fakeURL,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    };
    vm.createContext(sandbox2);
    try {
      vm.runInContext(code, sandbox2, { filename: 'nestris-homie.user.js (Sandbox)' });
      check('lädt ohne Fehler', true);
    } catch (err) {
      check('lädt ohne Fehler', false, err.stack);
    }

    const api2 = sandboxWindow.NestrisHomie;
    check('Debug-API im Skriptkontext', Boolean(api2));
    check(
      'Seitenfenster bleibt bis zur Injektion unberührt',
      pageWindow.WebSocket === FakeSocket &&
        !pageWindow.WebSocket.__nestrisHomieHooked &&
        !('NestrisHomie' in pageWindow) &&
        !('nestrisHomieCtx' in pageWindow),
    );
    check(
      'Direkter Hook bleibt in der eigenen Welt',
      Boolean(sandboxWindow.WebSocket.__nestrisHomieHooked),
    );
    check(
      'Hook-Modus "Injektion", Seite noch nicht bestätigt',
      api2 && api2.state.hook.mode === 'Injektion' && api2.state.hook.installed === false,
      JSON.stringify(api2 && api2.state.hook),
    );

    const injected = createdScripts[0];
    check(
      'Hook-Skript wurde injiziert',
      Boolean(injected) && injected.textContent.includes('__nestrisHomieHooked'),
      injected ? injected.textContent.slice(0, 60) : 'kein script-Node',
    );

    if (injected) {
      // Ausführung wie im Browser: in der Seiten-Welt, mit geteiltem Dokument.
      let hookOkDetail;
      documentStub.addEventListener('nestris-homie-hook-ok', (ev) => {
        hookOkDetail = ev.detail;
      });
      const pageCtx = { window: pageWindow, document: documentStub, CustomEvent: FakeCustomEvent };
      vm.createContext(pageCtx);
      vm.runInContext(injected.textContent, pageCtx);

      check('Hook in der Seite gelandet', Boolean(pageWindow.WebSocket.__nestrisHomieHooked));
      check(
        'HOOK_OK meldet Modus "Injektion" (Welt-Token)',
        hookOkDetail === 'Injektion',
        `ist ${JSON.stringify(hookOkDetail)}`,
      );
      check(
        'HOOK_OK-Event hat die Statusmeldung gesetzt',
        api2.state.hook.installed === true && api2.state.hook.mode === 'Injektion',
        JSON.stringify(api2.state.hook),
      );

      const pageSocket = new pageWindow.WebSocket('wss://nestris.org/ws');
      check('Seiten-Socket ist die Original-Instanz', pageSocket instanceof FakeSocket);

      const before = api2.state.hook.lastMsgAt;
      pageSocket.fire({ binary: true });
      check('nicht-String-Nachricht wird ignoriert', api2.state.hook.lastMsgAt === before);

      pageSocket.fire(
        JSON.stringify({
          type: 'in_room_status',
          status: 'player',
          roomState: {
            type: 'MULTIPLAYER',
            status: 'IN_GAME',
            ranked: true,
            players: [{ username: 'ich' }, { username: 'gegner' }],
            points: [],
          },
        }),
      );
      check('IN_GAME kam über die Brücke an', api2.state.status === 'IN_GAME', `ist ${api2.state.status}`);
      check('Raumrolle über die Brücke', api2.state.roomStatus === 'player');
      check('Empfangszeitpunkt vermerkt', api2.state.hook.lastMsgAt > 0);
    }

    documentStub.createElement = realCreate;
  }

  console.log('');
  if (failed === 0) {
    console.log(`OK – alle Prüfungen bestanden (${spoken.length} Ansagen).`);
  } else {
    console.error(`${failed} Prüfungen fehlgeschlagen.`);
    process.exitCode = 1;
  }
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
