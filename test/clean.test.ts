import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clean } from '../src/clean.ts';
import * as db from '../src/db.ts';
import { ensureWorktree, workspacePath } from '../src/launch.ts';
import { resolveProject } from '../src/project.ts';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();
process.env.CHORD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'chord-home-'));

test('clean removes merged offline agents, keeps unmerged ones unless forced, never touches online ones', () => {
  const proj = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-clean-')));
  const repo = path.join(proj, 'repo'); fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  const project = resolveProject(proj);
  const d = db.openDb(':memory:');
  const mk = (name: string) => {
    const ws = workspacePath(project, name); const wt = ensureWorktree(repo, path.join(ws, 'repo'), name);
    db.addAgent(d, { name, tool: 'claude', pid: process.pid, cwd: ws, worktree: wt });
    db.send(d, name, [name], 'note to self');
    return { ws, wt };
  };
  const merged = mk('merged'); const unmerged = mk('unmerged'); const online = mk('online');
  fs.writeFileSync(path.join(merged.wt, 'm.txt'), '1'); git(merged.wt, 'add', '.'); git(merged.wt, 'commit', '-q', '-m', 'm');
  git(repo, 'merge', '-q', '--ff-only', 'chord/merged');
  fs.writeFileSync(path.join(unmerged.wt, 'u.txt'), '1'); git(unmerged.wt, 'add', '.'); git(unmerged.wt, 'commit', '-q', '-m', 'u');
  db.setStatus(d, 'merged', 'offline'); db.setStatus(d, 'unmerged', 'offline');

  let r = clean(project, d);
  assert.deepEqual(r.removed, ['merged']);
  assert.deepEqual(r.kept.map(k => k.name), ['unmerged']);
  assert.ok(!fs.existsSync(merged.ws));
  assert.equal(git(repo, 'branch', '--list', 'chord/merged'), '');
  assert.equal(db.getAgent(d, 'merged'), undefined);
  assert.equal(db.hasUnread(d, 'merged'), false);
  assert.ok(fs.existsSync(unmerged.wt) && fs.existsSync(online.wt));

  r = clean(project, d, ['online', 'ghost']);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.kept.map(k => k.why.split(';')[0]), ['no such agent', 'still online']);

  r = clean(project, d, ['unmerged'], true);
  assert.deepEqual(r.removed, ['unmerged']);
  assert.equal(git(repo, 'branch', '--list', 'chord/unmerged'), '');
  assert.ok(!fs.existsSync(unmerged.ws));
  assert.equal(git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length, 2); // main + online
});
