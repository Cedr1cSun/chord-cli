import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type Status = 'busy' | 'idle' | 'offline';

export interface Agent {
  name: string;
  tool: string;
  pid: number;
  cwd: string;      // the agent's working directory (its workspace W)
  worktree: string; // the repository worktree inside W, used by finish
  task: string | null;
  scope: string | null;
  status: Status;
  started_at: number;
  updated_at: number;
}

export interface Claim {
  rid: number;      // rowid: orders claims created in the same millisecond
  agent: string;
  file: string;
  intent: string;
  kind: string;
  symbols: string | null;
  created_at: number;
  asked_at: number | null;
}

export type MessageKind = 'message' | 'notice';

export interface Message {
  id: number;
  sender: string;
  recipient: string;
  kind: MessageKind; // notices (e.g. "X merged into main") never count as replies
  body: string;
  created_at: number;
  read_at: number | null;
}

/** process.env without the GIT_* variables that would make git look at some other repository. */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|NAMESPACE|CEILING_DIRECTORIES|ALTERNATE_OBJECT_DIRECTORIES)$/.test(k)) env[k] = v;
  return env;
}

const commonDir = (cwd: string) => path.resolve(cwd, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', env: gitEnv() }).trim());

/** Root of the main checkout, even when run from inside a linked worktree. */
export const mainRoot = (cwd: string) => path.dirname(commonDir(cwd));

/** chord.db lives in the project's state directory under ~/.chord; CHORD_DB carries its path to hooks and servers. */
export const dbPath = (stateDir: string) => path.join(stateDir, 'chord.db');

/** Lock file that serialises finish() across agents: git cannot run two merges in one checkout at once. */
export const finishLockPath = (dbFile = process.env.CHORD_DB ?? '') => path.join(path.dirname(dbFile), 'finish.lock');

/** Windows and macOS file systems are case-insensitive: Src/a.ts and src/a.ts are one file, so one claim key. */
const FILE_COLLATION = process.platform === 'linux' ? '' : 'collate nocase';

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`
    pragma journal_mode = wal;
    pragma busy_timeout = 5000;
    pragma foreign_keys = on;
    create table if not exists agents (
      name       text primary key,
      tool       text not null,
      pid        integer not null,
      cwd        text not null,
      worktree   text not null,
      task       text,
      scope      text,
      status     text not null default 'busy',
      started_at integer not null,
      updated_at integer not null
    );
    create table if not exists claims (
      agent    text not null references agents(name),
      file     text not null ${FILE_COLLATION},
      intent   text not null,
      kind     text not null,
      symbols    text,
      created_at integer not null,
      asked_at   integer,
      primary key (agent, file)
    );
    create table if not exists messages (
      id         integer primary key autoincrement,
      sender     text not null,
      recipient  text not null,
      kind       text not null default 'message',
      body       text not null,
      created_at integer not null,
      read_at    integer
    );
  `);
  return db;
}

// agents

export function addAgent(db: DatabaseSync, a: { name: string; tool: string; pid: number; cwd: string; worktree?: string }): void {
  const now = Date.now();
  db.prepare(
    `insert into agents (name, tool, pid, cwd, worktree, status, started_at, updated_at)
     values (?, ?, ?, ?, ?, 'busy', ?, ?)
     on conflict(name) do update set tool = excluded.tool, pid = excluded.pid, cwd = excluded.cwd, worktree = excluded.worktree,
       status = 'busy', task = null, scope = null, started_at = excluded.started_at, updated_at = excluded.updated_at`,
  ).run(a.name, a.tool, a.pid, a.cwd, a.worktree ?? a.cwd, now, now);
  // a relaunch under the same name must not inherit messages meant for the previous session
  db.prepare('delete from messages where recipient = ? and read_at is null').run(a.name);
}

export function setTask(db: DatabaseSync, name: string, task: string, scope: string | null): void {
  db.prepare('update agents set task = ?, scope = ?, updated_at = ? where name = ?').run(task, scope, Date.now(), name);
}

export function setStatus(db: DatabaseSync, name: string, status: Status): void {
  db.prepare('update agents set status = ?, updated_at = ? where name = ?').run(status, Date.now(), name);
}

export function getAgent(db: DatabaseSync, name: string): Agent | undefined {
  return db.prepare('select * from agents where name = ?').get(name) as Agent | undefined;
}

export function listAgents(db: DatabaseSync): Agent[] {
  return db.prepare('select * from agents order by started_at').all() as unknown as Agent[];
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) {
    // EPERM: the process exists but we may not open it (e.g. from inside a sandbox). Only ESRCH means gone.
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EPERM') log(`pid ${pid} judged dead: ${code}`);
    return code === 'EPERM';
  }
}

/** Append a line to chord.db.log next to the database, when CHORD_DB is known. Silent otherwise. */
export function log(line: string): void {
  if (!process.env.CHORD_DB) return;
  try { fs.appendFileSync(process.env.CHORD_DB + '.log', `${new Date().toISOString()} [${process.env.CHORD_AGENT_ID ?? '-'}/${process.pid}] ${line}
`); } catch { /* best effort */ }
}

/** Mark agents whose process is gone as offline and drop their claims. Returns the names swept. */
export function sweep(db: DatabaseSync, alive: (pid: number) => boolean = pidAlive): string[] {
  const dead = listAgents(db).filter(a => a.status !== 'offline' && !alive(a.pid)).map(a => a.name);
  for (const name of dead) {
    log(`sweep: ${name} marked offline, claims released`);
    setStatus(db, name, 'offline');
    releaseAll(db, name);
  }
  return dead;
}

// claims

export function addClaim(db: DatabaseSync, c: { agent: string; file: string; intent: string; kind: string; symbols?: string | null }): void {
  db.prepare(
    `insert into claims (agent, file, intent, kind, symbols, created_at) values (?, ?, ?, ?, ?, ?)
     on conflict(agent, file) do update set intent = excluded.intent, kind = excluded.kind, symbols = excluded.symbols`,
  ).run(c.agent, c.file, c.intent, c.kind, c.symbols ?? null, Date.now());
}

export function setAskedAt(db: DatabaseSync, agent: string, file: string, at: number): void {
  db.prepare('update claims set asked_at = ? where agent = ? and file = ?').run(at, agent, file);
}

export function removeClaim(db: DatabaseSync, agent: string, file: string): void {
  db.prepare('delete from claims where agent = ? and file = ?').run(agent, file);
}

export function releaseAll(db: DatabaseSync, agent: string): void {
  db.prepare('delete from claims where agent = ?').run(agent);
}

export function claimsFor(db: DatabaseSync, file: string): Claim[] {
  return db.prepare('select rowid as rid, * from claims where file = ?').all(file) as unknown as Claim[];
}

export function claimsBy(db: DatabaseSync, agent: string): Claim[] {
  return db.prepare('select rowid as rid, * from claims where agent = ? order by file').all(agent) as unknown as Claim[];
}

export function allClaims(db: DatabaseSync): Claim[] {
  return db.prepare('select rowid as rid, * from claims order by file, agent').all() as unknown as Claim[];
}

// messages

export function send(db: DatabaseSync, sender: string, recipients: string[], body: string, kind: MessageKind = 'message'): void {
  const now = Date.now();
  const ins = db.prepare('insert into messages (sender, recipient, kind, body, created_at) values (?, ?, ?, ?, ?)');
  for (const r of recipients) ins.run(sender, r, kind, body, now);
}

/** Roughly what a hook may attach without the tool truncating it (Codex caps additionalContext near 2500 tokens). */
export const DELIVERY_BUDGET_CHARS = 6000;

/** Unread messages for `recipient`, oldest first, marked read as they are returned. Stops after `budget`
 *  characters (always at least one message) so a flood is delivered in several rounds instead of truncated. */
export function takeUnread(db: DatabaseSync, recipient: string, budget = DELIVERY_BUDGET_CHARS): Message[] {
  const rows = db.prepare('select * from messages where recipient = ? and read_at is null order by id').all(recipient) as unknown as Message[];
  const out: Message[] = [];
  let used = 0;
  for (const m of rows) { if (out.length && used + m.body.length > budget) break; out.push(m); used += m.body.length; }
  if (out.length) {
    db.prepare(`update messages set read_at = ? where recipient = ? and read_at is null and id <= ?`).run(Date.now(), recipient, out[out.length - 1].id);
  }
  return out;
}

export function hasUnread(db: DatabaseSync, recipient: string): boolean {
  return !!db.prepare('select 1 from messages where recipient = ? and read_at is null limit 1').get(recipient);
}

/** Has `sender` sent `recipient` a real message (not a notice) at or after `since`? */
export function repliedSince(db: DatabaseSync, sender: string, recipient: string, since: number): boolean {
  return firstMessageAt(db, sender, recipient, since) !== null;
}

/** When `sender` first messaged `recipient` at or after `since`; null if never. Notices do not count. */
export function firstMessageAt(db: DatabaseSync, sender: string, recipient: string, since: number): number | null {
  const row = db.prepare("select min(created_at) t from messages where sender = ? and recipient = ? and kind = 'message' and created_at >= ?").get(sender, recipient, since) as { t: number | null };
  return row?.t ?? null;
}
