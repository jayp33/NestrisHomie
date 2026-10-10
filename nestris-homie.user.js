// ==UserScript==
// @name         NestrisHomie – Sprachassistent für nestris.org
// @namespace    nestris-homie
// @version      0.5.2
// @description  Sprachansagen während 1v1-Matches auf nestris.org: alle 30 Sekunden Vorsprung/Rückstand,
//               plus Events (Spielstart, Führungswechsel, Chasedown/Sieg beim Gegner-Topout,
//               Spiel-/Matchende, Trophäen). Sprachausgabe über die Browser-Stimme oder optional
//               über einen lokalen neuronalen TTS-Server (audio.cpp + Supertonic, Issue #4).
// @author       NestrisHomie
// @match        https://nestris.org/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @sandbox      raw
// @inject-into  page
// @connect      127.0.0.1
// @connect      localhost
// @noframes
// ==/UserScript==

/*
 * Aufbau des Skripts:
 *   1. Einstellungen (localStorage)
 *   2. Sprachausgabe (Web Speech API) inkl. Sprechwarteschlange
 *   2a. Lokaler TTS-Server (audio.cpp + Supertonic, optional, Issue #4)
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

  /* Ausführungs-Kontext (Issue #6, v0.5.2): @grant unsafeWindow (v0.5.0)
     erzwingt bei Tampermonkey den "JavaScript"-Zugriffsmodus – auf Firefox
     entsteht dabei ein eigener Sonderkontext (USERSCRIPT_WORLD), in dem das
     Skript die Seite nicht mehr wie bis v0.4.0 (@grant none) erreichte. Das
     war der Auslöser der "Detecting game..."-Regression. Ohne diesen Grant
     und mit @sandbox raw läuft das Skript wieder im Seitenkontext. Falls der
     Manager uns dennoch sandboxt, injiziert Abschnitt 4 den Hook als
     Inline-Skript in die Seite und holt die Nachrichten per CustomEvent
     zurück; unsafeWindow wird dabei nie verwendet oder beschrieben. */

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
    announceTopout: true,     // Chasedown/Sieg, sobald der Gegner topoutet
    topoutSec: 5,             // Stillstand der Gegneranzeige, der als Topout gilt
    eventGapSec: 6,           // Mindestabstand zwischen Event-Ansagen
    // Sprach-Backend (Issue #4): 'auto' = lokaler neuronaler Server, sonst
    // Browser-Stimme; 'server' erzwingt den Server, 'browser' schließt ihn aus.
    ttsBackend: 'auto',
    ttsUrl: 'http://127.0.0.1:8099', // lokaler audio.cpp-Dienst
    ttsVoice: 'M1',                  // Supertonic-Stimme des Servers
    ttsTimeoutSec: 4,                // Timeout für Server-Anfragen
    serverRate: 1.2,                 // Abspielgeschwindigkeit der WAV-Ansagen
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
        fn(settings, patch);
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

  /* ------------------------------------------------------------
   * 2a. Lokaler TTS-Server (audio.cpp + Supertonic, Issue #4)
   * ------------------------------------------------------------
   * Der optionale Dienst auf 127.0.0.1:8099 synthetisiert unsere Sätze als
   * WAV über eine OpenAI-kompatible /v1/audio/speech-Schnittstelle –
   * deutlich natürlicher als espeak-ng. Weil nestris.org per HTTPS läuft
   * und der Server HTTP spricht, blockiert der Browser ein normales fetch()
   * als Mixed Content. Umweg: GM_xmlhttpRequest (Tampermonkey-Privileg,
   * @connect 127.0.0.1), das privilegiert antwortet.
   *
   * Verhalten:
   *   - 'auto': /health prüfen, bei Erfolg den Server nutzen, sonst die
   *     Browser-Stimme. Ein startender Dienst bekommt drei Anläufe.
   *   - Zwei aufeinanderfolgende Fehler schalten für die Sitzung ab
   *     (Circuit Breaker); danach spricht wieder speechSynthesis.
   *   - WAVs werden pro Sitzung gecacht – unsere Texte wiederholen sich
   *     (gerundete Tausenderdifferenzen), Wiederholungen sind dann sofort da.
   *   - Laufende Synthese lässt sich serverseitig nicht abbrechen; ein
   *     epoch-Zähler verwirft das Ergebnis, bevor es zu hören wäre.
   */

  const ServerTTS = (() => {
    /** 'unknown' | 'ready' | 'failed' */
    let mode = 'unknown';
    let failures = 0;
    let lastError = null;
    let lastLatencyMs = null;
    /** @type {Map<string, {size:number}>} Text -> WAV-Blob */
    const cache = new Map();
    /** Generationenzähler: steigt bei jeder Unterbrechung. */
    let epoch = 0;
    /** @type {null | (() => void)} stoppt die laufende Wiedergabe */
    let stopCurrent = null;

    function baseUrl() {
      return String(settings.ttsUrl || '').replace(/\/+$/, '');
    }

    function requestTimeoutMs() {
      return clamp(Number(settings.ttsTimeoutSec) || 4, 1, 30) * 1000;
    }

    /** Zugriff auf den Server über Tampermonkey; löst mit dem GM-Antwortobjekt.
        Je nach Inject-Kontext (Issue #6) stellt Tampermonkey die klassische
        Global-Funktion oder den GM-Namensraum bereit – wir nehmen, was da ist. */
    function gmXhrFn() {
      if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
      if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') {
        return GM.xmlHttpRequest.bind(GM);
      }
      return null;
    }

    function gmRequest(opts) {
      return new Promise((resolve, reject) => {
        const gmXhr = gmXhrFn();
        if (!gmXhr) {
          reject(new Error('GM_xmlhttpRequest fehlt (kein Tampermonkey?)'));
          return;
        }
        let settled = false;
        const finish = (fn, arg) => {
          if (settled) return;
          settled = true;
          fn(arg);
        };
        gmXhr({
          method: opts.method || 'GET',
          url: opts.url,
          data: opts.data,
          headers: opts.headers,
          responseType: opts.responseType,
          timeout: opts.timeout,
          onload: (res) => finish(resolve, res),
          onerror: () => finish(reject, new Error('Netzwerkfehler')),
          ontimeout: () => finish(reject, new Error('Zeitüberschreitung')),
          onabort: () => finish(reject, new Error('Abgebrochen')),
        });
      });
    }

    /** Kurze Lebensprüfung; true, wenn der Dienst mit "status ok" antwortet. */
    function probe(timeoutMs = 800) {
      if (!baseUrl()) return Promise.resolve(false);
      return gmRequest({
        url: `${baseUrl()}/health`,
        responseType: 'text',
        timeout: timeoutMs,
      }).then(
        (res) =>
          res.status >= 200 &&
          res.status < 300 &&
          /"status"\s*:\s*"ok"/.test(String(res.response ?? '')),
        () => false,
      );
    }

    function noteOk(ms) {
      lastLatencyMs = ms;
      failures = 0;
    }

    function noteFail(err) {
      failures += 1;
      lastError = { name: (err && err.message) || 'Fehler', at: Date.now() };
      console.warn(LOG, 'TTS-Serverfehler', failures, lastError.name);
      if (failures >= 2 && mode !== 'failed') {
        mode = 'failed';
        console.warn(
          LOG,
          'TTS-Server zweimal gescheitert – für diese Sitzung wird die Browser-Stimme verwendet',
        );
        updateStatusLine();
      }
    }

    /** true, wenn gerade der Server sprechen soll. */
    function active() {
      return mode === 'ready' && settings.ttsBackend !== 'browser';
    }

    /** Sitzungs-Cache; Schlüssel enthält Stimme und Sprache. */
    function cacheKey(text) {
      return `${settings.ttsVoice || 'M1'}|${settings.language || 'de'}|${text}`;
    }

    function getWav(text) {
      const key = cacheKey(text);
      const hit = cache.get(key);
      if (hit) return Promise.resolve(hit);
      const body = JSON.stringify({
        model: 'supertonic-3',
        input: text,
        voice: String(settings.ttsVoice || 'M1'),
        language: String(settings.language || 'de'),
        response_format: 'wav',
      });
      const t0 = Date.now();
      return gmRequest({
        method: 'POST',
        url: `${baseUrl()}/v1/audio/speech`,
        data: body,
        headers: { 'Content-Type': 'application/json' },
        responseType: 'blob',
        timeout: requestTimeoutMs(),
      }).then((res) => {
        if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
        const blob = res.response;
        if (!blob || typeof blob.size !== 'number' || blob.size === 0) {
          throw new Error('leere Antwort');
        }
        cache.set(key, blob);
        noteOk(Date.now() - t0);
        return blob;
      });
    }

    /** WAV abspielen; löst mit 'ended' | 'stopped' | 'blocked' oder Fehler. */
    function play(url, onGesture) {
      return new Promise((resolve, reject) => {
        const audio = new Audio(url);
        let settled = false;
        const finish = (how) => {
          if (settled) return;
          settled = true;
          if (stopCurrent === stop) stopCurrent = null;
          try {
            audio.pause();
          } catch (err) {
            /* ignorieren */
          }
          try {
            URL.revokeObjectURL(url);
          } catch (err) {
            /* ignorieren */
          }
          resolve(how);
        };
        const stop = () => finish('stopped');
        stopCurrent = stop;
        audio.volume = clamp(settings.volume, 0, 1);
        audio.playbackRate = clamp(settings.serverRate, 0.5, 2);
        audio.onended = () => finish('ended');
        audio.onerror = () => {
          if (settled) return;
          settled = true;
          if (stopCurrent === stop) stopCurrent = null;
          try {
            URL.revokeObjectURL(url);
          } catch (err) {
            /* ignorieren */
          }
          reject(new Error('Wiedergabe fehlgeschlagen'));
        };
        let started = null;
        try {
          started = audio.play();
        } catch (err) {
          audio.onerror();
          return;
        }
        if (started && typeof started.catch === 'function') {
          started.catch((err) => {
            if (settled) return;
            const name = (err && err.name) || '';
            if (name === 'NotAllowedError' || name === 'NotSupportedError') {
              // Autoplay-Sperre – wie bei speechSynthesis nach Geste wiederholen.
              finish('blocked');
              onGesture();
            } else {
              audio.onerror();
            }
          });
        }
      });
    }

    /**
     * Synthetisiert (ggf. aus dem Cache) und spielt ab. Ruft genau einen der
     * Rückläufer: onDone, onError oder – bei Autoplay-Sperre – onGesture.
     */
    function speak(text, { onDone, onError, onGesture }) {
      const myEpoch = epoch;
      getWav(text)
        .then((blob) => {
          if (myEpoch !== epoch) return 'dropped';
          return play(URL.createObjectURL(blob), onGesture);
        })
        .then((how) => {
          if (how === 'dropped') return;
          if (how === 'blocked') {
            onGesture();
            return;
          }
          onDone();
        })
        .catch((err) => {
          if (myEpoch !== epoch) return;
          noteFail(err);
          onError(err);
        });
    }

    /** Laufende Wiedergabe stoppen, Synthese-Ergebnis verwerfen. */
    function interrupt() {
      epoch += 1;
      if (stopCurrent) {
        const stop = stopCurrent;
        stopCurrent = null;
        stop();
      }
    }

    /** (Neu-)Prüfung des Servers; startet bei Bedarf mehrere Anläufe. */
    function revalidate(tryNo = 0) {
      if (settings.ttsBackend === 'browser') {
        mode = 'unknown';
        return;
      }
      probe().then((ok) => {
        if (ok) {
          if (mode !== 'ready') console.log(LOG, 'Lokaler TTS-Server aktiv:', baseUrl());
          mode = 'ready';
          failures = 0;
          updateStatusLine();
          return;
        }
        if (tryNo < 2) {
          // Ein neu gestarteter Dienst öffnet den Port erst nach dem
          // Modellladen (gemessen: ~4,8 s) – deshalb weitere Anläufe.
          setTimeout(() => revalidate(tryNo + 1), 2500 * (tryNo + 1));
          return;
        }
        if (mode !== 'failed') {
          console.log(LOG, 'TTS-Server nicht erreichbar – Browser-Stimme wird verwendet');
        }
        mode = 'failed';
        updateStatusLine();
      });
    }

    function start() {
      onSettingsChanged((s, patch) => {
        if (!patch || (!('ttsBackend' in patch) && !('ttsUrl' in patch))) return;
        failures = 0;
        lastError = null;
        mode = 'unknown';
        revalidate();
        updateStatusLine();
      });
      // Erstmalige Serverprüfung nicht auf document-start (Issue #6): die
      // Seite soll wie bis v0.4.0 ohne parallelen GM-Zugriff hochfahren.
      const kick = () => revalidate();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', kick, { once: true });
      } else {
        kick();
      }
    }

    function getInfo() {
      return {
        mode,
        ready: active(),
        wanted: settings.ttsBackend !== 'browser',
        failures,
        lastError,
        latencyMs: lastLatencyMs,
        cacheSize: cache.size,
      };
    }

    return { start, active, speak, interrupt, revalidate, getInfo };
  })();

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
        // Server-WAV stoppen, falls eine läuft; ihr Ergebnis wird verworfen.
        ServerTTS.interrupt();
        if (speechSynthesis.speaking) {
          try {
            speechSynthesis.cancel();
          } catch (err) {
            /* ignorieren */
          }
        }
        // Die Warteschlange darf nie klemmen: auch ohne cancel() (etwa beim
        // Server-Backend) muss die Unterbrechung busy lösen.
        busy = false;
        current = null;
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
      if (busy || queue.length === 0) return;
      // Keine Stimme im Browser und kein Server aktiv -> keine Ansage möglich.
      if (!supported && !ServerTTS.getInfo().ready) return;
      const item = queue.shift();

      busy = true;
      startedAt = Date.now();
      // Token statt der Utterance als "laufende Ansage": dieselbe Identität
      // prüft sowohl der Browser- als auch der Server-Pfad.
      const token = { text: item.text, kind: ServerTTS.active() ? 'server' : 'browser' };
      current = token;
      const done = () => {
        if (current !== token) return;
        busy = false;
        current = null;
        setTimeout(pump, 60);
      };

      if (ServerTTS.active()) {
        ServerTTS.speak(item.text, {
          onDone: done,
          onGesture: () => {
            // Autoplay-Sperre: nach der nächsten Nutzergeste erneut anbieten.
            needsGesture = true;
            retryItem = item;
            done();
          },
          onError: (err) => {
            lastError = {
              name: (err && err.message) || 'Serverfehler',
              text: item.text,
              at: Date.now(),
            };
            console.warn(LOG, 'Server-Ansage fehlgeschlagen:', item.text, err);
            // Nochmals anbieten: nach zwei Fehlern hat noteFail() das Backend
            // abgeschaltet, der Durchlauf läuft dann über die Browser-Stimme.
            queue.unshift(item);
            done();
          },
        });
        return;
      }

      const utter = new SpeechSynthesisUtterance(item.text);
      const voice = pickVoice();
      if (voice) utter.voice = voice;
      utter.lang = voice ? voice.lang : settings.language === 'de' ? 'de-DE' : 'en-US';
      utter.rate = clamp(settings.rate, 0.5, 2);
      utter.pitch = clamp(settings.pitch, 0.5, 2);
      utter.volume = clamp(settings.volume, 0, 1);

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
      // Betrifft nur die Browser-Stimme – eine laufende Server-WAV (mehrere
      // Sekunden, speechSynthesis meldet "nicht sprechend") darf er nicht
      // als hängengeblieben werten.
      setInterval(() => {
        if (!busy || !current || current.kind !== 'browser') return;
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
        server: ServerTTS.getInfo(),
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

  /* Ansagen der Differenz werden auf ganze Tausender gerundet: Vorsprung
     abwärts, Rückstand aufwärts. Der Rand liegt genau bei 1000:
     1000 Punkte Vorsprung heißen "eintausend", 999 noch "knapp vorn";
     1000 Punkte Rückstand heißen "eintausend", 1001 schon "zweitausend". */
  const roundLeadDown = (d) => Math.floor(d / 1000) * 1000;
  const roundDeficitUp = (d) => Math.ceil(d / 1000) * 1000;
  /** Kleiner als eine Tausend: Führung knapp, ohne Punktangabe ansagen. */
  const isNarrowLead = (d) => Math.abs(d) < 1000;

  const TEXTS = {
    de: {
      started: (opponent) => (opponent ? `Spiel gegen ${opponent} gestartet.` : 'Spiel gestartet.'),
      foundOpponent: () => 'Gegner gefunden.',
      ahead: (d) => `Du liegst vorn mit ${fmt(d)} Punkten Vorsprung.`,
      aheadKnapp: () => 'Du liegst knapp vorn.',
      behind: (d) => `Du liegst hinten mit ${fmt(d)} Punkten Rückstand.`,
      tied: (score) => `Gleichstand bei ${fmt(score)} Punkten.`,
      scores: (me, opp, name) => `Punkte: du ${fmt(me)}, ${name || 'Gegner'} ${fmt(opp)}.`,
      series: (me, opp) => `Spielstand ${fmtSeries(me)} zu ${fmtSeries(opp)}.`,
      leadTaken: () => 'Du übernimmst die Führung!',
      leadTakenKnapp: () => 'Du übernimmst knapp die Führung!',
      leadLost: () => 'Du hast die Führung abgegeben.',
      leadLostKnapp: () => 'Du hast die Führung knapp abgegeben.',
      opponentOutPrefix: () => 'Gegner ist raus.',
      opponentOutWin: () => 'Der Gegner ist raus! Du gewinnst das Spiel.',
      opponentOutChase: (gap) => `Der Gegner ist raus! Du musst noch ${fmt(gap)} Punkte aufholen.`,
      opponentOutTie: () => 'Der Gegner ist raus! Gleichstand, du musst ihn noch überholen.',
      opponentOutGeneric: () => 'Der Gegner ist raus!',
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
      aheadKnapp: () => 'You are narrowly ahead.',
      behind: (d) => `You are behind by ${fmt(d)} points.`,
      tied: (score) => `Tied at ${fmt(score)} points.`,
      scores: (me, opp, name) => `Scores: you ${fmt(me)}, ${name || 'opponent'} ${fmt(opp)}.`,
      series: (me, opp) => `Series ${fmtSeries(me)} to ${fmtSeries(opp)}.`,
      leadTaken: () => 'You take the lead!',
      leadTakenKnapp: () => 'You narrowly take the lead!',
      leadLost: () => 'You lost the lead.',
      leadLostKnapp: () => 'You narrowly lost the lead.',
      opponentOutPrefix: () => 'Opponent is out.',
      opponentOutWin: () => 'The opponent is out! You win the game.',
      opponentOutChase: (gap) => `The opponent is out! You need ${fmt(gap)} more points to catch up.`,
      opponentOutTie: () => 'The opponent is out! Tied, you still have to pass them.',
      opponentOutGeneric: () => 'The opponent is out!',
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

  /* Brücke Sandbox -> Seite (Issue #6): die injizierte Hook-Fassung schickt
     jede JSON-Nachricht als CustomEvent an das gemeinsame Dokument zurück. */
  const WS_EVENT = 'nestris-homie-ws';
  const HOOK_OK_EVENT = 'nestris-homie-hook-ok';

  /** JSON-Nachricht der Seite prüfen und an unsere Handler verteilen. */
  function handleWsJson(data) {
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
    state.hook.lastMsgAt = Date.now();
    dispatch(msg);
  }

  /* Selbständige Hook-Fassung für die Seite: läuft außerhalb unseres
     Skriptbereichs und darf deshalb keine Bindungen an unsere Variablen
     benutzen – nur DOM, window, die Event-Namen und den Welt-Token. Der
     Token stammt aus unserer Welt: sieht die Seite ihn, laufen wir selbst im
     Seitenkontext ("Seitenkontext"), sonst ist die Injektion der einzige Weg
     ("Injektion") – der Modus wird mit dem Hook_OK-Event gemeldet. Der
     Marker sitzt im get-Trap, nicht per defineProperty: das würde am Proxy
     vorbei auf dem nativen Seitenkonstruktor landen (Testabschnitt 12). */
  const CTX_TOKEN = 'nh-' + Math.random().toString(36).slice(2);

  const PAGE_HOOK_SNIPPET = `(() => {
  const W = window;
  if (!W.WebSocket) return;
  const sameWorld = W.__nestrisHomieCtx === '${CTX_TOKEN}';
  if (sameWorld) {
    try { delete W.__nestrisHomieCtx; } catch (err) {}
  }
  const mode = sameWorld ? 'Seitenkontext' : 'Injektion';
  if (!W.WebSocket.__nestrisHomieHooked) {
    const Native = W.WebSocket;
    const hooked = new Proxy(Native, {
      construct(target, args) {
        const socket = new target(...args);
        try {
          socket.addEventListener('message', (ev) => {
            if (typeof ev.data !== 'string') return;
            document.dispatchEvent(new CustomEvent('${WS_EVENT}', { detail: ev.data }));
          });
        } catch (err) {}
        return socket;
      },
      get(target, prop, receiver) {
        if (prop === '__nestrisHomieHooked') return true;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    W.WebSocket = hooked;
  }
  document.dispatchEvent(new CustomEvent('${HOOK_OK_EVENT}', { detail: mode }));
})();`;

  /**
   * Hängt sich an den WebSocket der Seite, ohne die Kommunikation anzutasten.
   * Muss vor dem Seitenaufruf installiert werden (@run-at document-start).
   *
   * Zwei Wege, die beide immer laufen (Issue #6 – Regression "Detecting
   * game..." seit v0.5.0):
   *  - Direkt: im Seitenkontext (@sandbox raw, wie bis v0.4.0 mit
   *    @grant none) hängt der Proxy sofort an window.WebSocket. Läuft eine
   *    Sandbox, bleibt dieser Eingriff auf unsere eigene Welt begrenzt und
   *    berührt die Seite nicht.
   *  - Injektion: ein Inline-Skript hakt den Konstruktor in der Seite um und
   *    schickt die Nachrichten per CustomEvent zurück. Im Seitenkontext
   *    erkennt es unseren Welt-Token und läuft nicht doppelt (Marker);
   *    sandboxt der Manager, ist die Injektion der einzige sichere Weg.
   *    nestris.org hat keine Content-Security-Policy (geprüft); scheitert
   *    die Injektion, bleibt die Seite unberührt und die Statuszeile weist
   *    den Mitschnitt als inaktiv aus.
   */
  function installWebSocketHook() {
    // Welt-Token: das injizierte Skript liest ihn zurück und verrät so,
    // ob es in unserem Kontext läuft.
    window.__nestrisHomieCtx = CTX_TOKEN;

    document.addEventListener(WS_EVENT, (ev) => handleWsJson(ev && ev.detail));
    document.addEventListener(HOOK_OK_EVENT, (ev) => {
      const mode = ev && ev.detail;
      if (mode === 'Seitenkontext' || mode === 'Injektion') state.hook.mode = mode;
      state.hook.installed = true;
      updateStatusLine();
    });

    // Modus-Schätzung bis das Skript sich meldet: Firefox-Sonderkontexte
    // führen cloneInto aus, Chromes Isolated World sieht chrome.runtime.
    const sandboxed = isSandboxWorld();
    state.hook.mode = sandboxed ? 'Injektion' : 'Seitenkontext';

    try {
      const Native = window.WebSocket;
      if (Native && !Native.__nestrisHomieHooked) {
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
            // Marker im get-Trap: per defineProperty landete er am Proxy vorbei
            // auf dem nativen Seitenkonstruktor (Page-Objekt) – hier bleibt der
            // unberührt, gleichwohl meldet sich window.WebSocket als gehookt.
            if (prop === '__nestrisHomieHooked') return true;
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        window.WebSocket = hooked;
      }
      // In einer Sandbox ist nur unsere eigene Welt gehookt – ob die Seite
      // hängt, sagt allein das Hook_OK-Event der Injektion.
      state.hook.installed =
        !sandboxed && Boolean(window.WebSocket && window.WebSocket.__nestrisHomieHooked);
    } catch (err) {
      console.warn(LOG, 'Direkter WebSocket-Hook nicht möglich', err);
    }

    installInjectedHook();
    console.log(LOG, 'WebSocket-Mitschnitt installiert', {
      modus: state.hook.mode,
      direkt: state.hook.installed,
      sandbox: sandboxed,
    });
  }

  /** Sandbox-Fall: Hook in die Seite injizieren, Nachrichten per CustomEvent. */
  function installInjectedHook() {
    const inject = () => {
      const parent = document.documentElement;
      if (!parent) {
        document.addEventListener('DOMContentLoaded', inject, { once: true });
        return;
      }
      try {
        const script = document.createElement('script');
        script.textContent = PAGE_HOOK_SNIPPET;
        parent.appendChild(script);
        script.remove();
      } catch (err) {
        console.warn(LOG, 'Injektion in den Seitenkontext fehlgeschlagen', err);
      }
    };
    inject();
  }

  /** Erkennt Sandbox-Welten (für Status/Logs; die Brücke läuft in beiden). */
  function isSandboxWorld() {
    if (typeof cloneInto === 'function') return true;
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) return true;
    return false;
  }

  function attachSocket(socket) {
    socket.addEventListener('message', (event) => handleWsJson(event.data));
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

  /* --- Lebenszeichen einer Spielseite (Chasedown-Erkennung) -------------- */

  /** Billiger String-Hash – nur zum Erkennen von Änderungen. */
  function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  /** Pixel-Hash eines Canvas; null, wenn nicht lesbar (z. B. fremde Quelle). */
  function canvasHash(canvas) {
    try {
      const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
      if (!ctx || typeof ctx.getImageData !== 'function') return null;
      const w = canvas.width || 0;
      const h = canvas.height || 0;
      if (!w || !h) return null;
      const data = ctx.getImageData(0, 0, w, h).data;
      let hash = 0x811c9dc5;
      for (let i = 0; i < data.length; i += 8) {
        hash ^= data[i];
        hash = Math.imul(hash, 0x01000193);
      }
      const out = (hash >>> 0).toString(36);
      return out || null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Signatur einer Spielseite: alle Werte, die sich nur ändern, wenn dieser
   * Spieler noch spielt (Score, Level, Lines, DRT/QUAD, Next Piece, Board).
   * h1.diff bleibt bewusst draußen – der ändert sich auch, wenn der ANDERE
   * gerade punktet.
   *
   * Rückgabe: {value, fast}. "fast" heißt: mindestens ein Signal, das sich
   * während des Spiels regelmäßig ändert (Board-Pixel, Next Piece,
   * Drought-Counter). Nur darauf ist Verlass – Score und Lines allein können
   * bei einer Dürre lange stehen, ohne dass jemand tot ist.
   */
  function sideSignature(side) {
    if (!side) return null;
    const parts = [];
    let fast = false;

    side.querySelectorAll('app-nes-panel').forEach((panel) => {
      const labelEl = panel.querySelector('p');
      const label = labelEl ? labelEl.textContent.trim() : '';
      const texts = [];
      panel.querySelectorAll('h1').forEach((el) => {
        if (el.classList.contains('diff')) return;
        texts.push(el.textContent.trim());
      });
      panel.querySelectorAll('h2').forEach((el) => texts.push(el.textContent.trim()));

      const piece = qs(panel, 'app-nes-piece');
      if (piece) {
        const pieceCanvas = qs(piece, 'canvas');
        const markup = piece.innerHTML || piece.textContent || '';
        const hash = pieceCanvas ? canvasHash(pieceCanvas) : markup ? fnv(markup) : null;
        if (hash) {
          texts.push('piece=' + hash);
          fast = true; // Next Piece wechselt mit jedem Spawn
        }
      }
      // DRT/QUAD-Panel: der Drought-Counter zählt jeden Spawn mit.
      if (label === 'DRT' || label === 'QUAD') fast = true;
      if (texts.length) parts.push(label + '=' + texts.join('/'));
    });

    const board = qs(side, 'app-nes-board');
    if (board) {
      const canvas = qs(board, 'canvas');
      const markup = board.innerHTML || '';
      const hash = canvas ? canvasHash(canvas) : markup ? fnv(markup) : null;
      if (hash) {
        parts.push('board=' + hash);
        fast = true; // Minos/aktives Piece ändern sich im Spiel ständig
      }
    }

    if (!parts.length) return null;
    return { value: parts.join('|'), fast };
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
    // Chasedown-Wächter: Lebenszeichen beider Seiten (siehe watchTopout)
    oppSig: null,            // Signatur der Gegneranzeige
    oppSigAt: null,          // Zeitpunkt ihrer letzten Änderung
    oppFast: false,          // schnelles Signal vorhanden (Board/Piece/DRT)
    meSig: null,             // dasselbe für die eigene Seite
    meSigAt: null,
    opponentOut: false,      // einmal pro Spiel: der Gegner ist raus
    // WebSocket-Mitschnitt (Issue #6): wie der Hook installiert wurde und
    // ob je eine Nachricht ankam – für die Statuszeile und die Konsole.
    hook: { mode: '–', installed: false, lastMsgAt: 0 },
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
      resetTopoutWatch();
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
    resetTopoutWatch();
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
    if (s.diff > 0) {
      // Vorsprung abwärts gerundet – unter 1000 ohne Zahl ansagen.
      const vorsprung = roundLeadDown(s.diff);
      text = vorsprung > 0 ? t('ahead', vorsprung) : t('aheadKnapp');
    } else if (s.diff < 0) {
      // Rückstand aufwärts gerundet – 1 Punkt heißt schon "eintausend".
      text = t('behind', roundDeficitUp(-s.diff));
    } else text = t('tied', s.myScore ?? 0);

    // Während des Chasedowns den Kontext mitliefern: jetzt zählt nur noch
    // der eigene Score.
    if (state.opponentOut && settings.announceTopout) {
      text = t('opponentOutPrefix') + ' ' + text;
    }

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
    // Chasedown: Gleichstand/Rückstand -> Vorsprung gegen einen gestorbenen
    // Gegner heißt der sichere Sieg (Scores können nicht mehr fallen).
    if (state.opponentOut && sign > 0 && prev <= 0) {
      emitEvent(t('opponentOutWin'), { interrupt: true, requireGap: false });
      return;
    }
    // 0 = Gleichstand: kein echter Führungswechsel, nicht ansagen.
    if (sign === 0 || prev === 0 || sign === prev) return;
    if (!settings.announceLeadChange) return;
    if (sign > 0) {
      emitEvent(t(isNarrowLead(s.diff) ? 'leadTakenKnapp' : 'leadTaken'));
    } else {
      emitEvent(t(isNarrowLead(s.diff) ? 'leadLostKnapp' : 'leadLost'));
    }
  }

  /* --- Chasedown / früher Sieg (Gegner-Topout) --------------------------- */

  function resetTopoutWatch() {
    state.oppSig = null;
    state.oppSigAt = null;
    state.oppFast = false;
    state.meSig = null;
    state.meSigAt = null;
    state.opponentOut = false;
  }

  /** Signatur einer Seite merken; merkt sich den Zeitpunkt der Änderung. */
  function trackSignature(selector, who) {
    const sig = sideSignature(document.querySelector(selector));
    if (!sig) return;
    const sigKey = who === 'opp' ? 'oppSig' : 'meSig';
    const atKey = who === 'opp' ? 'oppSigAt' : 'meSigAt';
    if (state[sigKey] === null) state[sigKey] = sig.value;
    else if (state[sigKey] !== sig.value) {
      state[sigKey] = sig.value;
      state[atKey] = Date.now();
    }
    if (who === 'opp' && sig.fast) state.oppFast = true;
  }

  /**
   * Chasedown-Erkennung: Solange ein Spieler noch spielt, ändern sich seine
   * Anzeigedaten ständig (Board, Next Piece, Drought-Counter, Score, Lines).
   * Nach einem Topout friert die ganze Seite ein – nestris.org meldet das
   * vor Spielende aber nicht (Victory/Defeat kommt erst, wenn beide raus
   * sind, siehe docs/protokoll.md). Wir messen deshalb den Stillstand:
   * gefriert die Gegneranzeige, während die eigene weiterläuft, ist der
   * Gegner raus.
   */
  function watchTopout() {
    if (!settings.announceTopout) {
      state.opponentOut = false;
      return;
    }
    if (!isPlaying() || state.opponentOut) return;

    const now = Date.now();
    trackSignature(DOM_SEL.sideOpponent, 'opp');
    trackSignature(DOM_SEL.sideMe, 'me');

    // "LEFT ROOM"/Abort ist ein anderer Fall: der Server bricht das Match ab.
    const oppBoardText = qs(document.querySelector(DOM_SEL.sideOpponent), DOM_SEL.countdown);
    const boardText = oppBoardText ? oppBoardText.textContent : '';
    if (boardText && /LEFT ROOM|Aborting/i.test(boardText)) return;

    const topoutMs = Math.max(3, Number(settings.topoutSec) || 5) * 1000;
    // Start-Countdown überspringen: vorher kann niemand topouten, und die
    // Daten laufen dort ohnehin noch (oder haben noch gar nicht angefangen).
    const graceMs = Math.min(Math.max(6000, topoutMs * 2), 15000);
    if (!state.inGameSince || now - state.inGameSince < graceMs) return;
    if (!state.oppFast) return; // nur langsame Signale: zu unsicher für ein "raus"
    if (state.oppSigAt === null) return; // noch keine Änderung beobachtet
    if (now - state.oppSigAt < topoutMs) return;
    // Die eigene Seite muss weiterlaufen – bin ich selbst tot, kündigt das
    // Spielende die Statusmaschine an, nicht diese Heuristik.
    if (state.meSigAt === null || now - state.meSigAt >= topoutMs) return;

    declareOpponentOut();
  }

  /** Der Gegner ist raus: Sieg ansagen (wenn ich führe) oder Chasedown. */
  function declareOpponentOut() {
    state.opponentOut = true;
    const s = state.scores || readScores();
    const diff = s ? s.diff : null;
    // Rückstand wird wie überall aufwärts gerundet – nie zu klein nennen.
    const text =
      typeof diff !== 'number'
        ? t('opponentOutGeneric')
        : diff > 0
          ? t('opponentOutWin')
          : diff < 0
            ? t('opponentOutChase', roundDeficitUp(-diff))
            : t('opponentOutTie');
    emitEvent(text, { interrupt: true, requireGap: false });
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
      <label class="row"><span>Chasedown / Sieg ansagen</span><input type="checkbox" data-key="announceTopout"></label>
      <label class="row"><span>Topout erkennen nach</span>
        <input type="number" min="3" max="60" step="1" data-key="topoutSec"> Sek. Stillstand</label>
      <label class="row"><span>Spielstand ansagen</span><input type="checkbox" data-key="announceSeries"></label>
      <label class="row"><span>Sprache</span>
        <select data-key="language">
          <option value="de">Deutsch</option>
          <option value="en">English</option>
        </select></label>
      <label class="row"><span>Stimme</span><select data-key="voiceURI"></select></label>
      <label class="row"><span>Tempo</span><input type="range" min="0.6" max="1.6" step="0.05" data-key="rate"></label>
      <label class="row"><span>Lautstärke</span><input type="range" min="0" max="1" step="0.05" data-key="volume"></label>
      <label class="row"><span>Sprach-Backend</span>
        <select data-key="ttsBackend">
          <option value="auto">Auto (Server, sonst Browser)</option>
          <option value="server">Server (Supertonic)</option>
          <option value="browser">Browser (speechSynthesis)</option>
        </select></label>
      <label class="row"><span>TTS-Server</span><input type="text" data-key="ttsUrl" size="20"></label>
      <label class="row"><span>Server-Stimme</span><input type="text" data-key="ttsVoice" size="6"></label>

      <div class="buttons">
        <button class="act" data-action="test">Ansage testen</button>
        <button class="act" data-action="close">Schließen</button>
      </div>
      <p class="hint">Ansagen starten automatisch, sobald ein Spiel läuft (Status IN_GAME).
         Einstellungen werden lokal im Browser gespeichert.
         "Server" ist der lokale audio.cpp-Dienst (siehe README „Sprachausgabe
         über einen lokalen TTS-Server"); ohne ihn übernimmt automatisch die Browser-Stimme.</p>
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
      const serverActive = Boolean(info.server && info.server.ready);
      if (!info.supported && !serverActive) {
        ui.updateStatus('Status: Sprachausgabe wird von diesem Browser nicht unterstützt.');
        return;
      }
      if (!serverActive && info.voiceCount === 0) {
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
    // Der stumme Probe-Übergang braucht nur die Browser-Stimme; für die
    // Server-WAV genügt die Nutzergeste selbst (audio.play() ist dann frei).
    if (TTS.supported && !speechUnlocked) {
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
    watchTopout();
    updateStatusLine();
  }

  /** Kurzbeschreibung des Sprachzustands für die Statuszeile. */
  function speechStatusText() {
    const info = TTS.getInfo();
    const server = info.server || {};
    let line;
    if (server.ready) {
      const ms =
        server.latencyMs === null || server.latencyMs === undefined ? '' : ` · ${server.latencyMs} ms`;
      line = `Sprache: lokaler Server (${settings.ttsVoice || 'M1'}, ${server.cacheSize} im Cache${ms})`;
    } else {
      if (!info.supported) return 'Sprache: wird vom Browser nicht unterstützt';
      if (info.voiceCount === 0) {
        // Häufigster Fall: Linux. Chromium-Browser (Vivaldi/Chrome/Brave/Chromium)
        // haben speech-dispatcher eingebaut, halten die Anbindung aber per Flag
        // versteckt (siehe README "Sprachausgabe unter Linux").
        return 'Sprache: KEINE Stimmen gefunden – auf Linux "speech-dispatcher" installieren; Chromium-Browser zusätzlich mit --enable-speech-dispatcher starten';
      }
      const voice = info.voice ? `${info.voice.name} (${info.voice.lang})` : 'Standardstimme';
      line = server.wanted
        ? `Sprache: Browser-Stimme (TTS-Server nicht erreichbar, ${voice})`
        : `Sprache: ${voice}`;
    }
    if (info.needsGesture) line += ' · ⚠ bitte einmal klicken (Autoplay-Schutz)';
    else if (info.lastError && Date.now() - info.lastError.at < 15000) {
      line += ` · ⚠ Fehler: ${info.lastError.name}`;
    }
    return line;
  }

  /** Kurzzeile zum WebSocket-Mitschnitt (Issue #6 – Regressionstest). */
  function hookStatusText() {
    const h = state.hook;
    if (!h.installed) return 'Mitschnitt: inaktiv (⚠ Hook nicht in der Seite)';
    const fresh = state.wsSeen ? '' : ' · noch keine WS-Nachricht';
    return `Mitschnitt: aktiv (${h.mode})${fresh}`;
  }

  /**
   * Diagnose-Spiegel für die Seitenkonsole (Issue #6): Läuft das Skript in
   * einer Sandbox, ist window.NestrisHomie dort nicht sichtbar – der
   * Datensatz am <html>-Element zeigt denselben Stand in beiden Welten:
   *   JSON.parse(document.documentElement.dataset.nestrisHomie)
   */
  function mirrorDiagnostics() {
    try {
      const el = document.documentElement;
      if (!el) return;
      el.dataset.nestrisHomie = JSON.stringify({
        modus: state.hook.mode,
        mitschnitt: state.hook.installed,
        letzteWs: state.hook.lastMsgAt,
        wsGesehen: state.wsSeen,
        status: state.status,
        raum: state.roomStatus,
        aktiv: settings.enabled,
      });
    } catch (err) {
      // Nur Diagnose – Fehler hier dürfen die Statuszeile nicht stören.
    }
  }

  function updateStatusLine() {
    if (!ui.updateStatus) return;
    const render = (text) => {
      ui.updateStatus(`${text}\n${hookStatusText()}`);
      mirrorDiagnostics();
    };
    if (!settings.enabled) {
      render(`Status: deaktiviert\n${speechStatusText()}`);
      return;
    }
    if (!inRoom()) {
      render(`Status: kein Match (warte auf Raum)\n${speechStatusText()}`);
      return;
    }
    const s = state.scores;
    const role = state.roomStatus === 'spectator' ? 'Zuschauer' : 'Spieler';
    if (!s) {
      render(`Status: ${state.status || '–'} · ${role} · keine Spieldaten\n${speechStatusText()}`);
      return;
    }
    const diff = s.diff === null ? '–' : (s.diff > 0 ? '+' : '') + s.diff;
    const out = state.opponentOut ? ' · Gegner raus' : '';
    render(
      `Status: ${state.status || '–'} · ${role}\n` +
        `Du: ${s.myScore ?? '–'} · Gegner: ${s.oppScore ?? '–'} · Differenz: ${diff}${out}\n` +
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
    ServerTTS.start();
    // Diagnose für Issue #6: Welcher Kontext greift und ist der Hook gelandet?
    console.log(LOG, 'Startkontext:', {
      hook: state.hook.mode,
      mitschnitt: state.hook.installed,
      sandbox: isSandboxWorld(),
      gmXhr:
        typeof GM_xmlhttpRequest === 'function' ||
        (typeof GM !== 'undefined' && Boolean(GM) && typeof GM.xmlHttpRequest === 'function'),
    });

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
  const debugApi = {
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
          info.needsGesture
            ? 'Autoplay-Schutz: einmal auf die Seite klicken.'
            : info.server && info.server.ready
              ? 'Lokaler TTS-Server aktiv (Supertonic).'
              : !info.supported
                ? 'Browser unterstützt speechSynthesis nicht.'
                : info.voiceCount === 0
                  ? 'Keine Stimmen vorhanden: im Browser/TTS-System nachsehen (z. B. Sprachausgabe aktiviert?).'
                  : info.server && info.server.wanted
                    ? 'TTS-Server nicht erreichbar – es spricht die Browser-Stimme; ansonsten sollte die Sprachausgabe funktionieren.'
                    : 'Sprachausgabe sollte funktionieren.',
      };
    },
    /** Test der Wiederholung nach Autoplay-Sperre (siehe speechInfo().needsGesture). */
    retryFailedSpeech: () => TTS.retryFailed(),
    /**
     * Chasedown-Diagnose für die Browserkonsole:
     *   NestrisHomie.topoutInfo()
     * Zeigt, wie alt die Lebenszeichen beider Seiten sind, ob ein schnelles
     * Signal (Board/Next Piece/DRT) erkannt wurde und ob der Gegner bereits
     * als raus gemeldet ist.
     */
    topoutInfo: () => ({
      opponentOut: state.opponentOut,
      active: settings.announceTopout && isPlaying(),
      thresholdSec: settings.topoutSec,
      oppAgeMs: state.oppSigAt === null ? null : Date.now() - state.oppSigAt,
      meAgeMs: state.meSigAt === null ? null : Date.now() - state.meSigAt,
      oppFast: state.oppFast,
      inGameAgeMs: state.inGameSince === null ? null : Date.now() - state.inGameSince,
    }),
  };

  // Debug-Hilfe in der Seitenkonsole (Seitenkontext) bzw. der TM-Konsole
  // (Sandbox – dort zeigt der Datensatz am <html>-Element denselben Stand):
  //   JSON.parse(document.documentElement.dataset.nestrisHomie)
  window.NestrisHomie = debugApi;

  start();
})();
