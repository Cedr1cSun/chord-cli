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
  db.addAgent(d, { name: 'a', tool: 'codex', pid: process.pid, cwd: ws, worktree: wt });
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
  db.addAgent(d, { name: 'w', tool: 'claude', pid: process.pid, cwd: ws, worktree: wt });
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
  // the main checkout dirtied by the shell blocks everyone's finish
  fs.appendFileSync(path.join(root, 'a.txt'), 'oops');
  assert.match(run('ls'), /main checkout \(.*\) has uncommitted changes.*a.txt/);
});
