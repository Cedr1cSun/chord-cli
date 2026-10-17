import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputGate, resolveCommand } from '../src/pty.ts';

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

test('InputGate decodes win32-input-mode key events, including a sequence split across chunks', () => {
  const key = (uc: number, down = 1) => `\x1b[${uc};0;${uc};${down};0;1_`;
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

test('resolveCommand unwraps npm .cmd shims on windows', { skip: process.platform !== 'win32' }, () => {
  const shim = '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
  const r = resolveCommand('codex', () => shim, () => 'C:\\npm\\codex.cmd');
  assert.equal(r.file, process.execPath);
  assert.deepEqual(r.args, ['C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js']);
  assert.deepEqual(resolveCommand('claude', () => '', () => 'C:\\bin\\claude.exe'), { file: 'C:\\bin\\claude.exe', args: [] });
  assert.throws(() => resolveCommand('nope', () => '', () => undefined), /not found/);
});

test('nextAction nudges once, retries Enter after 5s, retypes after 30s', async () => {
  const { nextAction } = await import('../src/pty.ts');
  const base = { status: 'idle', unread: true, gateClear: true, nudgedAt: 0 };
  assert.equal(nextAction(base, 100_000), 'nudge');
  assert.equal(nextAction({ ...base, nudgedAt: 100_000 }, 103_000), null);
  assert.equal(nextAction({ ...base, nudgedAt: 100_000 }, 106_000), 'enter');
  assert.equal(nextAction({ ...base, nudgedAt: 100_000 }, 131_000), 'nudge');
  assert.equal(nextAction({ ...base, status: 'busy' }, 100_000), null);
  assert.equal(nextAction({ ...base, unread: false }, 100_000), null);
  assert.equal(nextAction({ ...base, gateClear: false }, 100_000), null);
});
