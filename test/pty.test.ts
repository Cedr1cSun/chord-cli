import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputGate, decodeKeys, nextAction, nudgeEchoed, oscState, resolveCommand, stripAnsi, whereIs } from '../src/pty.ts';

const key = (uc: number, down = 1, ctrl = 0) => `\x1b[${uc};0;${uc};${down};${ctrl};1_`;

test('InputGate holds while a draft is being typed and releases only on Enter or Esc, however long the user takes', () => {
  const g = new InputGate();
  assert.equal(g.clear(), true);
  g.onUserInput('hel');
  assert.equal(g.clear(), false);
  g.onUserInput('lo\r');
  assert.equal(g.clear(), true);
  g.onUserInput('x');
  assert.equal(g.clear(), false); // no staleness rule: a half-typed line keeps chord out until the user deals with it
  g.onUserInput('\x1b');
  assert.equal(g.clear(), true);
  g.onUserInput('\x1b[B'); // arrow key: neither a draft nor a submit
  assert.equal(g.clear(), true);
  g.onUserInput('abc');
  g.onUserInput('\x1b[24;1R\x1b[?62;c'); // terminal replies to queries do not touch the draft state
  assert.equal(g.clear(), false);
  g.onUserInput('\r');
  assert.equal(g.clear(), true);
});

test('InputGate: backspace empties a draft, Ctrl+U/Ctrl+C clear it, a paste with newlines stays a draft, Shift+Enter is not a submit', () => {
  const g = new InputGate();
  g.onUserInput('ab'); g.onUserInput('\x7f'); assert.equal(g.clear(), false);
  g.onUserInput('\x7f'); assert.equal(g.clear(), true);
  g.onUserInput('typing'); g.onUserInput('\x15'); assert.equal(g.clear(), true); // Ctrl+U
  g.onUserInput('typing'); g.onUserInput('\x03'); assert.equal(g.clear(), true); // Ctrl+C
  g.onUserInput('\x1b[200~line one\nline two\n\x1b[201~'); assert.equal(g.clear(), false); // pasted text waits for Enter
  g.onUserInput('\r'); assert.equal(g.clear(), true);
  g.onUserInput(key(97) + key(13, 1, 0x10)); assert.equal(g.clear(), false); // 'a' then Shift+Enter: still a draft
  g.onUserInput(key(13)); assert.equal(g.clear(), true);
});

test('InputGate decodes win32-input-mode key events, including a sequence split across chunks', () => {
  const g = new InputGate();
  g.onUserInput(key(16, 1) + key(72) + key(72, 0) + key(16, 0)); // Shift, 'H' down, 'H' up, Shift up
  assert.equal(g.clear(), false);
  const enter = key(13) + key(13, 0);
  g.onUserInput(enter.slice(0, 7)); // chunk boundary inside the Enter sequence
  assert.equal(g.clear(), false);
  g.onUserInput(enter.slice(7));
  assert.equal(g.clear(), true);
  g.onUserInput(key(97));
  g.onUserInput('\x1b[24;1R\x1b[?62;c'); // plain terminal replies still ignored
  assert.equal(g.clear(), false);
  g.onUserInput(key(27)); // Esc clears the draft
  assert.equal(g.clear(), true);
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

test('nextAction nudges once, presses Enter once more only when the text was echoed, retypes 30s after the nudge', () => {
  const base = { status: 'idle', unread: true, gateClear: true, nudgedAt: 0, echoed: false, enters: 0, enteredAt: 0 };
  assert.equal(nextAction(base, 100_000), 'nudge');
  const typed = { ...base, nudgedAt: 100_000 };
  assert.equal(nextAction(typed, 103_000), null); // echo check pending
  assert.equal(nextAction(typed, 110_000), null); // not echoed: a dialog ate it, hands off
  const entered = { ...typed, echoed: true, enters: 1, enteredAt: 101_500 };
  assert.equal(nextAction(entered, 103_000), null);
  assert.equal(nextAction(entered, 106_600), 'enter'); // one retry
  assert.equal(nextAction({ ...entered, enters: 2, enteredAt: 106_600 }, 120_000), null); // never a third
  assert.equal(nextAction({ ...typed, echoed: true, enters: 0 }, 110_000), null); // the user got there first: leave it alone
  assert.equal(nextAction({ ...entered, enters: 2, enteredAt: 125_000 }, 131_000), 'nudge'); // retyped 30s after the nudge
  assert.equal(nextAction({ ...base, status: 'busy' }, 100_000), null);
  assert.equal(nextAction({ ...base, unread: false }, 100_000), null);
  assert.equal(nextAction({ ...base, gateClear: false }, 100_000), null);
});

test('nudgeEchoed sees the nudge through re-rendering, wrapping and escape sequences, and not when a dialog ate it', () => {
  assert.equal(nudgeEchoed('\x1b[?25l\x1b[2K\r> [chord] You have new\r\n  messages from other agents;\x1b[?25h'), true);
  assert.equal(nudgeEchoed('\x1b[1;1H› [ch\x1b[Kord] You ha\x1b[Kve new messag\x1b[Kes from'), true);
  assert.equal(nudgeEchoed('Hooks need review\n› 1. Review hooks\n  2. Trust all and continue'), false);
  assert.equal(nudgeEchoed(''), false);
  assert.equal(stripAnsi('a\x1b]7501;state=idle:app=codex\x1b\\b\x1b[31mc\x1b[0m\x1bPq..\x1b\\d\x1b(Be'), 'abcde');
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
