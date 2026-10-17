#!/usr/bin/env node
// chord <claude|codex> [--name <agent>] [tool args...]   launch an agent in its own workspace
// chord ls [--all]                                        agents and file claims, this project or all
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import * as db from './db.ts';
import { prepare } from './launch.ts';
import { NeedsRestructure, knownProjects, resolveProject, restructure, restructureBlocker, validateRepoName } from './project.ts';
import { run } from './pty.ts';
import type { Tool } from './hooks.ts';

const USAGE = 'usage: chord <claude|codex> [--name <agent>] [tool args...]\n       chord ls [--all]\n';

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
  return projects.map(p => `== ${p.dir ?? p.stateDir}\n${ls(db.openDb(p.dbFile))}`).join('\n');
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
    if (rest[0] !== '--all') {
      try { process.stdout.write(ls(db.openDb(db.dbPath(resolveProject(process.cwd()).stateDir)))); return 0; } catch { /* not in a project: fall through */ }
    }
    process.stdout.write(lsAll());
    return 0;
  }
  if (cmd !== 'claude' && cmd !== 'codex') { process.stderr.write(USAGE); return 2; }
  let name: string | undefined;
  if (rest[0] === '--name') { name = rest[1]; rest.splice(0, 2); }
  let launch;
  try {
    launch = prepare(cmd as Tool, process.cwd(), name);
  } catch (e) {
    if (!(e instanceof NeedsRestructure)) throw e;
    await offerRestructure(e);
    launch = prepare(cmd as Tool, process.cwd(), name);
  }
  process.stderr.write(`chord: agent ${launch.name} in ${launch.cwd}\n`);
  return run(cmd as Tool, launch, rest);
}

if (/cli\.ts$/.test(process.argv[1] ?? '')) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => { process.stderr.write(`chord: ${(e as Error).message}\n`); process.exit(1); });
}
