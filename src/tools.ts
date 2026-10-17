import type { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db.ts';
import type { Tool } from './mcp.ts';

/** cwd is the agent's workspace (claims are relative to it); worktree is the repository checkout inside it;
 *  project, when known, is the project folder that holds the main checkout and every agent's workspace. */
export interface Ctx { db: DatabaseSync; agent: string; cwd: string; worktree: string; project?: string }

/** Is `file` inside `dir`? False for paths on another drive or above it. */
export function insideDir(dir: string, file: string): boolean {
  const rel = path.relative(dir, path.resolve(dir, file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The claim key for a path an agent names: workspace-relative with forward slashes. Absolute paths and
 * paths starting with the repository directory are taken as given; any other relative path is read as
 * repository-relative (what the schema used to say, and what agents working inside the repo naturally
 * write). Paths outside the workspace are refused: chord cannot coordinate them.
 */
export function claimPath(ctx: Ctx, file: string): string {
  const repoDir = path.relative(ctx.cwd, ctx.worktree).split(path.sep).join('/');
  const asGiven = normFile(ctx, file);
  const abs = path.isAbsolute(file) || !repoDir || repoDir === '.' || asGiven === repoDir || asGiven.startsWith(repoDir + '/') || /^\.\.(\/|$)/.test(asGiven)
    ? path.resolve(ctx.cwd, file)
    : path.resolve(ctx.worktree, file);
  if (!insideDir(ctx.cwd, abs)) throw new Error(`${file} is outside your workspace; chord only coordinates files under ${ctx.cwd}`);
  return normFile(ctx, abs);
}

/** How long a latecomer waits for replies before it may write anyway. */
export const REPLY_TIMEOUT_MS = 10 * 60 * 1000;

const str = (desc: string) => ({ type: 'string', description: desc });

function req(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${key} is required`);
  return v;
}

/** Worktree-relative path with forward slashes, so the same file matches across worktrees. */
export function normFile(ctx: Ctx, file: string): string {
  return path.relative(ctx.cwd, path.resolve(ctx.cwd, file)).split(path.sep).join('/');
}

export function peers(ctx: Ctx) {
  return db.listAgents(ctx.db).filter(a => a.name !== ctx.agent).map(a => ({
    name: a.name, tool: a.tool, status: a.status, cwd: a.cwd, task: a.task, scope: a.scope,
  }));
}

/** Online agents who claimed `file` before `mine` did. */
function earlierOccupants(ctx: Ctx, mine: db.Claim): db.Claim[] {
  const before = (c: db.Claim) => c.created_at < mine.created_at || (c.created_at === mine.created_at && c.rid < mine.rid);
  return db.claimsFor(ctx.db, mine.file).filter(c => c.agent !== ctx.agent && before(c) && db.getAgent(ctx.db, c.agent)?.status !== 'offline');
}

export type WriteCheck = { ok: true } | { ok: false; reason: string };

/**
 * May `ctx.agent` write `file` now? It must hold a claim, and if others claimed the file first it must
 * have told each of them what it will do and heard back. An occupant who does not answer within
 * REPLY_TIMEOUT_MS of being told is taken as having no objection. Any exchange since this agent's session
 * started counts, so a peer who explained their scope before we even claimed is not asked again.
 */
export function canWrite(ctx: Ctx, file: string, now = Date.now()): WriteCheck {
  const rel = normFile(ctx, file);
  const mine = db.claimsFor(ctx.db, rel).find(c => c.agent === ctx.agent);
  if (!mine) return { ok: false, reason: `${rel} is not claimed by you. Call claim(file, intent, kind) first.` };
  const others = earlierOccupants(ctx, mine);
  if (!others.length) return { ok: true };
  const myStart = db.getAgent(ctx.db, ctx.agent)?.started_at ?? mine.created_at;
  const notAsked: string[] = [];
  const waiting: { agent: string; left: number }[] = [];
  for (const o of others) {
    // only what both current sessions have said to each other counts: a relaunched peer starts afresh
    const since = Math.max(myStart, db.getAgent(ctx.db, o.agent)?.started_at ?? 0);
    const askedAt = db.firstMessageAt(ctx.db, ctx.agent, o.agent, since);
    if (askedAt === null) notAsked.push(o.agent);
    else if (!db.repliedSince(ctx.db, o.agent, ctx.agent, since) && now - askedAt < REPLY_TIMEOUT_MS) waiting.push({ agent: o.agent, left: REPLY_TIMEOUT_MS - (now - askedAt) });
  }
  if (notAsked.length) {
    return { ok: false, reason: `${rel} is also claimed by ${notAsked.join(', ')}. Read their claim (claim tool output) and send each of them a message explaining what you intend to change before writing.` };
  }
  if (waiting.length) {
    const left = Math.ceil(Math.max(...waiting.map(w => w.left)) / 60000);
    return { ok: false, reason: `waiting for a reply from ${waiting.map(w => w.agent).join(', ')} about ${rel} (you may write without one in ${left} min). Work on something else meanwhile.` };
  }
  return { ok: true };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: db.gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const stderrOf = (e: unknown) => ((e as { stderr?: string }).stderr ?? (e as Error).message).trim();
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run fn holding an exclusive lock file. Waits up to `waitMs`; a lock older than `staleMs` is taken over. */
export function withLock<T>(file: string, fn: () => T, waitMs = 240_000, staleMs = 180_000): T {
  const t0 = Date.now();
  for (;;) {
    try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(file).mtimeMs > staleMs) { fs.unlinkSync(file); continue; } } catch { continue; }
      if (Date.now() - t0 > waitMs) throw new Error(`another agent has been finishing for over ${waitMs / 1000}s; try again later`);
      sleepSync(150 + Math.random() * 200);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(file); } catch { /* already gone */ } }
}

/** Rebase the agent's branch onto main and fast-forward main to it. Atomic from the agent's point of view.
 *  Finishes are serialised with a lock file: git cannot run two merges in one checkout concurrently. */
export function finish(ctx: Ctx) {
  const t0 = Date.now();
  return withLock(db.finishLockPath(), () => { db.log(`finish: lock acquired after ${Date.now() - t0}ms`); return finishLocked(ctx); });
}

function finishLocked(ctx: Ctx) {
  const wt = ctx.worktree;
  // A rebase in progress is only ours to clean up when finish itself started it (a finish killed mid-rebase leaves
  // the marker behind). Anyone else's rebase, perhaps with conflicts already resolved, is left alone.
  const marker = path.resolve(wt, git(wt, 'rev-parse', '--git-path', 'chord-finish'));
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    if (!fs.existsSync(path.resolve(wt, git(wt, 'rev-parse', '--git-path', dir)))) continue;
    if (!fs.existsSync(marker)) throw new Error('a rebase is in progress in your worktree that finish did not start; run `git rebase --continue` (after resolving conflicts) or `git rebase --abort` first');
    git(wt, 'rebase', '--abort'); break;
  }
  fs.rmSync(marker, { force: true });
  if (git(wt, 'status', '--porcelain')) throw new Error('your worktree has uncommitted changes; commit them first');
  const root = db.mainRoot(wt);
  if (git(root, 'status', '--porcelain', '--untracked-files=no')) throw new Error('the main checkout has uncommitted changes; ask the user to commit or stash them');
  const branch = git(wt, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (branch === 'HEAD') throw new Error('your worktree is not on its branch (detached HEAD); check out your chord/ branch first');
  const main = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (main === 'HEAD') throw new Error('the main checkout is not on a branch (detached HEAD); ask the user to check out a branch there');
  fs.writeFileSync(marker, `${Date.now()}\n`);
  try {
    git(wt, 'rebase', main);
    fs.rmSync(marker, { force: true });
  } catch (e) {
    try { git(wt, 'rebase', '--abort'); } catch { /* nothing to abort */ }
    fs.rmSync(marker, { force: true });
    db.log(`finish: rebase of ${branch} onto ${main} conflicted; aborted`);
    db.addEvent(ctx.db, ctx.agent, 'conflict', null, `rebase of ${branch} onto ${main} conflicted; aborted, nothing merged`);
    throw new Error(`rebase onto ${main} failed; nothing was merged. Ask the user how to resolve it.\n${stderrOf(e)}`);
  }
  const subjects = git(root, 'log', '--format=%s', `${main}..${branch}`).split('\n').filter(Boolean);
  if (!subjects.length) {
    db.log(`finish: ${branch} has nothing beyond ${main}; claims released, nothing merged`);
    db.releaseAll(ctx.db, ctx.agent, 'finish');
    return { merged: [] as string[], into: main, notified: [] as string[], note: 'your branch has no commits beyond main; nothing to merge' };
  }
  git(root, 'merge', '--ff-only', branch);
  db.log(`finish: merged ${branch} into ${main} (${subjects.length} commit(s))`);
  db.addEvent(ctx.db, ctx.agent, 'merge', null, `${subjects.length} commit(s) into ${main}: ${subjects.join('; ')}`);
  db.releaseAll(ctx.db, ctx.agent, 'finish');
  const online = db.listAgents(ctx.db).filter(a => a.name !== ctx.agent && a.status !== 'offline').map(a => a.name);
  if (online.length) db.send(ctx.db, ctx.agent, online, `${ctx.agent} merged into ${main}:\n${subjects.map(s => `- ${s}`).join('\n')}\nRebase your branch when convenient. This is a notification; do not reply.`, 'notice');
  return { merged: subjects, into: main, notified: online };
}

export function tools(ctx: Ctx): Tool[] {
  const list: Tool[] = [
    {
      name: 'register',
      description: 'Declare who you are and what you are working on. Call this once, first thing in the session.',
      inputSchema: {
        type: 'object',
        properties: { task: str('One sentence: what you are doing'), scope: str('Directory or glob you expect to touch (for others to read, not an authorisation)') },
        required: ['task'],
      },
      handler: a => {
        db.setTask(ctx.db, ctx.agent, req(a, 'task'), typeof a.scope === 'string' ? a.scope : null);
        return { registered: ctx.agent, peers: peers(ctx) };
      },
    },
    {
      name: 'list_agents',
      description: 'List the other agents working in this repository, with their task and status.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => peers(ctx),
    },
    {
      name: 'claim',
      description: 'Declare a file you are about to create or change. Required before any write to it. If others already hold the file you must message each of them and hear back before writing.',
      inputSchema: {
        type: 'object',
        properties: {
          file: str('The file, as a path from your working directory (e.g. <repo>/src/x.ts) or relative to the repository root (src/x.ts)'),
          intent: str('One sentence: what you will change and why'),
          kind: { type: 'string', enum: ['add', 'modify', 'delete', 'rename'] },
          symbols: str('Optional: functions or blocks you will touch'),
        },
        required: ['file', 'intent', 'kind'],
      },
      handler: a => {
        const file = claimPath(ctx, req(a, 'file'));
        const kind = req(a, 'kind');
        if (!['add', 'modify', 'delete', 'rename'].includes(kind)) throw new Error('kind must be add, modify, delete or rename');
        db.addClaim(ctx.db, { agent: ctx.agent, file, intent: req(a, 'intent'), kind, symbols: typeof a.symbols === 'string' ? a.symbols : null });
        const mine = db.claimsFor(ctx.db, file).find(c => c.agent === ctx.agent)!;
        const others = earlierOccupants(ctx, mine);
        db.log(`claim ${file} by ${ctx.agent} (cwd ${ctx.cwd}): rows=${JSON.stringify(db.claimsFor(ctx.db, file).map(c => [c.agent, c.created_at]))} agents=${JSON.stringify(db.listAgents(ctx.db).map(a => [a.name, a.status, a.pid]))} others=${others.map(o => o.agent)}`);
        return {
          claimed: file,
          must_talk_to: others.map(o => ({ agent: o.agent, intent: o.intent, kind: o.kind, symbols: o.symbols })),
          ...(others.length ? { next: 'Send each agent above a message describing your change. You may write once each has replied, or after 10 minutes.' } : {}),
        };
      },
    },
    {
      name: 'release',
      description: 'Drop your claim on a file you no longer intend to change.',
      inputSchema: { type: 'object', properties: { file: str('The file, as given to claim()') }, required: ['file'] },
      handler: a => { const file = claimPath(ctx, req(a, 'file')); db.removeClaim(ctx.db, ctx.agent, file); return { released: file }; },
    },
    {
      name: 'send',
      description: 'Send a message to one or more agents by name. Delivery is asynchronous; do not wait for a reply.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { description: 'Agent name, or array of names', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          message: str('The message'),
        },
        required: ['to', 'message'],
      },
      handler: a => {
        const to = Array.isArray(a.to) ? a.to.map(String) : [req(a, 'to')];
        const unknown = to.filter(n => !db.getAgent(ctx.db, n));
        if (unknown.length) throw new Error(`unknown agent(s): ${unknown.join(', ')}`);
        const offline = to.filter(n => db.getAgent(ctx.db, n)!.status === 'offline');
        if (offline.length) throw new Error(`${offline.join(', ')} is offline; nobody would read the message`);
        db.send(ctx.db, ctx.agent, to, req(a, 'message'));
        return { sent_to: to };
      },
    },
    {
      name: 'inbox',
      description: 'Read and clear your unread messages.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => db.takeUnread(ctx.db, ctx.agent).map(m => ({ from: m.sender, at: new Date(m.created_at).toISOString(), message: m.body })),
    },
    {
      name: 'finish',
      description: 'Your work is committed on your branch: rebase it onto main, fast-forward main, release all your claims and tell the other agents. On a rebase conflict nothing is changed; stop and ask the user.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => finish(ctx),
    },
  ];
  // every call sweeps dead agents first
  return list.map(t => ({ ...t, handler: a => { db.sweep(ctx.db); return t.handler(a); } }));
}
