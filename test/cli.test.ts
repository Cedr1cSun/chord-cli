import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/db.ts';
import { ago, cleanArgs, events, fit, listArgs, ls, messages, refuseHookKillers, resumeArgv, stop, takeSettings, when, width } from '../src/cli.ts';

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
  assert.match(when(now - 3 * 86_400_000, now), /^[A-Z][a-z]{2} \d\d \d\d:\d\d$/); // another day: "Oct 17 23:39"
  assert.match(when(now, now + 400 * 86_400_000), /^[A-Z][a-z]{2} \d\d \d{4} \d\d:\d\d$/); // another year: with the year
  // names are padded to the longest one listed, not to a fixed 28
  db.addAgent(d, { name: 'longname', tool: 'codex', pid: process.pid, cwd: '/' });
  db.addClaim(d, { agent: 'longname', file: 'y.ts', intent: 'y', kind: 'add' });
  const padded = events(d, undefined, 50, now);
  assert.match(padded, /^\d\d:\d\d:\d\d a {8}claim\s/m);
  assert.match(padded, /^\d\d:\d\d:\d\d longname claim\s/m);
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
  // one send to several agents is one line, without the sentence meant for the agents
  db.send(d, 'a', ['b', 'c', 'd', 'e'], 'a merged into main:\n- x\n' + db.NOTICE_TAIL, 'notice');
  const grouped = messages(d, undefined, 50, now).split('\n').filter(Boolean);
  assert.equal(grouped.length, 3);
  assert.match(grouped[2], /^\d\d:\d\d:\d\d a -> 4 agents \[notice\] \(unread\): a merged into main: - x$/);
  assert.match(messages(d, undefined, 1, now), /4 agents/); // -n counts sends, not recipients
  db.takeUnread(d, 'b');
  assert.match(messages(d, undefined, 1, now), /a -> 4 agents \[notice\] \(3\/4 unread\): /);
  db.send(d, 'a', ['b', 'c'], 'two of you');
  assert.match(messages(d, undefined, 1, now), /a -> b, c \(unread\): two of you\n$/); // up to three recipients are named
});

test('stop flags an online agent and refuses offline or unknown ones', () => {
  const d = db.openDb(':memory:');
  db.addAgent(d, { name: 'a', tool: 'claude', pid: process.pid, cwd: '/' });
  db.addAgent(d, { name: 'b', tool: 'codex', pid: process.pid, cwd: '/' });
  assert.match(stop(d, 'a'), /^stop requested: a will quit/);
  assert.ok(db.getAgent(d, 'a')!.stop_requested_at! > 0);
  db.setStatus(d, 'b', 'offline');
  assert.throws(() => stop(d, 'b'), /b is already offline/);
  assert.throws(() => stop(d, 'zz'), /no such agent: zz/);
  // a wrapper that died with its pid reused: stop must not promise a quit that never comes
  db.addAgent(d, { name: 'ghost', tool: 'codex', pid: process.pid, cwd: '/', heartbeat: true });
  d.prepare("update agents set heartbeat_at = ?, started_at = ? where name = 'ghost'").run(Date.now() - db.HEARTBEAT_STALE_MS - 5000, Date.now() - 3_600_000);
  assert.throws(() => stop(d, 'ghost', 10), /ghost is already offline/);
});

test('resume relaunches an agent under its own tool, reopening its recorded conversation', () => {
  const d = db.openDb(':memory:');
  db.addAgent(d, { name: 'a', tool: 'claude', pid: process.pid, cwd: '/' }); db.setSession(d, 'a', 'sid-a');
  db.addAgent(d, { name: 'b', tool: 'codex', pid: process.pid, cwd: '/' }); db.setSession(d, 'b', 'sid-b');
  db.addAgent(d, { name: 'c', tool: 'codex', pid: process.pid, cwd: '/' });
  assert.deepEqual(resumeArgv(d, 'a', ['go on']), ['claude', '--name', 'a', '--resume', 'sid-a', 'go on']);
  assert.deepEqual(resumeArgv(d, 'b', []), ['codex', '--name', 'b', 'resume', 'sid-b']);
  assert.throws(() => resumeArgv(d, 'c', []), /no recorded conversation for c; start it again with chord codex --name c/);
  assert.throws(() => resumeArgv(d, 'zz', []), /no such agent: zz/);
});

test('ls lists agents and claims, sweeping dead ones', () => {
  const d = db.openDb(':memory:');
  assert.equal(ls(d), 'no agents\n');
  db.addAgent(d, { name: 'a', tool: 'claude', pid: process.pid, cwd: '/' });
  db.setTask(d, 'a', 'build api', 'src/api');
  db.addAgent(d, { name: 'dead', tool: 'codex', pid: 999_999_999, cwd: '/' });
  db.addClaim(d, { agent: 'a', file: 'src/api/x.ts', intent: 'add route', kind: 'add' });
  db.send(d, 'dead', ['a'], 'unread one');
  db.send(d, 'dead', ['a'], 'dead merged', 'notice'); // notices never wake anyone, so they are not "unread"
  const out = ls(d);
  assert.match(out, /^agent\s+status\s+unread\s+branch\s+task$/m);
  assert.match(out, /^a \(claude\)\s+busy\s+1\s+\?\s+build api \[src\/api\]$/m); // no repo given: branch unknown
  assert.match(out, /^dead \(codex\)\s+off \d+s\s+0\s+\?\s+-$/m);
  assert.equal(ago(12_000), '12s'); assert.equal(ago(180_000), '3m'); assert.equal(ago(7_200_000), '2h'); assert.equal(ago(3 * 86_400_000), '3d');
  assert.match(out, /^a \(claude\)[^\n]*\n {4}add {4}src\/api\/x.ts  add route$/m); // claims sit under their agent
  assert.doesNotMatch(out, /no claims/);
  db.addClaim(d, { agent: 'dead', file: 'src/api/x.ts', intent: 'rename route', kind: 'rename' });
  assert.match(ls(d), /^ {4}add {4}src\/api\/x.ts  add route \(also dead\)$/m); // a file two agents hold says so on both lines
  assert.match(ls(d), /^ {4}rename src\/api\/x.ts  rename route \(also a\)$/m);
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

test('takeSettings lifts the user --settings out of the tool arguments; hook-killing flags are refused', () => {
  let rest = ['--settings', '{"model":"opus"}', '-p'];
  assert.deepEqual(takeSettings(rest), { model: 'opus' }); assert.deepEqual(rest, ['-p']);
  rest = ['--settings={"a":1}']; assert.deepEqual(takeSettings(rest), { a: 1 }); assert.deepEqual(rest, []);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-set-')), 's.json'); fs.writeFileSync(file, '{"b":2}');
  rest = ['--settings', file]; assert.deepEqual(takeSettings(rest), { b: 2 });
  assert.equal(takeSettings(['-p']), undefined);
  assert.throws(() => takeSettings(['--settings']), /needs a value/);
  assert.throws(() => takeSettings(['--settings', '{oops']), /JSON object or a path/);
  assert.throws(() => takeSettings(['--settings', '[1]']), /JSON object/);
  assert.throws(() => refuseHookKillers('claude', ['--bare']), /switches off the hooks/);
  assert.throws(() => refuseHookKillers('codex', ['-c', 'hooks.PreToolUse=[]']), /replace chord's own hooks/);
  assert.throws(() => refuseHookKillers('codex', ['--config=mcp_servers.chord.command="x"']), /replace chord's own hooks/);
  refuseHookKillers('claude', ['--model', 'opus']); refuseHookKillers('codex', ['-c', 'model="gpt-5"']); // fine
  if (process.platform === 'win32') {
    assert.throws(() => refuseHookKillers('codex', ['-s', 'workspace-write']), /sandbox cannot run chord's hooks on Windows/);
    assert.throws(() => refuseHookKillers('codex', ['--sandbox=read-only']), /sandbox/);
    assert.throws(() => refuseHookKillers('codex', ['-c', 'sandbox_mode="workspace-write"']), /sandbox/);
    refuseHookKillers('codex', ['-s', 'danger-full-access']); // fine
  }
});

test('cleanArgs takes --force or -f and agent names, refusing other options', () => {
  assert.deepEqual(cleanArgs(['-f', 'a']), { names: ['a'], force: true });
  assert.deepEqual(cleanArgs(['a', '--force', 'b']), { names: ['a', 'b'], force: true });
  assert.deepEqual(cleanArgs([]), { names: [], force: false });
  assert.throws(() => cleanArgs(['--all']), /unknown option --all/);
});

test('ls cuts the task to the terminal width, counting CJK as two cells', () => {
  const d = db.openDb(':memory:');
  db.addAgent(d, { name: 'claude-x', tool: 'claude', pid: process.pid, cwd: '/' });
  db.setTask(d, 'claude-x', '为 echo docstring 添加用例，并新增两个 pytest 测试后运行测试、提交并合并到 main', 'click/src/click/utils.py');
  const lines = ls(d, undefined, Date.now(), 80).split('\n').filter(Boolean);
  for (const l of lines) assert.ok(width(l) <= 80, `${width(l)} cells: ${l}`);
  assert.match(lines[1], /\.\.\.$/);
  assert.ok(ls(d).split('\n')[1].includes('合并到 main [click/src/click/utils.py]')); // no width: nothing cut
  assert.equal(fit('中文中文', 5), '中...');
  assert.equal(fit('abc', Infinity), 'abc');
  assert.equal(width('a中b'), 4);
});

test('help and version go to stdout; unknown commands and bad arguments to stderr with exit 2', () => {
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
  const run = (...a: string[]) => {
    try { return { code: 0, out: execFileSync(process.execPath, [cli, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), err: '' }; }
    catch (e: any) { return { code: e.status as number, out: e.stdout as string, err: e.stderr as string }; }
  };
  for (const a of [[], ['help'], ['-h'], ['--help']]) {
    const r = run(...a);
    assert.equal(r.code, 0, a.join(' '));
    assert.match(r.out, /chord ls \[--all\]/); assert.match(r.out, /chord resume <agent>/); assert.match(r.out, /chord clean/);
    for (const l of r.out.split('\n')) assert.ok(l.length < 80, l);
  }
  const v = run('--version');
  assert.equal(v.code, 0);
  assert.equal(v.out.trim(), JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')).version);
  const bad = run('bogus');
  assert.equal(bad.code, 2); assert.match(bad.err, /^chord: unknown command "bogus"\n/);
  const stop = run('stop');
  assert.equal(stop.code, 2); assert.equal(stop.err, 'usage: chord stop <agent>\n');
  const resume = run('resume', '--x');
  assert.equal(resume.code, 2); assert.equal(resume.err, 'usage: chord resume <agent> [tool args...]\n');
  const ls = run('ls', '-a');
  assert.equal(ls.code, 1); assert.match(ls.err, /unknown argument -a; usage: chord ls \[--all\]/);
});
