import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export type Status = 'busy' | 'idle' | 'offline';

export interface Agent {
  name: string;
  tool: string;
  pid: number;
  cwd: string;
  task: string | null;
  scope: string | null;
  status: Status;
  started_at: number;
  updated_at: number;
}

export interface Claim {
  agent: string;
  file: string;
  intent: string;
  kind: string;
  symbols: string | null;
  created_at: number;
  asked_at: number | null;
}

export interface Message {
  id: number;
  sender: string;
  recipient: string;
  body: string;
  created_at: number;
  read_at: number | null;
}

const commonDir = (cwd: string) => path.resolve(cwd, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8' }).trim());

/** Root of the main checkout, even when run from inside a linked worktree. */
export const mainRoot = (cwd: string) => path.dirname(commonDir(cwd));

/** chord.db lives in the common git dir, so every worktree of the repo shares it. */
export const dbPath = (cwd: string) => path.join(commonDir(cwd), 'chord.db');

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
      task       text,
      scope      text,
      status     text not null default 'busy',
      started_at integer not null,
      updated_at integer not null
    );
    create table if not exists claims (
      agent    text not null references agents(name),
      file     text not null,
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
      body       text not null,
      created_at integer not null,
      read_at    integer
    );
  `);
  return db;
}

// agents

export function addAgent(db: DatabaseSync, a: { name: string; tool: string; pid: number; cwd: string }): void {
  const now = Date.now();
  db.prepare(
    `insert into agents (name, tool, pid, cwd, status, started_at, updated_at)
     values (?, ?, ?, ?, 'busy', ?, ?)
     on conflict(name) do update set tool = excluded.tool, pid = excluded.pid, cwd = excluded.cwd,
       status = 'busy', task = null, scope = null, started_at = excluded.started_at, updated_at = excluded.updated_at`,
  ).run(a.name, a.tool, a.pid, a.cwd, now, now);
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
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Mark agents whose process is gone as offline and drop their claims. Returns the names swept. */
export function sweep(db: DatabaseSync, alive: (pid: number) => boolean = pidAlive): string[] {
  const dead = listAgents(db).filter(a => a.status !== 'offline' && !alive(a.pid)).map(a => a.name);
  for (const name of dead) {
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
  return db.prepare('select * from claims where file = ?').all(file) as unknown as Claim[];
}

export function claimsBy(db: DatabaseSync, agent: string): Claim[] {
  return db.prepare('select * from claims where agent = ? order by file').all(agent) as unknown as Claim[];
}

export function allClaims(db: DatabaseSync): Claim[] {
  return db.prepare('select * from claims order by file, agent').all() as unknown as Claim[];
}

// messages

export function send(db: DatabaseSync, sender: string, recipients: string[], body: string): void {
  const now = Date.now();
  const ins = db.prepare('insert into messages (sender, recipient, body, created_at) values (?, ?, ?, ?)');
  for (const r of recipients) ins.run(sender, r, body, now);
}

/** Unread messages for `recipient`, marked read as they are returned. */
export function takeUnread(db: DatabaseSync, recipient: string): Message[] {
  const rows = db.prepare('select * from messages where recipient = ? and read_at is null order by id').all(recipient) as unknown as Message[];
  if (rows.length) {
    db.prepare(`update messages set read_at = ? where recipient = ? and read_at is null and id <= ?`).run(Date.now(), recipient, rows[rows.length - 1].id);
  }
  return rows;
}

export function hasUnread(db: DatabaseSync, recipient: string): boolean {
  return !!db.prepare('select 1 from messages where recipient = ? and read_at is null limit 1').get(recipient);
}

/** Has `sender` sent `recipient` anything at or after `since`? */
export function repliedSince(db: DatabaseSync, sender: string, recipient: string, since: number): boolean {
  return !!db.prepare('select 1 from messages where sender = ? and recipient = ? and created_at >= ? limit 1').get(sender, recipient, since);
}
