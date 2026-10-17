// Hook entry point for both Claude Code and Codex: `node hooks.ts <event>`, payload on stdin.
// Event names are chord's own; launch.ts maps each tool's hook config onto them.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import * as db from './db.ts';
import { patchFiles } from './patch.ts';
import { canWrite, insideDir, normFile, type Ctx } from './tools.ts';

export type Event = 'session-start' | 'user-prompt-submit' | 'pre-tool-use' | 'post-tool-use' | 'stop' | 'session-end';
export type Tool = 'claude' | 'codex';

/** What the hook prints: plain text (context) or a JSON object; `undefined` prints nothing. */
export type HookOut = string | object | undefined;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function filesTouched(tool: Tool, payload: Record<string, any>): string[] {
  const name = String(payload.tool_name ?? '');
  const input = payload.tool_input ?? {};
  if (tool === 'claude' && EDIT_TOOLS.has(name)) {
    const p = input.file_path ?? input.notebook_path;
    return typeof p === 'string' ? [p] : [];
  }
  if (tool === 'codex' && name === 'apply_patch' && typeof input.command === 'string') return patchFiles(input.command);
  return [];
}

const isShell = (name: unknown) => /^(bash|powershell|shell|exec|exec_command|local_shell)$/i.test(String(name ?? ''));

export function formatMessages(ms: db.Message[]): string {
  return ms.map(m => `[chord] message from ${m.sender} at ${new Date(m.created_at).toISOString().slice(11, 16)}:\n${m.body}`).join('\n\n');
}

export function briefing(ctx: Ctx): string {
  const me = db.getAgent(ctx.db, ctx.agent);
  const peers = db.listAgents(ctx.db).filter(a => a.name !== ctx.agent);
  const claims = db.allClaims(ctx.db);
  const repoDir = path.relative(ctx.cwd, ctx.worktree) || '.';
  const lines = [
    `You are agent "${ctx.agent}" (${me?.tool ?? 'unknown'}), one of several coding agents working on the same project. Your working directory is your own workspace; the repository is the directory "${repoDir}" inside it, a git worktree on your own branch. Run git commands inside "${repoDir}". Name files as paths from your working directory, e.g. "${repoDir}/src/x.ts" (claim() also accepts repository-relative paths like "src/x.ts"). Other agents have their own worktrees of the same repository; never edit files outside your workspace. Coordination goes through the "chord" MCP tools.`,
    '',
    'Rules:',
    '1. First thing: call register(task, scope) to say what you are doing.',
    '2. Before creating or changing any file, call claim(file, intent, kind). Writes to unclaimed files are refused.',
    '3. If claim() lists agents under must_talk_to, read their intent and send() each of them a message saying what you will change. You may write once each has replied, or after 10 minutes. Do other work meanwhile; never wait idle.',
    '4. Do not modify files through shell commands (sed, echo >, etc.). Use the editor tools so claims are checked.',
    '5. To talk to other agents use only chord send()/inbox(); do not use any other agent-messaging feature. Messages are asynchronous.',
    '6. To learn about the project, read the agent list and claims below and ask a specific agent with send(); do not ask the user.',
    '7. When your change is complete and committed on your branch, call finish() to rebase onto main and fast-forward it. If finish() reports a conflict, stop and ask the user.',
    '',
    peers.length ? 'Agents online:' : 'No other agents are online yet.',
    ...peers.map(a => `- ${a.name} (${a.tool}, ${a.status}): ${a.task ?? 'not registered yet'}${a.scope ? ` [${a.scope}]` : ''}`),
    '',
    claims.length ? 'Current file claims:' : 'No files are claimed yet.',
    ...claims.map(c => `- ${c.file} <- ${c.agent}: ${c.kind}, ${c.intent}${c.symbols ? ` (${c.symbols})` : ''}`),
  ];
  return lines.join('\n');
}

/** Context for the model. Plain stdout also works for Claude Code and `codex exec`, but the Codex TUI
 *  only takes the JSON form, so both events use it. */
const context = (hookEventName: string, additionalContext: string) => ({ hookSpecificOutput: { hookEventName, additionalContext } });

export function handleHook(ctx: Ctx, tool: Tool, event: Event, payload: Record<string, any>): HookOut {
  db.sweep(ctx.db);
  switch (event) {
    case 'session-start':
      // the agent now waits for its first prompt: idle, so messages that arrive before the user types still wake it
      db.setStatus(ctx.db, ctx.agent, 'idle');
      return context('SessionStart', briefing(ctx));

    case 'user-prompt-submit': {
      db.setStatus(ctx.db, ctx.agent, 'busy');
      const ms = db.takeUnread(ctx.db, ctx.agent);
      return ms.length ? context('UserPromptSubmit', `${formatMessages(ms)}\n\n[chord] ${ms.length} message(s) above arrived from other agents. Act on them in this turn as well as on the user's request: reply with the chord send tool where a reply is asked for.`) : undefined;
    }

    case 'pre-tool-use': {
      for (const f of filesTouched(tool, payload)) {
        const abs = path.resolve(ctx.cwd, f);
        if (!insideDir(ctx.worktree, abs)) {
          // the main checkout and the other agents' workspaces are off limits; anything else is not ours to police
          if (ctx.project && insideDir(ctx.project, abs) && !insideDir(ctx.cwd, abs)) {
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${f} is outside your workspace: edit files only inside your own worktree ${ctx.worktree}` } };
          }
          continue;
        }
        const check = canWrite(ctx, f);
        if (!check.ok) {
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: check.reason } };
        }
      }
      return undefined;
    }

    case 'post-tool-use': {
      if (!isShell(payload.tool_name)) return undefined;
      let status = '';
      try { status = execFileSync('git', ['status', '--porcelain'], { cwd: ctx.worktree, encoding: 'utf8', env: db.gitEnv() }); } catch { return undefined; }
      const mine = new Set(db.claimsBy(ctx.db, ctx.agent).map(c => c.file.toLowerCase()));
      const unclaimed = status.split('\n').filter(Boolean)
        .map(l => normFile(ctx, path.join(ctx.worktree, l.slice(3).trim().replace(/^.* -> /, '').replace(/^"|"$/g, ''))))
        .filter(f => !mine.has(f.toLowerCase()));
      if (!unclaimed.length) return undefined;
      const text = `[chord] The shell command changed files you have not claimed: ${unclaimed.join(', ')}. Claim them now with claim(), or revert the change.`;
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } };
    }

    case 'stop': {
      const ms = db.takeUnread(ctx.db, ctx.agent);
      if (ms.length) return { decision: 'block', reason: formatMessages(ms) + '\n\nHandle these messages before stopping.' };
      db.setStatus(ctx.db, ctx.agent, 'idle');
      return undefined;
    }

    case 'session-end':
      db.setStatus(ctx.db, ctx.agent, 'offline');
      db.releaseAll(ctx.db, ctx.agent);
      return undefined;
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  const event = process.argv[2] as Event;
  const agent = process.env.CHORD_AGENT_ID;
  const file = process.env.CHORD_DB;
  const tool = process.env.CHORD_TOOL as Tool;
  if (!agent || !file || !tool) { process.stderr.write('chord hook: CHORD_AGENT_ID, CHORD_DB and CHORD_TOOL must be set\n'); process.exit(0); }
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let payload: Record<string, any> = {};
  try { payload = JSON.parse(raw); } catch { /* no payload */ }
  // the workspace is fixed per agent; the tool's own cwd moves when the agent runs `cd`, so it is not used as the base
  const cwd = process.env.CHORD_WORKSPACE ?? (typeof payload.cwd === 'string' ? payload.cwd : process.cwd());
  const ctx: Ctx = { db: db.openDb(file), agent, cwd, worktree: process.env.CHORD_WORKTREE ?? cwd, project: process.env.CHORD_PROJECT };
  const out = handleHook(ctx, tool, event, payload);
  db.log(`hook ${event} (${tool}, tool_name=${payload.tool_name ?? '-'}): ${out === undefined ? 'no output' : `${typeof out === 'string' ? 'text' : 'json'} ${JSON.stringify(out).length} chars`} in ${Date.now() - started}ms`);
  if (out !== undefined) process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out));
}

if (process.argv[1] && /hooks\.ts$/.test(process.argv[1])) main();
