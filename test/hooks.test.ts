import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/db.ts';
import { handleHook, filesTouched } from '../src/hooks.ts';
import type { Ctx } from '../src/tools.ts';

function setup() {
  const d = db.openDb(':memory:');
  db.addAgent(d, { name: 'a', tool: 'claude', pid: process.pid, cwd: '/wt/a' });
  db.addAgent(d, { name: 'b', tool: 'codex', pid: process.pid, cwd: '/wt/b' });
  const ctx = (agent: string): Ctx => ({ db: d, agent, cwd: `/wt/${agent}`, worktree: `/wt/${agent}` });
  return { d, ctx };
}

test('filesTouched: claude edit tools and codex apply_patch', () => {
  assert.deepEqual(filesTouched('claude', { tool_name: 'Edit', tool_input: { file_path: 'C:\\wt\\a\\x.ts' } }), ['C:\\wt\\a\\x.ts']);
  assert.deepEqual(filesTouched('claude', { tool_name: 'NotebookEdit', tool_input: { notebook_path: 'n.ipynb' } }), ['n.ipynb']);
  assert.deepEqual(filesTouched('claude', { tool_name: 'Bash', tool_input: { command: 'ls' } }), []);
  assert.deepEqual(filesTouched('codex', { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: x.ts\n+1\n*** End Patch' } }), ['x.ts']);
  assert.deepEqual(filesTouched('codex', { tool_name: 'Bash', tool_input: { command: 'ls' } }), []);
  // other shapes the patch may arrive in
  assert.deepEqual(filesTouched('codex', { tool_name: 'apply_patch', tool_input: { input: '*** Begin Patch\n*** Update File: y.ts\n*** End Patch' } }), ['y.ts']);
  assert.deepEqual(filesTouched('codex', { tool_name: 'apply_patch', tool_input: '*** Begin Patch\n*** Delete File: z.ts\n*** End Patch' }), ['z.ts']);
  assert.deepEqual(filesTouched('codex', { tool_name: 'Bash', tool_input: { command: "apply_patch <<'EOF'\n*** Begin Patch\n  *** Add File: u.txt\n+x\n*** End Patch\nEOF" } }), ['u.txt']); // from the shell, headers indented
});

test('pre-tool-use resolves a Codex patch against its workdir and refuses an edit tool that names no file', () => {
  const { d, ctx } = setup();
  const c = ctx('a'); // workspace /wt/a, worktree /wt/a: a workdir of a subdirectory
  db.addClaim(d, { agent: 'a', file: 'sub/ok.ts', intent: 'x', kind: 'add' });
  const patch = (f: string) => `*** Begin Patch\n*** Update File: ${f}\n*** End Patch`;
  assert.equal(handleHook(c, 'codex', 'pre-tool-use', { tool_name: 'apply_patch', tool_input: { command: patch('ok.ts'), workdir: '/wt/a/sub' } }), undefined); // sub/ok.ts, claimed
  const deny = handleHook(c, 'codex', 'pre-tool-use', { tool_name: 'apply_patch', tool_input: { command: patch('other.ts'), workdir: '/wt/a/sub' } }) as any;
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /sub\/other.ts/);
  const noFile = handleHook(c, 'codex', 'pre-tool-use', { tool_name: 'apply_patch', tool_input: { command: 'not a patch' } }) as any;
  assert.equal(noFile.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(noFile.hookSpecificOutput.permissionDecisionReason, /could not tell which file/);
  assert.equal((handleHook(c, 'claude', 'pre-tool-use', { tool_name: 'Write', tool_input: {} }) as any).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(handleHook(c, 'claude', 'pre-tool-use', { tool_name: 'Read', tool_input: {} }), undefined);
});

test('session-start sets busy and briefs with peers and claims', () => {
  const { d, ctx } = setup();
  db.setTask(d, 'b', 'write tests', 'test/');
  db.addClaim(d, { agent: 'b', file: 'test/x.test.ts', intent: 'cover parser', kind: 'add' });
  const out = (handleHook(ctx('a'), 'claude', 'session-start', {}) as any).hookSpecificOutput.additionalContext as string;
  assert.equal(db.getAgent(d, 'a')!.status, 'idle'); // waiting for its first prompt
  assert.match(out, /You are agent "a"/);
  assert.match(out, /- b \(codex, busy\): write tests \[test\/\]/);
  assert.match(out, /- test\/x.test.ts <- b: add, cover parser/);
});

test('user-prompt-submit delivers unread messages once and always restates who the agent is', () => {
  const { d, ctx } = setup();
  db.send(d, 'b', ['a'], 'hello a');
  const out = (handleHook(ctx('a'), 'claude', 'user-prompt-submit', {}) as any).hookSpecificOutput.additionalContext as string;
  assert.match(out, /message from b/); assert.match(out, /hello a/);
  assert.match(out, /You are agent "a" in a chord project/);
  // no messages left: only the one-line reminder, so a conversation that never saw the briefing (Codex /new) still knows the rules
  const again = (handleHook(ctx('a'), 'claude', 'user-prompt-submit', {}) as any).hookSpecificOutput.additionalContext as string;
  assert.doesNotMatch(again, /hello a/);
  assert.match(again, /^\[chord\] You are agent "a" in a chord project: claim a file with the chord claim tool before editing it/);
  assert.ok(again.length < 320);
});

test('pre-tool-use denies unclaimed writes and allows claimed ones', () => {
  const { d, ctx } = setup();
  const deny = handleHook(ctx('a'), 'claude', 'pre-tool-use', { tool_name: 'Write', tool_input: { file_path: '/wt/a/src/x.ts' } }) as any;
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /not claimed/);
  db.addClaim(d, { agent: 'a', file: 'src/x.ts', intent: 'x', kind: 'add' });
  assert.equal(handleHook(ctx('a'), 'claude', 'pre-tool-use', { tool_name: 'Write', tool_input: { file_path: '/wt/a/src/x.ts' } }), undefined);
  // codex path, relative
  const deny2 = handleHook(ctx('b'), 'codex', 'pre-tool-use', { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/x.ts\n*** End Patch' } }) as any;
  assert.equal(deny2.hookSpecificOutput.permissionDecision, 'deny');
  // files outside the worktree are ignored
  assert.equal(handleHook(ctx('a'), 'claude', 'pre-tool-use', { tool_name: 'Write', tool_input: { file_path: '/tmp/scratch.txt' } }), undefined);
  // non-edit tools pass
  assert.equal(handleHook(ctx('a'), 'claude', 'pre-tool-use', { tool_name: 'Read', tool_input: { file_path: '/wt/a/src/y.ts' } }), undefined);
});

test('stop feeds unread messages back, otherwise marks idle', () => {
  const { d, ctx } = setup();
  db.send(d, 'b', ['a'], 'one'); db.send(d, 'b', ['a'], 'two');
  const out = handleHook(ctx('a'), 'claude', 'stop', {}) as any;
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /one[\s\S]*two/);
  assert.equal(db.getAgent(d, 'a')!.status, 'busy');
  assert.equal(handleHook(ctx('a'), 'claude', 'stop', {}), undefined);
  assert.equal(db.getAgent(d, 'a')!.status, 'idle');
});

test('stop lets an agent with only notices unread go idle; the notices ride along with its next hook', () => {
  const { d, ctx } = setup();
  db.send(d, 'b', ['a'], 'b merged into main', 'notice');
  assert.equal(handleHook(ctx('a'), 'claude', 'stop', {}), undefined); // a notice is not worth another turn
  assert.equal(db.getAgent(d, 'a')!.status, 'idle');
  const out = handleHook(ctx('a'), 'claude', 'post-tool-use', { tool_name: 'Read' }) as any;
  assert.match(out.hookSpecificOutput.additionalContext, /b merged into main/);
});

test('session-end leaves going offline to the wrapper: the agent is idle and keeps its claims', () => {
  const { d, ctx } = setup();
  db.addClaim(d, { agent: 'a', file: 'f', intent: 'x', kind: 'add' });
  db.setStatus(d, 'a', 'busy');
  handleHook(ctx('a'), 'codex', 'session-end', {});
  assert.equal(db.getAgent(d, 'a')!.status, 'idle');
  assert.equal(db.claimsBy(d, 'a').length, 1);
});

test('session-start after compaction does not make a busy agent idle', () => {
  const { d, ctx } = setup();
  db.setStatus(d, 'a', 'busy');
  handleHook(ctx('a'), 'claude', 'session-start', { source: 'compact' });
  assert.equal(db.getAgent(d, 'a')!.status, 'busy');
  handleHook(ctx('a'), 'claude', 'session-start', { source: 'startup' });
  assert.equal(db.getAgent(d, 'a')!.status, 'idle');
  db.setStatus(d, 'a', 'idle');
  handleHook(ctx('a'), 'claude', 'post-tool-use', { tool_name: 'Read' }); // any tool call means the agent is working
  assert.equal(db.getAgent(d, 'a')!.status, 'busy');
});

test('pre-tool-use polices only the worktree and forbids other checkouts in the project', () => {
  const d = db.openDb(':memory:');
  const P = process.platform === 'win32' ? 'D:\\P' : '/P';
  const cwd = `${P}/chord/agents/a`.split('/').join(path.sep);
  const ctx: Ctx = { db: d, agent: 'a', cwd, worktree: `${cwd}/repo`, project: P };
  db.addAgent(d, { name: 'a', tool: 'claude', pid: process.pid, cwd });
  const write = (file_path: string) => handleHook(ctx, 'claude', 'pre-tool-use', { tool_name: 'Write', tool_input: { file_path } }) as any;
  assert.match(write(`${cwd}/repo/src/x.ts`).hookSpecificOutput.permissionDecisionReason, /not claimed/); // inside the worktree: needs a claim
  assert.equal(write(`${cwd}/notes.md`), undefined); // workspace scratch file outside the repo: not policed
  const own = path.join(cwd, 'repo', 'src', 'x.ts').replace(/[\\/]/g, '[\\\\/]');
  assert.match(write(`${P}/repo/src/x.ts`).hookSpecificOutput.permissionDecisionReason, new RegExp(`outside your workspace.*edit your own copy ${own}`)); // the main checkout; Claude's Edit wants an absolute path
  assert.match(write(`${P}/chord/agents/b/repo/src/x.ts`).hookSpecificOutput.permissionDecisionReason, /outside your workspace/); // another agent
  // Codex resolves relative patch paths against its real cwd, the project folder
  const patch = (f: string, workdir?: string) => handleHook(ctx, 'codex', 'pre-tool-use', { tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Update File: ${f}\n*** End Patch`, ...(workdir ? { workdir } : {}) } }) as any;
  assert.match(patch('repo/src/x.ts').hookSpecificOutput.permissionDecisionReason, /main checkout.*chord\/agents\/a\/repo\/src\/x\.ts/); // from P that is the main checkout
  assert.match(patch('chord/agents/a/repo/src/x.ts').hookSpecificOutput.permissionDecisionReason, /not claimed/); // own worktree: the claim check
  db.addClaim(d, { agent: 'a', file: 'repo/src/x.ts', intent: 'x', kind: 'add' });
  assert.equal(patch('chord/agents/a/repo/src/x.ts'), undefined);
  assert.equal(patch('src/x.ts', 'chord/agents/a/repo'), undefined); // workdir relative to P
  assert.equal(write(os.tmpdir() + '/scratch.txt'), undefined); // elsewhere: not ours
  if (process.platform === 'win32') assert.equal(write('C:\\elsewhere\\x.txt'), undefined); // another drive is not "inside" anything
});

test('pre-tool-use is not fooled by a change of case on macOS, whose file systems ignore it', { skip: process.platform !== 'darwin' }, () => {
  const d = db.openDb(':memory:');
  const cwd = '/P/chord/agents/a';
  const ctx: Ctx = { db: d, agent: 'a', cwd, worktree: `${cwd}/repo`, project: '/P' };
  db.addAgent(d, { name: 'a', tool: 'claude', pid: process.pid, cwd });
  const write = (file_path: string) => handleHook(ctx, 'claude', 'pre-tool-use', { tool_name: 'Write', tool_input: { file_path } }) as any;
  assert.match(write(`${cwd}/REPO/src/x.ts`).hookSpecificOutput.permissionDecisionReason, /not claimed/); // the own worktree still needs a claim
  assert.match(write('/p/Repo/src/x.ts').hookSpecificOutput.permissionDecisionReason, /outside your workspace/); // still the main checkout
  db.addClaim(d, { agent: 'a', file: 'repo/src/x.ts', intent: 'x', kind: 'add' });
  assert.equal(write('/p/Chord/Agents/A/Repo/src/X.ts'), undefined); // the claimed file, however it is spelled
});

test('pre-tool-use sees through a link to the worktree or the main checkout', () => {
  const d = db.openDb(':memory:');
  const P = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chord-link-')));
  const cwd = path.join(P, 'chord', 'agents', 'a'), wt = path.join(cwd, 'repo'), main = path.join(P, 'repo');
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true }); fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  const links = fs.mkdtempSync(path.join(os.tmpdir(), 'chord-links-')); // outside the project, as /tmp or a user's shortcut would be
  fs.symlinkSync(wt, path.join(links, 'mine'), 'junction'); fs.symlinkSync(main, path.join(links, 'theirs'), 'junction');
  const ctx: Ctx = { db: d, agent: 'a', cwd, worktree: wt, project: P };
  db.addAgent(d, { name: 'a', tool: 'claude', pid: process.pid, cwd });
  const write = (file_path: string) => handleHook(ctx, 'claude', 'pre-tool-use', { tool_name: 'Write', tool_input: { file_path } }) as any;
  assert.match(write(path.join(links, 'mine', 'src', 'x.ts')).hookSpecificOutput.permissionDecisionReason, /not claimed/); // the own worktree, however reached
  assert.match(write(path.join(links, 'theirs', 'src', 'x.ts')).hookSpecificOutput.permissionDecisionReason, /outside your workspace/); // the main checkout, however reached
  db.addClaim(d, { agent: 'a', file: 'repo/src/x.ts', intent: 'x', kind: 'add' });
  assert.equal(write(path.join(links, 'mine', 'src', 'x.ts')), undefined); // a new file under the link: the claim matches
});

test('briefing lists only online peers and appends the repository instructions', () => {
  const { d } = setup();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'chord-brief-'));
  fs.writeFileSync(path.join(wt, 'AGENTS.md'), '# House rules\nUse tabs.\n');
  fs.writeFileSync(path.join(wt, 'CLAUDE.md'), 'Reply in French.\n');
  db.addAgent(d, { name: 'gone', tool: 'codex', pid: process.pid, cwd: '/g' }); db.setStatus(d, 'gone', 'offline');
  const ctx: Ctx = { db: d, agent: 'a', cwd: path.dirname(wt), worktree: wt };
  const out = (handleHook(ctx, 'claude', 'session-start', {}) as any).hookSpecificOutput.additionalContext as string;
  assert.ok(!out.includes('- gone'));
  assert.match(out, /Project instructions from [^\n]*AGENTS.md:\n# House rules\nUse tabs\./);
  assert.match(out, /CLAUDE.md:\nReply in French\./);
});

test('session-end after /clear keeps the agent online with its claims', () => {
  const { d, ctx } = setup();
  db.addClaim(d, { agent: 'a', file: 'f', intent: 'x', kind: 'add' });
  handleHook(ctx('a'), 'claude', 'session-end', { reason: 'clear' });
  assert.equal(db.getAgent(d, 'a')!.status, 'idle');
  assert.equal(db.claimsBy(d, 'a').length, 1);
  handleHook(ctx('a'), 'claude', 'session-end', { reason: 'prompt_input_exit' }); // whatever the reason: the process exit, not the hook, takes the agent offline
  assert.equal(db.getAgent(d, 'a')!.status, 'idle');
  assert.equal(db.claimsBy(d, 'a').length, 1);
});

test('a hook that throws denies the write instead of failing open', async () => {
  const { safeHandle } = await import('../src/hooks.ts');
  const d = db.openDb(':memory:'); d.close(); // every query will throw
  const ctx: Ctx = { db: d, agent: 'a', cwd: '/w', worktree: '/w/repo' };
  const out = safeHandle(ctx, 'claude', 'pre-tool-use', { tool_name: 'Write', tool_input: { file_path: '/w/repo/x.ts' } }) as any;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /chord could not check this write/);
  assert.equal(safeHandle(ctx, 'claude', 'stop', {}), undefined); // other events fail quietly
});

test('post-tool-use hands over messages that arrived mid-turn, after any tool, but not to a subagent', () => {
  const { d, ctx } = setup();
  db.send(d, 'b', ['a'], 'heads up: I am touching the footer');
  // a Claude Code subagent's tool calls fire the same hook with an agent_id; what it is told never reaches the main
  // conversation, so the messages wait for a call of the agent's own
  assert.equal(handleHook(ctx('a'), 'claude', 'post-tool-use', { tool_name: 'Read', agent_id: 'sub-1', agent_type: 'Explore' }), undefined);
  assert.equal(db.hasUnread(d, 'a'), true);
  const out = handleHook(ctx('a'), 'claude', 'post-tool-use', { tool_name: 'Read' }) as any;
  assert.match(out.hookSpecificOutput.additionalContext, /message from b[\s\S]*heads up[\s\S]*arrived from other agents while you were working/);
  assert.equal(handleHook(ctx('a'), 'claude', 'post-tool-use', { tool_name: 'Read' }), undefined); // delivered once
});

test('an idle_prompt notification marks the agent idle; other notifications do not', () => {
  const { d, ctx } = setup();
  db.setStatus(d, 'a', 'busy');
  assert.equal(handleHook(ctx('a'), 'claude', 'notification', { notification_type: 'permission_prompt' }), undefined);
  assert.equal(db.getAgent(d, 'a')!.status, 'busy');
  handleHook(ctx('a'), 'claude', 'notification', { notification_type: 'idle_prompt' });
  assert.equal(db.getAgent(d, 'a')!.status, 'idle');
});

test('a hook that cannot open the database still refuses the write', async () => {
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const env = { ...process.env, CHORD_AGENT_ID: 'a', CHORD_DB: path.join(os.tmpdir(), 'chord-no-such-dir-' + Date.now(), 'chord.db'), CHORD_TOOL: 'claude', CHORD_WORKSPACE: 'C:/w', CHORD_WORKTREE: 'C:/w/repo' };
  const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'C:/w/repo/x.txt' } });
  const out = execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'hooks.ts'), 'pre-tool-use'], { input: payload, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny');
  // other events fail quietly
  const quiet = execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'hooks.ts'), 'stop'], { input: '{}', env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(quiet, '');
});

test('the hook and the MCP server refuse to run without the workspace variables rather than guess a base directory', async () => {
  const { spawnSync } = await import('node:child_process');
  const env: NodeJS.ProcessEnv = { ...process.env, CHORD_AGENT_ID: 'a', CHORD_DB: ':memory:', CHORD_TOOL: 'claude' };
  delete env.CHORD_WORKSPACE; delete env.CHORD_WORKTREE;
  const hook = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'hooks.ts'), 'stop'], { input: '{}', env, encoding: 'utf8' });
  assert.equal(hook.stdout, '');
  assert.match(hook.stderr, /CHORD_WORKSPACE/);
  const server = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'serve.ts')], { input: '', env, encoding: 'utf8' });
  assert.equal(server.status, 2);
  assert.match(server.stderr, /CHORD_WORKSPACE/);
});

test('session-start and user-prompt-submit record the tool session id', () => {
  const { d, ctx } = setup();
  handleHook(ctx('a'), 'claude', 'session-start', { session_id: 's1', source: 'startup' });
  assert.equal(db.getAgent(d, 'a')!.session_id, 's1');
  handleHook(ctx('a'), 'codex', 'user-prompt-submit', { session_id: 's2', prompt: 'hi' });
  assert.equal(db.getAgent(d, 'a')!.session_id, 's2');
  handleHook(ctx('a'), 'claude', 'user-prompt-submit', {}); // no id in the payload: unchanged
  assert.equal(db.getAgent(d, 'a')!.session_id, 's2');
});

test('briefing and reminder name the worktree as seen from the project folder', () => {
  const { d } = setup();
  const P = process.platform === 'win32' ? 'D:\\P' : '/P';
  const cwd = path.join(P, 'chord', 'agents', 'a');
  const ctx: Ctx = { db: d, agent: 'a', cwd, worktree: path.join(cwd, 'repo'), project: P };
  const out = (handleHook(ctx, 'claude', 'session-start', {}) as any).hookSpecificOutput.additionalContext as string;
  assert.match(out, /Your working directory is the project folder\. Your own copy of the repository is "chord\/agents\/a\/repo"/);
  assert.match(out, /"repo\/" in the project folder is the main checkout/);
  const again = (handleHook(ctx, 'claude', 'user-prompt-submit', {}) as any).hookSpecificOutput.additionalContext as string;
  assert.match(again, /Your worktree is "chord\/agents\/a\/repo"; edit and run git only there\.$/);
});

test('the deny reason finds the own copy when another agent is named like the repository', () => {
  const d = db.openDb(':memory:');
  const P = process.platform === 'win32' ? 'D:\\P' : '/P';
  const cwd = path.join(P, 'chord', 'agents', 'a');
  const ctx: Ctx = { db: d, agent: 'a', cwd, worktree: path.join(cwd, 'repo'), project: P };
  db.addAgent(d, { name: 'a', tool: 'codex', pid: process.pid, cwd });
  const other = handleHook(ctx, 'codex', 'pre-tool-use', { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: chord/agents/repo/repo/src/y.ts\n*** End Patch' } }) as any;
  assert.match(other.hookSpecificOutput.permissionDecisionReason, /edit your own copy chord\/agents\/a\/repo\/src\/y\.ts instead/);
});
