import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

test('the database runs in WAL mode without an fsync per write', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-pragma-')), 'chord.db');
  const d = db.openDb(file);
  assert.equal(d.prepare('pragma journal_mode').get()!.journal_mode, 'wal');
  assert.equal(d.prepare('pragma synchronous').get()!.synchronous, 1); // normal: a heartbeat a second from every wrapper must not wait for the disk
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
  db.removeClaim(d, 'a', 'g.ts');
  db.releaseAll(d, 'b');
  assert.deepEqual(db.allClaims(d).map(c => c.agent + ':' + c.file), ['a:f.ts']);
});

test('messages: send to many, take unread once, firstMessageAt', () => {
  const d = open();
  db.send(d, 'a', ['b', 'c'], 'hello');
  assert.equal(db.hasUnread(d, 'b'), true);
  const got = db.takeUnread(d, 'b');
  assert.deepEqual(got.map(m => [m.sender, m.body]), [['a', 'hello']]);
  assert.deepEqual(db.takeUnread(d, 'b'), []);
  assert.equal(db.hasUnread(d, 'c'), true);
  assert.equal(db.firstMessageAt(d, 'a', 'b', got[0].created_at), got[0].created_at);
  assert.equal(db.firstMessageAt(d, 'a', 'b', got[0].created_at + 1), null);
  assert.equal(db.firstMessageAt(d, 'b', 'a', 0), null);
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
  assert.equal(db.setStatus(d, 'a', 'offline'), true);
  assert.equal(db.setStatus(d, 'a', 'idle'), false); // a Stop hook that outlived its killed agent
  assert.equal(db.getAgent(d, 'a')!.status, 'offline');
  db.heartbeat(d, 'a');
  assert.equal(db.getAgent(d, 'a')!.status, 'busy'); // revived as busy: it may have been working the whole time
  db.setStatus(d, 'a', 'idle');
  assert.equal(db.getAgent(d, 'a')!.status, 'idle');
  db.heartbeat(d, 'a');
  assert.equal(db.getAgent(d, 'a')!.status, 'idle'); // a heartbeat never changes a live agent's status
});

test('sweep: when every heartbeat is stale the machine slept, so nobody is killed for it', () => {
  const d = open();
  db.addAgent(d, { name: 'a', tool: 'claude', pid: 1, cwd: '/', heartbeat: true });
  db.addAgent(d, { name: 'b', tool: 'codex', pid: 2, cwd: '/', heartbeat: true });
  const t = Date.now();
  d.prepare('update agents set heartbeat_at = ?').run(t - db.HEARTBEAT_STALE_MS - 5000);
  assert.deepEqual(db.sweep(d, () => true, t), []); // both stale: asleep, not dead
  assert.deepEqual(db.sweep(d, pid => pid !== 2, t), ['b']); // a missing pid still counts
  db.heartbeat(d, 'a');
  assert.deepEqual(db.sweep(d, () => true, Date.now()), []); // b already offline; a fresh
  db.addAgent(d, { name: 'c', tool: 'codex', pid: 3, cwd: '/', heartbeat: true });
  d.prepare("update agents set heartbeat_at = ? where name = 'c'").run(t - db.HEARTBEAT_STALE_MS - 5000);
  assert.deepEqual(db.sweep(d, () => true, Date.now()), ['c']); // one stale among fresh ones: dead
});

test('openDb upgrades a database from before heartbeat_at and keeps its rows', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-mig-')), 'chord.db');
  const old = new DatabaseSync(file);
  old.exec(`create table agents (name text primary key, tool text not null, pid integer not null, cwd text not null, worktree text not null,
    task text, scope text, status text not null default 'busy', started_at integer not null, updated_at integer not null);
    insert into agents (name, tool, pid, cwd, worktree, status, started_at, updated_at) values ('old', 'claude', 1, '/', '/', 'offline', 1, 1);`);
  old.close();
  const d = db.openDb(file);
  assert.equal(d.prepare('pragma user_version').get()!.user_version, 4);
  const cols = (table: string) => (d.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map(c => c.name);
  assert.ok(!cols('agents').includes('worktree') && !cols('claims').includes('asked_at')); // written and never read: dropped
  assert.equal(db.getAgent(d, 'old')!.session_id, null);
  assert.deepEqual(db.getAgent(d, 'old')!.heartbeat_at, null);
  assert.equal(db.getAgent(d, 'old')!.stop_requested_at, null);
  assert.equal(db.requestStop(d, 'old'), false); // offline
  assert.deepEqual(db.listEvents(d), []); // the events table exists
  assert.equal(db.getAgent(d, 'old')!.status, 'offline');
  db.heartbeat(d, 'old'); // the new column works
  assert.ok(db.getAgent(d, 'old')!.heartbeat_at! > 0);
  d.close();
  assert.equal(db.openDb(file).prepare('pragma user_version').get()!.user_version, 4); // idempotent
});

test('claims, releases and sweeps leave events behind', () => {
  const d = open();
  db.addAgent(d, { name: 'a', tool: 'claude', pid: 1, cwd: '/' });
  db.addClaim(d, { agent: 'a', file: 'f.ts', intent: 'x', kind: 'modify' });
  db.addClaim(d, { agent: 'a', file: 'g.ts', intent: 'y', kind: 'add' });
  db.removeClaim(d, 'a', 'f.ts');
  db.removeClaim(d, 'a', 'f.ts'); // already gone: no event
  assert.deepEqual(db.listEvents(d).map(e => [e.kind, e.file, e.detail]), [['claim', 'f.ts', 'modify: x'], ['claim', 'g.ts', 'add: y'], ['release', 'f.ts', 'released']]);
  assert.deepEqual(db.sweep(d, () => false), ['a']);
  assert.deepEqual(db.listEvents(d, 'a', 1).map(e => [e.kind, e.file, e.detail]), [['release', 'g.ts', 'swept']]);
});

test('listMessages returns the latest messages oldest first, for one agent or all', () => {
  const d = open();
  db.addAgent(d, { name: 'a', tool: 'claude', pid: 1, cwd: '/' });
  db.addAgent(d, { name: 'b', tool: 'codex', pid: 1, cwd: '/' });
  db.addAgent(d, { name: 'c', tool: 'codex', pid: 1, cwd: '/' });
  db.send(d, 'a', ['b'], 'one'); db.send(d, 'b', ['a'], 'two'); db.send(d, 'c', ['b'], 'three');
  assert.deepEqual(db.listMessages(d).map(m => m.body), ['one', 'two', 'three']);
  assert.deepEqual(db.listMessages(d, 'a').map(m => m.body), ['one', 'two']);
  assert.deepEqual(db.listMessages(d, 'b', 2).map(m => m.body), ['two', 'three']);
  assert.deepEqual(db.listMessages(d, 'zz'), []);
});

test('a stop request only sticks to an online agent and a relaunch clears it', () => {
  const d = open();
  db.addAgent(d, { name: 'a', tool: 'claude', pid: 1, cwd: '/' });
  assert.equal(db.getAgent(d, 'a')!.stop_requested_at, null);
  db.setStatus(d, 'a', 'offline');
  assert.equal(db.requestStop(d, 'a'), false); // offline
  db.addAgent(d, { name: 'a', tool: 'claude', pid: 1, cwd: '/' }); // relaunch
  assert.equal(db.requestStop(d, 'a'), true);
  assert.ok(db.getAgent(d, 'a')!.stop_requested_at! > 0);
  db.addAgent(d, { name: 'a', tool: 'claude', pid: 2, cwd: '/' });
  assert.equal(db.getAgent(d, 'a')!.stop_requested_at, null); // a relaunch starts without a pending stop
  assert.equal(db.requestStop(d, 'nobody'), false);
});

test('a notice waits for the next hook; only a message wakes an idle agent', () => {
  const d = open();
  db.addAgent(d, { name: 'a', tool: 'claude', pid: 1, cwd: '/' });
  db.send(d, 'peer', ['a'], 'x merged into main', 'notice');
  assert.equal(db.hasUnread(d, 'a'), false);
  db.send(d, 'peer', ['a'], 'are you there?');
  assert.equal(db.hasUnread(d, 'a'), true);
  assert.equal(db.takeUnread(d, 'a').length, 2); // both are delivered together
  assert.equal(db.hasUnread(d, 'a'), false);
});

test('six processes opening a brand-new database at once all get in', async () => {
  const { execFile } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chord-open-'));
  const script = path.join(dir, 'open.mjs');
  const dbTs = new URL('../src/db.ts', import.meta.url).href;
  fs.writeFileSync(script, `import { openDb, addAgent } from ${JSON.stringify(dbTs)};
while (Date.now() < Number(process.argv[2]));
const d = openDb(${JSON.stringify(path.join(dir, 'chord.db'))});
addAgent(d, { name: 'a' + process.pid, tool: 'claude', pid: process.pid, cwd: '/x' });
console.log('ok');`);
  // every child opens at the same instant, so the first-open race is real and not spread out by startup time
  const run = (at: number) => new Promise<string>((resolve, reject) => execFile(process.execPath, [script, String(at)], (e, out, err) => e ? reject(new Error(err || e.message)) : resolve(out.trim())));
  for (let round = 0; round < 3; round++) {
    fs.rmSync(path.join(dir, 'chord.db'), { force: true });
    const at = Date.now() + 1500;
    assert.deepEqual(await Promise.all(Array.from({ length: 6 }, () => run(at))), Array(6).fill('ok'));
  }
});

test('the log rotates once it grows past its limit, keeping one old copy', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-log-')), 'chord.db');
  const saved = process.env.CHORD_DB;
  process.env.CHORD_DB = file;
  try {
    fs.writeFileSync(`${file}.log`, Buffer.alloc(db.LOG_MAX_BYTES + 1, 0x78));
    db.log('after the limit');
    assert.ok(fs.statSync(`${file}.log.1`).size > db.LOG_MAX_BYTES); // the full file moved aside
    assert.match(fs.readFileSync(`${file}.log`, 'utf8'), /^[^\n]*after the limit\n$/); // the new file starts with this line
    db.log('and another'); // well under the limit: appended
    assert.equal(fs.readFileSync(`${file}.log`, 'utf8').split('\n').length, 3);
  } finally { process.env.CHORD_DB = saved; }
});

test('removeAgent keeps what the agent said and nobody has read yet', () => {
  const d = open();
  db.addAgent(d, { name: 'a', tool: 'claude', pid: 1, cwd: '/' });
  db.addAgent(d, { name: 'b', tool: 'codex', pid: 2, cwd: '/' });
  db.send(d, 'a', ['b'], 'hello'); db.takeUnread(d, 'b', 1); // read
  db.send(d, 'a', ['b'], 'f.ts is yours now, I am done'); // a's parting word, not yet read when a is cleaned away
  db.send(d, 'b', ['a'], 'thanks');
  db.removeAgent(d, 'a');
  assert.equal(db.getAgent(d, 'a'), undefined);
  assert.deepEqual(db.takeUnread(d, 'b').map(m => m.body), ['f.ts is yours now, I am done']);
  assert.deepEqual(db.listMessages(d, 'a').map(m => m.body), ['f.ts is yours now, I am done']); // the read one and those to a are gone
});

test('heartbeatAll refreshes every online wrapper at once, so a machine waking up kills nobody', () => {
  const d = open();
  const t = Date.now();
  db.addAgent(d, { name: 'a', tool: 'claude', pid: 1, cwd: '/', heartbeat: true });
  db.addAgent(d, { name: 'b', tool: 'codex', pid: 2, cwd: '/', heartbeat: true });
  db.addAgent(d, { name: 'starting', tool: 'codex', pid: 3, cwd: '/' }); // no wrapper yet: judged by pid, not given a heartbeat
  db.addAgent(d, { name: 'gone', tool: 'codex', pid: 4, cwd: '/', heartbeat: true }); db.setStatus(d, 'gone', 'offline');
  d.prepare('update agents set heartbeat_at = ? where heartbeat_at is not null').run(t - db.HEARTBEAT_STALE_MS - 5000);
  // the first wrapper to wake writes its own heartbeat; a hook sweeping in the next second would then see one fresh
  // heartbeat among stale ones and kill the rest, unless the wrapper vouches for everyone
  db.heartbeatAll(d);
  db.heartbeat(d, 'a');
  assert.deepEqual(db.sweep(d, () => true, Date.now()), []);
  assert.ok(db.getAgent(d, 'b')!.heartbeat_at! > t - 1000);
  assert.equal(db.getAgent(d, 'starting')!.heartbeat_at, null);
  assert.equal(db.getAgent(d, 'gone')!.heartbeat_at, t - db.HEARTBEAT_STALE_MS - 5000);
});

test('the wrapper takes over a reserved agent with its pid and first heartbeat, keeping messages and a stop request', () => {
  const d = open();
  db.addAgent(d, { name: 'a', tool: 'claude', pid: 1, cwd: '/' }); // reserved by prepare, no heartbeat yet
  db.send(d, 'peer', ['a'], 'arrived while the worktree was being set up');
  db.requestStop(d, 'a');
  db.setPid(d, 'a', 42);
  db.heartbeat(d, 'a');
  const a = db.getAgent(d, 'a')!;
  assert.equal(a.pid, 42);
  assert.ok(a.heartbeat_at! > 0);
  assert.equal(db.hasUnread(d, 'a'), true);
  assert.ok(a.stop_requested_at! > 0);
});

test('session id survives a relaunch and is replaced by the next session', () => {
  const d = open();
  db.addAgent(d, { name: 'a', tool: 'claude', pid: 1, cwd: '/' });
  db.setSession(d, 'a', 'sid-1');
  db.addAgent(d, { name: 'a', tool: 'claude', pid: 2, cwd: '/' }); // relaunch
  assert.equal(db.getAgent(d, 'a')!.session_id, 'sid-1');
  db.setSession(d, 'a', 'sid-2');
  assert.equal(db.getAgent(d, 'a')!.session_id, 'sid-2');
  db.addAgent(d, { name: 'a', tool: 'codex', pid: 3, cwd: '/' }); // another tool: its conversations are elsewhere
  assert.equal(db.getAgent(d, 'a')!.session_id, null);
});

test('a watch over stale heartbeats tells a sleeping machine from dead wrappers', () => {
  const d = open();
  const t = Date.now();
  db.addAgent(d, { name: 'x', tool: 'claude', pid: 1, cwd: '/', heartbeat: true });
  db.addAgent(d, { name: 'y', tool: 'codex', pid: 2, cwd: '/', heartbeat: true });
  d.prepare('update agents set heartbeat_at = ?, started_at = ?').run(t - db.HEARTBEAT_STALE_MS - 5000, t - 3_600_000);
  assert.deepEqual(db.sweep(d, () => true, t), []); // every heartbeat stale at once: asleep, not dead
  // a heartbeat that moves during the watch is a live wrapper; the one that does not is dead
  assert.deepEqual(db.sweep(d, () => true, t, 10, () => db.heartbeat(d, 'x')), ['y']);
  assert.equal(db.getAgent(d, 'x')!.status, 'busy');
  d.prepare('update agents set heartbeat_at = ?').run(t - db.HEARTBEAT_STALE_MS - 5000);
  // an agent still starting (setup, Codex's first-start wait) writes no heartbeat yet; its live pid keeps it
  db.addAgent(d, { name: 'z', tool: 'codex', pid: 3, cwd: '/', heartbeat: true });
  d.prepare("update agents set heartbeat_at = ? where name = 'z'").run(t - db.HEARTBEAT_STALE_MS - 5000);
  assert.deepEqual(db.sweep(d, () => true, t, 10).sort(), ['x']); // y already offline; x did not move: dead; z is starting
  assert.deepEqual(db.sweep(d, () => false, t, 10).sort(), ['z']); // but a dead pid is dead, starting or not
  assert.equal(db.getAgent(d, 'x')!.status, 'offline');
});
