import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/db.ts';
import chord from '../src/pi/extensions/chord.ts';

/** A chord agent's environment, as the wrapper gives it to pi, around a temporary project folder. */
function setup() {
  const P = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-pi-')));
  const cwd = path.join(P, 'chord', 'agents', 'a'), wt = path.join(cwd, 'repo');
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true }); fs.mkdirSync(path.join(P, 'repo', 'src'), { recursive: true });
  const file = path.join(P, 'state', 'chord.db'); fs.mkdirSync(path.dirname(file));
  const d = db.openDb(file);
  db.addAgent(d, { name: 'a', tool: 'pi', pid: process.pid, cwd });
  db.addAgent(d, { name: 'b', tool: 'claude', pid: process.pid, cwd: path.join(P, 'chord', 'agents', 'b') });
  const src = path.join(import.meta.dirname, '..', 'src');
  const env = { CHORD_AGENT_ID: 'a', CHORD_DB: file, CHORD_TOOL: 'pi', CHORD_PROJECT: P, CHORD_WORKSPACE: cwd, CHORD_WORKTREE: wt, CHORD_HOOKS: path.join(src, 'hooks.ts'), CHORD_SERVE: path.join(src, 'serve.ts') };
  return { P, cwd, wt, d, env };
}

/** Run `fn` with the agent's variables in the environment, as pi would have them. */
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

/** Enough of pi's ExtensionAPI to load the extension and fire its handlers. */
function fakePi() {
  const handlers: Record<string, Function> = {};
  const servers: Record<string, any> = {};
  const pi = { on: (event: string, h: Function) => { handlers[event] = h; }, registerMcpServer: (name: string, cfg: any) => { servers[name] = cfg; } };
  const ctx = (sessionId = 'ses_1') => ({ sessionManager: { getSessionId: () => sessionId } });
  return { pi, handlers, servers, ctx };
}

test('the extension registers chord\'s MCP server with the agent\'s environment, directly exposed, patient enough for finish', async () => {
  const { env } = setup();
  await withEnv(env, async () => {
    const { pi, servers } = fakePi();
    await chord(pi as any);
    const s = servers.chord;
    assert.equal(s.command, process.execPath);
    assert.deepEqual(s.args, [env.CHORD_SERVE]);
    assert.equal(s.env.CHORD_AGENT_ID, 'a');
    assert.equal(s.env.CHORD_WORKTREE, env.CHORD_WORKTREE);
    assert.equal(s.exposure, 'direct'); // pi's default, codemode, hides the tools from the model
    assert.ok(s.timeout >= 240 + 600); // seconds; finish may wait 240 s for the merge lock, then run the test command for up to 600 s
  });
});

test('the extension briefs the first run of a session, reminds on every run, records the session and delivers messages', async () => {
  const { d, env } = setup();
  await withEnv(env, async () => {
    const { pi, handlers, ctx } = fakePi();
    await chord(pi as any);
    await handlers.session_start({ type: 'session_start', reason: 'startup' }, ctx());
    assert.equal(db.getAgent(d, 'a')!.session_id, 'ses_1'); // chord resume reopens this
    assert.equal(db.getAgent(d, 'a')!.status, 'idle'); // waiting for the first prompt: messages wake it
    const first = await handlers.before_agent_start({ type: 'before_agent_start', messageType: 'user', prompt: 'fix the flaky test' }, ctx());
    assert.match(first.message.content, /You are agent "a" \(pi\)[\s\S]*\n\[chord\] You are agent "a" in a chord project/); // the briefing, then the reminder
    assert.equal(first.message.display, true);
    assert.equal(db.getAgent(d, 'a')!.status, 'busy');
    db.send(d, 'b', ['a'], 'I am on the footer, leave it to me');
    const again = await handlers.before_agent_start({ type: 'before_agent_start', messageType: 'user', prompt: 'carry on' }, ctx());
    assert.doesNotMatch(again.message.content, /You are agent "a" \(pi\)/); // briefed already
    assert.match(again.message.content, /message from b[\s\S]*leave it to me/);
    assert.equal(db.hasUnread(d, 'a'), false);
    // /new or /resume: a new session, briefed again, recorded again
    await handlers.session_start({ type: 'session_start', reason: 'new' }, ctx('ses_2'));
    assert.equal(db.getAgent(d, 'a')!.session_id, 'ses_2');
    const fresh = await handlers.before_agent_start({ type: 'before_agent_start', messageType: 'user', prompt: 'hello' }, ctx('ses_2'));
    assert.match(fresh.message.content, /You are agent "a" \(pi\)/);
  });
});

test('the extension blocks an unclaimed write with chord\'s reason and lets a claimed one through', async () => {
  const { d, env, wt, P } = setup();
  await withEnv(env, async () => {
    const { pi, handlers, ctx } = fakePi();
    await chord(pi as any);
    const write = (p: string) => handlers.tool_call({ type: 'tool_call', toolName: 'write', toolCallId: 'c1', input: { path: p, content: '' } }, ctx());
    let r = await write(path.join(wt, 'src', 'x.ts'));
    assert.equal(r.block, true); assert.match(r.reason, /not claimed by you/);
    r = await write(path.join(P, 'repo', 'src', 'x.ts')); // the main checkout
    assert.equal(r.block, true); assert.match(r.reason, /outside your workspace.*edit your own copy/);
    r = await write('repo/src/x.ts'); // pi resolves a relative path against its cwd, the project folder
    assert.match(r.reason, /outside your workspace/);
    db.addClaim(d, { agent: 'a', file: 'repo/src/x.ts', intent: 'x', kind: 'add' });
    assert.equal(await write(path.join(wt, 'src', 'x.ts')), undefined);
    assert.equal(await write('chord/agents/a/repo/src/x.ts'), undefined);
    assert.equal(await handlers.tool_call({ type: 'tool_call', toolName: 'read', toolCallId: 'c2', input: { path: path.join(P, 'repo', 'README.md') } }, ctx()), undefined); // reading anything is fine
  });
});

test('the extension appends messages that arrived mid-turn to the tool result, holds the agent for them at the end of a run, and marks it idle once settled', async () => {
  const { d, env } = setup();
  await withEnv(env, async () => {
    const { pi, handlers, ctx } = fakePi();
    await chord(pi as any);
    db.send(d, 'b', ['a'], 'heads up');
    const content = [{ type: 'text', text: 'file contents' }];
    const out = await handlers.tool_result({ type: 'tool_result', toolName: 'read', toolCallId: 'c1', input: {}, content, isError: false }, ctx());
    assert.equal(out.content[0], content[0]);
    assert.match(out.content[1].text, /\[chord\] message from b[\s\S]*heads up/);
    assert.equal(db.getAgent(d, 'a')!.status, 'busy');
    const quiet = await handlers.tool_result({ type: 'tool_result', toolName: 'read', toolCallId: 'c2', input: {}, content, isError: false }, ctx());
    assert.equal(quiet, undefined); // nothing to add: the result stays as it is
    // the run ends with nothing pending: idle
    assert.equal(await handlers.agent_before_settle({ type: 'agent_before_settle', entries: [], continue: false }, ctx()), undefined);
    assert.equal(db.getAgent(d, 'a')!.status, 'idle');
    // a message arrived during the last turn: one more run, with the message in it
    db.setStatus(d, 'a', 'busy');
    db.send(d, 'b', ['a'], 'are you there?');
    const held = await handlers.agent_before_settle({ type: 'agent_before_settle', entries: [{ type: 'custom', customType: 'x' }], continue: false }, ctx());
    assert.equal(held.continue, true);
    assert.equal(held.entries.length, 2); // what earlier handlers proposed stays
    assert.equal(held.entries[1].type, 'custom_message');
    assert.match(held.entries[1].content, /are you there\?[\s\S]*Handle these messages before stopping/);
    assert.equal(db.getAgent(d, 'a')!.status, 'busy');
    // settled (also after an Esc, which skips agent_before_settle): idle, messages left for the wrapper's nudge
    db.send(d, 'b', ['a'], 'still there?');
    await handlers.agent_settled({ type: 'agent_settled', aborted: true }, ctx());
    assert.equal(db.getAgent(d, 'a')!.status, 'idle');
    assert.equal(db.hasUnread(d, 'a'), true);
  });
});

test('a nested tool call from a codemode script leaves messages for the outer call, whose result reaches the model', async () => {
  const { d, env } = setup();
  await withEnv(env, async () => {
    const { pi, handlers, ctx } = fakePi();
    await chord(pi as any);
    db.send(d, 'b', ['a'], 'leave footer.ts to me');
    const content = [{ type: 'text', text: 'a\nb' }];
    const nested = await handlers.tool_result({ type: 'tool_result', toolName: 'bash', toolCallId: 'p1/1', parentToolCallId: 'p1', input: {}, content, structuredContent: { stdout: 'a\nb', exitCode: 0 }, isError: false }, ctx());
    assert.equal(nested, undefined); // only the script sees a nested result
    assert.equal(db.hasUnread(d, 'a'), true);
    const outer = await handlers.tool_result({ type: 'tool_result', toolName: 'codemode', toolCallId: 'p1', input: {}, content, isError: false }, ctx());
    assert.match(outer.content[1].text, /message from b[\s\S]*leave footer\.ts to me/);
    assert.equal(db.hasUnread(d, 'a'), false);
  });
});

test('without chord\'s environment the extension does nothing', async () => {
  const { pi, handlers, servers } = fakePi();
  await chord(pi as any);
  assert.deepEqual(Object.keys(handlers), []);
  assert.deepEqual(servers, {});
});

test('the extension blocks an edit when chord\'s hook process cannot run, and lets other tools through', async () => {
  const { env, wt } = setup();
  const f = fakePi();
  await withEnv({ ...env, CHORD_HOOKS: path.join(env.CHORD_WORKSPACE, 'no-such-hooks.ts') }, async () => {
    chord(f.pi as any);
    const call = (toolName: string) => f.handlers.tool_call({ type: 'tool_call', toolName, toolCallId: 'c1', input: { path: path.join(wt, 'src', 'x.ts') } }, f.ctx());
    for (const toolName of ['edit', 'write']) {
      const r = await call(toolName);
      assert.equal(r?.block, true, toolName);
      assert.match(r.reason, /chord's hook could not run.*edit was not checked.*exit code 1/s);
    }
    assert.equal(await call('read'), undefined);
    assert.equal(await call('bash'), undefined);
  });
});
