// Run the agent under a pseudo-terminal: pass the user's keyboard through, and when the
// agent is idle with unread messages, type them in as if the user had.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pty from 'node-pty';
import * as db from './db.ts';
import type { Tool } from './hooks.ts';
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

/**
 * Characters the user typed, out of a raw stdin chunk. Under ConPTY keys arrive in win32-input-mode,
 * `ESC [ Vk ; Sc ; Uc ; KeyDown ; Ctrl ; Repeat _`, one event per key press and release, and a chunk
 * may end mid-sequence; `hold` receives such a tail to prepend to the next chunk. Other escape
 * sequences (arrows, terminal replies to queries) are dropped: they are not a draft.
 */
export function decodeKeys(data: string, hold: (rest: string) => void): string {
  if (data === '\x1b') { hold(''); return data; } // a bare Esc key outside win32-input-mode
  const tail = data.lastIndexOf('\x1b');
  if (tail >= 0 && !/^\x1b(\[[0-9;?]*[ -/]*[@-~]|[^[])/.test(data.slice(tail))) { hold(data.slice(tail)); data = data.slice(0, tail); } else hold('');
  const ESC = ''; // stands in for a decoded Esc key while other sequences are stripped
  return data
    .replace(/\x1b\[(\d+);(\d+);(\d+);(\d+);(\d+);(\d+)_/g, (_, _vk, _sc, uc, down) =>
      down !== '1' || Number(uc) === 0 ? '' : Number(uc) === 27 ? ESC : String.fromCharCode(Number(uc)))
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[^[]/g, '')
    .replaceAll(ESC, '\x1b');
}

/** Decide whether chord may type into the terminal right now. */
export class InputGate {
  private typedSinceEnter = false;
  private lastKeyAt = 0;
  private staleMs: number;
  constructor(staleMs = 60_000) { this.staleMs = staleMs; }
  private pending = '';
  onUserInput(data: string, now = Date.now()): void {
    const text = decodeKeys(this.pending + data, rest => { this.pending = rest; });
    if (!text) return;
    this.lastKeyAt = now;
    this.typedSinceEnter = !/[\r\n\x1b]$/.test(text);
  }
  /** True when the input box is believed empty, or the user walked away mid-sentence. */
  clear(now = Date.now()): boolean {
    // ponytail: cannot see the real input box; treat any keystroke since the last Enter/Esc as a draft
    return !this.typedSinceEnter || now - this.lastKeyAt > this.staleMs;
  }
}

export const NUDGE = '[chord] You have new messages from other agents; they are attached to this prompt. Handle them, replying with the chord send tool where needed.';

export type Action = 'nudge' | 'enter' | null;

/** What the idle-wake loop should do this tick. Messages stay in the inbox until the
 *  UserPromptSubmit hook takes them, so a lost keystroke is retried, never dropped. */
export function nextAction(s: { status: string | undefined; unread: boolean; gateClear: boolean; nudgedAt: number }, now: number): Action {
  if (s.status !== 'idle' || !s.unread || !s.gateClear) return null;
  if (!s.nudgedAt || now - s.nudgedAt > 30_000) return 'nudge'; // first try, or the typed text was lost
  if (now - s.nudgedAt > 5_000) return 'enter'; // typed but not submitted: press Enter again
  return null;
}

export function run(tool: Tool, launch: Launch, extraArgs: string[]): Promise<number> {
  const { file, args } = resolveCommand(tool);
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...launch.env };
  for (const k of Object.keys(env)) if (/^CLAUDECODE/.test(k)) delete env[k]; // allow launching from inside a Claude session
  const term = pty.spawn(file, [...args, ...launch.args, ...extraArgs], {
    name: 'xterm-256color', cols: process.stdout.columns || 120, rows: process.stdout.rows || 40, cwd: launch.cwd, env,
  });
  const d = db.openDb(launch.dbFile);
  db.addAgent(d, { name: launch.name, tool, pid: term.pid, cwd: launch.cwd, worktree: launch.worktree });

  term.onData(x => process.stdout.write(x));
  const gate = new InputGate();
  const onKey = (x: Buffer) => { const s = x.toString(); if (process.env.CHORD_DEBUG_STDIN) db.log(`stdin ${JSON.stringify(s)}`); gate.onUserInput(s); term.write(s); };
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onKey);
  const onResize = () => term.resize(process.stdout.columns || 120, process.stdout.rows || 40);
  process.stdout.on('resize', onResize);

  Object.assign(process.env, launch.env); // so the wrapper writes to the same chord.db.log as the hooks
  let nudgedAt = 0, lastState = '';
  const timer = setInterval(() => {
    const status = db.getAgent(d, launch.name)?.status;
    if (status !== 'idle') nudgedAt = 0;
    const s = { status, unread: db.hasUnread(d, launch.name), gateClear: gate.clear(), nudgedAt };
    const action = nextAction(s, Date.now());
    const state = `${status}/${s.unread}/${s.gateClear}/${action}`;
    if (state !== lastState) { db.log(`wake loop: status=${status} unread=${s.unread} gateClear=${s.gateClear} action=${action}`); lastState = state; }
    if (!action) return;
    nudgedAt = Date.now();
    if (action === 'nudge') { term.write(NUDGE); setTimeout(() => term.write('\r'), 1000); } // Enter must arrive separately or the TUI treats it as pasted text
    else term.write('\r');
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
