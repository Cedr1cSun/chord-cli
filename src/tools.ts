import type { DatabaseSync } from 'node:sqlite';
import * as db from './db.ts';
import type { Tool } from './mcp.ts';

export interface Ctx { db: DatabaseSync; agent: string }

const str = (desc: string) => ({ type: 'string', description: desc });

function req(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${key} is required`);
  return v;
}

export function peers(ctx: Ctx) {
  return db.listAgents(ctx.db).filter(a => a.name !== ctx.agent).map(a => ({
    name: a.name, tool: a.tool, status: a.status, cwd: a.cwd, task: a.task, scope: a.scope,
  }));
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
