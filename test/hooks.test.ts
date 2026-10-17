import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/db.ts';
import { handleHook, filesTouched } from '../src/hooks.ts';
import type { Ctx } from '../src/tools.ts';

function setup() {
  const d = db.openDb(':memory:');
  db.addAgent(d, { name: 'a', tool: 'claude', pid: process.pid, cwd: '/wt/a' });
  db.addAgent(d, { name: 'b', tool: 'codex', pid: process.pid, cwd: '/wt/b' });
  const ctx = (agent: string): Ctx => ({ db: d, agent, cwd: `/wt/${agent}`, worktree: `/wt/${agent}` });
  return { d, ctx };
}

test('filesTouched: claude edit tools and codex apply_patch', () => {
  assert.deepEqual(filesTouched('claude', { tool_name: 'Edit', tool_input: { file_path: 'C:\\wt\\a\\x.ts' } }), ['C:\\wt\\a\\x.ts']);
  assert.deepEqual(filesTouched('claude', { tool_name: 'NotebookEdit', tool_input: { notebook_path: 'n.ipynb' } }), ['n.ipynb']);
  assert.deepEqual(filesTouched('claude', { tool_name: 'Bash', tool_input: { command: 'ls' } }), []);
  assert.deepEqual(filesTouched('codex', { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: x.ts\n+1\n*** End Patch' } }), ['x.ts']);
  assert.deepEqual(filesTouched('codex', { tool_name: 'Bash', tool_input: { command: 'ls' } }), []);
});

test('session-start sets busy and briefs with peers and claims', () => {
  const { d, ctx } = setup();
  db.setTask(d, 'b', 'write tests', 'test/');
  db.addClaim(d, { agent: 'b', file: 'test/x.test.ts', intent: 'cover parser', kind: 'add' });
  const out = (handleHook(ctx('a'), 'claude', 'session-start', {}) as any).hookSpecificOutput.additionalContext as string;
  assert.equal(db.getAgent(d, 'a')!.status, 'idle'); // waiting for its first prompt
  assert.match(out, /You are agent "a"/);
  assert.match(out, /- b \(codex, busy\): write tests \[test\/\]/);
  assert.match(out, /- test\/x.test.ts <- b: add, cover parser/);
});

test('user-prompt-submit delivers unread messages once', () => {
  const { d, ctx } = setup();
  db.send(d, 'b', ['a'], 'hello a');
  const out = (handleHook(ctx('a'), 'claude', 'user-prompt-submit', {}) as any).hookSpecificOutput.additionalContext as string;
  assert.match(out, /message from b/); assert.match(out, /hello a/);
  assert.equal(handleHook(ctx('a'), 'claude', 'user-prompt-submit', {}), undefined);
});

test('pre-tool-use denies unclaimed writes and allows claimed ones', () => {
  const { d, ctx } = setup();
  const deny = handleHook(ctx('a'), 'claude', 'pre-tool-use', { tool_name: 'Write', tool_input: { file_path: '/wt/a/src/x.ts' } }) as any;
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /not claimed/);
  db.addClaim(d, { agent: 'a', file: 'src/x.ts', intent: 'x', kind: 'add' });
  assert.equal(handleHook(ctx('a'), 'claude', 'pre-tool-use', { tool_name: 'Write', tool_input: { file_path: '/wt/a/src/x.ts' } }), undefined);
  // codex path, relative
  const deny2 = handleHook(ctx('b'), 'codex', 'pre-tool-use', { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/x.ts\n*** End Patch' } }) as any;
  assert.equal(deny2.hookSpecificOutput.permissionDecision, 'deny');
  // files outside the worktree are ignored
  assert.equal(handleHook(ctx('a'), 'claude', 'pre-tool-use', { tool_name: 'Write', tool_input: { file_path: '/tmp/scratch.txt' } }), undefined);
  // non-edit tools pass
  assert.equal(handleHook(ctx('a'), 'claude', 'pre-tool-use', { tool_name: 'Read', tool_input: { file_path: '/wt/a/src/y.ts' } }), undefined);
});

test('stop feeds unread messages back, otherwise marks idle', () => {
  const { d, ctx } = setup();
  db.send(d, 'b', ['a'], 'one'); db.send(d, 'b', ['a'], 'two');
  const out = handleHook(ctx('a'), 'claude', 'stop', {}) as any;
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /one[\s\S]*two/);
  assert.equal(db.getAgent(d, 'a')!.status, 'busy');
  assert.equal(handleHook(ctx('a'), 'claude', 'stop', {}), undefined);
  assert.equal(db.getAgent(d, 'a')!.status, 'idle');
});

test('session-end goes offline and releases claims', () => {
  const { d, ctx } = setup();
  db.addClaim(d, { agent: 'a', file: 'f', intent: 'x', kind: 'add' });
  handleHook(ctx('a'), 'codex', 'session-end', {});
  assert.equal(db.getAgent(d, 'a')!.status, 'offline');
  assert.equal(db.claimsBy(d, 'a').length, 0);
});

test('pre-tool-use polices only the worktree and forbids other checkouts in the project', () => {
  const d = db.openDb(':memory:');
  const P = process.platform === 'win32' ? 'D:\\P' : '/P';
  const cwd = `${P}/chord/agents/a`.split('/').join(path.sep);
  const ctx: Ctx = { db: d, agent: 'a', cwd, worktree: `${cwd}/repo`, project: P };
  db.addAgent(d, { name: 'a', tool: 'claude', pid: process.pid, cwd, worktree: `${cwd}/repo` });
  const write = (file_path: string) => handleHook(ctx, 'claude', 'pre-tool-use', { tool_name: 'Write', tool_input: { file_path } }) as any;
  assert.match(write(`${cwd}/repo/src/x.ts`).hookSpecificOutput.permissionDecisionReason, /not claimed/); // inside the worktree: needs a claim
  assert.equal(write(`${cwd}/notes.md`), undefined); // workspace scratch file outside the repo: not policed
  assert.match(write(`${P}/repo/src/x.ts`).hookSpecificOutput.permissionDecisionReason, /outside your workspace/); // the main checkout
  assert.match(write(`${P}/chord/agents/b/repo/src/x.ts`).hookSpecificOutput.permissionDecisionReason, /outside your workspace/); // another agent
  assert.equal(write(os.tmpdir() + '/scratch.txt'), undefined); // elsewhere: not ours
  if (process.platform === 'win32') assert.equal(write('C:\\elsewhere\\x.txt'), undefined); // another drive is not "inside" anything
});

test('briefing lists only online peers and appends the repository instructions', () => {
  const { d } = setup();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'chord-brief-'));
  fs.writeFileSync(path.join(wt, 'AGENTS.md'), '# House rules\nUse tabs.\n');
  fs.writeFileSync(path.join(wt, 'CLAUDE.md'), 'Reply in French.\n');
  db.addAgent(d, { name: 'gone', tool: 'codex', pid: process.pid, cwd: '/g' }); db.setStatus(d, 'gone', 'offline');
  const ctx: Ctx = { db: d, agent: 'a', cwd: path.dirname(wt), worktree: wt };
  const out = (handleHook(ctx, 'claude', 'session-start', {}) as any).hookSpecificOutput.additionalContext as string;
  assert.ok(!out.includes('- gone'));
  assert.match(out, /Project instructions from [^\n]*AGENTS.md:\n# House rules\nUse tabs\./);
  assert.match(out, /CLAUDE.md:\nReply in French\./);
});

test('session-end after /clear keeps the agent online with its claims', () => {
  const { d, ctx } = setup();
  db.addClaim(d, { agent: 'a', file: 'f', intent: 'x', kind: 'add' });
  handleHook(ctx('a'), 'claude', 'session-end', { reason: 'clear' });
  assert.equal(db.getAgent(d, 'a')!.status, 'idle');
  assert.equal(db.claimsBy(d, 'a').length, 1);
  handleHook(ctx('a'), 'claude', 'session-end', { reason: 'prompt_input_exit' });
  assert.equal(db.getAgent(d, 'a')!.status, 'offline');
  assert.equal(db.claimsBy(d, 'a').length, 0);
});

test('changedPaths reads NUL-separated status including renames and odd names', async () => {
  const { changedPaths } = await import('../src/hooks.ts');
  const z = ' M lib/a.js\0R  new name é.txt\0old.txt\0?? dir/sub/file with space.md\0';
  assert.deepEqual(changedPaths(z), ['lib/a.js', 'new name é.txt', 'dir/sub/file with space.md']);
  assert.deepEqual(changedPaths(''), []);
});

test('a hook that throws denies the write instead of failing open', async () => {
  const { safeHandle } = await import('../src/hooks.ts');
  const d = db.openDb(':memory:'); d.close(); // every query will throw
  const ctx: Ctx = { db: d, agent: 'a', cwd: '/w', worktree: '/w/repo' };
  const out = safeHandle(ctx, 'claude', 'pre-tool-use', { tool_name: 'Write', tool_input: { file_path: '/w/repo/x.ts' } }) as any;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /chord could not check this write/);
  assert.equal(safeHandle(ctx, 'claude', 'stop', {}), undefined); // other events fail quietly
});

test('post-tool-use hands over messages that arrived mid-turn, after any tool', () => {
  const { d, ctx } = setup();
  db.send(d, 'b', ['a'], 'heads up: I am touching the footer');
  const out = handleHook(ctx('a'), 'claude', 'post-tool-use', { tool_name: 'Read' }) as any;
  assert.match(out.hookSpecificOutput.additionalContext, /message from b[\s\S]*heads up[\s\S]*arrived from other agents while you were working/);
  assert.equal(handleHook(ctx('a'), 'claude', 'post-tool-use', { tool_name: 'Read' }), undefined); // delivered once
});

test('an idle_prompt notification marks the agent idle; other notifications do not', () => {
  const { d, ctx } = setup();
  db.setStatus(d, 'a', 'busy');
  assert.equal(handleHook(ctx('a'), 'claude', 'notification', { notification_type: 'permission_prompt' }), undefined);
  assert.equal(db.getAgent(d, 'a')!.status, 'busy');
  handleHook(ctx('a'), 'claude', 'notification', { notification_type: 'idle_prompt' });
  assert.equal(db.getAgent(d, 'a')!.status, 'idle');
});
