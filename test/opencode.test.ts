import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/db.ts';
import { ChordPlugin } from '../src/opencode/plugins/chord.ts';

/** A chord agent's environment, as the wrapper gives it to OpenCode, around a temporary project folder. */
function setup(parents: Record<string, string> = {}) {
  const P = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-oc-')));
  const cwd = path.join(P, 'chord', 'agents', 'a'), wt = path.join(cwd, 'repo');
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true }); fs.mkdirSync(path.join(P, 'repo', 'src'), { recursive: true });
  const file = path.join(P, 'state', 'chord.db'); fs.mkdirSync(path.dirname(file));
  const d = db.openDb(file);
  db.addAgent(d, { name: 'a', tool: 'opencode', pid: process.pid, cwd });
  db.addAgent(d, { name: 'b', tool: 'claude', pid: process.pid, cwd: path.join(P, 'chord', 'agents', 'b') });
  const env = { CHORD_AGENT_ID: 'a', CHORD_DB: file, CHORD_TOOL: 'opencode', CHORD_PROJECT: P, CHORD_WORKSPACE: cwd, CHORD_WORKTREE: wt, CHORD_HOOKS: path.join(import.meta.dirname, '..', 'src', 'hooks.ts') };
  const client = { session: { get: async ({ path: { id } }: { path: { id: string } }) => ({ data: parents[id] ? { parentID: parents[id] } : {} }) } };
  return { P, cwd, wt, d, env, client };
}

/** Run `fn` with the agent's variables in the environment, as OpenCode would have them. */
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('the plugin briefs the first prompt, reminds on every prompt, records the session and delivers messages', async () => {
  const { d, env, client } = setup();
  await withEnv(env, async () => {
    const hooks = await ChordPlugin({ client }) as any;
    const parts: any[] = [{ id: 'prt_1836afaa9001iG2TUQ6xfnuMIF', type: 'text', text: 'fix the flaky test' }];
    await hooks['chat.message']({ sessionID: 'ses_1', messageID: 'msg_1' }, { message: { id: 'msg_1' }, parts });
    assert.equal(parts.length, 3); // the user's text, the briefing, the reminder
    assert.match(parts[1].text, /You are agent "a" \(opencode\)/);
    assert.match(parts[2].text, /^\[chord\] You are agent "a" in a chord project/);
    assert.ok(parts[1].synthetic && parts[1].messageID === 'msg_1');
    // OpenCode orders parts by id: the briefing after the user's text, the reminder after the briefing
    assert.match(parts[1].id, /^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert.ok(parts[0].id < parts[1].id && parts[1].id < parts[2].id, [parts[0].id, parts[1].id, parts[2].id].join(' '));
    assert.equal(db.getAgent(d, 'a')!.session_id, 'ses_1'); // chord resume reopens this
    assert.equal(db.getAgent(d, 'a')!.status, 'busy');
    db.send(d, 'b', ['a'], 'I am on the footer, leave it to me');
    const again: any[] = [{ type: 'text', text: 'carry on' }];
    await hooks['chat.message']({ sessionID: 'ses_1' }, { message: { id: 'msg_2' }, parts: again });
    assert.equal(again.length, 2); // briefed already: the reminder alone, with the message in it
    assert.match(again[1].text, /message from b[\s\S]*leave it to me/);
    assert.equal(db.hasUnread(d, 'a'), false);
  });
});

test('the plugin refuses an unclaimed write with chord\'s reason and lets a claimed one through', async () => {
  const { d, env, client, wt, P } = setup();
  await withEnv(env, async () => {
    const hooks = await ChordPlugin({ client }) as any;
    const write = (filePath: string) => hooks['tool.execute.before']({ tool: 'write', sessionID: 'ses_1', callID: 'c1' }, { args: { filePath, content: '' } });
    await assert.rejects(write(path.join(wt, 'src', 'x.ts')), /not claimed by you/);
    await assert.rejects(write(path.join(P, 'repo', 'src', 'x.ts')), /outside your workspace.*edit your own copy/); // the main checkout
    db.addClaim(d, { agent: 'a', file: 'repo/src/x.ts', intent: 'x', kind: 'add' });
    await write(path.join(wt, 'src', 'x.ts'));
    await hooks['tool.execute.before']({ tool: 'read', sessionID: 'ses_1', callID: 'c2' }, { args: { filePath: path.join(P, 'repo', 'README.md') } }); // reading anything is fine
  });
});

test('the plugin appends messages that arrived mid-turn to the tool output, and marks the agent idle when the session is', async () => {
  const { d, env, client } = setup({ ses_child: 'ses_1' });
  await withEnv(env, async () => {
    const hooks = await ChordPlugin({ client }) as any;
    db.send(d, 'b', ['a'], 'heads up');
    const sub = { output: 'file contents' };
    await hooks['tool.execute.after']({ tool: 'read', sessionID: 'ses_child', callID: 'c0', args: {} }, sub); // a subagent's call: the messages wait
    assert.equal(sub.output, 'file contents');
    const out = { output: 'file contents' };
    await hooks['tool.execute.after']({ tool: 'read', sessionID: 'ses_1', callID: 'c1', args: {} }, out);
    assert.match(out.output, /^file contents\n\n\[chord\] message from b[\s\S]*heads up/);
    assert.equal(db.getAgent(d, 'a')!.status, 'busy');
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_child' } } });
    assert.equal(db.getAgent(d, 'a')!.status, 'busy'); // a subagent finishing is not the agent going idle
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
    assert.equal(db.getAgent(d, 'a')!.status, 'idle');
    db.send(d, 'b', ['a'], 'are you there?');
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
    assert.equal(db.hasUnread(d, 'a'), true); // idle takes nothing: the wrapper's nudge brings the message in through the prompt
  });
});

test('without chord\'s environment the plugin installs no hooks', async () => {
  const { client } = setup();
  assert.deepEqual(await ChordPlugin({ client }), {});
});
