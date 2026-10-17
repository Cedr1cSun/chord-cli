import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/db.ts';
import { handleHook } from '../src/hooks.ts';
import type { Ctx } from '../src/tools.ts';

function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-post-')));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'a\n');
  git('add', 'notes.txt'); git('commit', '-q', '-m', 'init');
  const d = db.openDb(':memory:');
  db.addAgent(d, { name: 'a', tool: 'claude', pid: process.pid, cwd: root });
  const ctx: Ctx = { db: d, agent: 'a', cwd: root };
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
