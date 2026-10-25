#!/usr/bin/env node
// chord <claude|codex> [--name <agent>] [tool args...]   launch an agent in its own workspace
// chord resume <agent> [tool args...]                     launch it again and reopen its recorded conversation
// chord ls [--all]                                        agents and file claims, this project or all
// chord messages [agent] [-n N]                           message history
// chord events [agent] [-n N]                             claim, release, merge and conflict history
// chord stop <agent>                                      quit an agent once it is idle
// chord clean [--force] [agent...]                        remove offline agents' workspaces, worktrees and branches
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { clean } from './clean.ts';
import * as db from './db.ts';
import { mergeUserSettings, prepare } from './launch.ts';
import { NeedsRestructure, knownProjects, resolveProject, restructure, restructureBlocker, validateRepoName } from './project.ts';
import { resolveCommand, run } from './pty.ts';
import { codexFirstStart, disabledCodexHooks } from './trust.ts';
import type { Tool } from './hooks.ts';

const USAGE = 'usage: chord <claude|codex> [--name <agent>] [tool args...]\n       chord resume <agent> [tool args...]\n       chord ls [--all]\n       chord messages [agent] [-n N]\n       chord events [agent] [-n N]\n       chord stop <agent>\n       chord clean [--force] [agent...]\n';

const gitOut = (cwd: string, ...args: string[]): string | undefined => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', env: db.gitEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return undefined; }
};

/** "12s", "3m", "2h", "5d": how long ago. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

/** Local time of day, with the date in front when it is not today. */
export function when(t: number, now = Date.now()): string {
  const d = new Date(t), pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

/** Agents (with unread messages, time since the last sign of life, commits on their branch not yet on main) and
 *  claims. `repo` is the main checkout; without it the branch column shows "?". */
export function ls(d: ReturnType<typeof db.openDb>, repo?: string, now = Date.now()): string {
  db.sweep(d);
  const agents = db.listAgents(d);
  const claims = db.allClaims(d);
  const main = repo ? gitOut(repo, 'rev-parse', '--abbrev-ref', 'HEAD') : undefined;
  const ahead = (name: string) => { if (!repo || !main) return '?'; const n = gitOut(repo, 'rev-list', '--count', `${main}..chord/${name}`); return n === undefined ? '-' : `+${n}`; };
  const unread = (name: string) => (d.prepare('select count(*) c from messages where recipient = ? and read_at is null').get(name) as { c: number }).c;
  const row = (a: db.Agent) => [a.name.padEnd(28), a.tool.padEnd(7), a.status.padEnd(8), String(unread(a.name)).padEnd(6), ago(now - (a.heartbeat_at ?? a.updated_at)).padEnd(7), ahead(a.name).padEnd(6), `${a.task ?? '-'}${a.scope ? ` [${a.scope}]` : ''}`].join(' ');
  const header = ['agent'.padEnd(28), 'tool'.padEnd(7), 'status'.padEnd(8), 'unread', 'active'.padEnd(7), 'branch', 'task'].join(' ');
  const out = agents.length ? [header, ...agents.map(row)] : ['no agents'];
  out.push('', ...(claims.length ? claims.map(c => `${c.file.padEnd(40)} ${c.agent.padEnd(28)} ${c.kind.padEnd(7)} ${c.intent}`) : ['no claims']));
  return out.join('\n') + '\n';
}
export function lsAll(): string {
  const projects = knownProjects();
  if (!projects.length) return 'no chord projects on this machine yet\n';
  const repoOf = (dir?: string) => { try { return dir ? resolveProject(dir).repo : undefined; } catch { return undefined; } };
  return projects.map(p => {
    try { return `== ${p.dir ?? p.stateDir}\n${ls(db.openDb(p.dbFile), repoOf(p.dir ?? undefined))}`; } catch (e) { return `== ${p.dir ?? p.stateDir}\n(unreadable: ${(e as Error).message})\n`; }
  }).join('\n');
}

/** chord messages [agent] [-n N]: the latest messages, oldest first, one line each. */
export function messages(d: ReturnType<typeof db.openDb>, agent?: string, limit = 50, now = Date.now()): string {
  const ms = db.listMessages(d, agent, limit);
  if (!ms.length) return agent ? `no messages to or from ${agent}\n` : 'no messages\n';
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
  return ms.map(m => `${when(m.created_at, now)} ${m.sender} -> ${m.recipient}${m.kind !== 'message' ? ` [${m.kind}]` : ''}${m.read_at ? '' : ' (unread)'}: ${oneLine(m.body)}`).join('\n') + '\n';
}

/** chord events [agent] [-n N]: claims, releases, merges and conflicts, oldest first. */
export function events(d: ReturnType<typeof db.openDb>, agent?: string, limit = 50, now = Date.now()): string {
  const es = db.listEvents(d, agent, limit);
  if (!es.length) return agent ? `no events for ${agent}\n` : 'no events\n';
  return es.map(e => `${when(e.at, now)} ${e.agent.padEnd(28)} ${e.kind.padEnd(8)} ${[e.file, e.detail].filter(Boolean).join(' ')}`).join('\n') + '\n';
}

/** chord stop <agent>: the wrapper quits the tool once the agent is idle and nothing is typed. */
export function stop(d: ReturnType<typeof db.openDb>, name: string): string {
  if (db.requestStop(d, name)) return `stop requested: ${name} will quit when its current turn ends and its input box is empty\n`;
  throw new Error(db.getAgent(d, name) ? `${name} is already offline` : `no such agent: ${name}`);
}

/** chord resume <agent>: the launch of that agent again under its own tool, reopening the conversation its hooks
 *  recorded. Every agent runs in the project folder, so the tools' "latest conversation here" could be anyone's. */
export function resumeArgv(d: ReturnType<typeof db.openDb>, name: string, more: string[]): string[] {
  const a = db.getAgent(d, name);
  if (!a) throw new Error(`no such agent: ${name}`);
  if (!a.session_id) throw new Error(`no recorded conversation for ${name}; start it again with chord ${a.tool} --name ${name}`);
  return [a.tool, '--name', a.name, ...(a.tool === 'codex' ? ['resume', a.session_id] : ['--resume', a.session_id]), ...more];
}

/** [agent] and -n N for the history commands. */
export function listArgs(rest: string[]): { agent?: string; limit: number } {
  let agent: string | undefined, limit = 50;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '-n') { limit = Number(rest[++i]); if (!Number.isInteger(limit) || limit <= 0) throw new Error('-n needs a positive number'); }
    else if (rest[i].startsWith('-')) throw new Error(`unknown option ${rest[i]}`);
    else if (agent) throw new Error('give at most one agent name');
    else agent = rest[i];
  }
  return { agent, limit };
}

/** `--name <x>` or `--name=<x>` anywhere before the tool's own arguments. */
/** The user's own `--settings <json|file>` for Claude, removed from the tool arguments: passed through as is it would
 *  replace chord's --settings wholesale and switch the hooks off, so chord folds it under its own instead. */
export function takeSettings(rest: string[]): Record<string, any> | undefined {
  let raw: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--settings') { raw = rest[i + 1]; if (raw === undefined || raw.startsWith('-')) throw new Error('--settings needs a value'); rest.splice(i, 2); break; }
    if (a.startsWith('--settings=')) { raw = a.slice(11); rest.splice(i, 1); break; }
  }
  if (raw === undefined) return undefined;
  const text = fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8') : raw;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`--settings must be a JSON object or a path to a JSON file: ${raw}`); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('--settings must be a JSON object');
  return parsed as Record<string, any>;
}

/** Tool flags that would silently disable chord's hooks or MCP server: refused rather than launched half-working. */
export function refuseHookKillers(tool: Tool, rest: string[]): void {
  if (tool === 'claude') {
    for (const flag of ['--bare', '--safe-mode', '--disable-all-hooks']) if (rest.includes(flag)) throw new Error(`${flag} switches off the hooks chord relies on; run plain claude for that`);
  } else {
    for (let i = 0; i < rest.length; i++) {
      const v = rest[i] === '-c' || rest[i] === '--config' ? rest[i + 1] ?? '' : rest[i].startsWith('--config=') ? rest[i].slice(9) : '';
      if (/^(hooks\b|mcp_servers\.chord\b)/.test(v)) throw new Error(`"-c ${v}" would replace chord's own hooks or MCP server; chord sets these itself`);
      // Codex's Windows sandbox runs commands as a restricted user that cannot start chord's hooks (nor reach the
      // state under the user's profile), so claims would go unchecked; refused rather than run half-working
      const sandbox = rest[i] === '-s' || rest[i] === '--sandbox' ? rest[i + 1] ?? '' : rest[i].startsWith('--sandbox=') ? rest[i].slice(10) : /^sandbox_mode\s*=\s*"?([\w-]+)/.exec(v)?.[1] ?? '';
      if (process.platform === 'win32' && sandbox && sandbox !== 'danger-full-access') throw new Error(`Codex's "${sandbox}" sandbox cannot run chord's hooks on Windows (the sandboxed user cannot start them), so file claims would not be checked; run without -s, or with -s danger-full-access`);
    }
  }
}

export function takeName(rest: string[]): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--name') {
      const v = rest[i + 1];
      if (!v || v.startsWith('-')) throw new Error('--name needs a value');
      rest.splice(i, 2); return v;
    }
    if (a.startsWith('--name=')) { rest.splice(i, 1); const v = a.slice(7); if (!v) throw new Error('--name needs a value'); return v; }
  }
  return undefined;
}

/** The folder is a repository root: offer to move it into a child directory so it fits the project layout.
 *  Throws with guidance when that is impossible or declined. */
async function offerRestructure(e: NeedsRestructure): Promise<void> {
  const example = path.join(e.dir, e.suggestedName);
  const blocker = restructureBlocker(e.dir);
  if (blocker) throw new Error(`${e.message}; ${blocker}`);
  if (!process.stdin.isTTY) throw new Error(`${e.message}. Move it into a subfolder (e.g. ${example}) and run chord in ${e.dir} again`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(`chord: ${e.dir} is itself a git repository.\n` +
      `A chord project is a folder that contains the repository as a subfolder, next to chord's own working directory.\n` +
      `Move everything in ${e.dir} into ${example}${path.sep} ? Open editors, other terminals' current directory and absolute paths in IDE settings will need updating.\n`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = (await rl.question(`[Y/n/other name] (${e.suggestedName}): `)).trim();
      if (/^n(o)?$/i.test(answer)) throw new Error('not moved; move the repository into a subfolder yourself and run chord in the parent folder');
      const name = answer === '' || /^y(es)?$/i.test(answer) ? e.suggestedName : answer;
      const invalid = validateRepoName(name) ?? (fs.existsSync(path.join(e.dir, name)) ? `${name} already exists` : null);
      if (invalid) { process.stderr.write(`chord: ${invalid}; try another name\n`); continue; }
      const target = restructure(e.dir, name);
      process.stderr.write(`chord: moved the repository to ${target}\n`);
      return;
    }
    throw new Error('no usable name given; nothing was moved');
  } finally { rl.close(); }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'ls') {
    if (rest.includes('--all')) { process.stdout.write(lsAll()); return 0; }
    let project;
    try { project = resolveProject(process.cwd()); } catch (e) {
      if (e instanceof NeedsRestructure) throw new Error(`${e.message}; run \`chord claude\` or \`chord codex\` here to set the project up, or \`chord ls --all\` for every project`);
      throw new Error(`${(e as Error).message}; use \`chord ls --all\` for every project on this machine`);
    }
    const file = db.dbPath(project.stateDir);
    if (!fs.existsSync(file)) { process.stdout.write(`no agents have run in ${project.dir} yet\n`); return 0; }
    process.stdout.write(ls(db.openDb(file), project.repo));
    return 0;
  }
  if (cmd === 'messages' || cmd === 'events' || cmd === 'stop' || cmd === 'resume') {
    const project = resolveProject(process.cwd());
    const file = db.dbPath(project.stateDir);
    if (!fs.existsSync(file)) { process.stdout.write(`no agents have run in ${project.dir} yet\n`); return 0; }
    const d = db.openDb(file);
    if (cmd === 'stop') { if (rest.length !== 1) { process.stderr.write(USAGE); return 2; } process.stdout.write(stop(d, rest[0])); return 0; }
    if (cmd === 'resume') { if (!rest[0] || rest[0].startsWith('-')) { process.stderr.write(USAGE); return 2; } return main(resumeArgv(d, rest[0], rest.slice(1))); }
    const { agent, limit } = listArgs(rest);
    process.stdout.write(cmd === 'messages' ? messages(d, agent, limit) : events(d, agent, limit));
    return 0;
  }
  if (cmd === 'clean') {
    const project = resolveProject(process.cwd());
    const file = db.dbPath(project.stateDir);
    if (!fs.existsSync(file)) { process.stdout.write(`no agents have run in ${project.dir} yet\n`); return 0; }
    const force = rest.includes('--force');
    const r = clean(project, db.openDb(file), rest.filter(a => a !== '--force'), force);
    for (const n of r.removed) process.stdout.write(`removed ${n}\n`);
    for (const k of r.kept) process.stdout.write(`kept ${k.name}: ${k.why}\n`);
    if (!r.removed.length && !r.kept.length) process.stdout.write('nothing to clean\n');
    return 0;
  }
  if (cmd !== 'claude' && cmd !== 'codex') { process.stderr.write(USAGE); return 2; }
  const name = takeName(rest);
  const userSettings = cmd === 'claude' ? takeSettings(rest) : undefined;
  refuseHookKillers(cmd as Tool, rest);
  resolveCommand(cmd); // fail before creating a workspace when the tool is not installed
  let launch;
  try {
    launch = prepare(cmd as Tool, process.cwd(), name);
  } catch (e) {
    if (!(e instanceof NeedsRestructure)) throw e;
    await offerRestructure(e);
    launch = prepare(cmd as Tool, process.cwd(), name);
  }
  process.stderr.write(`chord: agent ${launch.name}; worktree ${launch.worktree}\n`);
  if (userSettings) launch.args = mergeUserSettings(launch.args, userSettings);
  if (cmd === 'codex') {
    const off = disabledCodexHooks();
    if (off.length) process.stderr.write(`chord: Codex has chord's ${off.join(', ')} hook(s) switched off in ~/.codex/config.toml, so the matching chord features will not work. Remove the "enabled = false" line(s) under the [hooks.state.'...<session-flags>...'] tables to switch them back on.\n`);
  }
  const spawned = cmd === 'codex' ? await codexFirstStart() : () => {};
  const exit = run(cmd as Tool, launch, rest);
  spawned();
  return exit;
}

// run only as the entry point (argv[1] may be a symlink such as an npm bin link)
const isMain = (() => { try { return fs.realpathSync.native(process.argv[1] ?? '') === fs.realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => { process.stderr.write(`chord: ${(e as Error).message}\n`); process.exit(1); });
}
