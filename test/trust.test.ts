import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeTrusts, codexFirstStart, disabledCodexHooks } from '../src/trust.ts';

test('disabledCodexHooks names the chord hooks switched off in Codex\'s config', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-codex-')), 'config.toml');
  fs.writeFileSync(file, [
    'model = "gpt-5"',
    '',
    '[hooks.state]',
    '',
    '[hooks.state."some-plugin@x:hooks/h.json:session_start:0:0"]',
    'trusted_hash = "sha256:aa"',
    'enabled = false', // another tool's hook: not ours
    '',
    "[hooks.state.'C:\\<session-flags>\\config.toml:pre_tool_use:0:0']",
    'trusted_hash = "sha256:bb"',
    '',
    "[hooks.state.'C:\\<session-flags>\\config.toml:post_tool_use:0:0']",
    'trusted_hash = "sha256:cc"',
    'enabled = false',
    '',
    "[hooks.state.'C:\\<session-flags>\\config.toml:session_start:0:0']",
    'trusted_hash = "sha256:dd"',
    'enabled=false',
    '',
    '[windows]',
    'enabled = false', // unrelated table after ours
  ].join('\n'));
  assert.deepEqual(disabledCodexHooks(file), ['post_tool_use', 'session_start']);
  assert.deepEqual(disabledCodexHooks(path.join(path.dirname(file), 'missing.toml')), []);
});

test('claudeTrusts reads the trust answer for a folder in either path form', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-trust2-')), 'claude.json');
  fs.writeFileSync(file, JSON.stringify({ projects: { 'D:/p/repo': { hasTrustDialogAccepted: true }, 'D:/p/other': { hasTrustDialogAccepted: false } } }));
  assert.equal(claudeTrusts('D:\\p\\repo', file), true);
  assert.equal(claudeTrusts('d:/P/REPO', file), true);
  assert.equal(claudeTrusts('D:/p/other', file), false);
  assert.equal(claudeTrusts('D:/p/unknown', file), false);
  assert.equal(claudeTrusts('D:/p/repo', path.join(path.dirname(file), 'missing.json')), false);
});

test('codexFirstStart: without a Codex state database, a second launch waits until the first one\'s Codex has made it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chord-codex-'));
  const release1 = await codexFirstStart(home);
  let second = false;
  const waiting = codexFirstStart(home).then(r => { second = true; return r; });
  await new Promise(r => setTimeout(r, 600));
  assert.equal(second, false, 'the second launch must wait while the first Codex starts');
  release1(); // the first Codex has been spawned ...
  fs.writeFileSync(path.join(home, 'state_5.sqlite'), ''); // ... and creates its database
  (await waiting)();
  assert.equal(second, true);
  assert.equal(fs.existsSync(path.join(home, '.chord-first-start')), false, 'the lock is gone once the database is there');
  const t0 = Date.now(); (await codexFirstStart(home))();
  assert.ok(Date.now() - t0 < 100, 'with the database in place nobody waits');
});
