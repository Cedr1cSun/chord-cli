import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db.ts';
import { handle } from '../src/mcp.ts';
import { tools, canWrite, normFile, REPLY_TIMEOUT_MS, type Ctx } from '../src/tools.ts';

function setup() {
  const d = db.openDb(':memory:');
  const ctx = (agent: string): Ctx => ({ db: d, agent, cwd: `/wt/${agent}`, worktree: `/wt/${agent}` });
  db.addAgent(d, { name: 'a', tool: 'claude', pid: process.pid, cwd: '/wt/a' });
  db.addAgent(d, { name: 'b', tool: 'codex', pid: process.pid, cwd: '/wt/b' });
  const call = (agent: string, name: string, args: Record<string, unknown> = {}) => {
    const res = handle(tools(ctx(agent)), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) as any;
    return res.result.isError ? { error: res.result.content[0].text } : JSON.parse(res.result.content[0].text);
  };
  return { d, ctx, call };
}

test('normFile makes paths worktree-relative with forward slashes', () => {
  const ctx: Ctx = { db: db.openDb(':memory:'), agent: 'a', cwd: '/wt/a', worktree: '/wt/a' };
  assert.equal(normFile(ctx, 'src/x.ts'), 'src/x.ts');
  assert.equal(normFile(ctx, '/wt/a/src/x.ts'), 'src/x.ts');
  assert.equal(normFile(ctx, './src/../src/x.ts'), 'src/x.ts');
});

test('unclaimed file cannot be written; sole claimant can', () => {
  const { ctx, call } = setup();
  assert.equal(canWrite(ctx('a'), 'f.ts').ok, false);
  const r = call('a', 'claim', { file: 'f.ts', intent: 'add parser', kind: 'add' });
  assert.deepEqual(r, { claimed: 'f.ts', must_talk_to: [] });
  assert.equal(canWrite(ctx('a'), 'f.ts').ok, true);
  assert.equal(canWrite(ctx('a'), '/wt/a/f.ts').ok, true);
  assert.equal(call('a', 'claim', { file: 'f.ts', intent: 'x', kind: 'bogus' }).error, 'kind must be add, modify, delete or rename');
});

test('latecomer must message every earlier occupant and hear back', () => {
  const { d, ctx, call } = setup();
  call('a', 'claim', { file: 'f.ts', intent: 'add parser', kind: 'add', symbols: 'parse' });
  // make b's claim strictly later
  d.prepare('update claims set created_at = created_at - 1000').run();
  const r = call('b', 'claim', { file: 'f.ts', intent: 'fix types', kind: 'modify' });
  assert.deepEqual(r.must_talk_to, [{ agent: 'a', intent: 'add parser', kind: 'add', symbols: 'parse' }]);
  assert.ok(r.next);

  // a, the earlier claimant, is never blocked by b
  assert.equal(canWrite(ctx('a'), 'f.ts').ok, true);

  let c = canWrite(ctx('b'), 'f.ts');
  assert.equal(c.ok, false); assert.match((c as any).reason, /send each of them a message/);

  call('b', 'send', { to: 'a', message: 'I will change the type signatures in f.ts' });
  c = canWrite(ctx('b'), 'f.ts');
  assert.equal(c.ok, false); assert.match((c as any).reason, /waiting for a reply from a/);

  call('a', 'send', { to: 'b', message: 'fine, keep parse() as is' });
  assert.equal(canWrite(ctx('b'), 'f.ts').ok, true);
});

test('timeout and offline occupants unblock the latecomer', () => {
  const { d, ctx, call } = setup();
  call('a', 'claim', { file: 'f.ts', intent: 'x', kind: 'modify' });
  d.prepare('update claims set created_at = created_at - 1000').run();
  call('b', 'claim', { file: 'f.ts', intent: 'y', kind: 'modify' });
  const asked = db.claimsFor(d, 'f.ts').find(c => c.agent === 'b')!.asked_at!;
  assert.equal(canWrite(ctx('b'), 'f.ts', asked + REPLY_TIMEOUT_MS - 1).ok, false);
  assert.equal(canWrite(ctx('b'), 'f.ts', asked + REPLY_TIMEOUT_MS).ok, true);
  db.setStatus(d, 'a', 'offline');
  assert.equal(canWrite(ctx('b'), 'f.ts').ok, true);
});

test('release drops the claim', () => {
  const { ctx, call } = setup();
  call('a', 'claim', { file: 'f.ts', intent: 'x', kind: 'modify' });
  assert.deepEqual(call('a', 'release', { file: './f.ts' }), { released: 'f.ts' });
  assert.equal(canWrite(ctx('a'), 'f.ts').ok, false);
});

test('a peer who explained their scope before the latecomer claimed counts as having replied', () => {
  const { d, ctx, call } = setup();
  call('a', 'claim', { file: 'f.ts', intent: 'header', kind: 'modify' });
  d.prepare('update claims set created_at = created_at - 1000').run();
  call('a', 'send', { to: 'b', message: 'FYI I only touch the header of f.ts' }); // before b claims
  call('b', 'claim', { file: 'f.ts', intent: 'footer', kind: 'modify' });
  let c = canWrite(ctx('b'), 'f.ts');
  assert.equal(c.ok, false); assert.match((c as any).reason, /send each of them a message/); // b still has to say what it does
  call('b', 'send', { to: 'a', message: 'I only touch the footer' });
  assert.equal(canWrite(ctx('b'), 'f.ts').ok, true); // a's earlier note is the reply
});
