import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from '../src/db.ts';
import { ensureWorktree } from '../src/launch.ts';

const helper = fileURLToPath(new URL('./helpers/finish-one.ts', import.meta.url));
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();

test('five agents finishing at the same moment all land on main', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-race-')));
  git(root, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n'); git(root, 'add', 'base.txt'); git(root, 'commit', '-q', '-m', 'init');
  const file = path.join(root, '.git', 'chord.db');
  const d = db.openDb(file);
  const names = ['a', 'b', 'c', 'd', 'e'];
  const wts = names.map(n => {
    const wt = ensureWorktree(root, n);
    db.addAgent(d, { name: n, tool: 'claude', pid: process.pid, cwd: wt });
    db.addClaim(d, { agent: n, file: `${n}.txt`, intent: 'x', kind: 'add' });
    fs.writeFileSync(path.join(wt, `${n}.txt`), n + '\n'); git(wt, 'add', `${n}.txt`); git(wt, 'commit', '-q', '-m', `feat: ${n}`);
    return wt;
  });
  const results = await Promise.all(wts.map((wt, i) => new Promise<string>(res =>
    execFile(process.execPath, [helper, file, names[i], wt], { encoding: 'utf8' }, (_e, out) => res(out)))));
  const failed = results.filter(r => r.startsWith('ERROR'));
  assert.deepEqual(failed, [], 'every finish should succeed');
  const log = git(root, 'log', '--format=%s', 'main').split('\n');
  assert.deepEqual(log.filter(s => s.startsWith('feat: ')).sort(), names.map(n => `feat: ${n}`));
  assert.equal(db.allClaims(d).length, 0);
  for (const n of names) assert.ok(fs.existsSync(path.join(root, `${n}.txt`)));
});
