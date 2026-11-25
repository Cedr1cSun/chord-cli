import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/db.ts';
import { agyBriefingDue, agyHandle, fromAgy, toAgy, type Event } from '../src/hooks.ts';
import { ensureWorktree } from '../src/launch.ts';
import type { Ctx } from '../src/tools.ts';
import { initRepo, tmp } from './helpers/git.ts';

// Conversation ids and payload shapes as agy 1.5.16 sent them in a live run, trimmed
const MAIN = '67b9bc4f-084a-4318-b963-240bc2005b8d', SUB = 'c6c7310e-e4c7-4429-82ec-5f1b9a31c5d5', OTHER = '1082d9f3-dfd0-423b-a193-4142134fea27';
const HOOKS = path.join(import.meta.dirname, '..', 'src', 'hooks.ts');

function setup() {
  const P = tmp('chord-agy-');
  initRepo(path.join(P, 'repo'));
  const W = path.join(P, 'chord', 'agents', 'a');
  const wt = ensureWorktree(path.join(P, 'repo'), path.join(W, 'repo'), 'a');
  fs.mkdirSync(path.join(W, '.agents'), { recursive: true });
  fs.writeFileSync(agyBriefingDue(W), ''); // as the launch leaves it
  const d = db.openDb(':memory:');
  db.addAgent(d, { name: 'a', tool: 'agy', pid: process.pid, cwd: W });
  db.addAgent(d, { name: 'b', tool: 'claude', pid: process.pid, cwd: path.join(P, 'chord', 'agents', 'b') });
  const ctx: Ctx = { db: d, agent: 'a', cwd: W, worktree: wt, project: P };
  const common = (conversationId: string, hookEventName: string, lastUserInput: string) => ({
    artifactDirectoryPath: `C:\\Users\\u\\.gemini\\antigravity-cli\\brain\\${conversationId}`, conversationId, cwd: P, hookEventName, lastUserInput, modelName: 'gemini-3.8-flash-low', workspacePaths: [P, W],
  });
  const ask = 'append a line hello to notes.txt, then commit';
  const ev = {
    sessionStart: (lastUserInput = ask, conv = MAIN) => common(conv, 'SessionStart', lastUserInput),
    preInvocation: (invocationNum: number, conv = MAIN, lastUserInput = ask) => ({ ...common(conv, 'PreInvocation', lastUserInput), initialNumSteps: 1, invocationNum }),
    tool: (hookEventName: 'PreToolUse' | 'PostToolUse', name: string, args: object, conv = MAIN) => ({
      ...common(conv, hookEventName, conv === MAIN ? ask : ''), stepIdx: 13, toolCall: { args, id: 'call_1845947134738402647', name }, ...(hookEventName === 'PostToolUse' ? { error: '' } : {}),
    }),
    stop: (conv = MAIN, executionNum = 0) => ({ ...common(conv, 'Stop', conv === MAIN ? ask : ''), continuationActive: executionNum > 0, error: '', executionNum, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' }),
  };
  // launch.ts runs SessionStart as session-start, PreInvocation as user-prompt-submit, and the rest by their own names
  const hook = (event: Event, payload: object) => toAgy(agyHandle(ctx, event, fromAgy(payload))) as any;
  return { P, W, wt, d, ev, hook };
}

/** The text an answer injects into the conversation. */
const said = (out: any): string => out?.injectSteps?.map((s: any) => s.systemMessage.systemMessage).join('\n') ?? '';

test('agy: a new conversation is briefed once, at its first prompt, and every prompt restates who the agent is', () => {
  const { d, W, ev, hook } = setup();
  db.setTask(d, 'b', 'write the docs', null);
  const brief = hook('session-start', ev.sessionStart());
  assert.deepEqual(Object.keys(brief), ['injectSteps']);
  assert.match(said(brief), /You are agent "a" \(agy\)[\s\S]*Rules:[\s\S]*- b \(claude, busy\): write the docs/);
  assert.equal(db.getAgent(d, 'a')!.session_id, MAIN);
  assert.equal(fs.existsSync(agyBriefingDue(W)), false);
  const first = said(hook('user-prompt-submit', ev.preInvocation(0)));
  assert.match(first, /^\[chord\] You are agent "a" in a chord project/);
  assert.doesNotMatch(first, /Rules:/); // briefed already, at SessionStart
  assert.equal(db.getAgent(d, 'a')!.status, 'busy');
  // a new conversation in the same session (SessionStart with the user's prompt) is briefed and becomes the agent's
  assert.match(said(hook('session-start', ev.sessionStart('start over', OTHER))), /Rules:/);
  assert.equal(db.getAgent(d, 'a')!.session_id, OTHER);
});

test('agy: a resumed conversation, which fires no SessionStart, is briefed at its first PreInvocation, once per launch', () => {
  const { d, W, ev, hook } = setup();
  db.setSession(d, 'a', MAIN); // recorded by the launch before
  assert.match(said(hook('user-prompt-submit', ev.preInvocation(0))), /You are agent "a" \(agy\)[\s\S]*Rules:[\s\S]*\[chord\] You are agent "a" in a chord project/);
  assert.doesNotMatch(said(hook('user-prompt-submit', ev.preInvocation(0, MAIN, 'and now the tests'))), /Rules:/);
  fs.writeFileSync(agyBriefingDue(W), ''); // launched again
  assert.match(said(hook('user-prompt-submit', ev.preInvocation(0))), /Rules:/);
  // the first prompt after a launch belongs to the user's own conversation, even one picked in agy's resume list
  fs.writeFileSync(agyBriefingDue(W), '');
  assert.match(said(hook('user-prompt-submit', ev.preInvocation(0, OTHER))), /Rules:/);
  assert.equal(db.getAgent(d, 'a')!.session_id, OTHER);
});

test('agy: PreToolUse refuses in agy\'s shape and otherwise says nothing; a sub-agent\'s writes are checked too', () => {
  const { d, wt, ev, hook } = setup();
  db.setSession(d, 'a', MAIN);
  const deny = hook('pre-tool-use', ev.tool('PreToolUse', 'write_file', { Append: true, Content: 'hello\n', Path: path.join(wt, 'notes.txt') }));
  assert.deepEqual(Object.keys(deny), ['decision', 'reason']);
  assert.equal(deny.decision, 'deny');
  assert.match(deny.reason, /not claimed/);
  // printing {} would refuse the call, so a call chord lets through gets no answer at all
  assert.equal(hook('pre-tool-use', ev.tool('PreToolUse', 'run_command', { CommandLine: 'git status', WaitMsBeforeAsync: 5000, toolSummary: 'Run git status' })), undefined);
  assert.equal(hook('pre-tool-use', ev.tool('PreToolUse', 'call_mcp_tool', { Arguments: {}, ServerName: 'chord', ToolName: 'register' })), undefined);
  assert.equal(hook('pre-tool-use', ev.tool('PreToolUse', 'write_file', { Content: 'sub', Path: `${wt.split(path.sep).join('/')}/c.txt` }, SUB)).decision, 'deny'); // a sub-agent writes forward slashes
  db.addClaim(d, { agent: 'a', file: 'repo/notes.txt', intent: 'add hello', kind: 'modify' });
  assert.equal(hook('pre-tool-use', ev.tool('PreToolUse', 'write_file', { Append: true, Content: 'hello\n', Path: path.join(wt, 'notes.txt') })), undefined);
});

test('agy: what a shell command did behind chord\'s back reaches the model at the next PreInvocation, even after the turn ends', () => {
  const { d, W, wt, ev, hook } = setup();
  db.setSession(d, 'a', MAIN); fs.rmSync(agyBriefingDue(W));
  fs.writeFileSync(path.join(wt, 'notes2.txt'), 'x\n');
  // agy's PostToolUse cannot speak
  assert.equal(hook('post-tool-use', ev.tool('PostToolUse', 'run_command', { CommandLine: 'echo x > notes2.txt' })), undefined);
  assert.equal(hook('post-tool-use', ev.tool('PostToolUse', 'run_command', { CommandLine: 'git stash' })), undefined);
  assert.equal(hook('stop', ev.stop()), undefined); // the turn ends before another model call
  assert.equal(db.getAgent(d, 'a')!.status, 'idle');
  const next = said(hook('user-prompt-submit', ev.preInvocation(0, MAIN, 'go on')));
  assert.match(next, /The shell command changed files you have not claimed: repo\/notes2\.txt/);
  assert.match(next, /git stash is shared/);
  assert.equal(next.match(/changed files you have not claimed/g)!.length, 1); // both commands saw it; said once
  assert.doesNotMatch(said(hook('user-prompt-submit', ev.preInvocation(1, MAIN, 'go on'))), /not claimed/); // and not again
  // a sub-agent's shell command is checked as well; what it finds goes to the agent's own conversation
  assert.equal(hook('post-tool-use', ev.tool('PostToolUse', 'run_command', { CommandLine: 'git stash pop' }, SUB)), undefined);
  assert.match(said(hook('user-prompt-submit', ev.preInvocation(2, MAIN, 'go on'))), /git stash is shared/);
});

test('agy: messages reach the agent\'s own conversation at a PreInvocation or its Stop, never a sub-agent', () => {
  const { d, W, ev, hook } = setup();
  db.setSession(d, 'a', MAIN); fs.rmSync(agyBriefingDue(W));
  hook('user-prompt-submit', ev.preInvocation(0));
  db.send(d, 'b', ['a'], 'heads up: I am editing the footer');
  assert.equal(hook('post-tool-use', ev.tool('PostToolUse', 'update_steps', { steps: [] })), undefined);
  assert.equal(db.hasUnread(d, 'a'), true); // PostToolUse cannot speak, so it leaves them
  assert.equal(hook('session-start', ev.sessionStart('', SUB)), undefined); // a sub-agent starting
  assert.equal(db.getAgent(d, 'a')!.session_id, MAIN);
  assert.equal(hook('user-prompt-submit', ev.preInvocation(0, SUB, '')), undefined);
  assert.equal(hook('stop', ev.stop(SUB)), undefined);
  assert.equal(db.hasUnread(d, 'a'), true);
  assert.equal(db.getAgent(d, 'a')!.status, 'busy'); // a sub-agent finishing is not the agent going idle
  assert.match(said(hook('user-prompt-submit', ev.preInvocation(1))), /message from b[\s\S]*heads up[\s\S]*while you were working/);
  db.send(d, 'b', ['a'], 'and the header too');
  const more = hook('stop', ev.stop());
  assert.deepEqual(Object.keys(more), ['decision', 'reason']);
  assert.equal(more.decision, 'continue');
  assert.match(more.reason, /and the header too/);
  assert.equal(hook('stop', ev.stop(MAIN, 1)), undefined);
  assert.equal(db.getAgent(d, 'a')!.status, 'idle');
});

test('agy: the hook process prints nothing when chord has nothing to say, and refuses a write when the database will not open', () => {
  const { P, W, wt, ev } = setup();
  const file = path.join(tmp('chord-agy-db-'), 'chord.db');
  const d = db.openDb(file);
  db.addAgent(d, { name: 'a', tool: 'agy', pid: process.pid, cwd: W }); db.setSession(d, 'a', MAIN);
  d.close();
  const run = (event: Event, payload: object, dbFile = file) => spawnSync(process.execPath, [HOOKS, event], {
    input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, CHORD_AGENT_ID: 'a', CHORD_DB: dbFile, CHORD_TOOL: 'agy', CHORD_PROJECT: P, CHORD_WORKSPACE: W, CHORD_WORKTREE: wt },
  });
  const write = ev.tool('PreToolUse', 'write_file', { Content: 'x', Path: path.join(wt, 'x.txt') });
  for (const [event, payload] of [['pre-tool-use', ev.tool('PreToolUse', 'run_command', { CommandLine: 'git status' })], ['post-tool-use', ev.tool('PostToolUse', 'run_command', { CommandLine: 'git status' })], ['stop', ev.stop()]] as const) {
    const r = run(event, payload);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', `${event} printed ${r.stdout}`);
  }
  assert.equal(JSON.parse(run('pre-tool-use', write).stdout).decision, 'deny');
  const broken = path.join(os.tmpdir(), `chord-no-such-dir-${Date.now()}`, 'chord.db');
  const refused = JSON.parse(run('pre-tool-use', write, broken).stdout);
  assert.equal(refused.decision, 'deny');
  assert.match(refused.reason, /chord could not check this write/);
  assert.equal(run('stop', ev.stop(), broken).stdout, '');
});

test('agy: a stop that was cancelled or failed is not continued and leaves the messages unread', () => {
  for (const terminationReason of ['USER_CANCELED', 'ERROR', 'MAX_FORCED_INVOCATIONS']) {
    const { d, W, ev, hook } = setup();
    db.setSession(d, 'a', MAIN); fs.rmSync(agyBriefingDue(W));
    hook('user-prompt-submit', ev.preInvocation(0));
    db.send(d, 'b', ['a'], 'heads up');
    assert.equal(hook('stop', { ...ev.stop(), terminationReason }), undefined, terminationReason);
    assert.equal(db.hasUnread(d, 'a'), true, terminationReason);
    assert.equal(db.getAgent(d, 'a')!.status, 'idle', terminationReason);
  }
  const { d, W, ev, hook } = setup();
  db.setSession(d, 'a', MAIN); fs.rmSync(agyBriefingDue(W));
  db.send(d, 'b', ['a'], 'heads up');
  assert.equal(hook('stop', ev.stop()).decision, 'continue'); // the normal end of a turn still delivers
  assert.equal(hook('stop', { ...ev.stop(), terminationReason: undefined }), undefined); // read already; no field behaves as before
});
