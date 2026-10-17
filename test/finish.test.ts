import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/db.ts';
import { ensureWorktree } from '../src/launch.ts';
import { finish, type Ctx } from '../src/tools.ts';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-fin-')));
  git(root, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  git(root, 'add', 'a.txt'); git(root, 'commit', '-q', '-m', 'init');
  const wt = ensureWorktree(root, 'w');
  const d = db.openDb(':memory:');
  db.addAgent(d, { name: 'w', tool: 'claude', pid: process.pid, cwd: wt });
  db.addAgent(d, { name: 'peer', tool: 'codex', pid: process.pid, cwd: '/p' });
  db.addAgent(d, { name: 'gone', tool: 'codex', pid: process.pid, cwd: '/g' }); db.setStatus(d, 'gone', 'offline');
  db.addClaim(d, { agent: 'w', file: 'b.txt', intent: 'x', kind: 'add' });
  const ctx: Ctx = { db: d, agent: 'w', cwd: wt };
  return { root, wt, d, ctx };
}

test('finish rebases, fast-forwards main, releases claims and notifies online peers', () => {
  const { root, wt, d, ctx } = setup();
  fs.writeFileSync(path.join(wt, 'b.txt'), 'two\n');
  git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'feat: add b');
  // main moves on independently, without conflict
  fs.writeFileSync(path.join(root, 'c.txt'), 'three\n');
  git(root, 'add', 'c.txt'); git(root, 'commit', '-q', '-m', 'chore: add c');

  const r = finish(ctx);
  assert.deepEqual(r, { merged: ['feat: add b'], into: 'main', notified: ['peer'] });
  assert.equal(git(root, 'log', '--format=%s', '-1'), 'feat: add b');
  assert.ok(fs.existsSync(path.join(root, 'b.txt')) && fs.existsSync(path.join(root, 'c.txt')));
  assert.equal(db.claimsBy(d, 'w').length, 0);
  assert.match(db.takeUnread(d, 'peer')[0].body, /w merged into main:\n- feat: add b/);
  assert.equal(db.hasUnread(d, 'gone'), false);
});

test('finish refuses dirty worktrees and dirty main', () => {
  const { root, wt, ctx } = setup();
  fs.writeFileSync(path.join(wt, 'dirty.txt'), 'x');
  assert.throws(() => finish(ctx), /uncommitted changes; commit them first/);
  fs.rmSync(path.join(wt, 'dirty.txt'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
  assert.throws(() => finish(ctx), /main checkout has uncommitted changes/);
});

test('finish aborts cleanly on a rebase conflict', () => {
  const { root, wt, d, ctx } = setup();
  fs.writeFileSync(path.join(wt, 'a.txt'), 'from worktree\n'); git(wt, 'commit', '-q', '-am', 'wt change');
  fs.writeFileSync(path.join(root, 'a.txt'), 'from main\n'); git(root, 'commit', '-q', '-am', 'main change');
  assert.throws(() => finish(ctx), /rebase onto main failed; nothing was merged/);
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'chord/w'); // not left mid-rebase
  assert.equal(git(wt, 'status', '--porcelain'), '');
  assert.equal(git(root, 'log', '--format=%s', '-1'), 'main change');
  assert.equal(db.claimsBy(d, 'w').length, 1);
});

test('finish recovers from a worktree left mid-rebase by an earlier crash', () => {
  const { root, wt, ctx } = setup();
  fs.writeFileSync(path.join(wt, 'a.txt'), 'from worktree\n'); git(wt, 'commit', '-q', '-am', 'wt change');
  fs.writeFileSync(path.join(root, 'a.txt'), 'from main\n'); git(root, 'commit', '-q', '-am', 'main change');
  try { git(wt, 'rebase', 'main'); } catch { /* conflict: worktree now sits mid-rebase */ }
  assert.ok(fs.existsSync(path.join(root, '.git', 'worktrees', 'w', 'rebase-merge')));
  // main backs out of its change, so a fresh rebase would succeed
  git(root, 'reset', '-q', '--hard', 'HEAD~1');
  const r = finish(ctx);
  assert.deepEqual(r.merged, ['wt change']);
  assert.ok(!fs.existsSync(path.join(root, '.git', 'worktrees', 'w', 'rebase-merge')));
  assert.equal(git(root, 'log', '--format=%s', '-1'), 'wt change');
});
