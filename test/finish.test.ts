import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/db.ts';
import { ensureWorktree } from '../src/launch.ts';
import { finish, type Ctx } from '../src/tools.ts';

// autocrlf off for every git call in this process, chord's own included: the fixtures must reach the index and the
// worktrees byte for byte, whatever the machine's global git config says (GitHub's Windows runners set it to true)
for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' })) process.env[k] ??= v;
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();

/** Project layout: <proj>/repo is the main checkout, <proj>/chord/agents/w/repo the agent's worktree. */
function setup() {
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-fin-')));
  const repo = path.join(proj, 'repo'); fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', 'a.txt'); git(repo, 'commit', '-q', '-m', 'init');
  const ws = path.join(proj, 'chord', 'agents', 'w');
  const wt = ensureWorktree(repo, path.join(ws, 'repo'), 'w');
  process.env.CHORD_DB = path.join(proj, 'state', 'chord.db'); fs.mkdirSync(path.join(proj, 'state'));
  const d = db.openDb(':memory:');
  db.addAgent(d, { name: 'w', tool: 'claude', pid: process.pid, cwd: ws, worktree: wt });
  db.addAgent(d, { name: 'peer', tool: 'codex', pid: process.pid, cwd: '/p' });
  db.addAgent(d, { name: 'gone', tool: 'codex', pid: process.pid, cwd: '/g' }); db.setStatus(d, 'gone', 'offline');
  db.addClaim(d, { agent: 'w', file: 'repo/b.txt', intent: 'x', kind: 'add' });
  const ctx: Ctx = { db: d, agent: 'w', cwd: ws, worktree: wt };
  return { root: repo, wt, d, ctx };
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
  fs.appendFileSync(path.join(wt, 'a.txt'), 'dirty'); // a tracked file modified and not committed
  assert.throws(() => finish(ctx), /uncommitted changes to tracked files; commit them first/);
  git(wt, 'checkout', '--', 'a.txt');
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
  // finish writes this marker before its own rebase; a finish killed mid-rebase leaves it behind
  fs.writeFileSync(path.resolve(wt, git(wt, 'rev-parse', '--git-path', 'chord-finish')), '1\n');
  try { git(wt, 'rebase', 'main'); } catch { /* conflict: worktree now sits mid-rebase */ }
  const rebaseDir = path.resolve(wt, git(wt, 'rev-parse', '--git-path', 'rebase-merge'));
  assert.ok(fs.existsSync(rebaseDir));
  // main backs out of its change, so a fresh rebase would succeed
  git(root, 'reset', '-q', '--hard', 'HEAD~1');
  const r = finish(ctx);
  assert.deepEqual(r.merged, ['wt change']);
  assert.ok(!fs.existsSync(rebaseDir));
  assert.equal(git(root, 'log', '--format=%s', '-1'), 'wt change');
});

test('finish leaves a rebase it did not start alone, resolved conflicts included', () => {
  const { root, wt, ctx } = setup();
  fs.writeFileSync(path.join(wt, 'a.txt'), 'from worktree\n'); git(wt, 'commit', '-q', '-am', 'wt change');
  fs.writeFileSync(path.join(root, 'a.txt'), 'from main\n'); git(root, 'commit', '-q', '-am', 'main change');
  try { git(wt, 'rebase', 'main'); } catch { /* conflict */ }
  fs.writeFileSync(path.join(wt, 'a.txt'), 'RESOLVED\n'); git(wt, 'add', 'a.txt'); // the agent resolved it but has not continued yet
  assert.throws(() => finish(ctx), /a rebase is in progress in your worktree that finish did not start/);
  assert.equal(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8'), 'RESOLVED\n');
  assert.ok(fs.existsSync(path.resolve(wt, git(wt, 'rev-parse', '--git-path', 'rebase-merge'))));
  assert.equal(git(root, 'log', '--format=%s', '-1'), 'main change');
});

test('finish refuses when the main checkout is detached', () => {
  const { root, wt, ctx } = setup();
  fs.writeFileSync(path.join(wt, 'b.txt'), 'x\n'); git(wt, 'add', 'b.txt'); git(wt, 'commit', '-q', '-m', 'feat: b');
  git(root, 'checkout', '-q', '--detach');
  assert.throws(() => finish(ctx), /detached HEAD/);
});

test('withLock serialises callers and takes over a stale lock', async () => {
  const { withLock } = await import('../src/tools.ts');
  const lock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-lock-')), 'l.lock');
  assert.equal(withLock(lock, () => 42), 42);
  assert.ok(!fs.existsSync(lock));
  fs.writeFileSync(lock, '1'); // held by someone else, not stale
  assert.throws(() => withLock(lock, () => 0, 300, 60_000), /another agent has been finishing/);
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lock, old, old); // stale: taken over
  assert.equal(withLock(lock, () => 'took over', 300, 60_000), 'took over');
  assert.throws(() => withLock(lock, () => { throw new Error('boom'); }), /boom/);
  assert.ok(!fs.existsSync(lock)); // released even when fn throws
});

test('finish refuses a detached worktree and skips the merge when there is nothing new', () => {
  const { root, wt, d, ctx } = setup();
  git(wt, 'checkout', '-q', '--detach');
  assert.throws(() => finish(ctx), /your worktree is not on its branch/);
  git(wt, 'checkout', '-q', 'chord/w');
  const r = finish(ctx); // no commits beyond main
  assert.deepEqual(r.merged, []); assert.match((r as any).note, /nothing to merge/);
  assert.equal(db.claimsBy(d, 'w').length, 0);
  assert.equal(db.hasUnread(d, 'peer'), false); // nobody is told about an empty merge
  assert.equal(git(root, 'log', '--format=%s', '-1'), 'init');
});

test('merge broadcasts are notices', () => {
  const { wt, d, ctx } = setup();
  fs.writeFileSync(path.join(wt, 'b.txt'), 'two\n'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'feat: add b');
  finish(ctx);
  const [m] = db.takeUnread(d, 'peer');
  assert.equal(m.kind, 'notice');
  assert.equal(db.repliedSince(d, 'w', 'peer', 0), false);
});

test('finish ignores untracked files in the worktree instead of forcing them into a commit', () => {
  const { root, wt, ctx } = setup();
  fs.writeFileSync(path.join(wt, 'b.txt'), 'x\n'); git(wt, 'add', 'b.txt'); git(wt, 'commit', '-q', '-m', 'feat: b');
  fs.mkdirSync(path.join(wt, 'build')); fs.writeFileSync(path.join(wt, 'build', 'out.log'), 'build output');
  assert.deepEqual(finish(ctx).merged, ['feat: b']);
  assert.ok(fs.existsSync(path.join(wt, 'build', 'out.log')));
  assert.equal(git(root, 'status', '--porcelain'), '');
  fs.appendFileSync(path.join(wt, 'b.txt'), 'edited'); // tracked and modified: still refused
  assert.throws(() => finish(ctx), /uncommitted changes to tracked files/);
});

test('finish refuses when a claimed file sits untracked in the worktree, so half a change never reaches main', () => {
  const { root, wt, ctx, d } = setup(); // repo/b.txt is claimed as an add
  fs.writeFileSync(path.join(wt, 'b.txt'), 'two\n'); // written but never added
  fs.appendFileSync(path.join(wt, 'a.txt'), 'more\n'); git(wt, 'commit', '-q', '-am', 'feat: more a'); // -a does not pick up new files
  fs.writeFileSync(path.join(wt, 'scratch.log'), 'build output'); // unclaimed untracked files are still nobody's business
  assert.throws(() => finish(ctx), /claimed .*b\.txt.* never committed/);
  assert.equal(git(root, 'log', '--format=%s', '-1'), 'init');
  assert.equal(db.claimsBy(d, 'w').length, 1);
  git(wt, 'add', 'b.txt'); git(wt, 'commit', '-q', '-m', 'feat: b');
  assert.deepEqual(finish(ctx).merged, ['feat: b', 'feat: more a']);
  assert.ok(fs.existsSync(path.join(root, 'b.txt')));
});

test('finish refuses to fast-forward over untracked files of the same name in the main checkout', () => {
  const { root, wt, ctx, d } = setup();
  fs.writeFileSync(path.join(wt, 'gen.txt'), 'from branch\n'); git(wt, 'add', 'gen.txt'); git(wt, 'commit', '-q', '-m', 'feat: gen');
  fs.writeFileSync(path.join(root, 'gen.txt'), 'someone left this here\n');
  assert.throws(() => finish(ctx), /exist in the main checkout .* but are not tracked there: gen.txt/);
  assert.equal(fs.readFileSync(path.join(root, 'gen.txt'), 'utf8'), 'someone left this here\n');
  assert.equal(git(root, 'log', '--format=%s', '-1'), 'init');
  assert.equal(db.claimsBy(d, 'w').length, 1);
  fs.rmSync(path.join(root, 'gen.txt'));
  assert.deepEqual(finish(ctx).merged, ['feat: gen']);
});

test('finish survives a noisy post-merge hook and a stale index.lock, and does not call a hook refusal a conflict', () => {
  const { root, wt, ctx, d } = setup();
  const hooks = path.join(root, '.git', 'hooks'); fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'post-merge'), '#!/bin/sh\nnode -e "process.stdout.write(\'x\'.repeat(2e6))"\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(wt, 'b.txt'), 'x\n'); git(wt, 'add', 'b.txt'); git(wt, 'commit', '-q', '-m', 'feat: b');
  const lock = path.resolve(wt, git(wt, 'rev-parse', '--git-path', 'index.lock'));
  fs.writeFileSync(lock, ''); const old = new Date(Date.now() - 120_000); fs.utimesSync(lock, old, old);
  assert.deepEqual(finish(ctx).merged, ['feat: b']);
  assert.ok(!fs.existsSync(lock));
  assert.equal(git(root, 'log', '--format=%s', '-1'), 'feat: b');
  assert.equal(db.claimsBy(d, 'w').length, 0);
  // a pre-rebase hook that says no is not a conflict
  fs.writeFileSync(path.join(hooks, 'pre-rebase'), '#!/bin/sh\necho "no rebasing today" >&2\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(wt, 'c.txt'), 'y\n'); git(wt, 'add', 'c.txt'); git(wt, 'commit', '-q', '-m', 'feat: c');
  fs.writeFileSync(path.join(root, 'a.txt'), 'main moved\n'); git(root, 'commit', '-q', '-am', 'main change');
  assert.throws(() => finish(ctx), /rebase onto main failed \(not a conflict\)[\s\S]*no rebasing today/);
  assert.equal(d.prepare("select count(*) c from events where kind = 'conflict'").get()!.c, 0);
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'chord/w');
});

test('finish ignores line-ending-only differences a repository shows from the moment it is checked out', () => {
  const { root, wt, ctx } = setup();
  // a CRLF file committed as is, then a "* text" attribute without renormalising: git now reports it modified everywhere
  fs.writeFileSync(path.join(root, 'crlf.txt'), 'one\r\ntwo\r\n'); git(root, 'add', 'crlf.txt'); git(root, 'commit', '-q', '-m', 'crlf');
  fs.writeFileSync(path.join(root, '.gitattributes'), '* text\n'); git(root, 'add', '.gitattributes'); git(root, 'commit', '-q', '-m', 'attributes');
  git(wt, 'rebase', '-q', 'main');
  assert.notEqual(git(wt, 'status', '--porcelain', '--untracked-files=no'), ''); // the phantom change
  fs.writeFileSync(path.join(wt, 'b.txt'), 'x\n'); git(wt, 'add', 'b.txt'); git(wt, 'commit', '-q', '-m', 'feat: b');
  // git itself will not rebase over it, so finish names the cause and the fix instead of calling it the agent's change
  assert.throws(() => finish(ctx), /differ from the index only in their line endings.*crlf.txt.*git add --renormalize/);
  assert.equal(git(root, 'log', '--format=%s', '-1'), 'attributes');
  // once the repository is renormalised, a worktree made from that commit is clean and finishes normally
  git(root, 'add', '--renormalize', '.'); git(root, 'commit', '-q', '-m', 'renormalise');
  const ws2 = path.join(path.dirname(path.dirname(wt)), 'w2');
  const wt2 = ensureWorktree(root, path.join(ws2, 'repo'), 'w2');
  assert.equal(git(wt2, 'status', '--porcelain', '--untracked-files=no'), '');
  fs.writeFileSync(path.join(wt2, 'c.txt'), 'y\n'); git(wt2, 'add', 'c.txt'); git(wt2, 'commit', '-q', '-m', 'feat: c');
  db.addAgent(ctx.db, { name: 'w2', tool: 'claude', pid: process.pid, cwd: ws2, worktree: wt2 });
  assert.deepEqual(finish({ ...ctx, agent: 'w2', cwd: ws2, worktree: wt2 }).merged, ['feat: c']);
});

test('finish refuses a submodule commit that only exists inside the worktree', () => {
  const { root, wt, ctx } = setup();
  const subsrc = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-subsrc-')));
  git(subsrc, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(subsrc, 's.txt'), '1\n'); git(subsrc, 'add', '.'); git(subsrc, 'commit', '-q', '-m', 'sub init');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subsrc, 'sub'); git(root, 'commit', '-q', '-m', 'add submodule');
  git(wt, 'rebase', '-q', 'main');
  git(wt, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init');
  const sub = path.join(wt, 'sub');
  fs.writeFileSync(path.join(sub, 's.txt'), '2\n'); git(sub, 'commit', '-q', '-am', 'sub change');
  git(wt, 'add', 'sub'); git(wt, 'commit', '-q', '-m', 'bump submodule');
  assert.throws(() => finish(ctx), /submodule .* does not have; push that commit/);
  assert.equal(git(root, 'log', '--format=%s', '-1'), 'add submodule');
  // once the commit is where the main checkout's submodule can see it, finish goes ahead
  git(path.join(root, 'sub'), 'fetch', '-q', sub, 'HEAD');
  assert.deepEqual(finish(ctx).merged, ['bump submodule']);
});

test('finish runs the project\'s test command on the rebased branch and merges only when it passes', () => {
  const { root, wt, d, ctx } = setup();
  const proj = path.dirname(root);
  fs.mkdirSync(path.join(proj, 'chord'), { recursive: true });
  // the "suite": the worktree must hold both files once rebased, so it only passes with main's change underneath
  fs.writeFileSync(path.join(proj, 'chord', 'config.json'), JSON.stringify({ test: 'node -e "process.exit(require(\'fs\').existsSync(\'c.txt\') && !require(\'fs\').existsSync(\'broken\') ? 0 : 3)"' }));
  ctx.project = proj;
  fs.writeFileSync(path.join(wt, 'b.txt'), 'two\n'); fs.writeFileSync(path.join(wt, 'broken'), '');
  git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'feat: add b');
  fs.writeFileSync(path.join(root, 'c.txt'), 'three\n'); git(root, 'add', 'c.txt'); git(root, 'commit', '-q', '-m', 'chore: add c');
  assert.throws(() => finish(ctx), /test command failed there, so nothing was merged/);
  assert.equal(git(root, 'log', '--format=%s', '-1'), 'chore: add c', 'main has not moved');
  assert.equal(git(wt, 'log', '--format=%s', '-2'), 'feat: add b\nchore: add c', 'the branch stays rebased for the agent to fix');
  assert.equal(db.claimsBy(d, 'w').length, 1);
  git(wt, 'rm', '-q', 'broken'); git(wt, 'commit', '-q', '-m', 'fix: drop broken');
  assert.deepEqual(finish(ctx).merged, ['fix: drop broken', 'feat: add b']); // newest first, as git log lists them
  assert.equal(git(root, 'log', '--format=%s', '-1'), 'fix: drop broken');
});
