import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/db.ts';
import plugin from '../src/opencode/plugin/index.ts';

/** A chord agent's environment, as the wrapper gives it to OpenCode, around a temporary project folder. */
function setup() {
  const P = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-oc-')));
  const cwd = path.join(P, 'chord', 'agents', 'a'), wt = path.join(cwd, 'repo');
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true }); fs.mkdirSync(path.join(P, 'repo', 'src'), { recursive: true });
  const file = path.join(P, 'state', 'chord.db'); fs.mkdirSync(path.dirname(file));
  const d = db.openDb(file);
  db.addAgent(d, { name: 'a', tool: 'opencode', pid: process.pid, cwd });
  db.addAgent(d, { name: 'b', tool: 'claude', pid: process.pid, cwd: path.join(P, 'chord', 'agents', 'b') });
  const env = { CHORD_AGENT_ID: 'a', CHORD_DB: file, CHORD_TOOL: 'opencode', CHORD_PROJECT: P, CHORD_WORKSPACE: cwd, CHORD_WORKTREE: wt, CHORD_HOOKS: path.join(import.meta.dirname, '..', 'src', 'hooks.ts') };
  return { P, cwd, wt, d, env };
}

/** The part of OpenCode 2's plugin context chord uses: hook registration, synthetic input, sessions (child sessions
 *  have a parentID) and the event stream, which `emit` feeds. */
function fakeCtx(parents: Record<string, string> = {}) {
  const hooks: Record<string, (e: any) => Promise<void>> = {};
  const told: { sessionID: string; text: string; description: string; resume: boolean }[] = [];
  const subscribed: string[][] = [];
  const pending: any[] = [];
  let wake = () => {};
  async function* events() { for (;;) { while (pending.length) yield pending.shift(); await new Promise<void>(r => { wake = r; }); } }
  const ctx = {
    session: {
      hook: (name: string, fn: any) => { hooks[`session.${name}`] = fn; },
      synthetic: async (input: any) => { told.push(input); },
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, ...(parents[sessionID] ? { parentID: parents[sessionID] } : {}) }),
    },
    tool: { hook: (name: string, fn: any) => { hooks[`tool.${name}`] = fn; } },
    event: { subscribe: ({ types }: { types: string[] }) => { subscribed.push(types); return events(); } },
  };
  const emit = (ev: any) => { pending.push(ev); wake(); };
  return { ctx, hooks, told, subscribed, emit };
}

/** Run `fn` with the agent's variables in the environment, as OpenCode's server would have them. */
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

const until = async (fn: () => boolean, ms = 10000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise(r => setTimeout(r, 50)); } return true; };

test('the plugin is a plain { id, setup } object', () => {
  assert.equal(plugin.id, 'chord');
  assert.equal(typeof plugin.setup, 'function');
});

test('the plugin reports the agent idle as it starts, so it can be woken or stopped before its first prompt', async () => {
  const { d, env } = setup();
  const f = fakeCtx();
  await withEnv(env, async () => {
    assert.equal(db.getAgent(d, 'a')!.status, 'busy');
    await plugin.setup(f.ctx);
    assert.equal(db.getAgent(d, 'a')!.status, 'idle');
  });
});

test('the plugin briefs the first prompt and reminds on every one, as synthetic input; it records the session and delivers messages', async () => {
  const { d, env } = setup();
  const f = fakeCtx();
  await withEnv(env, async () => {
    await plugin.setup(f.ctx);
    await f.hooks['session.prompt']({ sessionID: 'ses_1', prompt: { text: 'fix the flaky test' } });
    assert.equal(f.told.length, 1); // one synthetic message just before the prompt
    assert.match(f.told[0].text, /^You are agent "a" \(opencode\)[\s\S]*\n\n\[chord\] You are agent "a" in a chord project/); // the briefing, then the reminder
    assert.deepEqual({ ...f.told[0], text: '' }, { sessionID: 'ses_1', text: '', description: 'chord', resume: false });
    assert.equal(db.getAgent(d, 'a')!.session_id, 'ses_1'); // chord resume reopens this
    assert.equal(db.getAgent(d, 'a')!.status, 'busy');
    db.send(d, 'b', ['a'], 'I am on the footer, leave it to me');
    await f.hooks['session.prompt']({ sessionID: 'ses_1', prompt: { text: 'carry on' } });
    assert.equal(f.told.length, 2);
    assert.doesNotMatch(f.told[1].text, /You are agent "a" \(opencode\)/); // briefed already: the reminder alone, with the message in it
    assert.match(f.told[1].text, /message from b[\s\S]*leave it to me/);
    assert.equal(db.hasUnread(d, 'a'), false);
  });
});

test('a child session (a subagent) gets no briefing and takes no messages, but its writes are still checked', async () => {
  const { d, env, wt } = setup();
  const f = fakeCtx({ ses_child: 'ses_1' });
  await withEnv(env, async () => {
    await plugin.setup(f.ctx);
    db.send(d, 'b', ['a'], 'heads up');
    await f.hooks['session.prompt']({ sessionID: 'ses_child', prompt: { text: 'look into the parser' } });
    assert.equal(f.told.length, 0);
    const result = { content: [{ type: 'text', text: 'file contents' }] };
    await f.hooks['tool.execute.after']({ sessionID: 'ses_child', tool: 'read', input: { path: 'x' }, status: 'completed', result });
    assert.equal(result.content.length, 1);
    assert.equal(db.hasUnread(d, 'a'), true);
    await assert.rejects(f.hooks['tool.execute.before']({ sessionID: 'ses_child', tool: 'write', input: { path: path.join(wt, 'src', 'x.ts'), content: '' } }), /not claimed by you/);
  });
});

test('the plugin refuses an unclaimed write with chord\'s reason and lets a claimed one through', async () => {
  const { d, env, wt, P } = setup();
  const f = fakeCtx();
  await withEnv(env, async () => {
    await plugin.setup(f.ctx);
    const write = (p: string, codemode = false) => f.hooks['tool.execute.before']({ sessionID: 'ses_1', tool: 'write', input: { path: p, content: '' }, codemode });
    await assert.rejects(write(path.join(wt, 'src', 'x.ts')), /not claimed by you/);
    await assert.rejects(write(path.join(wt, 'src', 'x.ts'), true), /not claimed by you/); // a call nested in Code Mode's execute too
    await assert.rejects(write(path.join(P, 'repo', 'src', 'x.ts')), /outside your workspace.*edit your own copy/); // the main checkout
    await assert.rejects(f.hooks['tool.execute.before']({ sessionID: 'ses_1', tool: 'patch', input: { patchText: '*** Begin Patch\n*** Add File: chord/agents/a/repo/src/y.ts\n+y\n*** End Patch' } }), /not claimed by you/);
    db.addClaim(d, { agent: 'a', file: 'repo/src/x.ts', intent: 'x', kind: 'add' });
    await write(path.join(wt, 'src', 'x.ts'));
    await f.hooks['tool.execute.before']({ sessionID: 'ses_1', tool: 'read', input: { path: path.join(P, 'repo', 'README.md') } }); // reading anything is fine
  });
});

test('messages that arrive mid-turn ride on the next tool result, but not on one nested in Code Mode', async () => {
  const { d, env } = setup();
  const f = fakeCtx();
  await withEnv(env, async () => {
    await plugin.setup(f.ctx);
    db.send(d, 'b', ['a'], 'heads up');
    const nested = { content: [{ type: 'text', text: 'file contents' }] };
    await f.hooks['tool.execute.after']({ sessionID: 'ses_1', tool: 'read', input: {}, status: 'completed', result: nested, codemode: true });
    assert.equal(nested.content.length, 1); // that result goes to the script, not the model
    assert.equal(db.hasUnread(d, 'a'), true);
    const result = { content: [{ type: 'text', text: 'file contents' }] };
    await f.hooks['tool.execute.after']({ sessionID: 'ses_1', tool: 'read', input: {}, status: 'completed', result });
    assert.equal(result.content[0].text, 'file contents');
    assert.match(result.content[1].text, /^\[chord\] message from b[\s\S]*heads up/);
    assert.equal(db.getAgent(d, 'a')!.status, 'busy');
  });
});

test('the end of a turn runs the stop hook: idle when nothing is waiting, the turn continues with the messages when something is', async () => {
  const { d, env } = setup();
  const f = fakeCtx({ ses_child: 'ses_1' });
  await withEnv(env, async () => {
    await plugin.setup(f.ctx);
    db.setStatus(d, 'a', 'busy');
    await f.hooks['session.experimental.idle']({ sessionID: 'ses_1', background: [{ id: 'job' }] });
    assert.equal(db.getAgent(d, 'a')!.status, 'busy'); // a subagent still works for it: not idle yet
    await f.hooks['session.experimental.idle']({ sessionID: 'ses_child', background: [] });
    assert.equal(db.getAgent(d, 'a')!.status, 'busy'); // a subagent finishing is not the agent going idle
    await f.hooks['session.experimental.idle']({ sessionID: 'ses_1', background: [] });
    assert.equal(db.getAgent(d, 'a')!.status, 'idle');
    db.setStatus(d, 'a', 'busy');
    db.send(d, 'b', ['a'], 'are you there?');
    await f.hooks['session.experimental.idle']({ sessionID: 'ses_1', background: [] });
    assert.equal(f.told.length, 1);
    assert.match(f.told[0].text, /message from b[\s\S]*are you there\?[\s\S]*Handle these messages before stopping/);
    assert.equal(f.told[0].resume, true); // admitted with resume: the turn goes on
    assert.equal(db.hasUnread(d, 'a'), false);
    assert.equal(db.getAgent(d, 'a')!.status, 'busy');
  });
});

test('an interrupted turn (Esc) makes the agent idle', async () => {
  const { d, env } = setup();
  const f = fakeCtx();
  await withEnv(env, async () => {
    await plugin.setup(f.ctx);
    assert.deepEqual(f.subscribed, [['session.execution.interrupted']]);
    db.setStatus(d, 'a', 'busy');
    f.emit({ type: 'session.execution.interrupted', data: { sessionID: 'ses_1' } });
    assert.ok(await until(() => db.getAgent(d, 'a')!.status === 'idle'));
  });
});

test('without chord\'s environment the plugin registers nothing', async () => {
  const f = fakeCtx();
  const saved = process.env.CHORD_AGENT_ID;
  delete process.env.CHORD_AGENT_ID;
  try { await plugin.setup(f.ctx); } finally { if (saved !== undefined) process.env.CHORD_AGENT_ID = saved; }
  assert.deepEqual(f.hooks, {});
  assert.deepEqual(f.subscribed, []);
});

test('the plugin refuses an edit when chord\'s hook process cannot run, and still lets other tools through', async () => {
  const { env, wt } = setup();
  const f = fakeCtx();
  await withEnv({ ...env, CHORD_HOOKS: path.join(env.CHORD_WORKSPACE, 'no-such-hooks.ts') }, async () => {
    await plugin.setup(f.ctx);
    for (const tool of ['edit', 'write', 'patch']) {
      await assert.rejects(f.hooks['tool.execute.before']({ sessionID: 'ses_1', tool, input: { path: path.join(wt, 'src', 'x.ts') } }), /chord's hook could not run.*edit was not checked.*exit code 1/s, tool);
    }
    await f.hooks['tool.execute.before']({ sessionID: 'ses_1', tool: 'read', input: { path: path.join(wt, 'src', 'x.ts') } });
    await f.hooks['tool.execute.before']({ sessionID: 'ses_1', tool: 'bash', input: { command: 'ls' } });
  });
});
