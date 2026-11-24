// Hook entry point for Claude Code, Codex, OpenCode and pi: `node hooks.ts <event>`, payload on stdin.
// Event names are chord's own; launch.ts maps each tool's hook config onto them (OpenCode's through the plugin in
// opencode/plugin/index.ts and pi's through the extension in pi/extensions/chord.ts, which call this with the same
// payload shape).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.ts';
import { patchFiles } from './patch.ts';
import { canWrite, dirtyTracked, insideDir, normFile, type Ctx } from './tools.ts';

export type Event = 'session-start' | 'user-prompt-submit' | 'pre-tool-use' | 'post-tool-use' | 'stop' | 'session-end' | 'notification';
export type Tool = 'claude' | 'codex' | 'opencode' | 'pi';

/** What the hook prints: a JSON object, or nothing for `undefined`. */
type HookOut = object | undefined;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// OpenCode 2 and pi: path, relative to the tool's cwd (the project folder) or absolute; OpenCode's patch carries a
// patch like Codex's
const OPENCODE_EDIT_TOOLS = new Set(['edit', 'write']);
const PI_EDIT_TOOLS = OPENCODE_EDIT_TOOLS;
/** The path as pi's own normalizePath reads it (pi 1.6 utils/paths.js): a leading @ dropped, Git Bash's /c/..., /mnt/c/...
 *  and /cygdrive/c/... as C:\... on Windows, ~ and file:// expanded. Checked as given, they would land outside the project. */
const piPath = (p: string): string => {
  p = p.startsWith('@') ? p.slice(1) : p;
  if (process.platform === 'win32' && !p.includes('\\')) p = p.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i, (_, d: string, r = '') => `${d.toUpperCase()}:\\${r.replaceAll('/', '\\')}`);
  if (p === '~' || p.startsWith('~/') || (process.platform === 'win32' && p.startsWith('~\\'))) return path.join(os.homedir(), p.slice(2));
  return p.startsWith('file://') ? fileURLToPath(p) : p;
};

export function filesTouched(tool: Tool, payload: Record<string, any>): string[] {
  const name = String(payload.tool_name ?? '');
  const input = payload.tool_input ?? {};
  if (tool === 'claude' && EDIT_TOOLS.has(name)) {
    const p = input.file_path ?? input.notebook_path;
    return typeof p === 'string' ? [p] : [];
  }
  if (tool === 'opencode' && OPENCODE_EDIT_TOOLS.has(name)) return typeof input.path === 'string' ? [input.path] : [];
  if (tool === 'pi') return PI_EDIT_TOOLS.has(name) && typeof input.path === 'string' ? [piPath(input.path)] : [];
  if (tool === 'codex' || tool === 'opencode') {
    // the patch has been seen under "command"; "patchText", "input", "patch" and a bare string cost nothing to accept as well
    const text = typeof input === 'string' ? input : [input.command, input.patchText, input.input, input.patch].find(v => typeof v === 'string');
    if (name === (tool === 'codex' ? 'apply_patch' : 'patch') && typeof text === 'string') return patchFiles(text);
    if (isShell(name) && typeof text === 'string' && text.includes('*** Begin Patch')) return patchFiles(text); // apply_patch run from the shell
  }
  return [];
}

/** Tools that write files and must therefore name them: a call that names none is refused rather than let through. */
const isEditTool = (tool: Tool, name: unknown) => (tool === 'claude' ? EDIT_TOOLS.has(String(name)) : tool === 'pi' ? PI_EDIT_TOOLS.has(String(name)) : tool === 'opencode' ? OPENCODE_EDIT_TOOLS.has(String(name)) || name === 'patch' : name === 'apply_patch');

const isShell = (name: unknown) => /^(bash|powershell|shell|exec|exec_command|local_shell)$/i.test(String(name ?? ''));

const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5); // local time

function formatMessages(ms: db.Message[]): string {
  return ms.map(m => `[chord] message from ${m.sender} at ${hhmm(m.created_at)}:\n${m.body}`).join('\n\n');
}

const MAX_CLAIM_LINES = 60;
const MAX_WARNED_FILES = 20;
const MAX_INSTRUCTION_CHARS = 8000;
const CLAUDE_BRIEFING_CHARS = 9500; // under Claude Code's 10,000-character cap on additionalContext

/** The agent's worktree as a path from its cwd, the project folder: chord/agents/<name>/<repoName>. */
const repoDirOf = (ctx: Ctx) => path.relative(ctx.project ?? ctx.cwd, ctx.worktree).split(path.sep).join('/') || '.';

/** The same file in the agent's own worktree, for a path that hit the main checkout or another agent's worktree:
 *  both are named after the repository, so what follows that directory is the file. */
function ownCopy(ctx: Ctx, abs: string, tool: Tool): string {
  const parts = path.relative(ctx.project ?? ctx.cwd, abs).split(path.sep), repoName = path.basename(ctx.worktree);
  // P/<repoName>/... is the main checkout; P/chord/agents/<other>/<repoName>/... another agent's worktree
  const tail = parts[0] === repoName ? parts.slice(1) : parts[0] === 'chord' && parts[1] === 'agents' && parts[3] === repoName ? parts.slice(4) : [];
  return tool === 'codex' ? `${repoDirOf(ctx)}/${tail.join('/')}` : path.join(ctx.worktree, ...tail); // Claude's, OpenCode's and pi's editors want absolute paths
}

/** The path with links resolved, so a write through a junction or symlink is judged by where it lands. The file may
 *  not exist yet: the nearest existing ancestor is resolved and the rest appended. */
function realPath(p: string): string {
  try { return fs.realpathSync.native(p); } catch {
    const parent = path.dirname(p);
    return parent === p ? p : path.join(realPath(parent), path.basename(p));
  }
}

/** The repository's own agent instructions. The agent's cwd is the project folder, which is not a git repository, so
 *  Codex does not load the worktree's AGENTS.md and Claude only reads a nested CLAUDE.md once it opens a file there. */
function projectInstructions(ctx: Ctx, repoDir: string, budget = Infinity): string[] {
  const out: string[] = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      const text = fs.readFileSync(path.join(ctx.worktree, name), 'utf8');
      const head = `Project instructions from ${repoDir}/${name}:`, tail = `\n[... truncated, read ${repoDir}/${name} for the rest]`;
      const reserve = name === 'AGENTS.md' ? pointer(repoDir, 'CLAUDE.md').length + 2 : 0; // CLAUDE.md is named at least
      const room = Math.min(MAX_INSTRUCTION_CHARS, budget - reserve - head.length - tail.length - 3);
      // too little room for a useful excerpt: only the pointer
      const lines = room < 1000 ? ['', pointer(repoDir, name)] : ['', head, (text.length > room ? text.slice(0, room) + tail : text).trimEnd()];
      out.push(...lines); budget -= lines.join('\n').length + 1;
    } catch { /* not present */ }
  }
  return out;
}

const pointer = (repoDir: string, name: string) => `Read ${repoDir}/${name} before starting: it holds the project's instructions.`;

export function briefing(ctx: Ctx): string {
  const me = db.getAgent(ctx.db, ctx.agent);
  const peers = db.listAgents(ctx.db).filter(a => a.name !== ctx.agent && a.status !== 'offline');
  const claims = db.allClaims(ctx.db);
  const repoDir = repoDirOf(ctx), repoName = path.basename(ctx.worktree);
  const lines = [
    `You are agent "${ctx.agent}" (${me?.tool ?? 'unknown'}), one of several coding agents working on the same project. Your working directory is the project folder. Your own copy of the repository is "${repoDir}", a git worktree on your own branch: edit, build and run git only there. "${repoName}/" in the project folder is the main checkout and other agents have their copies under chord/agents/; never touch those. Name files as "${repoDir}/src/x.ts" or repository-relative "src/x.ts" (claim() accepts both). Coordination goes through the "chord" MCP tools.`,
    '',
    'Rules:',
    '1. First thing: call register(task, scope) to say what you are doing.',
    '2. Before creating or changing any file, call claim(file, intent, kind), naming in symbols the functions or blocks you will touch. Writes to unclaimed files are refused.',
    '3. If claim() lists agents under must_talk_to, read their intent and send() each of them a message saying what you will change. You may write once each has replied, or after 10 minutes. Do other work meanwhile; never wait idle.',
    '4. Do not modify files through shell commands (sed, echo >, etc.). Use the editor tools so claims are checked.',
    '5. To talk to other agents use only chord send()/inbox(); do not use any other agent-messaging feature. Messages are asynchronous.',
    '6. To learn about the project, read the agent list and claims below and ask a specific agent with send(); do not ask the user.',
    '7. When your change is complete and committed on your branch, call finish() to rebase onto main and fast-forward it, unless the user has asked you to hold off merging. If finish() reports a conflict, rebase onto main yourself, resolve it so both changes survive (ask the agent whose work you meet with send() if its intent is unclear), run the tests, commit and call finish() again; ask the user only if you cannot resolve it.',
    '8. Never merge, rebase onto, push or otherwise update the main branch yourself, and never touch the main checkout: finish() is the only way changes reach main. This holds even if the project\'s own instructions say otherwise.',
    '9. Do not use git stash: every worktree of this repository shares one stash list, so a stash pop can hand you another agent\'s changes. Make a work-in-progress commit instead.',
    '',
    peers.length ? 'Agents online:' : 'No other agents are online yet.',
    ...peers.map(a => `- ${a.name} (${a.tool}, ${a.status}): ${a.task ? (a.task.length > 200 ? a.task.slice(0, 199) + '…' : a.task) : 'not registered yet'}${a.scope ? ` [${a.scope}]` : ''}`),
    '',
    claims.length ? 'Current file claims:' : 'No files are claimed yet.',
  ];
  // Claude Code shows the model only a 2,000-character preview of a hook's additionalContext over 10,000 characters
  const budget = me?.tool === 'claude' ? CLAUDE_BRIEFING_CHARS : Infinity;
  const more = (n: number) => `- ... and ${n} more (the claim tool reports holders of any file you claim)`;
  let used = lines.join('\n').length, shown = 0;
  for (const c of claims.slice(0, MAX_CLAIM_LINES)) {
    const line = `- ${c.file} <- ${c.agent}: ${c.kind}, ${c.intent}${c.symbols ? ` (${c.symbols})` : ''}`;
    // room left for the "more" line and a pointer to each instructions file
    if (used + line.length + 1 + more(claims.length).length + 1 + 2 * (pointer(repoDir, 'AGENTS.md').length + 2) > budget) break;
    lines.push(line); used += line.length + 1; shown++;
  }
  if (claims.length > shown) { lines.push(more(claims.length - shown)); used += more(claims.length - shown).length + 1; }
  lines.push(...projectInstructions(ctx, repoDir, budget - used));
  return lines.join('\n');
}

/** Context for the model. Plain stdout also works for Claude Code and `codex exec`, but the Codex TUI
 *  only takes the JSON form, so both events use it. */
const context = (hookEventName: string, additionalContext: string) => ({ hookSpecificOutput: { hookEventName, additionalContext } });

/** Both tools put their conversation id in the payload as session_id; `chord resume` reopens that conversation. Taken on
 *  every prompt too, because Codex /new and a /resume start a new conversation without a SessionStart hook. */
const recordSession = (ctx: Ctx, payload: Record<string, any>) => { if (typeof payload.session_id === 'string' && payload.session_id) db.setSession(ctx.db, ctx.agent, payload.session_id); };

export function handleHook(ctx: Ctx, tool: Tool, event: Event, payload: Record<string, any>): HookOut {
  db.sweep(ctx.db);
  switch (event) {
    case 'session-start':
      recordSession(ctx, payload);
      // The agent now waits for its first prompt: idle, so messages that arrive before the user types still wake it.
      // Claude Code also fires this after compacting a long conversation, in the middle of a turn: not idle then.
      if (payload.source !== 'compact') db.setStatus(ctx.db, ctx.agent, 'idle');
      return context('SessionStart', briefing(ctx));

    case 'user-prompt-submit': {
      recordSession(ctx, payload);
      db.setStatus(ctx.db, ctx.agent, 'busy');
      const ms = db.takeUnread(ctx.db, ctx.agent);
      // One line of identity on every prompt: a conversation that started without the briefing (Codex /new fires no
      // session hooks; a resumed conversation may predate chord) still learns what it is and what the rules are.
      const reminder = `[chord] You are agent "${ctx.agent}" in a chord project: claim a file with the chord claim tool before editing it, talk to the other agents with chord send, merge with chord finish. Your worktree is "${repoDirOf(ctx)}"; edit and run git only there.`;
      return context('UserPromptSubmit', ms.length
        ? `${formatMessages(ms)}\n\n[chord] ${ms.length} message(s) above arrived from other agents. Act on them in this turn as well as on the user's request: reply with the chord send tool where a reply is asked for.\n${reminder}`
        : reminder);
    }

    case 'pre-tool-use': {
      const files = filesTouched(tool, payload);
      if (!files.length && isEditTool(tool, payload.tool_name)) {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'chord could not tell which file this call writes, so it is refused; use the editor tool with a plain file path' } };
      }
      // Codex and OpenCode resolve a patch's relative paths against the call's workdir when it gives one, else against
      // their own cwd, the project folder (the workspace when no project is known, as in the tests)
      const base = ctx.project ?? ctx.cwd;
      const dir = tool !== 'claude' ? commandDir(tool, payload) : null;
      const workdir = dir !== null ? path.resolve(base, dir) : base;
      for (const f of files) {
        const abs = realPath(path.resolve(workdir, f));
        if (!insideDir(ctx.worktree, abs)) {
          // the main checkout and the other agents' workspaces are off limits; anything else is not ours to police
          if (ctx.project && insideDir(ctx.project, abs) && !insideDir(ctx.cwd, abs)) {
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${f} is outside your workspace (the main checkout or another agent's worktree); edit your own copy ${ownCopy(ctx, abs, tool)} instead` } };
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
      if (isShell(payload.tool_name)) parts.push(...shellWarnings(ctx, payload), ...commandWarnings(ctx, payload, tool));
      // a Claude Code subagent's tool calls fire this hook too (with its agent_id); context given to it never reaches
      // the main conversation, so the messages wait for a call of the agent's own. The same goes for a call the user
      // interrupted (is_interrupt): Claude Code discards that hook's output
      const ms = payload.agent_id || payload.is_interrupt === true ? [] : db.takeUnread(ctx.db, ctx.agent);
      if (ms.length) parts.push(`${formatMessages(ms)}\n\n[chord] ${ms.length} message(s) above arrived from other agents while you were working. Deal with them when convenient (reply with the chord send tool where a reply is asked for), then carry on with your task.`);
      // Claude Code fires PostToolUseFailure for a failed call (a shell command that exited non-zero) and drops output
      // that names another event
      return parts.length ? { hookSpecificOutput: { hookEventName: payload.hook_event_name === 'PostToolUseFailure' ? 'PostToolUseFailure' : 'PostToolUse', additionalContext: parts.join('\n\n') } } : undefined;
    }

    case 'stop': {
      // only a message is worth another turn; a notice (a merge broadcast) waits for the next hook, as it does for the wake-up
      if (!db.hasUnread(ctx.db, ctx.agent)) { db.setStatus(ctx.db, ctx.agent, 'idle'); return undefined; }
      return { decision: 'block', reason: formatMessages(db.takeUnread(ctx.db, ctx.agent)) + '\n\nHandle these messages before stopping.' };
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

/** git output, or '' when the command fails; optional locks off so this read-only look never fights the agent's own git. */
const gitOut = (cwd: string, ...args: string[]): string => {
  try { return execFileSync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8', env: db.gitEnv(), maxBuffer: 64 * 1024 * 1024 }); } catch { return ''; }
};

/** What a shell command may have done behind chord's back, according to git: edits or commits to unclaimed files,
 *  and changes to the main checkout. */
function shellWarnings(ctx: Ctx, payload: Record<string, any>): string[] {
  const out: string[] = [];
  const fold = (s: string) => process.platform === 'linux' ? s : s.toLowerCase(); // the claims table's rule (db.ts FILE_COLLATION)
  const mine = new Set(db.claimsBy(ctx.db, ctx.agent).map(c => fold(c.file)));
  // Everything the worktree differs in from where its branch left main, committed or not: a commit made from the
  // shell is no more a claim than an edit is. Tracked files by one diff against the merge base with the main
  // checkout's HEAD (real changes only, so a repository whose files differ in line endings from the moment they are
  // checked out does not make every shell command cry wolf); untracked files from status, directories folded.
  const status = gitOut(ctx.worktree, 'status', '--porcelain=v1', '-z', '-unormal');
  const untracked = status.split('\0').filter(e => e.startsWith('?? ')).map(e => e.slice(3));
  const modified = gitOut(ctx.worktree, 'diff', '--name-only', '-z', '--no-renames', '--ignore-cr-at-eol', '--merge-base', 'main-worktree/HEAD').split('\0');
  // the main checkout is <project>/<repoName>; asking git costs a subprocess on every shell command
  const root = ctx.project ? path.join(ctx.project, path.basename(ctx.worktree)) : db.mainRoot(ctx.worktree);
  const touched = [...new Set([...modified.filter(Boolean), ...untracked])];
  // a folded untracked directory counts as claimed when a claim names a file inside it
  const claimed = (f: string) => mine.has(f) || [...mine].some(m => m.startsWith(f + '/'));
  const unclaimed = touched.map(f => normFile(ctx, path.join(ctx.worktree, f))).filter(f => !claimed(fold(f)));
  const shown = unclaimed.slice(0, MAX_WARNED_FILES);
  if (unclaimed.length) out.push(`[chord] The shell command changed files you have not claimed: ${shown.join(', ')}${unclaimed.length > shown.length ? ` and ${unclaimed.length - shown.length} more` : ''}. Claim them now with claim(), or revert the change.`);
  if (path.resolve(root) !== path.resolve(ctx.worktree)) {
    // the same rule finish applies, so what finish will not mind (line endings, submodule insides) is not reported
    const dirty = (() => { try { return dirtyTracked(root).split('\n').filter(Boolean); } catch { return []; } })();
    if (dirty.length) out.push(`[chord] The main checkout (${root}) has uncommitted changes, which blocks everyone's finish(): ${dirty.slice(0, 10).join(', ')}. If your command did this, undo it there; the main branch is only ever changed through finish().`);
  }
  return out;
}

/** The directory a call ran in, when the payload says: the call's workdir, or for Codex the top-level cwd (its shell
 *  tool sends no workdir). Claude Code's cwd is its session's, the project folder, so it is not taken. */
const commandDir = (tool: Tool | undefined, payload: Record<string, any>): string | null =>
  typeof payload.tool_input?.workdir === 'string' ? payload.tool_input.workdir : tool === 'codex' && typeof payload.cwd === 'string' ? payload.cwd : null;

/** What the command's text alone gives away: it ran in or named the main checkout, or used git stash. Heuristics,
 *  so warnings, not gates; no git involved, unlike shellWarnings. */
export function commandWarnings(ctx: Ctx, payload: Record<string, any>, tool?: Tool): string[] {
  const out: string[] = [];
  const cmd = typeof payload.tool_input?.command === 'string' ? payload.tool_input.command : '';
  // From the project folder, "<repo>/" is the main checkout: a command that ran there (Codex's workdir), cd'd there or
  // named a path there did not touch the agent's own copy.
  if (ctx.project) {
    const repoName = path.basename(ctx.worktree);
    const dir = commandDir(tool, payload);
    const workdir = dir !== null ? path.resolve(ctx.project, dir) : null;
    // below the project folder, which is where Codex runs a command that names no directory, and outside the workspace
    const inMain = workdir !== null && insideDir(ctx.project, workdir) && !insideDir(workdir, ctx.project) && !insideDir(ctx.cwd, workdir);
    const words: string[] = cmd.split(/\s+/);
    const namesMain = words.some((w, i) => {
      if (/chord[\\/]agents[\\/]/.test(w)) return false;
      const stripped = w.replace(/^["'(]+/, '').replace(/^\.[\\/]/, '');
      const head = stripped.split(/[\\/]/)[0].replace(/["';&|)]+$/, '');
      return head === repoName && (/[\\/]/.test(stripped) || words[i - 1] === 'cd');
    });
    if (inMain || namesMain) out.push(`[chord] That command ran in the main checkout (${repoName}/) or named a path there; your copy is ${repoDirOf(ctx)}. Build, test and run git only there.`);
  }
  if (/\bgit\b[^|;&\n]*\bstash\b/.test(cmd)) out.push("[chord] git stash is shared by every worktree of this repository: a stash pop can hand you another agent's changes, and yours to them. Make a work-in-progress commit instead.");
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
  // the workspace is fixed per agent and comes from the launch; the tool's own cwd is the project folder, which would
  // make every claim path wrong, so it is never used as a stand-in
  const { CHORD_WORKSPACE: cwd, CHORD_WORKTREE: worktree } = process.env;
  if (!agent || !file || !tool || !cwd || !worktree) { process.stderr.write('chord hook: CHORD_AGENT_ID, CHORD_DB, CHORD_TOOL, CHORD_WORKSPACE and CHORD_WORKTREE must be set\n'); process.exit(0); }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8'); // decode once: a multi-byte character may straddle chunks
  let payload: Record<string, any> = {};
  try { payload = JSON.parse(raw); } catch { /* no payload */ }
  let ctx: Ctx;
  try {
    ctx = { db: db.openDb(file), agent, cwd, worktree, project: process.env.CHORD_PROJECT };
  } catch (e) {
    // the database would not open: a write must still not go through unchecked
    const msg = (e as Error).message;
    process.stderr.write(`chord hook: cannot open ${file}: ${msg}\n`);
    if (event === 'pre-tool-use' && filesTouched(tool, payload).length) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `chord could not check this write (${msg}); try again or report it to the user` } }));
    }
    return;
  }
  if (process.env.CHORD_DEBUG_HOOKS) db.log(`hook payload ${event}: keys=${Object.keys(payload).join(',')} agent_id=${payload.agent_id ?? '-'} agent_type=${payload.agent_type ?? '-'} source=${payload.source ?? '-'} reason=${payload.reason ?? '-'}`);
  const out = safeHandle(ctx, tool, event, payload);
  db.log(`hook ${event} (${tool}, tool_name=${payload.tool_name ?? '-'}): ${out === undefined ? 'no output' : `json ${JSON.stringify(out).length} chars`} in ${Date.now() - started}ms`);
  if (out !== undefined) process.stdout.write(JSON.stringify(out));
}

const isMain = (() => { try { return fs.realpathSync.native(process.argv[1] ?? '') === fs.realpathSync.native(fileURLToPath(new URL(import.meta.url))); } catch { return false; } })();
if (isMain) main();
