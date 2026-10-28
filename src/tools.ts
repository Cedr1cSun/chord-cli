import type { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db.ts';
import type { Tool } from './mcp.ts';

/** cwd is the agent's workspace W (claims are relative to it); worktree is the repository checkout inside it; project,
 *  when known, is the project folder that holds the main checkout and every agent's workspace, and is the tool's real cwd. */
export interface Ctx { db: DatabaseSync; agent: string; cwd: string; worktree: string; project?: string }

/** path.relative, except that on macOS directory names differing only in case match, as path.relative already has them
 *  on Windows: both file systems ignore case, so /P/Repo is /P/repo, and a write must not slip past a check that way. */
function relativePath(from: string, to: string): string {
  if (process.platform !== 'darwin') return path.relative(from, to);
  const a = path.resolve(from).split('/').filter(Boolean), b = path.resolve(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

/** Is `file` inside `dir`? False for paths on another drive or above it. */
export function insideDir(dir: string, file: string): boolean {
  const rel = relativePath(dir, path.resolve(dir, file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The claim key for a path an agent names: workspace-relative with forward slashes. Absolute paths are taken as
 * given; a path from the project folder (chord/agents/<name>/<repo>/...) is resolved there; any other relative
 * path is repository-relative (what agents working on the repository naturally write). Paths outside the
 * workspace are refused: chord cannot coordinate them.
 */
export function claimPath(ctx: Ctx, file: string): string {
  const asGiven = normFile(ctx, file);
  let abs: string;
  const fromProject = 'chord/agents/'; // the spelling from the tool's cwd, the project folder; another agent's folder then fails the check below
  if (path.isAbsolute(file) || /^\.\.(\/|$)/.test(asGiven)) abs = path.resolve(ctx.cwd, file);
  else if (ctx.project && asGiven.startsWith(fromProject)) abs = path.resolve(ctx.project, file);
  else {
    abs = path.resolve(ctx.worktree, file);
    // From the project folder "<repo>/x" is the main checkout's x. An agent naming its own copy that way, where the
    // repository has no such path but x exists at its root, is told the spellings that reach it rather than given a
    // claim on a file that is not there.
    const repoName = path.basename(ctx.worktree), inner = asGiven.slice(repoName.length + 1);
    if (asGiven.startsWith(`${repoName}/`) && !fs.existsSync(abs) && fs.existsSync(path.resolve(ctx.worktree, inner))) {
      throw new Error(`there is no ${asGiven} in the repository, but it has ${inner}: name files relative to the repository root ("${inner}") or from the project folder ("chord/agents/<you>/${repoName}/${inner}")`);
    }
  }
  if (!insideDir(ctx.cwd, abs)) throw new Error(`${file} is outside your workspace; chord only coordinates files under ${ctx.cwd}`);
  return normFile(ctx, abs);
}

/** How long a latecomer waits for replies before it may write anyway. */
export const REPLY_TIMEOUT_MS = 10 * 60 * 1000;
/** How long before its claim a latecomer's message to an occupant still counts as asking about that file. */
const ASK_WINDOW_MS = 2 * 60 * 1000;

const str = (desc: string) => ({ type: 'string', description: desc });

function req(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${key} is required`);
  return v;
}

/** Workspace-relative path with forward slashes (repo/src/x.ts), so the same file matches across agents' worktrees. */
export function normFile(ctx: Ctx, file: string): string {
  return relativePath(ctx.cwd, path.resolve(ctx.cwd, file)).split(path.sep).join('/');
}

export function peers(ctx: Ctx) {
  return db.listAgents(ctx.db).filter(a => a.name !== ctx.agent).map(a => ({
    name: a.name, tool: a.tool, status: a.status, cwd: a.cwd, task: a.task, scope: a.scope,
  }));
}

// words that describe code rather than name it: "the parse function" and "parse tests" share only "parse"
const NOT_SYMBOLS = new Set(['a', 'an', 'and', 'or', 'the', 'of', 'in', 'to', 'for', 'with', 'new', 'its', 'all', 'function', 'functions', 'method', 'methods', 'class', 'classes', 'test', 'tests', 'block', 'blocks', 'section', 'line', 'lines', 'file', 'helper', 'helpers', 'code', 'logic', 'docs', 'docstring']);
// "Parser.parse" names Parser and parse too: whoever holds either holds part of it
const symbolSet = (s: string | null) => new Set((s ?? '').toLowerCase().match(/[a-z_$][\w$.]*/g)?.flatMap(w => [w, ...w.split('.')]).filter(w => w && !NOT_SYMBOLS.has(w)) ?? []);

/** Two modify claims on one file that each name the functions or blocks they touch, with none in common, do not
 *  need to talk first. Anything less certain (no symbols on either side, or an add, delete or rename) does. */
function disjointEdits(a: db.Claim, b: db.Claim): boolean {
  if (a.kind !== 'modify' || b.kind !== 'modify') return false;
  const x = symbolSet(a.symbols), y = symbolSet(b.symbols);
  return x.size > 0 && y.size > 0 && ![...x].some(w => y.has(w));
}

/** Online agents who claimed `file` before `mine` did, split into those `mine` overlaps and must talk to and those
 *  editing other parts of it. */
function earlierOccupants(ctx: Ctx, mine: db.Claim): { overlap: db.Claim[]; elsewhere: db.Claim[] } {
  // by rowid, which the insert gets under the write lock, not by the timestamp read before waiting for it: two
  // agents claiming at once would otherwise each see the other as later and neither would talk first
  const before = (c: db.Claim) => c.rid < mine.rid;
  const all = db.claimsFor(ctx.db, mine.file).filter(c => c.agent !== ctx.agent && before(c) && db.getAgent(ctx.db, c.agent)?.status !== 'offline');
  return { overlap: all.filter(c => !disjointEdits(c, mine)), elsewhere: all.filter(c => disjointEdits(c, mine)) };
}

type WriteCheck = { ok: true } | { ok: false; reason: string };

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
  const others = earlierOccupants(ctx, mine).overlap;
  if (!others.length) return { ok: true };
  const myStart = db.getAgent(ctx.db, ctx.agent)?.started_at ?? mine.created_at;
  const notAsked: string[] = [];
  const waiting: { agent: string; left: number }[] = [];
  for (const o of others) {
    // Only what both current sessions have said to each other counts: a relaunched peer starts afresh. And the
    // question must belong to this claim: a message sent long before it, about something else, is not notice of
    // the change; two minutes before the claim allows for saying hello first. The reply may be older (a peer who
    // explained its scope in advance has answered already).
    const since = Math.max(myStart, db.getAgent(ctx.db, o.agent)?.started_at ?? 0);
    const askedAt = db.firstMessageAt(ctx.db, ctx.agent, o.agent, Math.max(since, mine.created_at - ASK_WINDOW_MS));
    if (askedAt === null) notAsked.push(o.agent);
    else if (db.firstMessageAt(ctx.db, o.agent, ctx.agent, since) === null && now - askedAt < REPLY_TIMEOUT_MS) waiting.push({ agent: o.agent, left: REPLY_TIMEOUT_MS - (now - askedAt) });
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

const { git } = db;
const gitOk = (cwd: string, ...args: string[]) => { try { git(cwd, ...args); return true; } catch { return false; } };

const stderrOf = (e: unknown) => ((e as { stderr?: string }).stderr ?? (e as Error).message).trim();
const { sleepSync } = db;

/** Tracked files with real changes, staged or not, ignoring line-ending differences and whatever happens inside
 *  submodules; '' when clean. */
export function dirtyTracked(cwd: string): string {
  const unstaged = git(cwd, 'diff', '--name-only', '--ignore-cr-at-eol', '--ignore-submodules=dirty');
  const staged = git(cwd, 'diff', '--cached', '--name-only', '--ignore-cr-at-eol', '--ignore-submodules=dirty');
  return [...new Set([...unstaged.split('\n'), ...staged.split('\n')].filter(Boolean))].join('\n');
}

/** git, retried for up to five seconds when another process (an IDE polling git status, say) holds index.lock. */
function gitRetry(cwd: string, ...args: string[]): string {
  const t0 = Date.now();
  for (let wait = 50; ; wait = Math.min(wait * 2, 500)) {
    try { return git(cwd, ...args); } catch (e) {
      if (!/index\.lock.*(File exists|exists)/i.test(stderrOf(e)) || Date.now() - t0 > 5000) throw e;
      sleepSync(wait);
    }
  }
}

/** Run fn holding an exclusive lock file that names its holder's pid. Waits up to `waitMs`. A lock whose holder is
 *  gone is taken over at once; one older than `staleMs` as well, which must exceed the longest run of the project's
 *  test command (ten minutes) so a live holder is never robbed of its lock. */
export function withLock<T>(file: string, fn: () => T, waitMs = 240_000, staleMs = 15 * 60_000): T {
  const t0 = Date.now();
  for (;;) {
    try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        const holder = Number(fs.readFileSync(file, 'utf8'));
        if ((holder > 0 && !db.pidAlive(holder)) || Date.now() - fs.statSync(file).mtimeMs > staleMs) { fs.unlinkSync(file); continue; }
      } catch { continue; }
      if (Date.now() - t0 > waitMs) throw new Error(`another agent has been finishing for over ${waitMs / 1000}s; try again later`);
      sleepSync(150 + Math.random() * 200);
    }
  }
  // only our own lock is removed: one taken over meanwhile belongs to whoever holds it now
  try { return fn(); } finally { try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); } catch { /* already gone */ } }
}

/** <project>/chord/config.json. `setup` is a shell command run in every new worktree before the agent starts,
 *  for example "npm install". `test` is a shell command finish runs in the worktree after rebasing onto main and
 *  before fast-forwarding it, for example "npm test"; when it fails nothing is merged. Lives here, not in launch.ts,
 *  so the hooks (which load this module for finish's sake) do not load the launch code on every tool call. */
export function readConfig(project: { dir: string }): { setup?: string; test?: string } {
  const file = path.join(project.dir, 'chord', 'config.json');
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  let cfg: unknown;
  try { cfg = JSON.parse(raw); } catch (e) { throw new Error(`${file} is not valid JSON: ${(e as Error).message}`); }
  if (typeof cfg !== 'object' || cfg === null) throw new Error(`${file} must hold a JSON object`);
  const out: { setup?: string; test?: string } = {};
  for (const key of ['setup', 'test'] as const) {
    const v = (cfg as Record<string, unknown>)[key];
    if (v !== undefined && typeof v !== 'string') throw new Error(`${file}: "${key}" must be a string (a shell command)`);
    if (v) out[key] = v;
  }
  return out;
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
  const [marker, rebaseMerge, rebaseApply, indexLock] = git(wt, 'rev-parse', '--git-path', 'chord-finish', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply', '--git-path', 'index.lock').split('\n').map(p => path.resolve(wt, p));
  for (const dir of [rebaseMerge, rebaseApply]) {
    if (!fs.existsSync(dir)) continue;
    if (!fs.existsSync(marker)) throw new Error('a rebase is in progress in your worktree that finish did not start; run `git rebase --continue` (after resolving conflicts) or `git rebase --abort` first');
    git(wt, 'rebase', '--abort'); break;
  }
  fs.rmSync(marker, { force: true });
  // a finish killed mid-operation can leave the worktree's own index.lock behind; one older than a minute is debris
  try { if (Date.now() - fs.statSync(indexLock).mtimeMs > 60_000) { fs.unlinkSync(indexLock); db.log('finish: removed a stale index.lock in the worktree'); } } catch { /* none */ }
  // Untracked files (build output, a venv) are not in the way of a rebase and must not be forced into a commit.
  // Line-ending-only differences are ignored: a repository with CRLF files and a "* text" attribute shows every
  // such file as modified the moment it is checked out, and no agent can commit that away.
  if (dirtyTracked(wt)) throw new Error('your worktree has uncommitted changes to tracked files; commit them first');
  // Except the files this agent claimed: one it wrote and never added (git commit -a skips new files) would leave
  // main with half the change, and the claim that protected it would be released below.
  const claimed = db.claimsBy(ctx.db, ctx.agent).map(c => relativePath(wt, path.resolve(ctx.cwd, c.file)).split(path.sep).join('/')).filter(f => f && !f.startsWith('..'));
  const lost = claimed.length ? git(wt, 'ls-files', '--others', '--exclude-standard', '--', ...claimed) : '';
  if (lost) throw new Error(`you claimed ${lost.split('\n').join(', ')} but never committed it: git add and commit it (or release the claim) and call finish again. Nothing was merged.`);
  // What status still reports now differs only in line endings. git will not rebase over it, and nothing done in a
  // worktree can clear it: the repository needs a renormalised commit, which is the user's call.
  const phantom = git(wt, 'status', '--porcelain', '--untracked-files=no', '--ignore-submodules=dirty').split('\n').filter(Boolean).map(l => l.replace(/^[ MADRCU?!]{1,2}\s+/, ''));
  if (phantom.length) throw new Error(`these files differ from the index only in their line endings (a .gitattributes text rule the repository never renormalised for): ${phantom.slice(0, 10).join(', ')}. git cannot rebase over that and no worktree can clear it; ask the user to run "git add --renormalize ." and commit in the main checkout, after which worktrees made from that commit are clean. Nothing was merged.`);
  const root = db.mainRoot(wt);
  if (dirtyTracked(root)) throw new Error('the main checkout has uncommitted changes; ask the user to commit or stash them');
  const branch = git(wt, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (branch === 'HEAD') throw new Error('your worktree is not on its branch (detached HEAD); check out your chord/ branch first');
  const main = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (main === 'HEAD') throw new Error('the main checkout is not on a branch (detached HEAD); ask the user to check out a branch there');
  fs.writeFileSync(marker, `${Date.now()}\n`);
  try {
    gitRetry(wt, 'rebase', main);
    fs.rmSync(marker, { force: true });
  } catch (e) {
    // a conflict is a conflict; anything else (a pre-rebase hook saying no, a lock) is reported as what it is
    const conflicted = !!git(wt, 'diff', '--name-only', '--diff-filter=U');
    try { git(wt, 'rebase', '--abort'); } catch { /* nothing to abort */ }
    fs.rmSync(marker, { force: true });
    if (!conflicted) throw new Error(`rebase onto ${main} failed (not a conflict); nothing was merged.\n${stderrOf(e)}`);
    db.log(`finish: rebase of ${branch} onto ${main} conflicted; aborted`);
    db.addEvent(ctx.db, ctx.agent, 'conflict', null, `rebase of ${branch} onto ${main} conflicted; aborted, nothing merged`);
    throw new Error(`rebase onto ${main} failed; nothing was merged. Run \`git rebase ${main}\` in your worktree, resolve the conflicts so both changes survive, run the tests, then call finish again; ask the user only if you cannot resolve them.\n${stderrOf(e)}`);
  }
  // The project's tests, on the branch as it now sits on top of main: a clean rebase can still break what another
  // agent merged. ponytail: they run inside the finish lock, so other agents' finish waits for them (withLock gives
  // up after 240 s); run them before taking the lock and re-check main if test suites get long.
  const test = ctx.project ? readConfig({ dir: ctx.project }).test : undefined;
  if (test) {
    db.log(`finish: running the test command in ${wt}: ${test}`);
    try { execSync(test, { cwd: wt, stdio: 'pipe', timeout: 600_000, maxBuffer: 64 << 20 }); } catch (e) {
      const x = e as { stdout?: Buffer; stderr?: Buffer; status?: number | null };
      const out = `${x.stdout ?? ''}${x.stderr ?? ''}`.trimEnd().split('\n').slice(-40).join('\n');
      db.log(`finish: the test command failed${x.status != null ? ` with exit code ${x.status}` : ''}; nothing merged`);
      throw new Error(`your branch is now rebased onto ${main}, but the project's test command failed there, so nothing was merged: ${test}\n${out}\nFix it (another agent's merged work may be what broke), commit, and call finish again.`);
    }
  }
  const subjects = git(root, 'log', '--format=%s', `${main}..${branch}`).split('\n').filter(Boolean);
  // A submodule commit the branch points at must exist in the main checkout's copy of the submodule, or the
  // fast-forward leaves main pointing at a commit that is nowhere but inside this agent's worktree.
  for (const line of git(root, '-c', 'core.quotePath=false', 'diff', '--raw', main, branch).split('\n')) { // a non-ASCII path arrives as itself, not quoted and escaped
    const m = /^:\d{6} 160000 [0-9a-f]+ ([0-9a-f]+) [AM]\t(.+)$/.exec(line);
    if (!m) continue;
    const [, sha, sub] = m;
    if (!gitOk(path.join(root, sub), 'cat-file', '-e', `${sha}^{commit}`)) throw new Error(`${sub} is a submodule and your branch points it at commit ${sha.slice(0, 7)}, which the main checkout's submodule does not have; push that commit to the submodule's remote (and fetch it in ${path.join(root, sub)}) before finishing. Nothing was merged.`);
  }
  if (!subjects.length) {
    db.log(`finish: ${branch} has nothing beyond ${main}; claims released, nothing merged`);
    db.releaseAll(ctx.db, ctx.agent, 'finish');
    return { merged: [] as string[], into: main, notified: [] as string[], note: 'your branch has no commits beyond main; nothing to merge' };
  }
  // Files the branch adds must not already sit untracked in the main checkout: the fast-forward would stop half-way,
  // leaving some of them written and every later finish of this agent failing on them.
  const added = git(root, 'diff', '--name-only', '-z', '--diff-filter=A', main, branch).split('\0').filter(Boolean);
  const blocking = added.filter(f => fs.existsSync(path.join(root, f)));
  if (blocking.length) throw new Error(`cannot fast-forward ${main}: these files exist in the main checkout (${root}) but are not tracked there: ${blocking.join(', ')}. Ask the user to move or delete them; nothing was merged.`);
  try {
    gitRetry(root, 'merge', '--ff-only', branch);
  } catch (e) {
    // a noisy post-merge hook can make git exit non-zero after the merge went through
    if (!gitOk(root, 'merge-base', '--is-ancestor', branch, main)) {
      // undo what a half-done fast-forward wrote: files of ours that now sit untracked in the main checkout
      for (const f of added) {
        const p = path.join(root, f);
        if (fs.existsSync(p) && !gitOk(root, 'ls-files', '--error-unmatch', f) && git(root, 'hash-object', p) === git(root, 'rev-parse', `${branch}:${f}`)) fs.rmSync(p);
      }
      db.addEvent(ctx.db, ctx.agent, 'merge-failed', null, `fast-forward of ${main} to ${branch} failed: ${stderrOf(e).split('\n')[0]}`);
      throw new Error(`fast-forward of ${main} failed; your branch is rebased and intact, the main checkout was left as it was. ${stderrOf(e)}`);
    }
    db.log(`finish: merge reported an error but ${branch} is on ${main}; carrying on: ${stderrOf(e).split('\n')[0]}`);
  }
  db.log(`finish: merged ${branch} into ${main} (${subjects.length} commit(s))`);
  db.addEvent(ctx.db, ctx.agent, 'merge', null, `${subjects.length} commit(s) into ${main}: ${subjects.join('; ')}`);
  db.releaseAll(ctx.db, ctx.agent, 'finish');
  const online = db.listAgents(ctx.db).filter(a => a.name !== ctx.agent && a.status !== 'offline').map(a => a.name);
  if (online.length) db.send(ctx.db, ctx.agent, online, `${ctx.agent} merged into ${main}:\n${subjects.map(s => `- ${s}`).join('\n')}\n${db.NOTICE_TAIL}`, 'notice');
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
          file: str('The file, as a path from your working directory (chord/agents/<you>/<repo>/src/x.ts) or relative to the repository root (src/x.ts)'),
          intent: str('One sentence: what you will change and why'),
          kind: { type: 'string', enum: ['add', 'modify', 'delete', 'rename'] },
          symbols: str('Optional: the functions or blocks you will touch, comma-separated. When you and an earlier holder of the file both name them and none are shared, you need not talk first.'),
        },
        required: ['file', 'intent', 'kind'],
      },
      handler: a => {
        const file = claimPath(ctx, req(a, 'file'));
        const kind = req(a, 'kind');
        if (!['add', 'modify', 'delete', 'rename'].includes(kind)) throw new Error('kind must be add, modify, delete or rename');
        db.addClaim(ctx.db, { agent: ctx.agent, file, intent: req(a, 'intent'), kind, symbols: typeof a.symbols === 'string' ? a.symbols : null });
        const mine = db.claimsFor(ctx.db, file).find(c => c.agent === ctx.agent)!;
        const { overlap: others, elsewhere } = earlierOccupants(ctx, mine);
        const brief = (o: db.Claim) => ({ agent: o.agent, intent: o.intent, kind: o.kind, symbols: o.symbols });
        return {
          claimed: file,
          must_talk_to: others.map(brief),
          ...(elsewhere.length ? { also_editing: elsewhere.map(brief) } : {}),
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
      description: 'Your work is committed on your branch: rebase it onto main, fast-forward main, release all your claims and tell the other agents. On a rebase conflict nothing is changed; rebase onto main yourself, resolve it, then call finish again.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => finish(ctx),
    },
  ];
  // every call sweeps dead agents first
  return list.map(t => ({ ...t, handler: a => { db.sweep(ctx.db); return t.handler(a); } }));
}
