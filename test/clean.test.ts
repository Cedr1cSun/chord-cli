import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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
  assert.deepEqual(r.kept.map(k => k.why), ['no such agent', 'still online']);

  // uncommitted and untracked work is kept too: an agent stopped half-way has not lost anything
  const dirty = mk('dirty');
  fs.writeFileSync(path.join(dirty.wt, 'wip.txt'), 'half done');
  fs.appendFileSync(path.join(dirty.wt, 'm.txt'), 'edited');
  db.setStatus(d, 'dirty', 'offline');
  r = clean(project, d);
  assert.deepEqual(r.removed, []);
  assert.match(r.kept.find(k => k.name === 'dirty')!.why, /^uncommitted changes in chord\/agents\/dirty\/repo$/);
  assert.ok(fs.existsSync(path.join(dirty.wt, 'wip.txt')));
  assert.equal(fs.readFileSync(path.join(dirty.wt, 'm.txt'), 'utf8'), '1edited');
  assert.deepEqual(clean(project, d, ['dirty'], true).removed, ['dirty']);
  assert.ok(!fs.existsSync(dirty.ws));

  // a worktree some process is using cannot be removed on Windows: that agent is kept whole, the others still go
  const busy = mk('busy'); const other = mk('other');
  db.setStatus(d, 'busy', 'offline'); db.setStatus(d, 'other', 'offline');
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { cwd: busy.wt, stdio: 'ignore', detached: true });
  try {
    r = clean(project, d, ['busy', 'other']);
    if (process.platform === 'win32') {
      assert.deepEqual(r.removed, ['other']);
      assert.match(r.kept.find(k => k.name === 'busy')!.why, /could not be removed/);
      assert.notEqual(git(repo, 'branch', '--list', 'chord/busy'), ''); // branch and row survive with the directory
      assert.ok(db.getAgent(d, 'busy'));
    } else {
      assert.deepEqual(r.removed, ['busy', 'other']); // Linux lets a directory in use go
    }
  } finally { holder.kill(); }
  // a junction inside the worktree is unlinked, not followed
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'chord-target-')); fs.writeFileSync(path.join(target, 'sentinel'), 'keep');
  const junk = mk('junk'); fs.symlinkSync(target, path.join(junk.wt, 'linked'), 'junction'); db.setStatus(d, 'junk', 'offline');
  assert.deepEqual(clean(project, d, ['junk'], true).removed, ['junk']);
  assert.ok(fs.existsSync(path.join(target, 'sentinel')));

  // a directory with no database row (a launch that died before the tool started) is cleaned by the same rules
  const orphanWt = ensureWorktree(repo, path.join(project.dir, 'chord', 'agents', 'orphan', 'repo'), 'orphan');
  fs.writeFileSync(path.join(orphanWt, 'o.txt'), '1'); git(orphanWt, 'add', '.'); git(orphanWt, 'commit', '-q', '-m', 'o');
  r = clean(project, d);
  assert.match(r.kept.find(k => k.name === 'orphan')!.why, /^unmerged commits on chord\/orphan$/);
  git(repo, 'merge', '-q', '--ff-only', 'chord/orphan');
  fs.mkdirSync(path.join(project.stateDir, 'setup-done'), { recursive: true }); fs.writeFileSync(path.join(project.stateDir, 'setup-done', 'orphan'), '1');
  r = clean(project, d);
  assert.ok(r.removed.includes('orphan'));
  assert.ok(!fs.existsSync(path.join(project.dir, 'chord', 'agents', 'orphan')));
  assert.equal(git(repo, 'branch', '--list', 'chord/orphan'), '');
  assert.ok(!fs.existsSync(path.join(project.stateDir, 'setup-done', 'orphan'))); // the setup marker goes with the agent

  // a row whose cwd is the project folder itself must not make clean delete the project
  const stray = mk('stray'); db.setStatus(d, 'stray', 'offline');
  d.prepare("update agents set cwd = ?, worktree = ? where name = 'stray'").run(project.dir, online.wt); // the row lies about both
  r = clean(project, d, ['stray']);
  assert.deepEqual(r.removed, ['stray']);
  assert.ok(fs.existsSync(repo) && fs.existsSync(online.wt) && !fs.existsSync(stray.ws)); // only stray's own folder went

  r = clean(project, d, ['unmerged'], true);
  assert.deepEqual(r.removed, ['unmerged']);
  assert.equal(git(repo, 'branch', '--list', 'chord/unmerged'), '');
  assert.ok(!fs.existsSync(unmerged.ws));
  assert.equal(git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length, 2); // main + online
});
