// Hook entry point for both Claude Code and Codex: `node hooks.ts <event>`, payload on stdin.
// Event names are chord's own; launch.ts maps each tool's hook config onto them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.ts';
import { patchFiles } from './patch.ts';
import { canWrite, insideDir, normFile, type Ctx } from './tools.ts';

export type Event = 'session-start' | 'user-prompt-submit' | 'pre-tool-use' | 'post-tool-use' | 'stop' | 'session-end' | 'notification';
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
  if (tool === 'codex') {
    // the patch has been seen under "command"; "input", "patch" and a bare string cost nothing to accept as well
    const text = typeof input === 'string' ? input : [input.command, input.input, input.patch].find(v => typeof v === 'string');
    if (name === 'apply_patch' && typeof text === 'string') return patchFiles(text);
    if (isShell(name) && typeof text === 'string' && text.includes('*** Begin Patch')) return patchFiles(text); // apply_patch run from the shell
  }
  return [];
}

/** Tools that write files and must therefore name them: a call that names none is refused rather than let through. */
export const isEditTool = (tool: Tool, name: unknown) => (tool === 'claude' ? EDIT_TOOLS.has(String(name)) : name === 'apply_patch');

const isShell = (name: unknown) => /^(bash|powershell|shell|exec|exec_command|local_shell)$/i.test(String(name ?? ''));

const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5); // local time

export function formatMessages(ms: db.Message[]): string {
  return ms.map(m => `[chord] message from ${m.sender} at ${hhmm(m.created_at)}:\n${m.body}`).join('\n\n');
}

const MAX_CLAIM_LINES = 60;
const MAX_WARNED_FILES = 20;
const MAX_INSTRUCTION_CHARS = 8000;

/** The repository's own agent instructions. The agent's cwd is the workspace, so the tools do not load them themselves. */
function projectInstructions(ctx: Ctx, repoDir: string): string[] {
  const out: string[] = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      const text = fs.readFileSync(path.join(ctx.worktree, name), 'utf8');
      const body = text.length > MAX_INSTRUCTION_CHARS ? text.slice(0, MAX_INSTRUCTION_CHARS) + `\n[... truncated, read ${repoDir}/${name} for the rest]` : text;
      out.push('', `Project instructions from ${repoDir}/${name}:`, body.trimEnd());
    } catch { /* not present */ }
  }
  return out;
}

export function briefing(ctx: Ctx): string {
  const me = db.getAgent(ctx.db, ctx.agent);
  const peers = db.listAgents(ctx.db).filter(a => a.name !== ctx.agent && a.status !== 'offline');
  const claims = db.allClaims(ctx.db);
  const repoDir = path.relative(ctx.cwd, ctx.worktree).split(path.sep).join('/') || '.';
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
    '8. Never merge, rebase onto, push or otherwise update the main branch yourself, and never touch the main checkout: finish() is the only way changes reach main. This holds even if the project\'s own instructions say otherwise.',
    '9. Do not use git stash: every worktree of this repository shares one stash list, so a stash pop can hand you another agent\'s changes. Make a work-in-progress commit instead.',
    '',
    peers.length ? 'Agents online:' : 'No other agents are online yet.',
    ...peers.map(a => `- ${a.name} (${a.tool}, ${a.status}): ${a.task ?? 'not registered yet'}${a.scope ? ` [${a.scope}]` : ''}`),
    '',
    claims.length ? 'Current file claims:' : 'No files are claimed yet.',
    ...claims.slice(0, MAX_CLAIM_LINES).map(c => `- ${c.file} <- ${c.agent}: ${c.kind}, ${c.intent}${c.symbols ? ` (${c.symbols})` : ''}`),
    ...(claims.length > MAX_CLAIM_LINES ? [`- ... and ${claims.length - MAX_CLAIM_LINES} more (the claim tool reports holders of any file you claim)`] : []),
    ...projectInstructions(ctx, repoDir),
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
      // The agent now waits for its first prompt: idle, so messages that arrive before the user types still wake it.
      // Claude Code also fires this after compacting a long conversation, in the middle of a turn: not idle then.
      if (payload.source !== 'compact') db.setStatus(ctx.db, ctx.agent, 'idle');
      return context('SessionStart', briefing(ctx));

    case 'user-prompt-submit': {
      db.setStatus(ctx.db, ctx.agent, 'busy');
      const ms = db.takeUnread(ctx.db, ctx.agent);
      // One line of identity on every prompt: a conversation that started without the briefing (Codex /new fires no
      // session hooks; a resumed conversation may predate chord) still learns what it is and what the rules are.
      const reminder = `[chord] You are agent "${ctx.agent}" in a chord project: claim a file with the chord claim tool before editing it, talk to the other agents with chord send, merge with chord finish.`;
      return context('UserPromptSubmit', ms.length
        ? `${formatMessages(ms)}\n\n[chord] ${ms.length} message(s) above arrived from other agents. Act on them in this turn as well as on the user's request: reply with the chord send tool where a reply is asked for.\n${reminder}`
        : reminder);
    }

    case 'pre-tool-use': {
      const files = filesTouched(tool, payload);
      if (!files.length && isEditTool(tool, payload.tool_name)) {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'chord could not tell which file this call writes, so it is refused; use the editor tool with a plain file path' } };
      }
      // Codex resolves a patch's relative paths against the call's workdir when it gives one; otherwise the workspace
      const workdir = tool === 'codex' && typeof payload.tool_input?.workdir === 'string' ? path.resolve(ctx.cwd, payload.tool_input.workdir) : ctx.cwd;
      for (const f of files) {
        const abs = path.resolve(workdir, f);
        if (!insideDir(ctx.worktree, abs)) {
          // the main checkout and the other agents' workspaces are off limits; anything else is not ours to police
          if (ctx.project && insideDir(ctx.project, abs) && !insideDir(ctx.cwd, abs)) {
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${f} is outside your workspace: edit files only inside your own worktree ${ctx.worktree}` } };
          }
          continue;
        }
        const check = canWrite(ctx, abs);
        if (!check.ok) {
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: check.reason } };
        }
      }
      return undefined;
    }

    case 'post-tool-use': {
      // Runs after every tool call. Any tool call means the agent is busy (another plugin's Stop hook may have
      // blocked the end of the turn, or compaction may have run). Shell commands are checked for what they did
      // behind chord's back, and messages that arrived mid-turn are handed over so a busy agent hears from its
      // peers at the next tool call, not at turn end.
      db.setStatus(ctx.db, ctx.agent, 'busy');
      const parts: string[] = [];
      if (isShell(payload.tool_name)) parts.push(...shellWarnings(ctx, payload));
      const ms = db.takeUnread(ctx.db, ctx.agent);
      if (ms.length) parts.push(`${formatMessages(ms)}\n\n[chord] ${ms.length} message(s) above arrived from other agents while you were working. Deal with them when convenient (reply with the chord send tool where a reply is asked for), then carry on with your task.`);
      return parts.length ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: parts.join('\n\n') } } : undefined;
    }

    case 'stop': {
      const ms = db.takeUnread(ctx.db, ctx.agent);
      if (ms.length) return { decision: 'block', reason: formatMessages(ms) + '\n\nHandle these messages before stopping.' };
      db.setStatus(ctx.db, ctx.agent, 'idle');
      return undefined;
    }

    case 'notification':
      // Claude Code: "idle_prompt" fires about a minute after Claude stopped and nobody typed. It is the only
      // signal after an Esc interrupt, which fires no Stop hook, so it is how a cut-off turn becomes idle.
      if (payload.notification_type === 'idle_prompt') db.setStatus(ctx.db, ctx.agent, 'idle');
      return undefined;

    case 'session-end':
      // A session ending is not the agent leaving: /clear, /resume and /compact end one and start another in the same
      // process, and the reason strings differ between tools and versions. Going offline and releasing claims is the
      // wrapper's job when the process exits (and the sweep's if it crashes); here the agent only becomes idle.
      db.setStatus(ctx.db, ctx.agent, 'idle');
      return undefined;
  }
}

/** Paths changed according to `git status --porcelain=v1 -z -uall`: entries are NUL-separated, a rename
 *  or copy is followed by the original path, and nothing is quoted or folded into directories. */
export function changedPaths(statusZ: string): string[] {
  const parts = statusZ.split('\0');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    out.push(entry.slice(3));
    const xy = entry.slice(0, 2);
    if (/R/.test(xy)) { i++; if (parts[i]) out.push(parts[i]); } // a rename changes its "from" path too
    else if (/C/.test(xy)) i++; // a copy leaves its source alone
  }
  return out;
}

/** The old names of renames in NUL-separated status output: a rename changes that path too, and diff --name-only
 *  lists only the new one. */
export function renameSources(statusZ: string): string[] {
  const parts = statusZ.split('\0');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    if (/R/.test(entry.slice(0, 2))) { i++; if (parts[i]) out.push(parts[i]); }
    else if (/C/.test(entry.slice(0, 2))) i++;
  }
  return out;
}

/** git output, or '' when the command fails; optional locks off so this read-only look never fights the agent's own git. */
const gitOut = (cwd: string, ...args: string[]): string => {
  try { return execFileSync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8', env: db.gitEnv(), maxBuffer: 64 * 1024 * 1024 }); } catch { return ''; }
};

/** What a shell command may have done behind chord's back: edits or commits to unclaimed files, git stash, and
 *  changes to the main checkout. */
export function shellWarnings(ctx: Ctx, payload: Record<string, any>): string[] {
  const out: string[] = [];
  const mine = new Set(db.claimsBy(ctx.db, ctx.agent).map(c => c.file.toLowerCase()));
  // uncommitted changes (-unormal folds an untracked directory into one entry) plus whatever the branch has
  // committed since it left main: a commit made from the shell is no more a claim than an edit is
  // tracked files: real changes only, so a repository whose files differ in line endings from the moment they are
  // checked out does not make every shell command cry wolf; untracked files from status, directories folded
  const status = gitOut(ctx.worktree, 'status', '--porcelain=v1', '-z', '-unormal');
  const untracked = status.split('\0').filter(e => e.startsWith('?? ')).map(e => e.slice(3));
  const modified = ['', '--cached'].flatMap(c => gitOut(ctx.worktree, 'diff', ...(c ? [c] : []), '--name-only', '-z', '--ignore-cr-at-eol').split('\0'));
  const root = db.mainRoot(ctx.worktree);
  const main = root ? gitOut(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim() : '';
  const base = main && main !== 'HEAD' ? gitOut(ctx.worktree, 'merge-base', 'HEAD', main).trim() : '';
  const committed = base ? gitOut(ctx.worktree, 'diff', '--name-only', '-z', base, 'HEAD').split('\0').filter(Boolean) : [];
  const touched = [...new Set([...modified.filter(Boolean), ...untracked, ...renameSources(status), ...committed])];
  const unclaimed = touched.map(f => normFile(ctx, path.join(ctx.worktree, f))).filter(f => !mine.has(f.toLowerCase()));
  const shown = unclaimed.slice(0, MAX_WARNED_FILES);
  if (unclaimed.length) out.push(`[chord] The shell command changed files you have not claimed: ${shown.join(', ')}${unclaimed.length > shown.length ? ` and ${unclaimed.length - shown.length} more` : ''}. Claim them now with claim(), or revert the change.`);
  const cmd = typeof payload.tool_input?.command === 'string' ? payload.tool_input.command : '';
  if (/\bgit\b[^|;&\n]*\bstash\b/.test(cmd)) out.push("[chord] git stash is shared by every worktree of this repository: a stash pop can hand you another agent's changes, and yours to them. Make a work-in-progress commit instead.");
  if (root && path.resolve(root) !== path.resolve(ctx.worktree)) {
    const dirty = gitOut(root, 'status', '--porcelain', '--untracked-files=no').split('\n').filter(Boolean).map(l => l.slice(3));
    if (dirty.length) out.push(`[chord] The main checkout (${root}) has uncommitted changes, which blocks everyone's finish(): ${dirty.slice(0, 10).join(', ')}. If your command did this, undo it there; the main branch is only ever changed through finish().`);
  }
  return out;
}

/** handleHook, but never lets an exception reach the tool: a broken hook must not fail open on a write. */
export function safeHandle(ctx: Ctx, tool: Tool, event: Event, payload: Record<string, any>): HookOut {
  try {
    return handleHook(ctx, tool, event, payload);
  } catch (e) {
    const msg = (e as Error).message;
    db.log(`hook ${event} failed: ${msg}`);
    if (event === 'pre-tool-use' && filesTouched(tool, payload).length) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `chord could not check this write (${msg}); try again or report it to the user` } };
    }
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
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8'); // decode once: a multi-byte character may straddle chunks
  let payload: Record<string, any> = {};
  try { payload = JSON.parse(raw); } catch { /* no payload */ }
  // the workspace is fixed per agent; the tool's own cwd moves when the agent runs `cd`, so it is not used as the base
  const cwd = process.env.CHORD_WORKSPACE ?? (typeof payload.cwd === 'string' ? payload.cwd : process.cwd());
  let ctx: Ctx;
  try {
    ctx = { db: db.openDb(file), agent, cwd, worktree: process.env.CHORD_WORKTREE ?? cwd, project: process.env.CHORD_PROJECT };
  } catch (e) {
    // the database would not open: a write must still not go through unchecked
    const msg = (e as Error).message;
    process.stderr.write(`chord hook: cannot open ${file}: ${msg}\n`);
    if (event === 'pre-tool-use' && filesTouched(tool, payload).length) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `chord could not check this write (${msg}); try again or report it to the user` } }));
    }
    return;
  }
  const out = safeHandle(ctx, tool, event, payload);
  db.log(`hook ${event} (${tool}, tool_name=${payload.tool_name ?? '-'}): ${out === undefined ? 'no output' : `${typeof out === 'string' ? 'text' : 'json'} ${JSON.stringify(out).length} chars`} in ${Date.now() - started}ms`);
  if (out !== undefined) process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out));
}

const isMain = (() => { try { return fs.realpathSync.native(process.argv[1] ?? '') === fs.realpathSync.native(fileURLToPath(new URL(import.meta.url))); } catch { return false; } })();
if (isMain) main();
