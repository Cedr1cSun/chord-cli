// Entry point for the per-agent MCP server. Spawned by the coding agent over stdio.
import { openDb } from './db.ts';
import { serve } from './mcp.ts';
import { tools } from './tools.ts';

const agent = process.env.CHORD_AGENT_ID;
const file = process.env.CHORD_DB;
if (!agent || !file) {
  process.stderr.write('chord: CHORD_AGENT_ID and CHORD_DB must be set\n');
  process.exit(2);
}
serve(tools({ db: openDb(file), agent }));
