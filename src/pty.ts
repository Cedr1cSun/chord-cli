// Run the agent under a pseudo-terminal: pass the user's keyboard through, and when the
// agent is idle with unread messages, type a nudge in as if the user had.
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import pty from 'node-pty';
import * as db from './db.ts';
import type { Tool } from './hooks.ts';
import { withNodeOnPath, type Launch } from './launch.ts';

/** First PATH entry holding `<tool>.exe` or `<tool>.cmd`. Pure Node: `where.exe` output is in the OEM code page. */
export function whereIs(tool: string, pathVar = process.env.PATH ?? '', exists: (p: string) => boolean = p => fs.existsSync(p)): string | undefined {
  for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
    for (const ext of ['.exe', '.cmd']) { const p = path.join(dir, tool + ext); if (exists(p)) return p; }
  }
  return undefined;
}

/** Executable and leading args for a tool. On Windows an npm .cmd shim is unwrapped to
 *  `node <script>` so JSON arguments reach the process intact instead of going through cmd.exe. */
export function resolveCommand(tool: string, readFile = (f: string) => fs.readFileSync(f, 'utf8'), lookup = whereIs): { file: string; args: string[] } {
  if (process.platform !== 'win32') return { file: tool, args: [] };
  const hit = lookup(tool);
  if (!hit) throw new Error(`${tool} not found on PATH`);
  if (!/\.cmd$/i.test(hit)) return { file: hit, args: [] };
  const m = /"%~?dp0%?\\([^"]+\.(?:js|mjs|cjs))"/.exec(readFile(hit)); // npm writes %dp0%\, pnpm and yarn %~dp0\
  if (!m) throw new Error(`cannot read the script path from ${hit}`);
  return { file: process.execPath, args: [path.join(path.dirname(hit), m[1])] };
}

const ESC_KEY = '';   // a decoded Esc key, kept apart from escape sequences while they are stripped
const SOFT_NL = '';   // Shift+Enter: a newline inside the draft, not a submit

/**
 * Characters the user typed, out of a raw stdin chunk. Under ConPTY keys arrive in win32-input-mode,
 * `ESC [ Vk ; Sc ; Uc ; KeyDown ; Ctrl ; Repeat _`, one event per key press and release, and a chunk may
 * end mid-sequence; `hold` receives such a tail to prepend to the next chunk. Other escape sequences
 * (arrows, mouse reports, terminal replies to queries) are dropped: they are not a draft.
 */
export function decodeKeys(data: string, hold: (rest: string) => void): string {
  if (data === '\x1b') { hold(''); return '\x1b'; } // a bare Esc key outside win32-input-mode
  const lastEsc = data.lastIndexOf('\x1b');
  if (lastEsc >= 0) {
    const tail = data.slice(lastEsc);
    const complete = /^\x1b(\[[0-9;?<>=]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|P[^\x1b]*\x1b\\|O.|[^[\]PO\x1b])/.test(tail) || tail === '\x1b\x1b';
    if (!complete) { hold(tail); data = data.slice(0, lastEsc); } else hold('');
  } else hold('');
  return data
    .replace(/\x1b\[(\d+);(\d+);(\d+);(\d+);(\d+);(\d+)_/g, (_, _vk, _sc, uc, down, ctrl) => {
      if (down !== '1' || Number(uc) === 0) return '';
      const code = Number(uc);
      if (code === 27) return ESC_KEY;
      if (code === 13 && (Number(ctrl) & 0x10)) return SOFT_NL; // SHIFT_PRESSED
      return String.fromCharCode(code);
    })
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')  // OSC (terminal replies, titles)
    .replace(/\x1bP[^\x1b]*\x1b\\/g, '')               // DCS (e.g. XTVERSION replies)
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')      // CSI (arrows, mouse, replies)
    .replace(/\x1bO./g, '')                            // SS3 (application-mode arrows)
    .replace(/\x1b\x1b/g, ESC_KEY)                     // Esc pressed twice outside win32 mode
    .replace(/\x1b[^\x1b]/g, '')                       // Alt+key and other two-byte sequences
    .replaceAll(ESC_KEY, '\x1b');
}

/** Decide whether chord may type into the terminal right now, by tracking what the user has typed but not sent.
 *  The user's interaction always wins: while anything they typed is still in the input box, chord stays out,
 *  however long they take. Messages wait in the inbox until they submit or clear it. */
export class InputGate {
  private draftLen = 0;
  private pending = '';
  private inPaste = false;
  private lastKeyAt = -Infinity; // never
  private lastEscAt = -Infinity;
  onUserInput(data: string, now = Date.now()): void {
    // bracketed paste: its newlines are content, not submits, and a long paste arrives in several chunks
    const pasted = this.inPaste || data.includes('\x1b[200~');
    const open = data.lastIndexOf('\x1b[200~'), close = data.lastIndexOf('\x1b[201~');
    if (open >= 0 || close >= 0) this.inPaste = open > close;
    const text = decodeKeys(this.pending + data, rest => { this.pending = rest; });
    if (!text) return;
    this.lastKeyAt = now;
    if (text.includes('\x1b')) this.lastEscAt = now;
    for (const ch of text) {
      if (ch === '\x15' || ch === '\x03') this.draftLen = 0;                              // Ctrl+U, Ctrl+C clear the line
      else if (ch === '\x7f' || ch === '\x08') this.draftLen = Math.max(0, this.draftLen - 1); // Backspace
      else if ((ch === '\r' || ch === '\n') && !pasted) this.draftLen = 0;                // submitted
      else if (ch !== '\x1b') this.draftLen++;
      // Esc is neither: in Claude Code one press closes a menu or interrupts, in Codex it never empties the box, so the
      // draft is assumed to be still there (erring towards leaving the user alone)
    }
  }
  /** True when the input box is believed empty. */
  clear(): boolean {
    // ponytail: cannot see the real input box; count keystrokes since the last submit as the draft
    return this.draftLen === 0;
  }
  /** True when the user has not touched the keyboard for a while: three seconds after any key, ten after Esc. A
   *  submit takes the hook up to a second to show as busy, and after an interrupt the user is about to type a
   *  correction; chord must not slip its text in between. */
  settled(now = Date.now()): boolean {
    return now - this.lastKeyAt >= 3000 && now - this.lastEscAt >= 10_000;
  }
}

export const NUDGE = '[chord] You have new messages from other agents; they are attached to this prompt. Handle them, replying with the chord send tool where needed.';

/** Terminal output with escape sequences removed (OSC, CSI, DCS, charset selection, other two-byte sequences). */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
    .replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b./g, '');
}

/** What `chord stop` types to quit the tool, once the agent is idle and the input box is empty. */
export const EXIT_COMMAND: Record<Tool, string> = { claude: '/exit', codex: '/quit' };

/** Did the TUI echo the typed text into its input box? A dialog, picker or any other mode that swallows keystrokes
 *  does not echo them, so this is the test before Enter is pressed: Enter in a dialog picks the default answer. Only
 *  the opening characters are checked, with whitespace ignored, so wrapping and re-rendering do not matter. */
export function typedEchoed(output: string, text: string): boolean {
  const squash = (s: string) => stripAnsi(s).replace(/\s+/g, '');
  return squash(output).includes(squash(text).slice(0, 25));
}

/** The terminal title is chord's: "chord <agent> · <task>", so a window or tab can be matched to a `chord ls` row.
 *  The tools set their own titles (Claude Code its session summary, Codex the folder name), so their title
 *  sequences (OSC 0, 1, 2) are removed from the forwarded output; everything else, including Codex's OSC 7501
 *  state reports, passes through. A sequence split across two chunks is held until it completes. */
export class TitleFilter {
  private pending = '';
  push(chunk: string): string {
    let s = this.pending + chunk;
    this.pending = '';
    s = s.replace(/\x1b\][012];[^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
    const i = s.lastIndexOf('\x1b]');
    if (i !== -1 && /^\x1b\](?:[012](?:;[^\x07\x1b]*\x1b?)?)?$/.test(s.slice(i))) { this.pending = s.slice(i); s = s.slice(0, i); }
    return s;
  }
}

export function titleFor(name: string, task: string | null | undefined): string {
  const t = (task ?? '').replace(/\s+/g, ' ').trim();
  return `chord ${name}${t ? ` · ${t.length > 80 ? `${t.slice(0, 79)}…` : t}` : ''}`;
}
export const titleSequence = (title: string) => `\x1b]0;${title.replace(/[\x00-\x1f\x7f]/g, ' ')}\x07`;

export type Typed = 'nudge' | 'stop';
export type Action = Typed | 'enter' | null;

/** What the idle-wake loop should do this tick: type the nudge (unread messages), type the exit command (`chord
 *  stop`), press Enter once more, or nothing. Messages stay in the inbox until a hook takes them, so a lost
 *  keystroke is retried, never dropped. `typed`/`typedAt` say what was last typed and when; `echoed` whether the TUI
 *  showed it; `enters` how many times Enter was pressed for it and `enteredAt` when last. Enter is pressed at most
 *  twice per typed text, never when the text was not echoed, and nothing new is typed while the last text is fresh. */
export function nextAction(s: { status: string | undefined; unread: boolean; stop: boolean; gateClear: boolean; typed: Typed | null; typedAt: number; echoed: boolean; enters: number; enteredAt: number }, now: number): Action {
  if (s.status !== 'idle' || !s.gateClear) return null;
  const want: Typed | null = s.stop ? 'stop' : s.unread ? 'nudge' : null;
  if (!want) return null;
  if (!s.typedAt || now - s.typedAt > 30_000) return want; // first try, or the typed text was lost or swallowed
  if (s.typed !== want) return null; // something else is still in the input box; wait for it to go through or expire
  if (!s.echoed || s.enters !== 1) return null; // swallowed: hands off; never pressed: the user got there first; pressed twice: enough
  if (now - s.enteredAt > 5_000) return 'enter'; // typed and echoed but not submitted: press Enter once more
  return null;
}

/** Codex reports its state to the terminal as OSC 7501 ("state=idle" / "state=working"); Claude Code does not. */
export function oscState(chunk: string): 'idle' | 'busy' | null {
  const m = /\x1b\]7501;state=(\w+)/g;
  let last: 'idle' | 'busy' | null = null;
  for (const x of chunk.matchAll(m)) last = x[1] === 'idle' ? 'idle' : 'busy';
  return last;
}

/** A database call from the wrapper's own callbacks. One that fails (a lock held past busy_timeout while the disk
 *  stalls) is logged and dropped: thrown from a timer or a PTY callback it would end the wrapper and the agent in
 *  it, and the next tick or terminal report puts the state right anyway. */
function tolerant(what: string, f: () => void): void {
  try { f(); } catch (e) { db.log(`${what}: ${(e as Error).message}; skipped`); }
}

export function run(tool: Tool, launch: Launch, extraArgs: string[]): Promise<number> {
  const { file, args } = resolveCommand(tool);
  const env: Record<string, string> = withNodeOnPath({ ...process.env as Record<string, string>, ...launch.env });
  for (const k of Object.keys(env)) if (/^CLAUDECODE/.test(k)) delete env[k]; // allow launching from inside a Claude session
  const term = pty.spawn(file, [...args, ...launch.args, ...extraArgs], {
    name: 'xterm-256color', cols: process.stdout.columns || 120, rows: process.stdout.rows || 40, cwd: launch.cwd, env,
  });
  const d = db.openDb(launch.dbFile);
  db.addAgent(d, { name: launch.name, tool, pid: term.pid, cwd: launch.cwd, worktree: launch.worktree, heartbeat: true });

  let outTail = '', echoBuf = '', awaitingEcho = false;
  const titles = new TitleFilter();
  let title = titleFor(launch.name, null);
  process.stdout.write(titleSequence(title));
  term.onData(x => {
    process.stdout.write(titles.push(x));
    if (awaitingEcho) echoBuf = (echoBuf + x).slice(-16000);
    if (tool === 'codex') { // the hooks set status too; the terminal report catches turns the hooks miss (Esc, untrusted hooks)
      const state = oscState(outTail + x);
      if (state) tolerant('terminal state report', () => db.setStatus(d, launch.name, state));
      outTail = x.slice(-64);
    }
  });
  const gate = new InputGate();
  const decoder = new StringDecoder('utf8'); // a multi-byte character may straddle two stdin chunks
  const onKey = (x: Buffer) => { const s = decoder.write(x); if (!s) return; if (process.env.CHORD_DEBUG_STDIN) db.log(`stdin ${JSON.stringify(s)}`); gate.onUserInput(s); term.write(s); };
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onKey);
  const onResize = () => term.resize(process.stdout.columns || 120, process.stdout.rows || 40);
  process.stdout.on('resize', onResize);

  Object.assign(process.env, launch.env); // so the wrapper writes to the same chord.db.log as the hooks
  let typed: Typed | null = null, typedAt = 0, enteredAt = 0, enters = 0, echoed = false, lastState = '';
  const timer = setInterval(() => tolerant('wake loop', () => {
    db.heartbeat(d, launch.name);
    const me = db.getAgent(d, launch.name);
    const wanted = titleFor(launch.name, me?.task);
    if (wanted !== title) { title = wanted; process.stdout.write(titleSequence(title)); }
    const status = me?.status;
    if (status !== 'idle') { typed = null; typedAt = enteredAt = enters = 0; echoed = false; }
    const s = { status, unread: db.hasUnread(d, launch.name), stop: !!me?.stop_requested_at, gateClear: gate.clear() && gate.settled(), typed, typedAt, echoed, enters, enteredAt };
    const action = nextAction(s, Date.now());
    const state = `${status}/${s.unread}/${s.stop}/${s.gateClear}/${action}`;
    if (state !== lastState) { db.log(`wake loop: status=${status} unread=${s.unread} stop=${s.stop} gateClear=${s.gateClear} action=${action}`); lastState = state; }
    if (!action) return;
    if (action === 'enter') { enteredAt = Date.now(); enters++; term.write('\r'); return; }
    const text = action === 'stop' ? EXIT_COMMAND[tool] : NUDGE;
    typed = action; typedAt = Date.now(); enteredAt = enters = 0; echoed = false;
    echoBuf = ''; awaitingEcho = true;
    term.write(text);
    // Enter must arrive separately or the TUI treats it as pasted text. It is only pressed once the TUI has echoed
    // the text (so a dialog or picker, which swallows keystrokes, never gets an Enter) and the user has not typed.
    setTimeout(() => {
      awaitingEcho = false;
      echoed = typedEchoed(echoBuf, text);
      if (!echoed) { db.log(`wake loop: ${action} text was not echoed, something other than the prompt has the keyboard; not pressing Enter`); return; }
      if (!gate.clear() || !gate.settled()) { db.log('wake loop: the user typed meanwhile; not pressing Enter'); return; }
      term.write('\r'); enteredAt = Date.now(); enters = 1;
    }, 1500);
  }), 1000);

  return new Promise(resolve => {
    term.onExit(({ exitCode }) => {
      clearInterval(timer);
      process.stdin.off('data', onKey);
      process.stdout.off('resize', onResize);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      tolerant('exit', () => db.setStatus(d, launch.name, 'offline'));
      tolerant('exit', () => db.releaseAll(d, launch.name, 'exit')); // missed here, the next sweep releases them
      resolve(exitCode);
    });
  });
}
