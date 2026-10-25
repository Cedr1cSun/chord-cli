#!/usr/bin/env node
// The chord command line; see USAGE.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { clean, type CleanResult } from './clean.ts';
import * as db from './db.ts';
import { mergeUserSettings, prepare } from './launch.ts';
import { NeedsRestructure, knownProjects, resolveProject, restructure, restructureBlocker, validateRepoName } from './project.ts';
import { resolveCommand, run } from './pty.ts';
import { codexFirstStart, disabledCodexHooks } from './trust.ts';
import type { Tool } from './hooks.ts';

const USAGE = [
  'usage: chord <command> [arguments]',
  '',
  '  chord claude [--name <agent>] ...   start a Claude Code agent here',
  '  chord codex [--name <agent>] ...    start a Codex agent here',
  "  chord resume <agent> ...            reopen an agent's conversation",
  '  chord ls [--all]                    agents and claims (--all: every project)',
  '  chord messages [agent] [-n N]       message history, latest N',
  '  chord events [agent] [-n N]         claims, releases, merges, conflicts',
  '  chord stop <agent>                  quit an agent once it is idle',
  "  chord clean [--force] [agent...]    remove offline agents' worktrees",
  '  chord --version',
  '',
  '  ... stands for arguments passed on to the tool.',
  '',
].join('\n');

const gitOut = (cwd: string, ...args: string[]): string | undefined => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', env: db.gitEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return undefined; }
};

/** "12s", "3m", "2h", "5d": how long ago. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

/** Local time of day; another day reads "Oct 17 23:39" (a numeric date differs between the UK and the US), another
 *  year adds the year. */
export function when(t: number, now = Date.now()): string {
  const d = new Date(t), n = new Date(now), pad = (x: number) => String(x).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (d.toDateString() === n.toDateString()) return time;
  return `${d.toDateString().slice(4, 10)}${d.getFullYear() === n.getFullYear() ? '' : ` ${d.getFullYear()}`} ${time.slice(0, 5)}`;
}

// East Asian wide and fullwidth ranges, plus emoji: two terminal cells each
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

/** Terminal cells `s` takes. */
export function width(s: string): number {
  let n = 0;
  for (const ch of s) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

/** `s` cut to `max` cells with an ASCII "..." (the ellipsis character is ambiguous-width). */
export function fit(s: string, max: number): string {
  if (width(s) <= max) return s;
  let out = '', n = 0;
  for (const ch of s) { const w = WIDE.test(ch) ? 2 : 1; if (n + w > max - 3) break; out += ch; n += w; }
  return out + '...';
}

/** Agents (status, unread messages, commits on their branch not yet on main, task), each followed by its claims. `repo`
 *  is the main checkout; without it the branch column shows "?". `cols` is the terminal width: lines are cut to fit. */
export function ls(d: ReturnType<typeof db.openDb>, repo?: string, now = Date.now(), cols = Infinity): string {
  db.sweep(d, undefined, undefined, 2500); // a short watch, so a killed wrapper whose pid was reused is not shown online for ever
  const agents = db.listAgents(d);
  const main = repo ? gitOut(repo, 'rev-parse', '--abbrev-ref', 'HEAD') : undefined;
  const ahead = (name: string) => { if (!repo || !main) return '?'; const n = gitOut(repo, 'rev-list', '--count', `${main}..chord/${name}`); return n === undefined ? '-' : `+${n}`; };
  // messages only: a merge notice never wakes an agent, so it is not waiting on anyone
  const unread = (name: string) => (d.prepare("select count(*) c from messages where recipient = ? and read_at is null and kind = 'message'").get(name) as { c: number }).c;
  const label = (a: db.Agent) => (a.name.startsWith(`${a.tool}-`) ? a.name : `${a.name} (${a.tool})`);
  const nameW = Math.max(5, ...agents.map(a => label(a).length));
  // a live agent's heartbeat is always seconds old, so the age only means something once it is offline
  const state = (a: db.Agent) => (a.status === 'offline' ? `off ${ago(now - (a.heartbeat_at ?? a.updated_at))}` : a.status);
  const row = (a: db.Agent) => {
    const head = [label(a).padEnd(nameW), state(a).padEnd(8), String(unread(a.name)).padEnd(6), ahead(a.name).padEnd(6), ''].join(' ');
    return head + fit(`${a.task ?? '-'}${a.scope ? ` [${a.scope}]` : ''}`, cols - head.length);
  };
  const header = ['agent'.padEnd(nameW), 'status'.padEnd(8), 'unread', 'branch', 'task'].join(' ');
  // each agent's claims under its row; a file held by several agents says so on each of their lines
  const also = (c: db.Claim) => { const o = db.claimsFor(d, c.file).filter(x => x.agent !== c.agent).map(x => x.agent); return o.length ? ` (also ${o.join(', ')})` : ''; };
  const claimLines = (a: db.Agent) => db.claimsBy(d, a.name).map(c => fit(`    ${c.kind.padEnd(6)} ${c.file}  ${c.intent}${also(c)}`, cols));
  if (!agents.length) return 'no agents\n';
  return [header, ...agents.flatMap(a => [row(a), ...claimLines(a)])].join('\n') + '\n';
}
export function lsAll(cols = Infinity): string {
  const projects = knownProjects();
  if (!projects.length) return 'no chord projects on this machine yet\n';
  const repoOf = (dir?: string) => { try { return dir ? resolveProject(dir).repo : undefined; } catch { return undefined; } };
  return projects.map(p => {
    try { return `== ${p.dir ?? p.stateDir}\n${ls(db.openDb(p.dbFile), repoOf(p.dir ?? undefined), Date.now(), cols)}`; } catch (e) { return `== ${p.dir ?? p.stateDir}\n(unreadable: ${(e as Error).message})\n`; }
  }).join('\n');
}

/** chord messages [agent] [-n N]: the latest sends, oldest first, one line each. */
export function messages(d: ReturnType<typeof db.openDb>, agent?: string, limit = 50, now = Date.now()): string {
  const ms = db.listMessages(d, agent, limit);
  if (!ms.length) return agent ? `no messages to or from ${agent}\n` : 'no messages\n';
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
  const body = (m: db.MessageGroup) => (m.kind === 'notice' && m.body.endsWith('\n' + db.NOTICE_TAIL) ? m.body.slice(0, -db.NOTICE_TAIL.length - 1) : m.body);
  const to = (m: db.MessageGroup) => (m.n > 3 ? `${m.n} agents` : m.recipient);
  const flag = (m: db.MessageGroup) => (m.unread === 0 ? '' : m.unread === m.n ? ' (unread)' : ` (${m.unread}/${m.n} unread)`);
  return ms.map(m => `${when(m.created_at, now)} ${m.sender} -> ${to(m)}${m.kind !== 'message' ? ` [${m.kind}]` : ''}${flag(m)}: ${oneLine(body(m))}`).join('\n') + '\n';
}

/** chord events [agent] [-n N]: claims, releases, merges and conflicts, oldest first. */
export function events(d: ReturnType<typeof db.openDb>, agent?: string, limit = 50, now = Date.now()): string {
  const es = db.listEvents(d, agent, limit);
  if (!es.length) return agent ? `no events for ${agent}\n` : 'no events\n';
  const w = Math.max(...es.map(e => e.agent.length));
  return es.map(e => `${when(e.at, now)} ${e.agent.padEnd(w)} ${e.kind.padEnd(8)} ${[e.file, e.detail].filter(Boolean).join(' ')}`).join('\n') + '\n';
}

/** What chord says when the tool has exited: how to carry on, or why resume cannot yet. */
export function quitHint(d: ReturnType<typeof db.openDb>, name: string): string {
  const a = db.getAgent(d, name);
  return a?.session_id
    ? `chord: ${name} quit; \`chord resume ${name}\` continues it\n`
    : `chord: ${name} quit before its conversation was recorded; start it again with chord ${a?.tool ?? 'claude'} --name ${name}\n`;
}

/** chord clean's report: what went, what stayed and why, and the exact --force that would discard the held work. */
export function cleanReport(r: CleanResult): string {
  const lines = [...r.removed.map(n => `removed ${n}`), ...r.kept.map(k => `kept ${k.name}: ${k.why}`)];
  // named, so the hint never reads as a bare "chord clean --force", which would discard every offline agent's work
  const held = r.kept.filter(k => /^(unmerged|uncommitted)/.test(k.why)).map(k => k.name);
  if (held.length) lines.push(`to discard their work: chord clean --force ${held.join(' ')}`);
  return (lines.length ? lines : ['nothing to clean']).join('\n') + '\n';
}

/** chord stop <agent>: the wrapper quits the tool once the agent is idle and nothing is typed. `watchMs`: see db.sweep;
 *  a wrapper that died with its pid reused must be found out here, or the quit is promised and never comes. */
export function stop(d: ReturnType<typeof db.openDb>, name: string, watchMs = 2500): string {
  db.sweep(d, undefined, undefined, watchMs);
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

/** `[--force|-f] [agent...]` for chord clean. */
export function cleanArgs(rest: string[]): { names: string[]; force: boolean } {
  const names: string[] = [];
  let force = false;
  for (const a of rest) {
    if (a === '--force' || a === '-f') force = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else names.push(a);
  }
  return { names, force };
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
  if (cmd === undefined || cmd === 'help' || cmd === '-h' || cmd === '--help') { process.stdout.write(USAGE); return 0; }
  if (cmd === '--version' || cmd === '-V') { process.stdout.write(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version + '\n'); return 0; }
  // argument shapes are checked before the project is looked up, so a typo gets one line, not a project error
  if (cmd === 'stop' && rest.length !== 1) { process.stderr.write('usage: chord stop <agent>\n'); return 2; }
  if (cmd === 'resume' && (!rest[0] || rest[0].startsWith('-'))) { process.stderr.write('usage: chord resume <agent> [tool args...]\n'); return 2; }
  if (cmd === 'ls') {
    const bad = rest.find(a => a !== '--all');
    if (bad) throw new Error(`unknown argument ${bad}; usage: chord ls [--all]`);
    const cols = process.stdout.isTTY ? process.stdout.columns ?? Infinity : Infinity; // piped output is never cut
    if (rest.includes('--all')) { process.stdout.write(lsAll(cols)); return 0; }
    let project;
    try { project = resolveProject(process.cwd()); } catch (e) {
      if (e instanceof NeedsRestructure) throw new Error(`${e.message}; run \`chord claude\` or \`chord codex\` here to set the project up, or \`chord ls --all\` for every project`);
      throw new Error(`${(e as Error).message}; use \`chord ls --all\` for every project on this machine`);
    }
    const file = db.dbPath(project.stateDir);
    if (!fs.existsSync(file)) { process.stdout.write(`no agents have run in ${project.dir} yet\n`); return 0; }
    process.stdout.write(ls(db.openDb(file), project.repo, Date.now(), cols));
    return 0;
  }
  if (cmd === 'messages' || cmd === 'events' || cmd === 'stop' || cmd === 'resume') {
    const project = resolveProject(process.cwd());
    const file = db.dbPath(project.stateDir);
    if (!fs.existsSync(file)) { process.stdout.write(`no agents have run in ${project.dir} yet\n`); return 0; }
    const d = db.openDb(file);
    if (cmd === 'stop') { process.stdout.write(stop(d, rest[0])); return 0; }
    if (cmd === 'resume') return main(resumeArgv(d, rest[0], rest.slice(1)));
    const { agent, limit } = listArgs(rest);
    process.stdout.write(cmd === 'messages' ? messages(d, agent, limit) : events(d, agent, limit));
    return 0;
  }
  if (cmd === 'clean') {
    const project = resolveProject(process.cwd());
    const file = db.dbPath(project.stateDir);
    if (!fs.existsSync(file)) { process.stdout.write(`no agents have run in ${project.dir} yet\n`); return 0; }
    const { names, force } = cleanArgs(rest);
    process.stdout.write(cleanReport(clean(project, db.openDb(file), names, force)));
    return 0;
  }
  if (cmd !== 'claude' && cmd !== 'codex') { process.stderr.write(`chord: unknown command "${cmd}"\n${USAGE}`); return 2; }
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
  spawned(); // right after the spawn: it releases the Codex first-start lock
  const code = await exit;
  // the tool's own parting line (Codex prints "codex resume <id>") would start it outside chord
  process.stderr.write(quitHint(db.openDb(launch.dbFile), launch.name));
  return code;
}

// run only as the entry point (argv[1] may be a symlink such as an npm bin link)
const isMain = (() => { try { return fs.realpathSync.native(process.argv[1] ?? '') === fs.realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => { process.stderr.write(`chord: ${(e as Error).message}\n`); process.exit(1); });
}
