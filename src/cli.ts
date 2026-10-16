#!/usr/bin/env node
// chord <claude|codex> [--name <agent>] [tool args...]
import { prepare } from './launch.ts';
import { run } from './pty.ts';
import type { Tool } from './hooks.ts';

const USAGE = 'usage: chord <claude|codex> [--name <agent>] [tool args...]\n';

async function main(argv: string[]): Promise<number> {
  const [tool, ...rest] = argv;
  if (tool !== 'claude' && tool !== 'codex') { process.stderr.write(USAGE); return 2; }
  let name: string | undefined;
  if (rest[0] === '--name') { name = rest[1]; rest.splice(0, 2); }
  const launch = prepare(tool as Tool, process.cwd(), name);
  process.stderr.write(`chord: agent ${launch.name} in ${launch.worktree}\n`);
  return run(tool as Tool, launch, rest);
}

main(process.argv.slice(2)).then(code => process.exit(code), e => { process.stderr.write(`chord: ${(e as Error).message}\n`); process.exit(1); });
