import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/db.ts';
import { handleHook } from '../src/hooks.ts';
import { ensureWorktree } from '../src/launch.ts';
import type { Ctx } from '../src/tools.ts';

// autocrlf off for every git call in this process, chord's own included: the CRLF fixture below must reach the index
// byte for byte, whatever the machine's global git config says
for (const [k, v] of Object.entries({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' })) process.env[k] ??= v;

function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-post-')));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'a\n');
  git('add', 'notes.txt'); git('commit', '-q', '-m', 'init');
  const d = db.openDb(':memory:');
  db.addAgent(d, { name: 'a', tool: 'claude', pid: process.pid, cwd: root });
  const ctx: Ctx = { db: d, agent: 'a', cwd: root, worktree: root };
  return { root, d, ctx };
}

test('post-tool-use warns about shell edits to unclaimed files, for Bash and PowerShell', () => {
  const { root, d, ctx } = repo();
  fs.appendFileSync(path.join(root, 'notes.txt'), 'b\n');
  fs.writeFileSync(path.join(root, 'new.txt'), 'x\n');
  for (const tool_name of ['Bash', 'PowerShell']) {
    const out = handleHook(ctx, 'claude', 'post-tool-use', { tool_name }) as any;
    assert.match(out.hookSpecificOutput.additionalContext, /changed files you have not claimed: notes.txt, new.txt/);
  }
  // Codex reports its shell as Bash
  assert.ok(handleHook(ctx, 'codex', 'post-tool-use', { tool_name: 'Bash' }));
  // once claimed, no warning
  db.addClaim(d, { agent: 'a', file: 'notes.txt', intent: 'x', kind: 'modify' });
  db.addClaim(d, { agent: 'a', file: 'new.txt', intent: 'x', kind: 'add' });
  assert.equal(handleHook(ctx, 'claude', 'post-tool-use', { tool_name: 'PowerShell' }), undefined);
  // non-shell tools and clean trees are silent
  assert.equal(handleHook(ctx, 'claude', 'post-tool-use', { tool_name: 'Read' }), undefined);
});

test('post-tool-use reports paths relative to the workspace when the repo is a subdirectory', () => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-ws-')));
  const wt = path.join(ws, 'repo'); fs.mkdirSync(wt);
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: wt, stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(wt, 'a.txt'), '1\n'); git('add', 'a.txt'); git('commit', '-q', '-m', 'i');
  const d = db.openDb(':memory:');
  db.addAgent(d, { name: 'a', tool: 'codex', pid: process.pid, cwd: ws });
  const ctx: Ctx = { db: d, agent: 'a', cwd: ws, worktree: wt };
  fs.appendFileSync(path.join(wt, 'a.txt'), '2\n');
  const out = handleHook(ctx, 'codex', 'post-tool-use', { tool_name: 'Bash' }) as any;
  assert.match(out.hookSpecificOutput.additionalContext, /not claimed: repo\/a.txt/);
  db.addClaim(d, { agent: 'a', file: 'repo/a.txt', intent: 'x', kind: 'modify' });
  assert.equal(handleHook(ctx, 'codex', 'post-tool-use', { tool_name: 'Bash' }), undefined);
});

test('post-tool-use handles renames and names with spaces or accents', () => {
  const { root, ctx } = repo();
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'ünï cødé.txt'), 'x\n'); git('add', '.'); git('commit', '-q', '-m', 'add');
  git('mv', 'notes.txt', 'renamed notes.txt');
  fs.appendFileSync(path.join(root, 'ünï cødé.txt'), 'y\n');
  fs.mkdirSync(path.join(root, 'newdir')); fs.writeFileSync(path.join(root, 'newdir', 'inner.md'), 'z');
  const out = handleHook(ctx, 'claude', 'post-tool-use', { tool_name: 'Bash' }) as any;
  const text = out.hookSpecificOutput.additionalContext as string;
  assert.match(text, /renamed notes.txt/); assert.match(text, /(^|[ ,])notes.txt/); // both ends of a rename changed
  assert.match(text, /ünï cødé.txt/); assert.match(text, /, newdir[.,]/); assert.doesNotMatch(text, /inner\.md/); // an untracked directory is one entry, not every file in it
  // a claim on a file inside a new directory covers that entry: the agent is not told to revert its own work
  db.addClaim(ctx.db, { agent: 'a', file: 'newdir/inner.md', intent: 'x', kind: 'add' });
  assert.doesNotMatch((handleHook(ctx, 'claude', 'post-tool-use', { tool_name: 'Bash' }) as any).hookSpecificOutput.additionalContext, /newdir/);
});

test('post-tool-use names at most twenty unclaimed files and counts the rest', () => {
  const { root, ctx } = repo();
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(root, `gen-${String(i).padStart(2, '0')}.txt`), 'x');
  const text = (handleHook(ctx, 'claude', 'post-tool-use', { tool_name: 'Bash' }) as any).hookSpecificOutput.additionalContext as string;
  assert.equal((text.match(/gen-\d\d\.txt/g) || []).length, 20);
  assert.match(text, / and 5 more\./);
  assert.ok(text.length < 1200);
});

test('post-tool-use also warns about commits to unclaimed files, git stash, and a dirtied main checkout', () => {
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-post2-')));
  const root = path.join(proj, 'repo'); fs.mkdirSync(root);
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();
  git(root, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(root, 'a.txt'), 'a\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init');
  const ws = path.join(proj, 'chord', 'agents', 'w');
  const wt = ensureWorktree(root, path.join(ws, 'repo'), 'w');
  const d = db.openDb(':memory:');
  db.addAgent(d, { name: 'w', tool: 'claude', pid: process.pid, cwd: ws });
  const ctx: Ctx = { db: d, agent: 'w', cwd: ws, worktree: wt };
  const run = (command: string) => ((handleHook(ctx, 'claude', 'post-tool-use', { tool_name: 'Bash', tool_input: { command } }) as any)?.hookSpecificOutput?.additionalContext ?? '') as string;
  assert.equal(run('ls'), '');
  // committed straight from the shell: still not claimed
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n'); git(wt, 'add', 'b.txt'); git(wt, 'commit', '-q', '-m', 'add b');
  assert.match(run('git commit -am x'), /changed files you have not claimed: repo\/b.txt/);
  db.addClaim(d, { agent: 'w', file: 'repo/b.txt', intent: 'x', kind: 'add' });
  assert.equal(run('ls'), '');
  // stash is shared between worktrees
  assert.match(run('git stash && npm test && git stash pop'), /git stash is shared by every worktree/);
  assert.equal(run('echo stash'), '');
  // a line-ending-only difference in the main checkout (a CRLF file under a "* text" rule never renormalised) does not
  // block finish, so it is not reported either: the warning uses finish's own rule
  fs.writeFileSync(path.join(root, 'crlf.txt'), 'one\r\ntwo\r\n'); git(root, 'add', 'crlf.txt'); git(root, 'commit', '-q', '-m', 'crlf');
  fs.writeFileSync(path.join(root, '.gitattributes'), '* text\n'); git(root, 'add', '.gitattributes'); git(root, 'commit', '-q', '-m', 'attributes');
  assert.notEqual(git(root, 'status', '--porcelain', '--untracked-files=no'), ''); // the phantom change
  assert.equal(run('ls'), '');
  // the main checkout dirtied by the shell blocks everyone's finish
  fs.appendFileSync(path.join(root, 'a.txt'), 'oops');
  assert.match(run('ls'), /main checkout \(.*\) has uncommitted changes.*a.txt/);
});

test('post-tool-use says so when a shell command ran in the main checkout', () => {
  const P = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-post-p-')));
  const main = path.join(P, 'repo'); fs.mkdirSync(main);
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'init', '-q', '-b', 'main'], { cwd: main, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: main, stdio: 'ignore' });
  const W = path.join(P, 'chord', 'agents', 'a');
  const wt = ensureWorktree(main, path.join(W, 'repo'), 'a');
  const d = db.openDb(':memory:');
  db.addAgent(d, { name: 'a', tool: 'codex', pid: process.pid, cwd: W });
  const ctx: Ctx = { db: d, agent: 'a', cwd: W, worktree: wt, project: P };
  const warn = (tool_input: Record<string, string>) => ((handleHook(ctx, 'codex', 'post-tool-use', { tool_name: 'Bash', tool_input }) as any)?.hookSpecificOutput?.additionalContext ?? '') as string;
  assert.match(warn({ command: 'npm test', workdir: 'repo' }), /ran in the main checkout.*chord\/agents\/a\/repo/); // Codex workdir
  assert.match(warn({ command: 'cd repo && git status' }), /main checkout/);
  assert.match(warn({ command: 'cat repo/x.txt' }), /main checkout/);
  assert.equal(warn({ command: 'npm test', workdir: 'chord/agents/a/repo' }), '');
  assert.equal(warn({ command: 'cat chord/agents/a/repo/x.txt && git -C chord/agents/a/repo status' }), '');
});

test('commandWarnings judges the command text alone, with no repository to look at', async () => {
  const { commandWarnings } = await import('../src/hooks.ts');
  const P = process.platform === 'win32' ? 'D:\P' : '/P';
  const ctx: Ctx = { db: db.openDb(':memory:'), agent: 'a', cwd: path.join(P, 'chord', 'agents', 'a'), worktree: path.join(P, 'chord', 'agents', 'a', 'repo'), project: P };
  assert.match(commandWarnings(ctx, { tool_input: { command: 'cd repo && npm test' } })[0], /main checkout/);
  assert.match(commandWarnings(ctx, { tool_input: { command: 'git stash' } })[0], /git stash is shared/);
  assert.deepEqual(commandWarnings(ctx, { tool_input: { command: 'npm test', workdir: 'chord/agents/a/repo' } }), []);
});
