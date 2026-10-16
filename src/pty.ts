// Run the agent under a pseudo-terminal: pass the user's keyboard through, and when the
// agent is idle with unread messages, type them in as if the user had.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pty from 'node-pty';
import * as db from './db.ts';
import { formatMessages, type Tool } from './hooks.ts';
import type { Launch } from './launch.ts';

/** Executable and leading args for a tool. On Windows an npm .cmd shim is unwrapped to
 *  `node <script>` so JSON arguments reach the process intact instead of going through cmd.exe. */
export function resolveCommand(tool: string, readFile = (f: string) => fs.readFileSync(f, 'utf8'), lookup = whereIs): { file: string; args: string[] } {
  if (process.platform !== 'win32') return { file: tool, args: [] };
  const hit = lookup(tool);
  if (!hit) throw new Error(`${tool} not found on PATH`);
  if (!/\.cmd$/i.test(hit)) return { file: hit, args: [] };
  const m = /"%dp0%\\([^"]+\.(?:js|mjs|cjs))"/.exec(readFile(hit));
  if (!m) throw new Error(`cannot read the script path from ${hit}`);
  return { file: process.execPath, args: [path.join(path.dirname(hit), m[1])] };
}

function whereIs(tool: string): string | undefined {
  try {
    const hits = execFileSync('where', [tool], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    return hits.find(h => /\.(exe|cmd)$/i.test(h)) ?? hits[0];
  } catch { return undefined; }
}

/** Decide whether chord may type into the terminal right now. */
export class InputGate {
  private typedSinceEnter = false;
  private lastKeyAt = 0;
  private staleMs: number;
  constructor(staleMs = 60_000) { this.staleMs = staleMs; }
  onUserInput(data: string, now = Date.now()): void {
    this.lastKeyAt = now;
    this.typedSinceEnter = !/[\r\n\x1b]$/.test(data) && data.length > 0;
  }
  /** True when the input box is believed empty, or the user walked away mid-sentence. */
  clear(now = Date.now()): boolean {
    // ponytail: cannot see the real input box; treat any keystroke since the last Enter/Esc as a draft
    return !this.typedSinceEnter || now - this.lastKeyAt > this.staleMs;
  }
}

export const injectionText = (ms: db.Message[]) => formatMessages(ms) + '\n\nReply to the sender with the chord send tool if a reply is needed.';

export function run(tool: Tool, launch: Launch, extraArgs: string[]): Promise<number> {
  const { file, args } = resolveCommand(tool);
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...launch.env };
  for (const k of Object.keys(env)) if (/^CLAUDECODE/.test(k)) delete env[k]; // allow launching from inside a Claude session
  const term = pty.spawn(file, [...args, ...launch.args, ...extraArgs], {
    name: 'xterm-256color', cols: process.stdout.columns || 120, rows: process.stdout.rows || 40, cwd: launch.worktree, env,
  });
  const d = db.openDb(launch.dbFile);
  db.addAgent(d, { name: launch.name, tool, pid: term.pid, cwd: launch.worktree });

  term.onData(x => process.stdout.write(x));
  const gate = new InputGate();
  const onKey = (x: Buffer) => { const s = x.toString(); gate.onUserInput(s); term.write(s); };
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onKey);
  const onResize = () => term.resize(process.stdout.columns || 120, process.stdout.rows || 40);
  process.stdout.on('resize', onResize);

  const timer = setInterval(() => {
    if (db.getAgent(d, launch.name)?.status !== 'idle' || !db.hasUnread(d, launch.name) || !gate.clear()) return;
    const ms = db.takeUnread(d, launch.name);
    db.setStatus(d, launch.name, 'busy'); // the UserPromptSubmit hook will set this too; avoid a second injection meanwhile
    term.write(injectionText(ms));
    setTimeout(() => term.write('\r'), 400); // Enter must arrive separately or the TUI treats it as pasted text
  }, 1000);

  return new Promise(resolve => {
    term.onExit(({ exitCode }) => {
      clearInterval(timer);
      process.stdin.off('data', onKey);
      process.stdout.off('resize', onResize);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      db.setStatus(d, launch.name, 'offline');
      db.releaseAll(d, launch.name);
      resolve(exitCode);
    });
  });
}
