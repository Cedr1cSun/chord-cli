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
  g.onUserInput('\x1b', 1700);
  assert.equal(g.clear(1700), true);
});

test('resolveCommand unwraps npm .cmd shims on windows', { skip: process.platform !== 'win32' }, () => {
  const shim = '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
  const r = resolveCommand('codex', () => shim, () => 'C:\\npm\\codex.cmd');
  assert.equal(r.file, process.execPath);
  assert.deepEqual(r.args, ['C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js']);
  assert.deepEqual(resolveCommand('claude', () => '', () => 'C:\\bin\\claude.exe'), { file: 'C:\\bin\\claude.exe', args: [] });
  assert.throws(() => resolveCommand('nope', () => '', () => undefined), /not found/);
});
