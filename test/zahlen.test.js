#!/usr/bin/env node
/*
 * Minimaler Regressionstest für die deutsche Zahlwort-Umwandlung.
 * Ohne Abhängigkeiten: Der Test liest den Hilfsblock direkt aus dem Userscript
 * (markiert mit "// @test-helpers:start / :end") und prüft bekannte Werte.
 *
 * Aufruf: node test/zahlen.test.js
 */

const fs = require('fs');
const path = require('path');

const scriptPath = path.join(__dirname, '..', 'nestris-homie.user.js');
const source = fs.readFileSync(scriptPath, 'utf8');

const start = source.indexOf('// @test-helpers:start');
const end = source.indexOf('// @test-helpers:end');
if (start === -1 || end === -1) {
  console.error('Test-Hilfsblock im Userscript nicht gefunden.');
  process.exit(1);
}

const block = source.slice(start + '// @test-helpers:start'.length, end);
const factory = new Function(`${block}\nreturn { deWords, deUnder100, deUnder1000 };`);
const { deWords } = factory();

const cases = [
  [0, 'null'],
  [1, 'eins'],
  [2, 'zwei'],
  [13, 'dreizehn'],
  [15, 'fünfzehn'],
  [19, 'neunzehn'],
  [20, 'zwanzig'],
  [21, 'einundzwanzig'],
  [42, 'zweiundvierzig'],
  [55, 'fünfundfünfzig'],
  [60, 'sechzig'],
  [70, 'siebzig'],
  [99, 'neunundneunzig'],
  [100, 'einhundert'],
  [101, 'einhunderteins'],
  [111, 'einhundertelf'],
  [123, 'einhundertdreiundzwanzig'],
  [200, 'zweihundert'],
  [999, 'neunhundertneunundneunzig'],
  [1000, 'eintausend'],
  [1001, 'eintausendeins'],
  [1100, 'eintausendeinhundert'],
  [1234, 'eintausendzweihundertvierunddreißig'],
  [5000, 'fünftausend'],
  [20000, 'zwanzigtausend'],
  [21000, 'einundzwanzigtausend'],
  [42000, 'zweiundvierzigtausend'],
  [100000, 'einhunderttausend'],
  [120000, 'einhundertzwanzigtausend'],
  [123456, 'einhundertdreiundzwanzigtausendvierhundertsechsundfünfzig'],
  [999999, 'neunhundertneunundneunzigtausendneunhundertneunundneunzig'],
  [1000000, 'eine Million'],
  [1250000, 'eine Million zweihundertfünfzigtausend'],
  [2345678, 'zwei Millionen dreihundertfünfundvierzigtausendsechshundertachtundsiebzig'],
];

let failed = 0;
for (const [input, expected] of cases) {
  const actual = deWords(input);
  if (actual !== expected) {
    failed += 1;
    console.error(`FAIL deWords(${input}) => "${actual}", erwartet "${expected}"`);
  }
}

// Negative Zahlen (Differenz wird vorher normalisiert, aber absichern)
if (deWords(-1234) !== 'eintausendzweihundertvierunddreißig') {
  failed += 1;
  console.error('FAIL deWords(-1234) sollte den Betrag umwandeln');
}

if (failed === 0) {
  console.log(`OK – ${cases.length + 1} Fälle geprüft.`);
} else {
  console.error(`${failed} Fehler.`);
  process.exit(1);
}
