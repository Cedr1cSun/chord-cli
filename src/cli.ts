#!/usr/bin/env node
// chord <claude|codex> [--name <agent>] [tool args...]   launch an agent in its own worktree
// chord ls                                               show agents and file claims
import * as db from './db.ts';
import { prepare } from './launch.ts';
import { run } from './pty.ts';
import type { Tool } from './hooks.ts';

const USAGE = 'usage: chord <claude|codex> [--name <agent>] [tool args...]\n       chord ls\n';

export function ls(d: ReturnType<typeof db.openDb>): string {
  db.sweep(d);
  const agents = db.listAgents(d);
  const claims = db.allClaims(d);
  const out = agents.length ? agents.map(a => `${a.name.padEnd(28)} ${a.tool.padEnd(7)} ${a.status.padEnd(8)} ${a.task ?? '-'}${a.scope ? ` [${a.scope}]` : ''}`) : ['no agents'];
  out.push('', ...(claims.length ? claims.map(c => `${c.file.padEnd(40)} ${c.agent.padEnd(28)} ${c.kind.padEnd(7)} ${c.intent}`) : ['no claims']));
  return out.join('\n') + '\n';
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'ls') { process.stdout.write(ls(db.openDb(db.dbPath(process.cwd())))); return 0; }
  if (cmd !== 'claude' && cmd !== 'codex') { process.stderr.write(USAGE); return 2; }
  let name: string | undefined;
  if (rest[0] === '--name') { name = rest[1]; rest.splice(0, 2); }
  const launch = prepare(cmd as Tool, process.cwd(), name);
  process.stderr.write(`chord: agent ${launch.name} in ${launch.worktree}\n`);
  return run(cmd as Tool, launch, rest);
}

if (/cli\.ts$/.test(process.argv[1] ?? '')) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => { process.stderr.write(`chord: ${(e as Error).message}\n`); process.exit(1); });
}
