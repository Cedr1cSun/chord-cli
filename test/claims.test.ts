import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db.ts';
import { handle } from '../src/mcp.ts';
import path from 'node:path';
import { tools, canWrite, claimPath, normFile, REPLY_TIMEOUT_MS, type Ctx } from '../src/tools.ts';

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
  // without ever telling a, time alone never unblocks b
  assert.equal(canWrite(ctx('b'), 'f.ts', Date.now() + 10 * REPLY_TIMEOUT_MS).ok, false);
  call('b', 'send', { to: 'a', message: 'I am changing f.ts too' });
  const asked = db.firstMessageAt(d, 'b', 'a', 0)!;
  assert.equal(canWrite(ctx('b'), 'f.ts', asked + REPLY_TIMEOUT_MS - 1).ok, false);
  assert.equal(canWrite(ctx('b'), 'f.ts', asked + REPLY_TIMEOUT_MS).ok, true); // a stayed silent: no objection
  db.setStatus(d, 'a', 'offline');
  assert.equal(canWrite(ctx('b'), 'f.ts').ok, true);
});

test('notices such as merge broadcasts do not count as replies', () => {
  const { d, ctx, call } = setup();
  call('a', 'claim', { file: 'f.ts', intent: 'x', kind: 'modify' });
  d.prepare('update claims set created_at = created_at - 1000').run();
  call('b', 'claim', { file: 'f.ts', intent: 'y', kind: 'modify' });
  call('b', 'send', { to: 'a', message: 'changing the footer' });
  db.send(d, 'a', ['b'], 'a merged into main: ...', 'notice');
  assert.match((canWrite(ctx('b'), 'f.ts') as any).reason, /waiting for a reply from a/);
  db.send(d, 'a', ['b'], 'fine by me');
  assert.equal(canWrite(ctx('b'), 'f.ts').ok, true);
});

test('two claims in the same millisecond are ordered by insertion', () => {
  const { d, ctx, call } = setup();
  call('a', 'claim', { file: 'f.ts', intent: 'x', kind: 'modify' });
  call('b', 'claim', { file: 'f.ts', intent: 'y', kind: 'modify' });
  d.prepare('update claims set created_at = 1000').run(); // identical timestamps
  assert.equal(canWrite(ctx('a'), 'f.ts').ok, true); // a was inserted first
  assert.match((canWrite(ctx('b'), 'f.ts') as any).reason, /also claimed by a/);
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

test('claimPath accepts workspace-relative and repository-relative forms and refuses paths outside the workspace', async () => {
  const { claimPath } = await import('../src/tools.ts');
  const ctx: Ctx = { db: db.openDb(':memory:'), agent: 'a', cwd: '/P/chord/agents/a', worktree: '/P/chord/agents/a/repo' };
  assert.equal(claimPath(ctx, 'repo/src/x.ts'), 'repo/src/x.ts');
  assert.equal(claimPath(ctx, 'src/x.ts'), 'repo/src/x.ts');
  assert.equal(claimPath(ctx, 'repo'), 'repo');
  assert.equal(claimPath(ctx, '/P/chord/agents/a/repo/src/x.ts'), 'repo/src/x.ts');
  assert.equal(claimPath(ctx, 'notes.txt'), 'repo/notes.txt'); // bare names are repository files
  assert.throws(() => claimPath(ctx, '../verification/x.patch'), /outside your workspace/);
  assert.throws(() => claimPath(ctx, '/P/repo/src/x.ts'), /outside your workspace/);
  // workspace == worktree (no repo subdirectory): everything is relative to it
  const flat: Ctx = { db: ctx.db, agent: 'a', cwd: '/wt', worktree: '/wt' };
  assert.equal(claimPath(flat, 'src/x.ts'), 'src/x.ts');
});

test('claimPath resolves a package named like the repository by what exists on disk', async () => {
  const { claimPath } = await import('../src/tools.ts');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-rich-')));
  const wt = path.join(ws, 'rich'); fs.mkdirSync(path.join(wt, 'rich'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'rich', 'console.py'), ''); fs.writeFileSync(path.join(wt, 'README.md'), '');
  const ctx: Ctx = { db: db.openDb(':memory:'), agent: 'a', cwd: ws, worktree: wt };
  assert.equal(claimPath(ctx, 'rich/console.py'), 'rich/rich/console.py'); // only the package file exists
  assert.equal(claimPath(ctx, 'rich/README.md'), 'rich/README.md'); // only the workspace reading exists
  assert.equal(claimPath(ctx, 'rich/new.py'), 'rich/new.py'); // neither exists: the workspace reading, as before
  fs.writeFileSync(path.join(wt, 'console.py'), '');
  assert.throws(() => claimPath(ctx, 'rich/console.py'), /ambiguous/); // both exist
  assert.equal(claimPath(ctx, 'rich/rich/console.py'), 'rich/rich/console.py'); // the full path is never ambiguous
});

test('a relaunched occupant must be told again: only both current sessions count', () => {
  const { d, ctx, call } = setup();
  call('a', 'claim', { file: 'f.ts', intent: 'x', kind: 'modify' });
  d.prepare('update claims set created_at = created_at - 1000').run();
  call('b', 'claim', { file: 'f.ts', intent: 'y', kind: 'modify' });
  call('b', 'send', { to: 'a', message: 'changing the footer' });
  call('a', 'send', { to: 'b', message: 'fine' });
  assert.equal(canWrite(ctx('b'), 'f.ts').ok, true);
  // a crashes and comes back under the same name a little later; its old reply no longer counts
  d.prepare("update agents set started_at = ? where name = 'a'").run(Date.now() + 5000);
  db.addClaim(d, { agent: 'a', file: 'f.ts', intent: 'x', kind: 'modify' }); d.prepare("update claims set created_at = 0 where agent = 'a'").run();
  assert.match((canWrite(ctx('b'), 'f.ts', Date.now() + 6000) as any).reason, /also claimed by a/);
});

test('an old, unrelated message to the occupant is not notice of the claim; one just before it is', () => {
  const { d, ctx, call } = setup();
  const now = Date.now();
  d.prepare('update agents set started_at = ?').run(now - 20 * 60 * 1000); // both sessions have been running a while
  call('a', 'claim', { file: 'f.ts', intent: 'x', kind: 'modify' });
  d.prepare('update claims set created_at = created_at - 1000').run();
  call('b', 'send', { to: 'a', message: 'hi, I am working on the docs today' }); // fifteen minutes before b claims f.ts
  d.prepare("update messages set created_at = ? where sender = 'b'").run(now - 15 * 60 * 1000);
  call('b', 'claim', { file: 'f.ts', intent: 'y', kind: 'modify' });
  const c = canWrite(ctx('b'), 'f.ts', now);
  assert.equal(c.ok, false); assert.match((c as any).reason, /send each of them a message/);
  // a message sent a minute before the claim is about it
  call('b', 'send', { to: 'a', message: 'I am about to change f.ts too' });
  d.prepare("update messages set created_at = ? where sender = 'b' and body like 'I am about%'").run(now - 60 * 1000);
  assert.match((canWrite(ctx('b'), 'f.ts', now) as any).reason, /waiting for a reply from a/);
  call('a', 'send', { to: 'b', message: 'fine' });
  assert.equal(canWrite(ctx('b'), 'f.ts').ok, true);
});

test('two modify claims naming disjoint symbols go ahead without talking; any shared symbol, or none named, means talking first', () => {
  const { d, ctx, call } = setup();
  db.addAgent(d, { name: 'c', tool: 'codex', pid: process.pid, cwd: '/wt/c' });
  db.addAgent(d, { name: 'e', tool: 'codex', pid: process.pid, cwd: '/wt/e' });
  call('a', 'claim', { file: 'f.ts', intent: 'validate nesting', kind: 'modify', symbols: 'Context.__init__, close' });
  d.prepare('update claims set created_at = created_at - 3000').run();
  const b = call('b', 'claim', { file: 'f.ts', intent: 'close contexts', kind: 'modify', symbols: 'the _resolve_context function' });
  assert.deepEqual(b.must_talk_to, []);
  assert.deepEqual(b.also_editing.map((o: any) => o.agent), ['a']);
  assert.equal(canWrite(ctx('b'), 'f.ts').ok, true);
  d.prepare('update claims set created_at = created_at - 2000 where agent != ?').run('c');
  const c = call('c', 'claim', { file: 'f.ts', intent: 'tidy close', kind: 'modify', symbols: 'close method' });
  assert.deepEqual(c.must_talk_to.map((o: any) => o.agent), ['a'], 'shares "close" with a, nothing with b');
  assert.equal(canWrite(ctx('c'), 'f.ts').ok, false);
  d.prepare('update claims set created_at = created_at - 1000 where agent != ?').run('e');
  const e = call('e', 'claim', { file: 'f.ts', intent: 'rework it', kind: 'modify' });
  assert.deepEqual(e.must_talk_to.map((o: any) => o.agent).sort(), ['a', 'b', 'c'], 'no symbols named: everyone earlier');
});

test('a dotted symbol overlaps with each of its parts: Parser.parse is not disjoint from Parser or parse', () => {
  const { d, ctx, call } = setup();
  db.addAgent(d, { name: 'c', tool: 'codex', pid: process.pid, cwd: '/wt/c' });
  call('a', 'claim', { file: 'f.ts', intent: 'rework the class', kind: 'modify', symbols: 'Parser' });
  d.prepare('update claims set created_at = created_at - 2000').run();
  assert.deepEqual(call('b', 'claim', { file: 'f.ts', intent: 'fix one method', kind: 'modify', symbols: 'Parser.parse' }).must_talk_to.map((o: any) => o.agent), ['a']);
  d.prepare('update claims set created_at = created_at - 1000 where agent != ?').run('c');
  assert.deepEqual(call('c', 'claim', { file: 'f.ts', intent: 'rename parse', kind: 'modify', symbols: 'parse' }).must_talk_to.map((o: any) => o.agent), ['b']); // Parser alone is another name
  assert.equal(canWrite(ctx('b'), 'f.ts').ok, false);
});

test('claimPath accepts the project-relative spelling of the own worktree', () => {
  const d = db.openDb(':memory:');
  const P = process.platform === 'win32' ? 'D:\\P' : '/P';
  const cwd = path.join(P, 'chord', 'agents', 'a');
  const ctx: Ctx = { db: d, agent: 'a', cwd, worktree: path.join(cwd, 'repo'), project: P };
  assert.equal(claimPath(ctx, 'chord/agents/a/repo/src/x.ts'), 'repo/src/x.ts');
  assert.equal(claimPath(ctx, 'src/x.ts'), 'repo/src/x.ts');
  assert.equal(claimPath(ctx, 'repo/src/x.ts'), 'repo/src/x.ts'); // the workspace-relative spelling keeps working
  assert.throws(() => claimPath(ctx, 'chord/agents/b/repo/src/x.ts'), /outside your workspace/);
});
