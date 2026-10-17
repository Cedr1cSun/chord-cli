import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/db.ts';
import { mainRoot, ensureExcluded, ensureWorktree, pickName, claudeArgs, codexArgs, prepare, hookCommand } from '../src/launch.ts';

function tempRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chord-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return fs.realpathSync(root);
}

test('mainRoot from the root and from inside a worktree', () => {
  const root = tempRepo();
  assert.equal(mainRoot(root), root);
  const wt = ensureWorktree(root, 'x');
  assert.equal(mainRoot(wt), root);
  assert.equal(ensureWorktree(root, 'x'), wt); // idempotent
  assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim(), 'chord/x');
});

test('ensureExcluded appends once', () => {
  const root = tempRepo();
  ensureExcluded(root); ensureExcluded(root);
  const lines = fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8').split('\n').filter(l => l === '.chord/');
  assert.equal(lines.length, 1);
});

test('pickName derives from tool and repo, refuses an online duplicate', () => {
  const d = db.openDb(':memory:');
  assert.match(pickName(d, 'claude', '/x/My Repo'), /^claude-my-repo-[0-9a-f]{4}$/);
  db.addAgent(d, { name: 'busy', tool: 'codex', pid: process.pid, cwd: '/' });
  assert.throws(() => pickName(d, 'codex', '/x', 'busy'), /already online/);
  db.setStatus(d, 'busy', 'offline');
  assert.equal(pickName(d, 'codex', '/x', 'busy'), 'busy');
});

test('claudeArgs carries hooks in --settings and the server in --mcp-config', () => {
  const env = { CHORD_AGENT_ID: 'a', CHORD_DB: '/db', CHORD_TOOL: 'claude' };
  const args = claudeArgs(env);
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit');
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, hookCommand('pre-tool-use'));
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].timeout, 10);
  const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
  assert.equal(mcp.mcpServers.chord.command, 'node');
  assert.deepEqual(mcp.mcpServers.chord.env, env);
  assert.ok(!args.includes('--strict-mcp-config'));
});

test('codexArgs is a list of -c TOML overrides', () => {
  const args = codexArgs({ CHORD_AGENT_ID: 'a', CHORD_DB: '/db', CHORD_TOOL: 'codex' });
  assert.equal(args.filter(a => a === '-c').length, 7);
  const pre = args.find(a => a.startsWith('hooks.PreToolUse='))!;
  assert.ok(pre.includes('matcher="^apply_patch$"'));
  assert.ok(pre.includes(`command=${JSON.stringify(hookCommand('pre-tool-use'))}`));
  assert.ok(args.find(a => a.startsWith('mcp_servers.chord='))!.includes('env={CHORD_AGENT_ID="a",CHORD_DB="/db",CHORD_TOOL="codex"}'));
  // paths with quotes, spaces and non-ASCII survive as TOML basic strings
  const odd = codexArgs({ CHORD_AGENT_ID: 'a', CHORD_DB: "C:/repo o'brien/仓库/.git/chord.db", CHORD_TOOL: 'codex' });
  assert.ok(odd.find(a => a.startsWith('mcp_servers.chord='))!.includes(`CHORD_DB="C:/repo o'brien/仓库/.git/chord.db"`));
});

test('prepare creates the worktree and db and names the agent', () => {
  const root = tempRepo();
  const l = prepare('codex', root);
  assert.ok(fs.existsSync(path.join(l.worktree, '.git')));
  assert.ok(fs.existsSync(l.dbFile));
  assert.equal(l.env.CHORD_AGENT_ID, l.name);
  assert.equal(path.dirname(l.worktree), path.join(root, '.chord', 'wt'));
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), ''); // .chord/ ignored
});

test('prepare explains a non-git directory and an empty repository', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'chord-plain-'));
  assert.throws(() => prepare('claude', plain), /not inside a git repository/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'chord-empty-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: empty });
  assert.throws(() => prepare('claude', empty), /no commits yet/);
});
