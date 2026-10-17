import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureWorktree } from '../src/launch.ts';
import { NeedsRestructure, resolveProject, restructure, restructureBlocker, suggestedRepoName, validateRepoName } from '../src/project.ts';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();
const tmp = (p: string) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), p)));
function initRepo(dir: string) { fs.mkdirSync(dir, { recursive: true }); git(dir, 'init', '-q', '-b', 'main'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'init'); }
function tempProject() { const proj = tmp('chord-proj-'); initRepo(path.join(proj, 'repo')); return proj; }
process.env.CHORD_HOME = tmp('chord-home-');

test('resolveProject finds the enclosing project from the main checkout, a worktree and their subdirectories', () => {
  const proj = tempProject(); const repo = path.join(proj, 'repo');
  const wt = ensureWorktree(repo, path.join(proj, 'chord', 'agents', 'x', 'repo'), 'x');
  fs.mkdirSync(path.join(repo, 'src'));
  for (const where of [path.join(repo, 'src'), repo, wt, path.join(proj, 'chord', 'agents', 'x')]) {
    assert.equal(resolveProject(where).dir, proj, where);
  }
});

test('an ancestor project does not claim a new project folder created beside its repository', () => {
  const work = tempProject();
  ensureWorktree(path.join(work, 'repo'), path.join(work, 'chord', 'agents', 'a', 'repo'), 'a'); // the old project has been used
  const fresh = path.join(work, 'newproj'); initRepo(path.join(fresh, 'api'));
  const p = resolveProject(fresh);
  assert.equal(p.dir, fresh); assert.equal(p.repoName, 'api');
  assert.throws(() => resolveProject(path.join(fresh, 'api')), NeedsRestructure); // the new repository root is treated on its own merits, not as part of the old project
  fs.mkdirSync(path.join(work, 'repo', 'src'));
  assert.equal(resolveProject(path.join(work, 'repo', 'src')).dir, work); // the old project still owns its own territory
});

test('a junction to a repository counts as the project repository', () => {
  const proj = tmp('chord-junction-'); const target = tmp('chord-target-'); initRepo(path.join(target, 'src'));
  fs.symlinkSync(path.join(target, 'src'), path.join(proj, 'repo'), 'junction');
  const p = resolveProject(proj);
  assert.equal(p.repoName, 'repo'); assert.equal(p.repo, path.join(proj, 'repo'));
});

test('resolveProject ignores .git files and refuses a repository named chord', () => {
  const proj = tempProject(); const repo = path.join(proj, 'repo');
  ensureWorktree(repo, path.join(proj, 'linked'), 'l'); // a child with a .git FILE is not a project repository
  assert.equal(resolveProject(proj).repoName, 'repo');
  const bad = tmp('chord-badname-'); initRepo(path.join(bad, 'chord'));
  assert.throws(() => resolveProject(bad), /reserved for chord/);
});

test('restructure is refused for linked worktrees, tracked chord/ and bad names', () => {
  const root = tmp('chord-guard-'); initRepo(root);
  fs.mkdirSync(path.join(root, 'chord')); fs.writeFileSync(path.join(root, 'chord', 'x.txt'), '1');
  git(root, 'add', 'chord/x.txt'); git(root, 'commit', '-q', '-m', 'track chord dir');
  assert.match(restructureBlocker(root)!, /tracks a top-level chord/);
  git(root, 'rm', '-q', '-r', 'chord'); git(root, 'commit', '-q', '-m', 'untrack');
  assert.equal(restructureBlocker(root), null);
  ensureWorktree(root, path.join(tmp('chord-guard-wt-'), 'w'), 'g');
  assert.match(restructureBlocker(root)!, /linked worktrees/);
  assert.throws(() => restructure(root, 'app'), /linked worktrees/);
  assert.match(validateRepoName('chord')!, /reserved/);
  assert.match(validateRepoName('a/b')!, /single directory name/);
  assert.match(validateRepoName('  ')!, /empty/);
  assert.equal(validateRepoName('my-app'), null);
});

test('restructure rolls back when a move fails and reports both outcomes', () => {
  const root = tmp('chord-rollback-'); initRepo(root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'a'); fs.writeFileSync(path.join(root, 'b.txt'), 'b');
  let calls = 0;
  const flaky = (from: string, to: string) => { if (++calls === 2) throw new Error('EBUSY pretend'); fs.renameSync(from, to); };
  assert.throws(() => restructure(root, 'app', flaky), /EBUSY pretend.*Everything was moved back/);
  assert.ok(fs.existsSync(path.join(root, '.git')) && fs.existsSync(path.join(root, 'a.txt')) && fs.existsSync(path.join(root, 'b.txt')));
  assert.ok(!fs.existsSync(path.join(root, 'app')));
});

test('suggestedRepoName handles odd origin URLs and falls back safely', () => {
  const root = tmp('chord-origin-'); initRepo(root);
  const set = (url: string) => { try { git(root, 'remote', 'remove', 'origin'); } catch { /* none yet */ } git(root, 'remote', 'add', 'origin', url); };
  set('git@github.com:user/My-App.git'); assert.equal(suggestedRepoName(root), 'My-App');
  set('https://host/group/sub/thing/'); assert.equal(suggestedRepoName(root), 'thing');
  set('ssh://git@host:2222/x/y.git'); assert.equal(suggestedRepoName(root), 'y');
  set('C:\\repos\\local.git'); assert.equal(suggestedRepoName(root), 'local');
  set('file:///srv/chord.git'); assert.equal(suggestedRepoName(root), path.basename(root)); // "chord" is reserved
  git(root, 'remote', 'remove', 'origin'); assert.equal(suggestedRepoName(root), path.basename(root));
});
