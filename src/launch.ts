// Everything `chord <tool>` needs before spawning: the project, an agent name, the agent's
// workspace with its repository worktree, and the per-launch hook/MCP configuration for each
// tool. Hook command strings must stay identical across launches (Codex persists trust by
// hashing them), so per-session values go in env.
import { execFileSync, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import * as db from './db.ts';
import { ensureStateDir, resolveProject, type Project } from './project.ts';
import { claudeTrusts } from './trust.ts';
import type { Event, Tool } from './hooks.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: db.gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// realpath gives one canonical spelling (drive letter and directory case): Codex persists hook trust by hashing the command string
const here = (f: string) => fs.realpathSync.native(fileURLToPath(new URL(f, import.meta.url))).split(path.sep).join('/');
export const HOOKS_TS = here('./hooks.ts');
export const SERVE_TS = here('./serve.ts');

export function pickName(d: DatabaseSync, tool: Tool, project: string, override?: string): string {
  if (override) {
    if (!/^[A-Za-z0-9._-]+$/.test(override)) throw new Error('agent names may only contain letters, digits, ".", "_" and "-"');
    // the name becomes a directory and a branch: ".." would escape agents/, git refuses components starting with "."
    // or ending in "." or ".lock", and Windows reserves CON, NUL, COM1 and friends
    if (/^[.-]|\.$|\.\.|\.lock$/i.test(override) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(override)) throw new Error(`"${override}" cannot be an agent name: no leading "." or "-", no trailing "." or ".lock", no "..", and no Windows reserved names (CON, NUL, COM1...)`);
    // workspace paths are case-insensitive on Windows and macOS, so names differing only in case would share one
    const clash = db.listAgents(d).find(a => a.name.toLowerCase() === override.toLowerCase());
    if (clash && clash.name !== override) throw new Error(`agent "${clash.name}" already exists; names must differ in more than case`);
    if (clash && clash.status !== 'offline') throw new Error(`agent "${override}" is already online`);
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
  if (fs.existsSync(path.join(wt, '.git'))) {
    try { git(wt, 'rev-parse', '--git-dir'); return wt; } catch { /* the link is broken, e.g. the project was moved */ }
    git(repo, 'worktree', 'repair', wt);
    git(wt, 'rev-parse', '--git-dir');
    return wt;
  }
  if (fs.existsSync(wt) && fs.readdirSync(wt).length) throw new Error(`${wt} exists but is not a git worktree; remove it or pick another --name`);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(repo, 'worktree', 'prune'); // a workspace deleted by hand leaves a stale registration behind
  const branch = `chord/${name}`;
  const exists = git(repo, 'branch', '--list', branch) !== '';
  if (exists) git(repo, 'worktree', 'add', wt, branch);
  else git(repo, 'worktree', 'add', '-b', branch, wt);
  return wt;
}

// ctxLimit: Codex caps a hook's additionalContext (default about 2,500 tokens); the briefing and message batches need more
const EVENTS: { event: Event; claude: string; codex?: string; matcher?: { claude: string; codex?: string }; timeout?: number; ctxLimit?: number }[] = [
  { event: 'session-start', claude: 'SessionStart', codex: 'SessionStart', ctxLimit: 16000 },
  { event: 'notification', claude: 'Notification', matcher: { claude: 'idle_prompt' } }, // Claude only: Codex reports idle through OSC 7501
  { event: 'user-prompt-submit', claude: 'UserPromptSubmit', codex: 'UserPromptSubmit', ctxLimit: 16000 },
  { event: 'pre-tool-use', claude: 'PreToolUse', codex: 'PreToolUse', matcher: { claude: 'Edit|Write|MultiEdit|NotebookEdit', codex: '^apply_patch$' } },
  { event: 'post-tool-use', claude: 'PostToolUse', codex: 'PostToolUse', ctxLimit: 16000 }, // every tool: shell-edit warnings and mid-turn message delivery
  { event: 'stop', claude: 'Stop', codex: 'Stop' },
  { event: 'session-end', claude: 'SessionEnd', codex: 'SessionEnd', timeout: 10 },
];

export const hookCommand = (event: Event) => `node "${HOOKS_TS}" ${event}`;

/** CLI arguments that inject chord's hooks and MCP server into Claude Code. */
/** `projectConfig`: also load the repository's own .claude settings and .mcp.json. Only when the user has trusted the
 *  repository in Claude Code, because Claude's trust dialogue is what normally stands between a cloned repository's
 *  hooks and MCP servers and running them. */
export function claudeArgs(env: Record<string, string>, projectConfig = false): string[] {
  const hooks: Record<string, unknown[]> = {};
  for (const e of EVENTS) {
    hooks[e.claude] = [{
      ...(e.matcher ? { matcher: e.matcher.claude } : {}),
      hooks: [{ type: 'command', command: hookCommand(e.event), ...(e.timeout ? { timeout: e.timeout } : {}) }],
    }];
  }
  const mcp = { mcpServers: { chord: { command: 'node', args: [SERVE_TS], env } } };
  // The agent's cwd is its workspace, not the repository, so Claude Code would not pick up the repository's
  // own CLAUDE.md, .claude/settings*.json or .mcp.json. --add-dir covers CLAUDE.md; the others are passed along.
  const wt = env.CHORD_WORKTREE;
  const addDir = wt ? ['--add-dir', wt] : [];
  const mcpFiles = projectConfig && wt ? [path.join(wt, '.mcp.json')].filter(f => fs.existsSync(f)) : [];
  const settings = projectConfig ? mergeProjectSettings({ hooks }, wt) : { hooks };
  // --add-dir and --mcp-config take any number of values, so they must not come last: the user's own arguments
  // follow these, and a prompt such as `chord claude "fix the tests"` would be read as another directory.
  // --settings takes exactly one value and closes the list.
  return [...addDir, '--mcp-config', JSON.stringify(mcp), ...mcpFiles, '--settings', JSON.stringify(settings)];
}

/** The user's own --settings folded under chord's (chord's hooks stay, theirs are added), in place in `args`. */
export function mergeUserSettings(args: string[], user: Record<string, any>): string[] {
  const i = args.indexOf('--settings');
  if (i < 0 || i + 1 >= args.length) return args;
  const out = [...args];
  out[i + 1] = JSON.stringify(mergeSettings(JSON.parse(args[i + 1]), user));
  return out;
}

const PROJECT_CONFIG_FILES = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json'];
export const hasProjectConfig = (worktree: string) => PROJECT_CONFIG_FILES.some(f => fs.existsSync(path.join(worktree, f)));

/** chord's settings plus the repository's .claude/settings.json and settings.local.json (later files win,
 *  hook lists are concatenated so both chord's and the project's hooks run). */
/** Hook lists of `b` appended to those of `a`, so both sets run. */
function concatHooks(a: Record<string, any>, b: Record<string, any>): Record<string, unknown[]> {
  const hooks: Record<string, unknown[]> = { ...(a.hooks ?? {}) };
  for (const [event, list] of Object.entries(b.hooks ?? {})) hooks[event] = [...(hooks[event] ?? []), ...(Array.isArray(list) ? list : [])];
  return hooks;
}

/** Somebody else's settings underneath chord's: their keys fill in, chord's keys win, hook lists are concatenated,
 *  and disableAllHooks is dropped because it would switch chord itself off. */
export function mergeSettings(ours: Record<string, any>, theirs: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...theirs, ...ours, hooks: concatHooks(ours, theirs) };
  delete out.disableAllHooks;
  return out;
}

export function mergeProjectSettings(ours: Record<string, any>, worktree?: string): Record<string, any> {
  if (!worktree) return ours;
  let theirs: Record<string, any> = {};
  for (const name of ['settings.json', 'settings.local.json']) { // settings.local.json wins, as in Claude Code itself
    let one: Record<string, any>;
    try { one = JSON.parse(fs.readFileSync(path.join(worktree, '.claude', name), 'utf8')); } catch { continue; }
    if (typeof one !== 'object' || one === null) continue;
    theirs = { ...theirs, ...one, hooks: concatHooks(theirs, one) };
  }
  return mergeSettings(ours, theirs);
}

/** A JSON string literal is also a valid TOML basic string, quotes, backslashes and non-ASCII included. */
const toml = (s: string) => JSON.stringify(s);

/** CLI arguments that inject chord's hooks and MCP server into Codex. Values are TOML. */
export function codexArgs(env: Record<string, string>): string[] {
  const args: string[] = [];
  for (const e of EVENTS) {
    if (!e.codex) continue;
    const matcher = e.matcher?.codex ? `matcher=${toml(e.matcher.codex)},` : '';
    const limit = e.ctxLimit ? `,additionalContextLimit=${e.ctxLimit}` : '';
    args.push('-c', `hooks.${e.codex}=[{${matcher}hooks=[{type="command",command=${toml(hookCommand(e.event))}${limit}}]}]`);
  }
  const envToml = Object.entries(env).map(([k, v]) => `${k}=${toml(v)}`).join(',');
  // finish may wait minutes for the merge lock; Codex's default tool timeout is 60s
  args.push('-c', `mcp_servers.chord={command="node",args=[${toml(SERVE_TS)}],env={${envToml}},tool_timeout_sec=600}`);
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
  const config = readConfig(project);
  const fresh = !fs.existsSync(path.join(ws, project.repoName, '.git'));
  const worktree = ensureWorktree(project.repo, path.join(ws, project.repoName), name);
  const env = { CHORD_AGENT_ID: name, CHORD_DB: fwd(dbFile), CHORD_TOOL: tool, CHORD_PROJECT: fwd(project.dir), CHORD_WORKSPACE: fwd(ws), CHORD_WORKTREE: fwd(worktree) };
  if (fresh && config.setup) runSetup(project, name, worktree, config.setup, env);
  let projectConfig = false;
  if (tool === 'claude' && hasProjectConfig(worktree)) {
    projectConfig = claudeTrusts(project.repo) || claudeTrusts(project.dir);
    if (!projectConfig) process.stderr.write(`chord: ${project.repo} has its own .claude settings or .mcp.json, but you have not trusted it in Claude Code, so they are not loaded for this agent. Run claude in ${project.repo} once and accept the trust prompt to change that.\n`);
  }
  return { name, project, cwd: ws, worktree, dbFile, env, args: tool === 'claude' ? claudeArgs(env, projectConfig) : codexArgs(env) };
}

/** <project>/chord/config.json. `setup` is a shell command run in every new worktree before the agent starts,
 *  for example "npm install". */
export function readConfig(project: Project): { setup?: string } {
  const file = path.join(project.dir, 'chord', 'config.json');
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  let cfg: unknown;
  try { cfg = JSON.parse(raw); } catch (e) { throw new Error(`${file} is not valid JSON: ${(e as Error).message}`); }
  if (typeof cfg !== 'object' || cfg === null) throw new Error(`${file} must hold a JSON object`);
  const setup = (cfg as { setup?: unknown }).setup;
  if (setup !== undefined && typeof setup !== 'string') throw new Error(`${file}: "setup" must be a string (a shell command)`);
  return setup ? { setup } : {};
}

/** A failed setup aborts the launch, and the half-prepared worktree and branch go with it so the next launch starts clean. */
function runSetup(project: Project, name: string, worktree: string, setup: string, env: Record<string, string>): void {
  process.stderr.write(`chord: running setup in ${worktree}: ${setup}\n`);
  try {
    execSync(setup, { cwd: worktree, stdio: 'inherit', env: { ...process.env, ...env } });
  } catch (e) {
    try { git(project.repo, 'worktree', 'remove', '--force', worktree); } catch { /* best effort */ }
    try { git(project.repo, 'branch', '-D', `chord/${name}`); } catch { /* best effort */ }
    const status = (e as { status?: number | null }).status;
    throw new Error(`setup command failed${status != null ? ` with exit code ${status}` : ''}: ${setup}\nthe worktree was removed; fix the command in ${path.join(project.dir, 'chord', 'config.json')} or the repository and launch again`);
  }
}
