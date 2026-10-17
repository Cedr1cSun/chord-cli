import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db.ts';

const open = () => db.openDb(':memory:');

test('agents: add, task, status, list', () => {
  const d = open();
  db.addAgent(d, { name: 'a', tool: 'claude', pid: 1, cwd: '/x' });
  db.setTask(d, 'a', 'do thing', 'src/');
  db.setStatus(d, 'a', 'idle');
  const a = db.getAgent(d, 'a')!;
  assert.equal(a.task, 'do thing');
  assert.equal(a.status, 'idle');
  // re-adding the same name resets it to a fresh busy agent
  db.addAgent(d, { name: 'a', tool: 'codex', pid: 2, cwd: '/y' });
  assert.deepEqual([db.getAgent(d, 'a')!.tool, db.getAgent(d, 'a')!.task, db.getAgent(d, 'a')!.status], ['codex', null, 'busy']);
  assert.equal(db.listAgents(d).length, 1);
});

test('sweep marks dead agents offline and drops their claims', () => {
  const d = open();
  db.addAgent(d, { name: 'live', tool: 'claude', pid: 10, cwd: '/' });
  db.addAgent(d, { name: 'dead', tool: 'codex', pid: 20, cwd: '/' });
  db.addClaim(d, { agent: 'dead', file: 'f.ts', intent: 'x', kind: 'modify' });
  const swept = db.sweep(d, pid => pid === 10);
  assert.deepEqual(swept, ['dead']);
  assert.equal(db.getAgent(d, 'dead')!.status, 'offline');
  assert.equal(db.claimsFor(d, 'f.ts').length, 0);
  assert.deepEqual(db.sweep(d, pid => pid === 10), []); // idempotent
});

test('claims: multiple agents per file, release', () => {
  const d = open();
  db.addAgent(d, { name: 'a', tool: 'claude', pid: 1, cwd: '/' });
  db.addAgent(d, { name: 'b', tool: 'codex', pid: 2, cwd: '/' });
  db.addClaim(d, { agent: 'a', file: 'f.ts', intent: 'add fn', kind: 'modify', symbols: 'foo' });
  db.addClaim(d, { agent: 'b', file: 'f.ts', intent: 'fix bug', kind: 'modify' });
  db.addClaim(d, { agent: 'a', file: 'g.ts', intent: 'new', kind: 'add' });
  assert.equal(db.claimsFor(d, 'f.ts').length, 2);
  assert.equal(db.claimsBy(d, 'a').length, 2);
  db.setAskedAt(d, 'b', 'f.ts', 123);
  assert.equal(db.claimsFor(d, 'f.ts').find(c => c.agent === 'b')!.asked_at, 123);
  db.removeClaim(d, 'a', 'g.ts');
  db.releaseAll(d, 'b');
  assert.deepEqual(db.allClaims(d).map(c => c.agent + ':' + c.file), ['a:f.ts']);
});

test('messages: send to many, take unread once, repliedSince', () => {
  const d = open();
  db.send(d, 'a', ['b', 'c'], 'hello');
  assert.equal(db.hasUnread(d, 'b'), true);
  const got = db.takeUnread(d, 'b');
  assert.deepEqual(got.map(m => [m.sender, m.body]), [['a', 'hello']]);
  assert.deepEqual(db.takeUnread(d, 'b'), []);
  assert.equal(db.hasUnread(d, 'c'), true);
  assert.equal(db.repliedSince(d, 'a', 'b', got[0].created_at), true);
  assert.equal(db.repliedSince(d, 'a', 'b', got[0].created_at + 1), false);
  assert.equal(db.repliedSince(d, 'b', 'a', 0), false);
});

test('claims on case-insensitive file systems ignore case', { skip: process.platform === 'linux' }, () => {
  const d = open();
  db.addAgent(d, { name: 'a', tool: 'claude', pid: 1, cwd: '/' });
  db.addAgent(d, { name: 'b', tool: 'codex', pid: 2, cwd: '/' });
  db.addClaim(d, { agent: 'a', file: 'Src/A.ts', intent: 'x', kind: 'modify' });
  assert.equal(db.claimsFor(d, 'src/a.ts').length, 1);
  db.addClaim(d, { agent: 'a', file: 'SRC/a.TS', intent: 'y', kind: 'modify' }); // same claim, updated
  assert.equal(db.claimsBy(d, 'a').length, 1);
  db.addClaim(d, { agent: 'b', file: 'src/a.ts', intent: 'z', kind: 'modify' });
  assert.equal(db.claimsFor(d, 'SRC/A.TS').length, 2);
});

test('takeUnread delivers within a character budget, at least one message at a time', () => {
  const d = open();
  db.send(d, 'a', ['b'], 'x'.repeat(50));
  db.send(d, 'a', ['b'], 'y'.repeat(50));
  db.send(d, 'a', ['b'], 'z'.repeat(500));
  assert.equal(db.takeUnread(d, 'b', 120).length, 2); // 50 + 50 fit, the 500 one waits
  assert.equal(db.takeUnread(d, 'b', 120).length, 1); // too big for the budget but always delivered alone
  assert.equal(db.hasUnread(d, 'b'), false);
});

test('sweep also kills agents whose heartbeat went stale, even when the pid is alive', () => {
  const d = open();
  db.addAgent(d, { name: 'beating', tool: 'claude', pid: 1, cwd: '/', heartbeat: true });
  db.addAgent(d, { name: 'silent', tool: 'codex', pid: 2, cwd: '/', heartbeat: true });
  db.addAgent(d, { name: 'nobeat', tool: 'codex', pid: 3, cwd: '/' }); // no heartbeat column: pid alone decides
  const t = Date.now();
  d.prepare('update agents set heartbeat_at = ? where name = ?').run(t - db.HEARTBEAT_STALE_MS - 1, 'silent');
  assert.deepEqual(db.sweep(d, () => true, t), ['silent']);
  db.heartbeat(d, 'beating');
  assert.deepEqual(db.sweep(d, () => true, t + 10), []);
});

test('only the wrapper brings an agent back from offline: hooks cannot, the heartbeat can', () => {
  const d = open();
  db.addAgent(d, { name: 'a', tool: 'claude', pid: 1, cwd: '/', heartbeat: true });
  db.setStatus(d, 'a', 'offline');
  db.setStatus(d, 'a', 'idle'); // a Stop hook that outlived its killed agent
  assert.equal(db.getAgent(d, 'a')!.status, 'offline');
  db.heartbeat(d, 'a');
  assert.equal(db.getAgent(d, 'a')!.status, 'idle');
  db.setStatus(d, 'a', 'busy');
  assert.equal(db.getAgent(d, 'a')!.status, 'busy');
  db.heartbeat(d, 'a');
  assert.equal(db.getAgent(d, 'a')!.status, 'busy'); // a heartbeat never changes a live agent's status
});
