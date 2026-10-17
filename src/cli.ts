#!/usr/bin/env node
// chord <claude|codex> [--name <agent>] [tool args...]   launch an agent in its own workspace
// chord ls [--all]                                        agents and file claims, this project or all
// chord events [agent] [-n N]                             claim, release, merge and conflict history
// chord clean [--force] [agent...]                        remove offline agents' workspaces, worktrees and branches
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { clean } from './clean.ts';
import * as db from './db.ts';
import { prepare } from './launch.ts';
import { NeedsRestructure, knownProjects, resolveProject, restructure, restructureBlocker, validateRepoName } from './project.ts';
import { resolveCommand, run } from './pty.ts';
import { disabledCodexHooks, pretrustClaude } from './trust.ts';
import type { Tool } from './hooks.ts';

const USAGE = 'usage: chord <claude|codex> [--name <agent>] [tool args...]\n       chord ls [--all]\n       chord events [agent] [-n N]\n       chord clean [--force] [agent...]\n';

export function ls(d: ReturnType<typeof db.openDb>): string {
  db.sweep(d);
  const agents = db.listAgents(d);
  const claims = db.allClaims(d);
  const out = agents.length ? agents.map(a => `${a.name.padEnd(28)} ${a.tool.padEnd(7)} ${a.status.padEnd(8)} ${a.task ?? '-'}${a.scope ? ` [${a.scope}]` : ''}`) : ['no agents'];
  out.push('', ...(claims.length ? claims.map(c => `${c.file.padEnd(40)} ${c.agent.padEnd(28)} ${c.kind.padEnd(7)} ${c.intent}`) : ['no claims']));
  return out.join('\n') + '\n';
}

export function lsAll(): string {
  const projects = knownProjects();
  if (!projects.length) return 'no chord projects on this machine yet\n';
  return projects.map(p => {
    try { return `== ${p.dir ?? p.stateDir}\n${ls(db.openDb(p.dbFile))}`; } catch (e) { return `== ${p.dir ?? p.stateDir}\n(unreadable: ${(e as Error).message})\n`; }
  }).join('\n');
}

/** Local time of day, with the date in front when it is not today. */
export function when(t: number, now = Date.now()): string {
  const d = new Date(t), pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

/** chord events [agent] [-n N]: claims, releases, merges and conflicts, oldest first. */
export function events(d: ReturnType<typeof db.openDb>, agent?: string, limit = 50, now = Date.now()): string {
  const es = db.listEvents(d, agent, limit);
  if (!es.length) return agent ? `no events for ${agent}\n` : 'no events\n';
  return es.map(e => `${when(e.at, now)} ${e.agent.padEnd(28)} ${e.kind.padEnd(8)} ${[e.file, e.detail].filter(Boolean).join(' ')}`).join('\n') + '\n';
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
    process.stdout.write(ls(db.openDb(file)));
    return 0;
  }
  if (cmd === 'events') {
    const project = resolveProject(process.cwd());
    const file = db.dbPath(project.stateDir);
    if (!fs.existsSync(file)) { process.stdout.write(`no agents have run in ${project.dir} yet\n`); return 0; }
    const { agent, limit } = listArgs(rest);
    process.stdout.write(events(db.openDb(file), agent, limit));
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
  resolveCommand(cmd); // fail before creating a workspace when the tool is not installed
  let launch;
  try {
    launch = prepare(cmd as Tool, process.cwd(), name);
  } catch (e) {
    if (!(e instanceof NeedsRestructure)) throw e;
    await offerRestructure(e);
    launch = prepare(cmd as Tool, process.cwd(), name);
  }
  process.stderr.write(`chord: agent ${launch.name} in ${launch.cwd}\n`);
  if (cmd === 'claude') pretrustClaude(launch.cwd); // otherwise every new workspace asks "do you trust this folder?"
  if (cmd === 'codex') {
    const off = disabledCodexHooks();
    if (off.length) process.stderr.write(`chord: Codex has chord's ${off.join(', ')} hook(s) switched off in ~/.codex/config.toml, so the matching chord features will not work. Remove the "enabled = false" line(s) under the [hooks.state.'...<session-flags>...'] tables to switch them back on.\n`);
  }
  return run(cmd as Tool, launch, rest);
}

// run only as the entry point (argv[1] may be a symlink such as an npm bin link)
const isMain = (() => { try { return fs.realpathSync.native(process.argv[1] ?? '') === fs.realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => { process.stderr.write(`chord: ${(e as Error).message}\n`); process.exit(1); });
}
