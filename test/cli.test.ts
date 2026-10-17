import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db.ts';
import { events, listArgs, ls, messages, when } from '../src/cli.ts';

test('events lists claims, releases and merges oldest first, one line each', () => {
  const d = db.openDb(':memory:');
  assert.equal(events(d, 'a'), 'no events for a\n');
  db.addAgent(d, { name: 'a', tool: 'claude', pid: process.pid, cwd: '/' });
  const now = Date.now();
  db.addClaim(d, { agent: 'a', file: 'src/x.ts', intent: 'add route', kind: 'add' });
  db.removeClaim(d, 'a', 'src/x.ts');
  db.addEvent(d, 'a', 'merge', null, '2 commit(s) into main: x; y');
  const es = events(d, undefined, 50, now).split('\n').filter(Boolean);
  assert.match(es[0], /^\d\d:\d\d:\d\d a\s+claim\s+src\/x.ts add: add route$/);
  assert.match(es[1], /^\d\d:\d\d:\d\d a\s+release\s+src\/x.ts released$/);
  assert.match(es[2], /^\d\d:\d\d:\d\d a\s+merge\s+2 commit\(s\) into main: x; y$/);
  assert.equal(events(d, undefined, 1, now).split('\n').filter(Boolean).length, 1); // -n keeps the latest
  assert.equal(events(d, 'b'), 'no events for b\n');
  assert.deepEqual(listArgs([]), { agent: undefined, limit: 50 });
  assert.deepEqual(listArgs(['a', '-n', '5']), { agent: 'a', limit: 5 });
  assert.throws(() => listArgs(['-n', 'x']), /positive number/);
  assert.throws(() => listArgs(['--full']), /unknown option/);
  assert.throws(() => listArgs(['a', 'b']), /at most one agent/);
  assert.match(when(now, now), /^\d\d:\d\d:\d\d$/);
  assert.match(when(now - 3 * 86_400_000, now), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
});

test('messages lists message history oldest first, marking notices and unread ones', () => {
  const d = db.openDb(':memory:');
  assert.equal(messages(d), 'no messages\n');
  db.addAgent(d, { name: 'a', tool: 'claude', pid: process.pid, cwd: '/' });
  db.addAgent(d, { name: 'b', tool: 'codex', pid: process.pid, cwd: '/' });
  db.send(d, 'a', ['b'], 'first\nline two');
  db.send(d, 'b', ['a'], 'reply', 'notice');
  db.takeUnread(d, 'b');
  const now = Date.now();
  const ms = messages(d, undefined, 50, now).split('\n').filter(Boolean);
  assert.equal(ms.length, 2);
  assert.match(ms[0], /^\d\d:\d\d:\d\d a -> b: first line two$/);
  assert.match(ms[1], /^\d\d:\d\d:\d\d b -> a \[notice\] \(unread\): reply$/);
  assert.equal(messages(d, 'b', 1, now).split('\n').filter(Boolean).length, 1); // -n keeps the latest
  assert.equal(messages(d, 'c'), 'no messages to or from c\n');
});


test('ls lists agents and claims, sweeping dead ones', () => {
  const d = db.openDb(':memory:');
  assert.equal(ls(d), 'no agents\n\nno claims\n');
  db.addAgent(d, { name: 'a', tool: 'claude', pid: process.pid, cwd: '/' });
  db.setTask(d, 'a', 'build api', 'src/api');
  db.addAgent(d, { name: 'dead', tool: 'codex', pid: 999_999_999, cwd: '/' });
  db.addClaim(d, { agent: 'a', file: 'src/api/x.ts', intent: 'add route', kind: 'add' });
  const out = ls(d);
  assert.match(out, /^a\s+claude\s+busy\s+build api \[src\/api\]/m);
  assert.match(out, /^dead\s+codex\s+offline/m);
  assert.match(out, /^src\/api\/x.ts\s+a\s+add\s+add route/m);
});

test('takeName accepts --name x and --name=x anywhere and insists on a value', async () => {
  const { takeName } = await import('../src/cli.ts');
  let rest = ['--model', 'opus', '--name', 'bob', '-p'];
  assert.equal(takeName(rest), 'bob'); assert.deepEqual(rest, ['--model', 'opus', '-p']);
  rest = ['--name=alice', 'x']; assert.equal(takeName(rest), 'alice'); assert.deepEqual(rest, ['x']);
  rest = ['x']; assert.equal(takeName(rest), undefined); assert.deepEqual(rest, ['x']);
  assert.throws(() => takeName(['--name']), /needs a value/);
  assert.throws(() => takeName(['--name', '--model']), /needs a value/);
  assert.throws(() => takeName(['--name=']), /needs a value/);
});

test('lsAll survives an unreadable project database', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { lsAll } = await import('../src/cli.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chord-lsall-'));
  const prev = process.env.CHORD_HOME; process.env.CHORD_HOME = home;
  try {
    const bad = path.join(home, 'projects', 'bad-000000'); fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'chord.db'), 'this is not a database'); fs.writeFileSync(path.join(bad, 'path'), 'D:/bad');
    const good = path.join(home, 'projects', 'good-000000'); fs.mkdirSync(good, { recursive: true });
    db.openDb(path.join(good, 'chord.db')).close(); fs.writeFileSync(path.join(good, 'path'), 'D:/good');
    const out = lsAll();
    assert.match(out, /== D:\/bad\n\(unreadable:/); assert.match(out, /== D:\/good\nno agents/);
  } finally { process.env.CHORD_HOME = prev; }
});
