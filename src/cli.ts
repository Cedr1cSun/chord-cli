#!/usr/bin/env node
// chord <claude|codex> [--name <agent>] [tool args...]   launch an agent in its own workspace
// chord ls [--all]                                        agents and file claims, this project or all
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
import { pretrustClaude } from './trust.ts';
import type { Tool } from './hooks.ts';

const USAGE = 'usage: chord <claude|codex> [--name <agent>] [tool args...]\n       chord ls [--all]\n       chord clean [--force] [agent...]\n';

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
  return run(cmd as Tool, launch, rest);
}

// run only as the entry point (argv[1] may be a symlink such as an npm bin link)
const isMain = (() => { try { return fs.realpathSync.native(process.argv[1] ?? '') === fs.realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => { process.stderr.write(`chord: ${(e as Error).message}\n`); process.exit(1); });
}
