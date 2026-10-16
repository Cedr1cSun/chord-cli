import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import * as db from './db.ts';
import type { Tool } from './mcp.ts';

export interface Ctx { db: DatabaseSync; agent: string; cwd: string }

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
  return db.claimsFor(ctx.db, mine.file).filter(c =>
    c.agent !== ctx.agent && c.created_at < mine.created_at && db.getAgent(ctx.db, c.agent)?.status !== 'offline');
}

export type WriteCheck = { ok: true } | { ok: false; reason: string };

/**
 * May `ctx.agent` write `file` now? It must hold a claim, and if others claimed the
 * file first it must have messaged each of them and heard back, or waited out the timeout.
 */
export function canWrite(ctx: Ctx, file: string, now = Date.now()): WriteCheck {
  const rel = normFile(ctx, file);
  const mine = db.claimsFor(ctx.db, rel).find(c => c.agent === ctx.agent);
  if (!mine) return { ok: false, reason: `${rel} is not claimed by you. Call claim(file, intent, kind) first.` };
  const others = earlierOccupants(ctx, mine);
  if (!others.length) return { ok: true };
  const since = mine.asked_at ?? mine.created_at;
  if (now - since >= REPLY_TIMEOUT_MS) return { ok: true };
  const notAsked = others.filter(o => !db.repliedSince(ctx.db, ctx.agent, o.agent, since)).map(o => o.agent);
  if (notAsked.length) {
    return { ok: false, reason: `${rel} is also claimed by ${notAsked.join(', ')}. Read their claim (claim tool output) and send each of them a message explaining what you intend to change before writing.` };
  }
  const waiting = others.filter(o => !db.repliedSince(ctx.db, o.agent, ctx.agent, since)).map(o => o.agent);
  if (waiting.length) {
    const left = Math.ceil((REPLY_TIMEOUT_MS - (now - since)) / 60000);
    return { ok: false, reason: `waiting for a reply from ${waiting.join(', ')} about ${rel} (you may write without one in ${left} min). Work on something else meanwhile.` };
  }
  return { ok: true };
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
          file: str('Path relative to the worktree root'),
          intent: str('One sentence: what you will change and why'),
          kind: { type: 'string', enum: ['add', 'modify', 'delete', 'rename'] },
          symbols: str('Optional: functions or blocks you will touch'),
        },
        required: ['file', 'intent', 'kind'],
      },
      handler: a => {
        const file = normFile(ctx, req(a, 'file'));
        const kind = req(a, 'kind');
        if (!['add', 'modify', 'delete', 'rename'].includes(kind)) throw new Error('kind must be add, modify, delete or rename');
        db.addClaim(ctx.db, { agent: ctx.agent, file, intent: req(a, 'intent'), kind, symbols: typeof a.symbols === 'string' ? a.symbols : null });
        const mine = db.claimsFor(ctx.db, file).find(c => c.agent === ctx.agent)!;
        const others = earlierOccupants(ctx, mine);
        if (others.length && mine.asked_at === null) db.setAskedAt(ctx.db, ctx.agent, file, Date.now());
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
      inputSchema: { type: 'object', properties: { file: str('Path relative to the worktree root') }, required: ['file'] },
      handler: a => { db.removeClaim(ctx.db, ctx.agent, normFile(ctx, req(a, 'file'))); return { released: normFile(ctx, req(a, 'file')) }; },
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
  ];
  // every call sweeps dead agents first
  return list.map(t => ({ ...t, handler: a => { db.sweep(ctx.db); return t.handler(a); } }));
}
