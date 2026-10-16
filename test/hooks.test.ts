import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db.ts';
import { handleHook, filesTouched } from '../src/hooks.ts';
import type { Ctx } from '../src/tools.ts';

function setup() {
  const d = db.openDb(':memory:');
  db.addAgent(d, { name: 'a', tool: 'claude', pid: process.pid, cwd: '/wt/a' });
  db.addAgent(d, { name: 'b', tool: 'codex', pid: process.pid, cwd: '/wt/b' });
  const ctx = (agent: string): Ctx => ({ db: d, agent, cwd: `/wt/${agent}` });
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
  db.setStatus(d, 'a', 'idle');
  const out = handleHook(ctx('a'), 'claude', 'session-start', {}) as string;
  assert.equal(db.getAgent(d, 'a')!.status, 'busy');
  assert.match(out, /You are agent "a"/);
  assert.match(out, /- b \(codex, busy\): write tests \[test\/\]/);
  assert.match(out, /- test\/x.test.ts <- b: add, cover parser/);
});

test('user-prompt-submit delivers unread messages once', () => {
  const { d, ctx } = setup();
  db.send(d, 'b', ['a'], 'hello a');
  const out = handleHook(ctx('a'), 'claude', 'user-prompt-submit', {}) as string;
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
