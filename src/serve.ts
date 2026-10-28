// Entry point for the per-agent MCP server. Spawned by the coding agent over stdio, in the project folder; the
// agent's workspace comes from the CHORD_* environment, never from cwd, which would make every claim path wrong.
import { openDb } from './db.ts';
import { serve } from './mcp.ts';
import { tools } from './tools.ts';

const { CHORD_AGENT_ID: agent, CHORD_DB: file, CHORD_WORKSPACE: cwd, CHORD_WORKTREE: worktree } = process.env;
if (!agent || !file || !cwd || !worktree) {
  process.stderr.write('chord: CHORD_AGENT_ID, CHORD_DB, CHORD_WORKSPACE and CHORD_WORKTREE must be set\n');
  process.exit(2);
}
serve(tools({ db: openDb(file), agent, cwd, worktree, project: process.env.CHORD_PROJECT }));
