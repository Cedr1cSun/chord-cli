import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputGate, decodeKeys, nextAction, oscState, resolveCommand, whereIs } from '../src/pty.ts';

const key = (uc: number, down = 1, ctrl = 0) => `\x1b[${uc};0;${uc};${down};${ctrl};1_`;

test('InputGate holds while a draft is being typed, releases on Enter/Esc or after staleness', () => {
  const g = new InputGate(1000);
  assert.equal(g.clear(0), true);
  g.onUserInput('hel', 100);
  assert.equal(g.clear(200), false);
  g.onUserInput('lo\r', 300);
  assert.equal(g.clear(400), true);
  g.onUserInput('x', 500);
  assert.equal(g.clear(1400), false);
  assert.equal(g.clear(1600), true); // walked away
  g.onUserInput('\x1b[B', 1700); // arrow key: neither a draft nor a submit
  assert.equal(g.clear(1700), true);
  g.onUserInput('abc', 1800);
  g.onUserInput('\x1b[24;1R\x1b[?62;c', 1900); // terminal replies to queries do not touch the draft state
  assert.equal(g.clear(1950), false);
  g.onUserInput('\r', 2000);
  assert.equal(g.clear(2000), true);
});

test('InputGate: backspace empties a draft, Ctrl+U/Ctrl+C clear it, a paste with newlines stays a draft, Shift+Enter is not a submit', () => {
  const g = new InputGate(60_000);
  g.onUserInput('ab', 10); g.onUserInput('\x7f', 20); assert.equal(g.clear(30), false);
  g.onUserInput('\x7f', 40); assert.equal(g.clear(50), true);
  g.onUserInput('typing', 60); g.onUserInput('\x15', 70); assert.equal(g.clear(80), true); // Ctrl+U
  g.onUserInput('typing', 90); g.onUserInput('\x03', 100); assert.equal(g.clear(110), true); // Ctrl+C
  g.onUserInput('\x1b[200~line one\nline two\n\x1b[201~', 120); assert.equal(g.clear(130), false); // pasted text waits for Enter
  g.onUserInput('\r', 140); assert.equal(g.clear(150), true);
  g.onUserInput(key(97) + key(13, 1, 0x10), 160); assert.equal(g.clear(170), false); // 'a' then Shift+Enter: still a draft
  g.onUserInput(key(13), 180); assert.equal(g.clear(190), true);
});

test('InputGate decodes win32-input-mode key events, including a sequence split across chunks', () => {
  const g = new InputGate(1000);
  g.onUserInput(key(16, 1) + key(72) + key(72, 0) + key(16, 0), 100); // Shift, 'H' down, 'H' up, Shift up
  assert.equal(g.clear(200), false);
  const enter = key(13) + key(13, 0);
  g.onUserInput(enter.slice(0, 7), 300); // chunk boundary inside the Enter sequence
  assert.equal(g.clear(300), false);
  g.onUserInput(enter.slice(7), 400);
  assert.equal(g.clear(400), true);
  g.onUserInput(key(97), 500);
  g.onUserInput('\x1b[24;1R\x1b[?62;c', 600); // plain terminal replies still ignored
  assert.equal(g.clear(600), false);
  g.onUserInput(key(27), 700); // Esc clears the draft
  assert.equal(g.clear(700), true);
});

test('decodeKeys drops OSC, DCS, SS3 and mouse sequences and holds any unfinished one', () => {
  let held = '';
  const dec = (s: string) => decodeKeys(s, r => { held = r; });
  assert.equal(dec('\x1b]11;rgb:0000/0000/0000\x1b\\'), ''); // OSC reply with ST terminator
  assert.equal(dec('\x1b]0;title\x07'), ''); // OSC with BEL
  assert.equal(dec('\x1bP>|ConPTY 1.19\x1b\\'), ''); // DCS reply with printable payload
  assert.equal(dec('\x1bOA\x1bOB'), ''); // SS3 arrows
  assert.equal(dec('\x1b[<35;10;5M'), ''); // SGR mouse report
  assert.equal(dec('ab\x1b]11;rgb:00'), 'ab'); assert.equal(held, '\x1b]11;rgb:00'); // unfinished OSC is held
  assert.equal(dec('x\x1b'), 'x'); assert.equal(held, '\x1b'); // chunk ending right after ESC
  assert.equal(dec('\x1b'), '\x1b'); // a bare Esc key is a key
  assert.equal(dec('\x1b\x1b'), '\x1b'); // Esc twice (some terminals) is an Esc key
  assert.equal(dec('\x1bx'), ''); // Alt+x is not text
});

test('nextAction nudges once, retries Enter 5s after the last Enter, retypes 30s after the nudge', () => {
  const base = { status: 'idle', unread: true, gateClear: true, nudgedAt: 0, enteredAt: 0 };
  assert.equal(nextAction(base, 100_000), 'nudge');
  const nudged = { ...base, nudgedAt: 100_000, enteredAt: 101_000 };
  assert.equal(nextAction(nudged, 103_000), null);
  assert.equal(nextAction(nudged, 106_500), 'enter');
  assert.equal(nextAction({ ...nudged, enteredAt: 106_500 }, 110_000), null); // the retry does not restart the 30s clock
  assert.equal(nextAction({ ...nudged, enteredAt: 125_000 }, 131_000), 'nudge'); // but the nudge is retyped after 30s
  assert.equal(nextAction({ ...base, status: 'busy' }, 100_000), null);
  assert.equal(nextAction({ ...base, unread: false }, 100_000), null);
  assert.equal(nextAction({ ...base, gateClear: false }, 100_000), null);
});

test('oscState reads the last Codex state report in a chunk', () => {
  assert.equal(oscState('text\x1b]7501;state=working:app=codex\x1b\\more'), 'busy');
  assert.equal(oscState('\x1b]7501;state=working:app=codex\x1b\\..\x1b]7501;state=idle:app=codex\x1b\\'), 'idle');
  assert.equal(oscState('no report here'), null);
});

test('whereIs scans PATH without where.exe', () => {
  const exists = (p: string) => p === 'C:\\tools\\codex.cmd' || p === 'C:\\bin\\claude.exe';
  assert.equal(whereIs('codex', 'C:\\nothing;C:\\tools', exists), 'C:\\tools\\codex.cmd');
  assert.equal(whereIs('claude', 'C:\\bin', exists), 'C:\\bin\\claude.exe');
  assert.equal(whereIs('nope', 'C:\\bin', exists), undefined);
});

test('resolveCommand unwraps npm, pnpm and yarn .cmd shims on windows', { skip: process.platform !== 'win32' }, () => {
  const npm = '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
  const r = resolveCommand('codex', () => npm, () => 'C:\\npm\\codex.cmd');
  assert.equal(r.file, process.execPath);
  assert.deepEqual(r.args, ['C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js']);
  const pnpm = '@SETLOCAL\r\nnode "%~dp0\\node_modules\\x\\bin\\x.js" %*\r\n';
  assert.deepEqual(resolveCommand('x', () => pnpm, () => 'C:\\p\\x.cmd').args, ['C:\\p\\node_modules\\x\\bin\\x.js']);
  assert.deepEqual(resolveCommand('claude', () => '', () => 'C:\\bin\\claude.exe'), { file: 'C:\\bin\\claude.exe', args: [] });
  assert.throws(() => resolveCommand('nope', () => '', () => undefined), /not found/);
});
