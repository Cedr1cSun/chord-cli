import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db.ts';
import { ls } from '../src/cli.ts';

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
