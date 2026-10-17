import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { disabledCodexHooks, pretrustClaude } from '../src/trust.ts';

test('pretrustClaude adds a trusted project entry and leaves the rest of the file alone', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-trust-')), 'claude.json');
  fs.writeFileSync(file, JSON.stringify({ numStartups: 3, projects: { 'D:/other': { allowedTools: ['x'], hasTrustDialogAccepted: true } } }));
  assert.equal(pretrustClaude('D:\\proj\\chord\\agents\\a', file), true);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.numStartups, 3);
  assert.deepEqual(cfg.projects['D:/other'], { allowedTools: ['x'], hasTrustDialogAccepted: true });
  // Claude Code keys projects by the cwd with forward slashes, so that is the form written
  assert.equal(cfg.projects['D:\\proj\\chord\\agents\\a'], undefined);
  assert.equal(cfg.projects['D:/proj/chord/agents/a'].hasTrustDialogAccepted, true);
  assert.deepEqual(cfg.projects['D:/proj/chord/agents/a'].allowedTools, []);
  assert.equal(pretrustClaude('D:\\proj\\chord\\agents\\a', file), false); // already trusted
  assert.equal(pretrustClaude('d:/PROJ/chord/agents/A', file), false); // same folder, other case and separators
  // an existing entry keeps its own fields
  fs.writeFileSync(file, JSON.stringify({ projects: { 'D:/w': { allowedTools: ['Bash'], hasTrustDialogAccepted: false, lastCost: 1.5 } } }));
  assert.equal(pretrustClaude('D:\\w', file), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects, { 'D:/w': { allowedTools: ['Bash'], hasTrustDialogAccepted: true, lastCost: 1.5 } });
  assert.equal(pretrustClaude('D:\\w', path.join(path.dirname(file), 'missing.json')), false); // no Claude config: nothing to do
  fs.writeFileSync(file, '{not json');
  assert.equal(pretrustClaude('D:\\w', file), false); // never rewrites a file it cannot parse
});

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
