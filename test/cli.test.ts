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
