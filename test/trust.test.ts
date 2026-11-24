import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agyAllowList, agyHasChordServer, claudeMcpChoices, claudeTrusts, codexFirstStart, disabledCodexHooks } from '../src/trust.ts';

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

test('claudeMcpChoices reads .mcp.json approvals from the repository\'s settings.local.json, the user\'s settings.json and, as before, ~/.claude.json', () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-mcp-')));
  const repo = path.join(home, 'repo'); fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  const claudeJson = path.join(home, 'claude.json'), userSettings = path.join(home, 'settings.json');
  const none = { all: false, enabled: [], disabled: [] };
  assert.deepEqual(claudeMcpChoices(repo, claudeJson, userSettings), none); // nothing anywhere
  // Claude Code 2.1.323 and later write the approval dialogue's answers into the folder's settings.local.json
  fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['a', 'x'], disabledMcpjsonServers: ['b'] }));
  assert.deepEqual(claudeMcpChoices(repo, claudeJson, userSettings), { all: false, enabled: ['a', 'x'], disabled: ['b'] });
  // the user's own settings add to that; a server disabled anywhere stays disabled, whoever enabled it
  fs.writeFileSync(userSettings, JSON.stringify({ enabledMcpjsonServers: ['c'], disabledMcpjsonServers: ['x'] }));
  // older versions kept them in ~/.claude.json under the project, still read for whoever has not migrated
  fs.writeFileSync(claudeJson, JSON.stringify({ projects: { [repo.replace(/\\/g, '/')]: { enabledMcpjsonServers: ['d'] } } }));
  const c = claudeMcpChoices(repo, claudeJson, userSettings);
  assert.deepEqual([c.all, c.enabled.sort(), c.disabled.sort()], [false, ['a', 'c', 'd', 'x'], ['b', 'x']]);
  fs.writeFileSync(userSettings, JSON.stringify({ enableAllProjectMcpServers: true }));
  assert.equal(claudeMcpChoices(repo, claudeJson, userSettings).all, true);
  fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{oops'); fs.writeFileSync(userSettings, 'null');
  assert.deepEqual(claudeMcpChoices(repo, claudeJson, userSettings), { all: false, enabled: ['d'], disabled: [] }); // broken files count as empty
});

test('agyAllowList reads the permissions.allow list of the user\'s agy settings; agyHasChordServer spots a global server named chord', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chord-agy-'));
  const settings = path.join(home, 'settings.json'), mcp = path.join(home, 'mcp_config.json');
  assert.deepEqual(agyAllowList(settings), []); // no file
  fs.writeFileSync(settings, JSON.stringify({ toolPermission: 'request-review', permissions: { allow: ['command(git status)', 'mcp(fs/*)'], deny: ['command(rm)'] } }));
  assert.deepEqual(agyAllowList(settings), ['command(git status)', 'mcp(fs/*)']);
  fs.writeFileSync(settings, '{oops');
  assert.deepEqual(agyAllowList(settings), []); // a broken file counts as empty
  assert.equal(agyHasChordServer(mcp), false); // no file
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { playwright: { command: 'npx' } } }));
  assert.equal(agyHasChordServer(mcp), false);
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { playwright: { command: 'npx' }, chord: { command: 'node' } } }));
  assert.equal(agyHasChordServer(mcp), true);
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
