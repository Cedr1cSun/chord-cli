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
  task: string | null;
  scope: string | null;
  status: Status;
  started_at: number;
  updated_at: number;
  heartbeat_at: number | null; // refreshed by the wrapper; null for agents without one (tests)
  stop_requested_at: number | null; // set by `chord stop`; the wrapper quits the tool once the agent is idle
  session_id: string | null; // the tool's own conversation id, recorded by the hooks, for `chord resume`
}

export interface Claim {
  rid: number;      // rowid: orders claims created in the same millisecond
  agent: string;
  file: string;
  intent: string;
  kind: string;
  symbols: string | null;
  created_at: number;
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
  // the busy timeout must be in force before the first statement: switching to WAL below does not wait otherwise,
  // and several agents starting at once on a new database all hit it together
  const db = new DatabaseSync(file, { timeout: 5000 });
  // A brand-new database opened by several processes at once: SQLite answers the WAL switch and the schema with an
  // immediate SQLITE_BUSY instead of waiting (seen on Linux, never on Windows), so the setup is retried briefly.
  for (let attempt = 0; ; attempt++) {
    try { setup(db); break; }
    catch (e) {
      if (attempt >= 50 || !/database is locked/.test((e as Error).message)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  return db;
}

function setup(db: DatabaseSync): void {
  db.exec(`
    pragma journal_mode = wal;
    pragma synchronous = normal;
    pragma busy_timeout = 5000;
    pragma foreign_keys = on;
    create table if not exists agents (
      name       text primary key,
      tool       text not null,
      pid        integer not null,
      cwd        text not null,
      task       text,
      scope      text,
      status     text not null default 'busy',
      started_at integer not null,
      updated_at integer not null,
      heartbeat_at integer,
      stop_requested_at integer,
      session_id text
    );
    create table if not exists claims (
      agent    text not null references agents(name),
      file     text not null ${FILE_COLLATION},
      intent   text not null,
      kind     text not null,
      symbols    text,
      created_at integer not null,
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
    create table if not exists events (
      id     integer primary key autoincrement,
      at     integer not null,
      agent  text not null,
      kind   text not null,
      file   text,
      detail text
    );
  `);
  migrate(db);
}

/** Bump when the schema changes and add a step below; `pragma user_version` records what a database has. A database
 *  from before versioning reads as 0 and gets every step, each of which checks what is actually there. */
const SCHEMA_VERSION = 4;

function migrate(db: DatabaseSync): void {
  // under a write lock: several processes opening an old database together must not each add the same column
  db.exec('begin immediate');
  try {
    const v = (db.prepare('pragma user_version').get() as { user_version: number }).user_version;
    if (v < SCHEMA_VERSION) {
      const agentCols = () => (db.prepare('pragma table_info(agents)').all() as { name: string }[]).map(c => c.name);
      if (v < 1 && !agentCols().includes('heartbeat_at')) db.exec('alter table agents add column heartbeat_at integer'); // 2026-10-17
      if (v < 2 && !agentCols().includes('stop_requested_at')) db.exec('alter table agents add column stop_requested_at integer'); // 2026-10-17; the events table is created above
      if (v < 3 && !agentCols().includes('session_id')) db.exec('alter table agents add column session_id text'); // 2026-10-25
      if (v < 4) { // 2026-10-28: two columns written and never read
        if (agentCols().includes('worktree')) db.exec('alter table agents drop column worktree');
        if ((db.prepare('pragma table_info(claims)').all() as { name: string }[]).some(c => c.name === 'asked_at')) db.exec('alter table claims drop column asked_at');
      }
      db.exec(`pragma user_version = ${SCHEMA_VERSION}`);
    }
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
}

// agents

export function addAgent(db: DatabaseSync, a: { name: string; tool: string; pid: number; cwd: string; heartbeat?: boolean }): void {
  const now = Date.now();
  db.prepare(
    `insert into agents (name, tool, pid, cwd, status, started_at, updated_at, heartbeat_at)
     values (?, ?, ?, ?, 'busy', ?, ?, ?)
     on conflict(name) do update set tool = excluded.tool, pid = excluded.pid, cwd = excluded.cwd,
       status = 'busy', task = null, scope = null, started_at = excluded.started_at, updated_at = excluded.updated_at, heartbeat_at = excluded.heartbeat_at,
       stop_requested_at = null, session_id = case when tool = excluded.tool then session_id end`,
  ).run(a.name, a.tool, a.pid, a.cwd, now, now, a.heartbeat ? now : null);
  // a relaunch under the same name must not inherit messages meant for the previous session
  db.prepare('delete from messages where recipient = ? and read_at is null').run(a.name);
}

/** Forget an agent: its claims, the messages to it and those it sent that have been read. What it said and nobody
 *  has read yet stays: "f.ts is yours now" must still reach its recipient after the sender has been cleaned away. */
export function removeAgent(db: DatabaseSync, name: string): void {
  db.prepare('delete from claims where agent = ?').run(name);
  db.prepare('delete from messages where recipient = ? or (sender = ? and read_at is not null)').run(name, name);
  db.prepare('delete from agents where name = ?').run(name);
}

/** The wrapper's take-over of the row prepare reserved: the tool's own pid replaces chord's. */
export function setPid(db: DatabaseSync, name: string, pid: number): void {
  db.prepare('update agents set pid = ? where name = ?').run(pid, name);
}

/** The tool's conversation id, from the hook payloads; a relaunch keeps the old one until the new session reports its own. */
export function setSession(db: DatabaseSync, name: string, id: string): void {
  db.prepare('update agents set session_id = ? where name = ?').run(id, name);
}

export function setTask(db: DatabaseSync, name: string, task: string, scope: string | null): void {
  db.prepare('update agents set task = ?, scope = ?, updated_at = ? where name = ?').run(task, scope, Date.now(), name);
}

/** Offline is sticky here: a hook that outlives its killed agent must not revive it. Only the wrapper does, through
 *  addAgent (relaunch) or heartbeat. */
export function setStatus(db: DatabaseSync, name: string, status: Status): void {
  db.prepare(`update agents set status = ?, updated_at = ? where name = ? and status != 'offline'`).run(status, Date.now(), name);
}

export function getAgent(db: DatabaseSync, name: string): Agent | undefined {
  return db.prepare('select * from agents where name = ?').get(name) as Agent | undefined;
}

export function listAgents(db: DatabaseSync): Agent[] {
  return db.prepare('select * from agents order by started_at').all() as unknown as Agent[];
}

export function pidAlive(pid: number): boolean {
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

/** The wrapper refreshes this every second; an agent whose heartbeat is this old is dead even if its pid is taken again. */
export const HEARTBEAT_STALE_MS = 30_000;

/** The wrapper is the one process that knows the agent is alive, so its heartbeat also revives an agent a sweep
 *  marked offline (a machine asleep for over 30 s looks dead to the first sweep after waking). Claims are gone by
 *  then; the agent claims again when it next writes. */
export function heartbeat(db: DatabaseSync, name: string): void {
  // revived as busy, the safe direction: a wake-up or a stop must not be typed into an agent that was in fact
  // working all along; the next Stop, idle report or idle_prompt makes it idle again
  db.prepare(`update agents set heartbeat_at = ?, status = case when status = 'offline' then 'busy' else status end where name = ?`).run(Date.now(), name);
}

/** Every online wrapper's heartbeat refreshed at once. For the first wrapper to wake after the machine slept: its own
 *  heartbeat alone would make the others look dead to a sweep in the second before they wake too. Agents without a
 *  wrapper yet are left to their pid. */
export function heartbeatAll(db: DatabaseSync): void {
  db.prepare(`update agents set heartbeat_at = ? where status != 'offline' and heartbeat_at is not null`).run(Date.now());
}

/** How long after launch an agent may go without a heartbeat before the watch in sweep calls it dead. */
const STARTUP_GRACE_MS = 10 * 60_000;

export const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Mark agents whose process is gone as offline and drop their claims. Returns the names swept. A missing
 *  process or a stale heartbeat both count: Windows reuses pids quickly, so the pid alone can lie.
 *  `watchMs`: when every heartbeat is stale, wait that long and see whose heartbeat moves (a live wrapper writes every
 *  second); the rest are dead. Zero, the default for hooks and tools, judges by pid alone in that case. */
export function sweep(db: DatabaseSync, alive: (pid: number) => boolean = pidAlive, now = Date.now(), watchMs = 0, sleep: (ms: number) => void = sleepSync): string[] {
  const online = listAgents(db).filter(a => a.status !== 'offline');
  // Every heartbeat stale at once means the machine was asleep, not that everyone died: judge by pid alone then.
  // ponytail: a lone dead agent whose pid was reused is therefore missed by the hooks until a second agent comes online.
  const beating = online.filter(a => a.heartbeat_at !== null);
  const stale = (a: Agent) => a.heartbeat_at !== null && now - a.heartbeat_at > HEARTBEAT_STALE_MS;
  const slept = beating.length > 0 && beating.every(stale);
  let dead: string[];
  if (slept && watchMs > 0) {
    sleep(watchMs);
    const moved = new Set(listAgents(db).filter(a => beating.some(b => b.name === a.name && b.heartbeat_at !== a.heartbeat_at)).map(a => a.name));
    // no heartbeat yet while the setup command or Codex's first-start wait runs: a live pid that started lately is starting
    const starting = (a: Agent) => now - a.started_at < STARTUP_GRACE_MS;
    dead = online.filter(a => !alive(a.pid) || (a.heartbeat_at !== null && !moved.has(a.name) && !starting(a))).map(a => a.name);
  } else {
    if (slept) log('sweep: every heartbeat is stale, the machine was probably asleep; judging by pid only');
    dead = online.filter(a => !alive(a.pid) || (!slept && stale(a))).map(a => a.name);
  }
  for (const name of dead) {
    log(`sweep: ${name} marked offline, claims released`);
    setStatus(db, name, 'offline');
    releaseAll(db, name, 'swept');
  }
  return dead;
}

// claims

export function addClaim(db: DatabaseSync, c: { agent: string; file: string; intent: string; kind: string; symbols?: string | null }): void {
  db.prepare(
    `insert into claims (agent, file, intent, kind, symbols, created_at) values (?, ?, ?, ?, ?, ?)
     on conflict(agent, file) do update set intent = excluded.intent, kind = excluded.kind, symbols = excluded.symbols`,
  ).run(c.agent, c.file, c.intent, c.kind, c.symbols ?? null, Date.now());
  addEvent(db, c.agent, 'claim', c.file, `${c.kind}: ${c.intent}`);
}

export function removeClaim(db: DatabaseSync, agent: string, file: string): void {
  const gone = db.prepare('delete from claims where agent = ? and file = ?').run(agent, file).changes;
  if (gone) addEvent(db, agent, 'release', file, 'released');
}

/** `why` is what the events log shows: released (by the agent), finish, swept, offline, exit. */
export function releaseAll(db: DatabaseSync, agent: string, why = 'released'): void {
  const files = (db.prepare('select file from claims where agent = ? order by file').all(agent) as { file: string }[]).map(r => r.file);
  db.prepare('delete from claims where agent = ?').run(agent);
  for (const f of files) addEvent(db, agent, 'release', f, why);
}

export type EventKind = 'claim' | 'release' | 'merge' | 'conflict' | 'merge-failed';
export interface Event { id: number; at: number; agent: string; kind: EventKind; file: string | null; detail: string | null }

/** Append-only history of claims, releases and merges, for `chord events`. */
export function addEvent(db: DatabaseSync, agent: string, kind: EventKind, file: string | null, detail: string | null): void {
  db.prepare('insert into events (at, agent, kind, file, detail) values (?, ?, ?, ?, ?)').run(Date.now(), agent, kind, file, detail);
}

/** The latest `limit` events (oldest first), for one agent or all. */
export function listEvents(db: DatabaseSync, agent?: string, limit = 50): Event[] {
  const rows = agent
    ? db.prepare('select * from events where agent = ? order by id desc limit ?').all(agent, limit)
    : db.prepare('select * from events order by id desc limit ?').all(limit);
  return (rows as unknown as Event[]).reverse();
}

/** The closing sentence of a merge notice: for the agents, not for `chord messages`. */
export const NOTICE_TAIL = 'No action is needed: finish() rebases your branch for you when you call it. This is a notification; do not reply.';

/** One send: `recipient` names them all, `n` how many, `unread` how many have not read it. */
export interface MessageGroup extends Message { n: number; unread: number }

/** The latest `limit` sends (oldest first), all or those sent or received by one agent. A message to several agents
 *  is one row per recipient in the table and one send here. */
export function listMessages(db: DatabaseSync, agent?: string, limit = 50): MessageGroup[] {
  const sql = (where: string) => `select min(id) id, sender, group_concat(recipient, ', ') recipient, kind, body, created_at, max(read_at) read_at,
    count(*) n, count(*) - count(read_at) unread from messages ${where} group by sender, kind, body, created_at order by max(id) desc limit ?`;
  const rows = agent ? db.prepare(sql('where sender = ? or recipient = ?')).all(agent, agent, limit) : db.prepare(sql('')).all(limit);
  return (rows as unknown as MessageGroup[]).reverse();
}

/** `chord stop`: ask the wrapper to quit the tool once the agent is idle. Returns false for an unknown or offline agent. */
export function requestStop(db: DatabaseSync, name: string): boolean {
  return db.prepare(`update agents set stop_requested_at = ? where name = ? and status != 'offline'`).run(Date.now(), name).changes > 0;
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
  // one transaction: parallel tool calls run several PostToolUse hooks at once, and each must get different messages
  db.exec('begin immediate');
  try {
    const rows = db.prepare('select * from messages where recipient = ? and read_at is null order by id').all(recipient) as unknown as Message[];
    const out: Message[] = [];
    let used = 0;
    for (const m of rows) { if (out.length && used + m.body.length > budget) break; out.push(m); used += m.body.length; }
    if (out.length) {
      db.prepare(`update messages set read_at = ? where recipient = ? and read_at is null and id <= ?`).run(Date.now(), recipient, out[out.length - 1].id);
    }
    db.exec('commit');
    return out;
  } catch (e) { db.exec('rollback'); throw e; }
}

/** Whether a message (not a notice) is waiting: only messages wake an idle agent; notices ride along with the next hook. */
export function hasUnread(db: DatabaseSync, recipient: string): boolean {
  return !!db.prepare(`select 1 from messages where recipient = ? and read_at is null and kind = 'message' limit 1`).get(recipient);
}

/** When `sender` first messaged `recipient` at or after `since`; null if never. Notices do not count. */
export function firstMessageAt(db: DatabaseSync, sender: string, recipient: string, since: number): number | null {
  const row = db.prepare("select min(created_at) t from messages where sender = ? and recipient = ? and kind = 'message' and created_at >= ?").get(sender, recipient, since) as { t: number | null };
  return row?.t ?? null;
}
