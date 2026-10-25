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
import { claudeMcpChoices, claudeTrusts } from './trust.ts';
import type { Event, Tool } from './hooks.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: db.gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// realpath gives one canonical spelling (drive letter and directory case): Codex persists hook trust by hashing the command string
// sibling modules by absolute path: .ts when run from src, .js from the built dist
const here = (f: string) => fs.realpathSync.native(fileURLToPath(new URL(f + path.extname(fileURLToPath(import.meta.url)), import.meta.url))).split(path.sep).join('/');
export const HOOKS_TS = here('./hooks');
export const SERVE_TS = here('./serve');


/** `staleWaitMs`: how long to watch a stale heartbeat before calling its agent dead (tests shorten it). */
export function pickName(d: DatabaseSync, tool: Tool, project: string, override?: string, staleWaitMs = 2500): string {
  if (override) {
    if (!/^[A-Za-z0-9._-]+$/.test(override)) throw new Error('agent names may only contain letters, digits, ".", "_" and "-"');
    // the name becomes a directory and a branch: ".." would escape agents/, git refuses components starting with "."
    // or ending in "." or ".lock", and Windows reserves CON, NUL, COM1 and friends
    if (/^[.-]|\.$|\.\.|\.lock$/i.test(override) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(override)) throw new Error(`"${override}" cannot be an agent name: no leading "." or "-", no trailing "." or ".lock", no "..", and no Windows reserved names (CON, NUL, COM1...)`);
    // workspace paths are case-insensitive on Windows and macOS, so names differing only in case would share one
    const clash = db.listAgents(d).find(a => a.name.toLowerCase() === override.toLowerCase());
    if (clash && clash.name !== override) throw new Error(`agent "${clash.name}" already exists; names must differ in more than case`);
    if (clash && clash.status !== 'offline') {
      // A lone agent killed outright, whose pid Windows has since handed to another process, is never swept: nobody
      // else's heartbeat is fresh to compare with. A heartbeat that stays stale while we watch it is a dead wrapper
      // (a live one writes every second), and this launch itself proves the machine is awake.
      const stale = clash.heartbeat_at !== null && Date.now() - clash.heartbeat_at > db.HEARTBEAT_STALE_MS;
      if (stale) db.sleepSync(staleWaitMs);
      const again = stale ? db.getAgent(d, clash.name) : clash;
      if (!stale || again?.heartbeat_at !== clash.heartbeat_at) throw new Error(`agent "${override}" is already online`);
      db.log(`launch: ${override} has not had a heartbeat for ${Math.round((Date.now() - clash.heartbeat_at!) / 1000)}s; taking it for dead`);
      db.setStatus(d, clash.name, 'offline');
      db.releaseAll(d, clash.name, 'swept');
    }
    return override;
  }
  // the project name makes the agent recognisable in `chord ls --all`; kept short so the worktree path stays short
  const base = path.basename(project).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 12).replace(/^-+|-+$/g, '') || 'project';
  for (;;) {
    const name = `${tool}-${base}-${randomBytes(2).toString('hex')}`;
    if (!db.getAgent(d, name)) return name;
  }
}

/** The agent's workspace: <project>/chord/agents/<name>. Its repository worktree sits inside at <repoName>. */
export const workspacePath = (p: Project, name: string) => path.join(p.dir, 'chord', 'agents', name);

/** Create (or reuse) a worktree of `repo` at `wt` on branch chord/<name>, forked from the current main HEAD. */
export function ensureWorktree(repo: string, wt: string, name: string): string {
  const branch = `chord/${name}`;
  if (fs.existsSync(path.join(wt, '.git'))) {
    try { git(wt, 'rev-parse', '--git-dir'); } catch { // the link is broken, e.g. the project was moved
      git(repo, 'worktree', 'repair', wt);
      git(wt, 'rev-parse', '--git-dir');
    }
    return onBranch(wt, branch);
  }
  if (fs.existsSync(wt) && fs.readdirSync(wt).length) throw new Error(`${wt} exists but is not a git worktree; remove it or pick another --name`);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  // Every worktree directory is named after the repository, so git gives them ids repo, repo1, repo2... After the
  // project moves, the registrations point at the old place: pruning first would drop them all and let this new
  // worktree take the id "repo" that belonged to another agent, which a later repair of that agent would then share.
  // Repair the siblings first; prune only removes what the user really deleted.
  const siblings = siblingWorktrees(wt);
  if (siblings.length) { try { git(repo, 'worktree', 'repair', ...siblings); } catch { /* a sibling beyond repair is pruned below */ } }
  git(repo, 'worktree', 'prune');
  const exists = git(repo, 'branch', '--list', branch) !== '';
  try {
    // core.longpaths: a worktree path is some forty characters longer than the main checkout's, which on Windows is
    // enough to push a deep repository past MAX_PATH
    if (exists) git(repo, '-c', 'core.longpaths=true', 'worktree', 'add', wt, branch);
    else git(repo, '-c', 'core.longpaths=true', 'worktree', 'add', '-b', branch, wt);
  } catch (e) {
    // nothing half-made stays behind: a stale branch or an empty directory would trip the next launch
    try { git(repo, 'worktree', 'prune'); } catch { /* best effort */ }
    if (!exists) { try { git(repo, 'branch', '-D', branch); } catch { /* never created */ } }
    try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best effort */ }
    const msg = ((e as { stderr?: string }).stderr ?? (e as Error).message).trim();
    if (/too long/i.test(msg)) throw new Error(`${msg}\n${wt} is too long a path for git here; run "git config --global core.longpaths true", or move the project to a shorter path`);
    throw new Error(`could not create the worktree ${wt}: ${msg}`);
  }
  return onBranch(wt, branch);
}

/** The other agents' worktrees beside `wt` (chord/agents/<other>/<repoName>) that still exist on disk. */
function siblingWorktrees(wt: string): string[] {
  const agents = path.dirname(path.dirname(wt));
  try {
    return fs.readdirSync(agents)
      .map(n => path.join(agents, n, path.basename(wt)))
      .filter(p => p !== wt && fs.existsSync(path.join(p, '.git')));
  } catch { return []; }
}

/** A worktree that is not on its own branch is sharing a registration with another agent: refuse rather than let two
 *  agents work on one index. */
function onBranch(wt: string, branch: string): string {
  const head = git(wt, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (head !== branch) throw new Error(`${wt} is on ${head} instead of ${branch}; its git registration seems to be shared with another agent. Remove the directory and launch again`);
  return wt;
}

// ctxLimit: Codex caps a hook's additionalContext (default about 2,500 tokens); the briefing and message batches need more
const EVENTS: { event: Event; claude: string; codex?: string; matcher?: { claude: string; codex?: string }; timeout?: number; ctxLimit?: number }[] = [
  { event: 'session-start', claude: 'SessionStart', codex: 'SessionStart', ctxLimit: 16000 },
  { event: 'notification', claude: 'Notification', matcher: { claude: 'idle_prompt' } }, // Claude only: Codex reports idle through OSC 7501
  { event: 'user-prompt-submit', claude: 'UserPromptSubmit', codex: 'UserPromptSubmit', ctxLimit: 16000 },
  { event: 'pre-tool-use', claude: 'PreToolUse', codex: 'PreToolUse', matcher: { claude: 'Edit|Write|MultiEdit|NotebookEdit' } }, // Codex: every tool, so apply_patch run from the shell is seen too
  { event: 'post-tool-use', claude: 'PostToolUse', codex: 'PostToolUse', ctxLimit: 16000 }, // every tool: shell-edit warnings and mid-turn message delivery
  { event: 'stop', claude: 'Stop', codex: 'Stop' },
  { event: 'session-end', claude: 'SessionEnd', codex: 'SessionEnd', timeout: 10 },
];

/** The node that runs chord, by absolute path, for the MCP server (spawned from an argument list, so spaces in the
 *  path are no problem). The hook commands say plain `node`: Codex cannot run a command whose executable is quoted
 *  ("C:/Program Files/nodejs/node.exe" fails silently, a quoted argument is fine), so instead the wrapper puts this
 *  node's directory at the front of the agent's PATH (see withNodeOnPath), which also keeps an older node on the
 *  user's PATH (nvm, a project .nvmrc) from being the one that cannot run .ts files. */
export const NODE = fs.realpathSync.native(process.execPath).split(path.sep).join('/');
export const hookCommand = (event: Event) => `node "${HOOKS_TS}" ${event}`;

/** The environment with the directory of the node running chord first on PATH (whatever the variable's case). */
export function withNodeOnPath(env: Record<string, string>): Record<string, string> {
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
  const dir = path.dirname(fs.realpathSync.native(process.execPath));
  const current = env[key] ?? '';
  if (current.split(path.delimiter)[0] === dir) return env;
  return { ...env, [key]: current ? `${dir}${path.delimiter}${current}` : dir };
}

/** CLI arguments that inject chord's hooks and MCP server into Claude Code. */
/** `projectConfig`: also load the repository's own .claude settings and .mcp.json. Only when the user has trusted the
 *  repository in Claude Code, because Claude's trust dialogue is what normally stands between a cloned repository's
 *  hooks and MCP servers and running them. */
export interface ProjectConfigSource { repo: string; claudeConfig?: string }

/** `$CLAUDE_PROJECT_DIR` in a repository's hook commands and MCP definitions means the repository, which for an agent
 *  is its worktree; Claude would point it at the workspace. */
export function substituteProjectDir<T>(value: T, worktree: string): T {
  const dir = worktree.split(path.sep).join('/');
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR/g, dir);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** The repository's .mcp.json as an --mcp-config value, reduced to the servers the user approved in Claude Code, or
 *  null when there is nothing to pass. */
export function projectMcpConfig(worktree: string, source: ProjectConfigSource): string | null {
  const file = path.join(worktree, '.mcp.json');
  if (!fs.existsSync(file)) return null;
  let parsed: { mcpServers?: Record<string, unknown> };
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { process.stderr.write(`chord: ${file} is not valid JSON (${(e as Error).message}); its servers are not loaded\n`); return null; }
  const servers = parsed?.mcpServers ?? {};
  const choice = claudeMcpChoices(source.repo, source.claudeConfig);
  const keep = Object.fromEntries(Object.entries(servers).filter(([name]) => !choice.disabled.includes(name) && (choice.all || choice.enabled.includes(name))));
  const skipped = Object.keys(servers).filter(n => !(n in keep));
  if (skipped.length) process.stderr.write(`chord: not starting the repository's MCP server(s) ${skipped.join(', ')}: run claude in ${source.repo} once and approve them there first\n`);
  return Object.keys(keep).length ? JSON.stringify({ mcpServers: substituteProjectDir(keep, worktree) }) : null;
}

export function claudeArgs(env: Record<string, string>, projectConfig: boolean | ProjectConfigSource = false): string[] {
  const hooks: Record<string, unknown[]> = {};
  for (const e of EVENTS) {
    hooks[e.claude] = [{
      ...(e.matcher ? { matcher: e.matcher.claude } : {}),
      hooks: [{ type: 'command', command: hookCommand(e.event), ...(e.timeout ? { timeout: e.timeout } : {}) }],
    }];
  }
  const mcp = { mcpServers: { chord: { command: NODE, args: [SERVE_TS], env } } };
  // chord's own tools are pre-approved: in the default permission mode every claim, send and finish would otherwise
  // stop at a prompt, and an unattended agent would never get past the first one
  const ours = { hooks, permissions: { allow: ['mcp__chord'] } };
  // The agent's cwd is the project folder, not the repository, so Claude Code would not pick up the repository's
  // skills, commands and agents under .claude/, nor its settings*.json or .mcp.json. --add-dir covers the first group
  // (the briefing carries CLAUDE.md itself); the others are passed along.
  const wt = env.CHORD_WORKTREE;
  const addDir = wt ? ['--add-dir', wt] : [];
  const source: ProjectConfigSource | null = projectConfig === true ? { repo: wt ?? '' } : projectConfig || null;
  const projectMcp = source && wt ? projectMcpConfig(wt, source) : null;
  const mcpFiles = projectMcp ? [projectMcp] : [];
  const settings = source ? mergeProjectSettings(ours, wt) : ours;
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
  if (ours.permissions || theirs.permissions) {
    // permission lists add up, as across Claude's own settings levels; other permission keys follow the usual precedence
    const lists = (k: 'allow' | 'deny' | 'ask') => [...new Set([...(ours.permissions?.[k] ?? []), ...(theirs.permissions?.[k] ?? [])])];
    out.permissions = { ...theirs.permissions, ...ours.permissions };
    for (const k of ['allow', 'deny', 'ask'] as const) if (lists(k).length) out.permissions[k] = lists(k);
  }
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
    one = substituteProjectDir(one, worktree);
    theirs = { ...theirs, ...one, hooks: concatHooks(theirs, one) };
  }
  return mergeSettings(ours, theirs);
}

/** A JSON string literal is also a valid TOML basic string, quotes, backslashes and non-ASCII included. */
const toml = (s: string) => JSON.stringify(s);

/** CLI arguments that inject chord's hooks and MCP server into Codex. Values are TOML. */
/** `writableRoots`: directories Codex's workspace-write sandbox must also be allowed to write. A linked worktree keeps
 *  its index and refs under the main checkout's .git, outside the agent's workspace, so without this every git commit
 *  fails inside the sandbox. */
export function codexArgs(env: Record<string, string>, writableRoots: string[] = []): string[] {
  const args: string[] = [];
  if (writableRoots.length) args.push('-c', `sandbox_workspace_write.writable_roots=[${writableRoots.map(toml).join(',')}]`);
  for (const e of EVENTS) {
    if (!e.codex) continue;
    const matcher = e.matcher?.codex ? `matcher=${toml(e.matcher.codex)},` : '';
    const limit = e.ctxLimit ? `,additionalContextLimit=${e.ctxLimit}` : '';
    args.push('-c', `hooks.${e.codex}=[{${matcher}hooks=[{type="command",command=${toml(hookCommand(e.event))}${limit}}]}]`);
  }
  const envToml = Object.entries(env).map(([k, v]) => `${k}=${toml(v)}`).join(',');
  // finish may wait minutes for the merge lock; Codex's default tool timeout is 60s
  args.push('-c', `mcp_servers.chord={command=${toml(NODE)},args=[${toml(SERVE_TS)}],env={${envToml}},tool_timeout_sec=600}`);
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
  // Take the name now, before the worktree and setup take their time: a second launch under the same name a moment
  // later must find it online. The wrapper re-registers with the tool's own pid when it starts.
  db.addAgent(d, { name, tool, pid: process.pid, cwd: ws, worktree: path.join(ws, project.repoName), heartbeat: true });
  try {
    const config = readConfig(project);
    const worktree = ensureWorktree(project.repo, path.join(ws, project.repoName), name);
    const env = { CHORD_AGENT_ID: name, CHORD_DB: fwd(dbFile), CHORD_TOOL: tool, CHORD_PROJECT: fwd(project.dir), CHORD_WORKSPACE: fwd(ws), CHORD_WORKTREE: fwd(worktree) };
    // Setup is owed until it has finished once: a marker, not the worktree's existence, says so, because a setup
    // interrupted half-way leaves the worktree behind and a relaunch must not take a half-prepared checkout for ready.
    const marker = setupMarker(project, name);
    if (config.setup && !fs.existsSync(marker)) {
      runSetup(project, name, worktree, config.setup, env);
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, `${Date.now()}\n`);
    }
    let projectConfig: boolean | ProjectConfigSource = false;
    if (tool === 'claude' && hasProjectConfig(worktree)) {
      projectConfig = claudeTrusts(project.repo) || claudeTrusts(project.dir) ? { repo: project.repo } : false;
      if (!projectConfig) process.stderr.write(`chord: ${project.repo} has its own .claude settings or .mcp.json, but you have not trusted it in Claude Code, so they are not loaded for this agent. Run claude in ${project.repo} once and accept the trust prompt to change that.\n`);
    }
    return { name, project, cwd: ws, worktree, dbFile, env, args: tool === 'claude' ? claudeArgs(env, projectConfig) : codexArgs(env, [path.join(project.repo, '.git')]) };
  } catch (e) {
    db.setStatus(d, name, 'offline'); // the launch failed: the name is free again
    throw e;
  }
}

/** <project>/chord/config.json. `setup` is a shell command run in every new worktree before the agent starts,
 *  for example "npm install". `test` is a shell command finish runs in the worktree after rebasing onto main and
 *  before fast-forwarding it, for example "npm test"; when it fails nothing is merged. */
export function readConfig(project: Pick<Project, 'dir'>): { setup?: string; test?: string } {
  const file = path.join(project.dir, 'chord', 'config.json');
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  let cfg: unknown;
  try { cfg = JSON.parse(raw); } catch (e) { throw new Error(`${file} is not valid JSON: ${(e as Error).message}`); }
  if (typeof cfg !== 'object' || cfg === null) throw new Error(`${file} must hold a JSON object`);
  const out: { setup?: string; test?: string } = {};
  for (const key of ['setup', 'test'] as const) {
    const v = (cfg as Record<string, unknown>)[key];
    if (v !== undefined && typeof v !== 'string') throw new Error(`${file}: "${key}" must be a string (a shell command)`);
    if (v) out[key] = v;
  }
  return out;
}

/** Where `chord clean` and a relaunch look to see whether the setup command has run for this agent. */
export const setupMarker = (project: Project, name: string) => path.join(project.stateDir, 'setup-done', name);

/** A failed setup aborts the launch, and the half-prepared worktree and branch go with it so the next launch starts clean. */
function runSetup(project: Project, name: string, worktree: string, setup: string, env: Record<string, string>): void {
  process.stderr.write(`chord: running setup in ${worktree}: ${setup}\n`);
  // Ctrl+C goes to the setup command, which then fails and is cleaned up below; without a listener it would kill chord
  // itself first and leave the worktree and branch behind
  const ignoreSigint = () => {};
  process.on('SIGINT', ignoreSigint);
  try {
    execSync(setup, { cwd: worktree, stdio: 'inherit', env: { ...process.env, ...env } });
  } catch (e) {
    try { git(project.repo, 'worktree', 'remove', '--force', worktree); } catch { /* best effort */ }
    try { git(project.repo, 'branch', '-D', `chord/${name}`); } catch { /* best effort */ }
    const status = (e as { status?: number | null }).status;
    throw new Error(`setup command failed${status != null ? ` with exit code ${status}` : ''}: ${setup}\nthe worktree was removed; fix the command in ${path.join(project.dir, 'chord', 'config.json')} or the repository and launch again`);
  } finally {
    process.off('SIGINT', ignoreSigint);
  }
}
