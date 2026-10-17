// Everything `chord <tool>` needs before spawning: the project, an agent name, the agent's
// workspace with its repository worktree, and the per-launch hook/MCP configuration for each
// tool. Hook command strings must stay identical across launches (Codex persists trust by
// hashing them), so per-session values go in env.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import * as db from './db.ts';
import { ensureStateDir, resolveProject, type Project } from './project.ts';
import type { Event, Tool } from './hooks.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url)).split(path.sep).join('/');
export const HOOKS_TS = here('./hooks.ts');
export const SERVE_TS = here('./serve.ts');

export function pickName(d: DatabaseSync, tool: Tool, project: string, override?: string): string {
  if (override) {
    const a = db.getAgent(d, override);
    if (a && a.status !== 'offline') throw new Error(`agent "${override}" is already online`);
    return override;
  }
  const base = path.basename(project).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  for (;;) {
    const name = `${tool}-${base}-${randomBytes(2).toString('hex')}`;
    if (!db.getAgent(d, name)) return name;
  }
}

/** The agent's workspace: <project>/chord/agents/<name>. Its repository worktree sits inside at <repoName>. */
export const workspacePath = (p: Project, name: string) => path.join(p.dir, 'chord', 'agents', name);

/** Create (or reuse) a worktree of `repo` at `wt` on branch chord/<name>, forked from the current main HEAD. */
export function ensureWorktree(repo: string, wt: string, name: string): string {
  if (fs.existsSync(path.join(wt, '.git'))) return wt;
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const branch = `chord/${name}`;
  const exists = git(repo, 'branch', '--list', branch) !== '';
  if (exists) git(repo, 'worktree', 'add', wt, branch);
  else git(repo, 'worktree', 'add', '-b', branch, wt);
  return wt;
}

const EVENTS: { event: Event; claude: string; codex: string; matcher?: { claude: string; codex: string }; timeout?: number }[] = [
  { event: 'session-start', claude: 'SessionStart', codex: 'SessionStart' },
  { event: 'user-prompt-submit', claude: 'UserPromptSubmit', codex: 'UserPromptSubmit' },
  { event: 'pre-tool-use', claude: 'PreToolUse', codex: 'PreToolUse', matcher: { claude: 'Edit|Write|MultiEdit|NotebookEdit', codex: '^apply_patch$' } },
  { event: 'post-tool-use', claude: 'PostToolUse', codex: 'PostToolUse', matcher: { claude: 'Bash|PowerShell', codex: 'Bash' } },
  { event: 'stop', claude: 'Stop', codex: 'Stop' },
  { event: 'session-end', claude: 'SessionEnd', codex: 'SessionEnd', timeout: 10 },
];

export const hookCommand = (event: Event) => `node "${HOOKS_TS}" ${event}`;

/** CLI arguments that inject chord's hooks and MCP server into Claude Code. */
export function claudeArgs(env: Record<string, string>): string[] {
  const hooks: Record<string, unknown[]> = {};
  for (const e of EVENTS) {
    hooks[e.claude] = [{
      ...(e.matcher ? { matcher: e.matcher.claude } : {}),
      hooks: [{ type: 'command', command: hookCommand(e.event), ...(e.timeout ? { timeout: e.timeout } : {}) }],
    }];
  }
  const mcp = { mcpServers: { chord: { command: 'node', args: [SERVE_TS], env } } };
  return ['--settings', JSON.stringify({ hooks }), '--mcp-config', JSON.stringify(mcp)];
}

/** A JSON string literal is also a valid TOML basic string, quotes, backslashes and non-ASCII included. */
const toml = (s: string) => JSON.stringify(s);

/** CLI arguments that inject chord's hooks and MCP server into Codex. Values are TOML. */
export function codexArgs(env: Record<string, string>): string[] {
  const args: string[] = [];
  for (const e of EVENTS) {
    const matcher = e.matcher ? `matcher=${toml(e.matcher.codex)},` : '';
    args.push('-c', `hooks.${e.codex}=[{${matcher}hooks=[{type="command",command=${toml(hookCommand(e.event))}}]}]`);
  }
  const envToml = Object.entries(env).map(([k, v]) => `${k}=${toml(v)}`).join(',');
  args.push('-c', `mcp_servers.chord={command="node",args=[${toml(SERVE_TS)}],env={${envToml}}}`);
  return args;
}

export interface Launch {
  name: string;
  project: Project;
  cwd: string;      // the agent's workspace W
  worktree: string; // W/<repoName>, the repository worktree
  dbFile: string;
  env: Record<string, string>;
  args: string[];
}

const fwd = (p: string) => p.split(path.sep).join('/');

/** Resolve everything for `chord <tool> [--name x] [tool args...]` without spawning. Throws NeedsRestructure. */
export function prepare(tool: Tool, cwd: string, override?: string): Launch {
  const project = resolveProject(cwd);
  try { git(project.repo, 'rev-parse', '--verify', '-q', 'HEAD'); } catch { throw new Error(`${project.repo} has no commits yet; make an initial commit first`); }
  ensureStateDir(project);
  const dbFile = db.dbPath(project.stateDir);
  const d = db.openDb(dbFile);
  db.sweep(d);
  const name = pickName(d, tool, project.dir, override);
  const ws = workspacePath(project, name);
  const worktree = ensureWorktree(project.repo, path.join(ws, project.repoName), name);
  const env = { CHORD_AGENT_ID: name, CHORD_DB: fwd(dbFile), CHORD_TOOL: tool, CHORD_PROJECT: fwd(project.dir), CHORD_WORKSPACE: fwd(ws), CHORD_WORKTREE: fwd(worktree) };
  return { name, project, cwd: ws, worktree, dbFile, env, args: tool === 'claude' ? claudeArgs(env) : codexArgs(env) };
}
