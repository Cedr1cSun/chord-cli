// Entry point for the per-agent MCP server. Spawned by the coding agent over stdio, in the project folder; the
// agent's workspace comes from the CHORD_* environment, not from cwd.
import { openDb } from './db.ts';
import { serve } from './mcp.ts';
import { tools } from './tools.ts';

const agent = process.env.CHORD_AGENT_ID;
const file = process.env.CHORD_DB;
if (!agent || !file) {
  process.stderr.write('chord: CHORD_AGENT_ID and CHORD_DB must be set\n');
  process.exit(2);
}
const cwd = process.env.CHORD_WORKSPACE ?? process.cwd();
serve(tools({ db: openDb(file), agent, cwd, worktree: process.env.CHORD_WORKTREE ?? cwd, project: process.env.CHORD_PROJECT }));
