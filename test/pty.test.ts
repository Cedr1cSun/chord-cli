import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_COMMAND, InputGate, NUDGE, TitleFilter, decodeKeys, exitDeclined, nextAction, oscState, resolveCommand, stripAnsi, titleFor, titleSequence, typedEchoed, whereIs } from '../src/pty.ts';

const key = (uc: number, down = 1, ctrl = 0) => `\x1b[${uc};0;${uc};${down};${ctrl};1_`;

test('InputGate holds while a draft is being typed and releases only on Enter or Esc, however long the user takes', () => {
  const g = new InputGate();
  assert.equal(g.clear(), true);
  g.onUserInput('hel');
  assert.equal(g.clear(), false);
  g.onUserInput('lo\r');
  assert.equal(g.clear(), true);
  g.onUserInput('x');
  assert.equal(g.clear(), false); // no staleness rule: a half-typed line keeps chord out until the user deals with it
  g.onUserInput('\x1b');
  assert.equal(g.clear(), false); // Esc closes a menu or interrupts; it does not empty the box
  g.onUserInput('\x15');
  assert.equal(g.clear(), true);
  g.onUserInput('\x1b[B'); // arrow key: neither a draft nor a submit
  assert.equal(g.clear(), true);
  g.onUserInput('abc');
  g.onUserInput('\x1b[24;1R\x1b[?62;c'); // terminal replies to queries do not touch the draft state
  assert.equal(g.clear(), false);
  g.onUserInput('\r');
  assert.equal(g.clear(), true);
});

test('InputGate.settled: chord keeps its hands off for three seconds after any key and ten after Esc', () => {
  const g = new InputGate();
  assert.equal(g.settled(1000), true);
  g.onUserInput('hello\r', 1000); // a submit: the box is empty but the turn has not shown as busy yet
  assert.equal(g.clear(), true);
  assert.equal(g.settled(3500), false);
  assert.equal(g.settled(4000), true);
  g.onUserInput('\x1b', 5000); // Esc interrupts; the user is about to type a correction
  assert.equal(g.settled(12000), false);
  assert.equal(g.settled(15000), true);
  g.onUserInput('\x1b[24;1R', 20000); // a terminal reply is not a key
  assert.equal(g.settled(20000), true);
});

test('InputGate: backspace empties a draft, Ctrl+U/Ctrl+C clear it, a paste with newlines stays a draft, Shift+Enter is not a submit', () => {
  const g = new InputGate();
  g.onUserInput('ab'); g.onUserInput('\x7f'); assert.equal(g.clear(), false);
  g.onUserInput('\x7f'); assert.equal(g.clear(), true);
  g.onUserInput('typing'); g.onUserInput('\x15'); assert.equal(g.clear(), true); // Ctrl+U
  g.onUserInput('typing'); g.onUserInput('\x03'); assert.equal(g.clear(), true); // Ctrl+C
  g.onUserInput('\x1b[200~line one\nline two\n\x1b[201~'); assert.equal(g.clear(), false); // pasted text waits for Enter
  g.onUserInput('\r'); assert.equal(g.clear(), true);
  g.onUserInput('\x1b[200~line one\rline two\r'); g.onUserInput('line three\r\x1b[201~'); assert.equal(g.clear(), false); // a paste split across chunks
  g.onUserInput('\r'); assert.equal(g.clear(), true);
  g.onUserInput(key(97) + key(13, 1, 0x10)); assert.equal(g.clear(), false); // 'a' then Shift+Enter: still a draft
  g.onUserInput(key(13)); assert.equal(g.clear(), true);
});

test('InputGate decodes win32-input-mode key events, including a sequence split across chunks', () => {
  const g = new InputGate();
  g.onUserInput(key(16, 1) + key(72) + key(72, 0) + key(16, 0)); // Shift, 'H' down, 'H' up, Shift up
  assert.equal(g.clear(), false);
  const enter = key(13) + key(13, 0);
  g.onUserInput(enter.slice(0, 7)); // chunk boundary inside the Enter sequence
  assert.equal(g.clear(), false);
  g.onUserInput(enter.slice(7));
  assert.equal(g.clear(), true);
  g.onUserInput(key(97));
  g.onUserInput('\x1b[24;1R\x1b[?62;c'); // plain terminal replies still ignored
  assert.equal(g.clear(), false);
  g.onUserInput(key(27)); // Esc leaves the draft alone
  assert.equal(g.clear(), false);
  g.onUserInput('\x15');
  assert.equal(g.clear(), true);
});

test('decodeKeys drops OSC, DCS, SS3 and mouse sequences and holds any unfinished one', () => {
  let held = '';
  const dec = (s: string) => decodeKeys(s, r => { held = r; });
  assert.equal(dec('\x1b]11;rgb:0000/0000/0000\x1b\\'), ''); // OSC reply with ST terminator
  assert.equal(dec('\x1b]0;title\x07'), ''); // OSC with BEL
  assert.equal(dec('\x1bP>|ConPTY 1.19\x1b\\'), ''); // DCS reply with printable payload
  assert.equal(dec('\x1bOA\x1bOB'), ''); // SS3 arrows
  assert.equal(dec('\x1b[<35;10;5M'), ''); // SGR mouse report
  assert.equal(dec('ab\x1b]11;rgb:00'), 'ab'); assert.equal(held, '\x1b]11;rgb:00'); // unfinished OSC is held
  assert.equal(dec('x\x1b'), 'x'); assert.equal(held, '\x1b'); // chunk ending right after ESC
  assert.equal(dec('\x1b'), '\x1b'); // a bare Esc key is a key
  assert.equal(dec('\x1b\x1b'), '\x1b'); // Esc twice (some terminals) is an Esc key
  assert.equal(dec('\x1bx'), ''); // Alt+x is not text
});

test('nextAction nudges once, presses Enter once more only when the text was echoed, retypes 30s after the nudge', () => {
  const base = { status: 'idle', unread: true, stop: false, gateClear: true, quietFor: 10_000, typed: null, typedAt: 0, echoed: false, enters: 0, enteredAt: 0 };
  assert.equal(nextAction(base, 100_000), 'nudge');
  assert.equal(nextAction({ ...base, quietFor: 2000 }, 100_000), null); // the screen is still moving: a goal or another Stop hook is running on
  const typed = { ...base, typed: 'nudge' as const, typedAt: 100_000 };
  assert.equal(nextAction(typed, 103_000), null); // echo check pending
  assert.equal(nextAction(typed, 110_000), null); // not echoed: a dialog ate it, hands off
  const entered = { ...typed, echoed: true, enters: 1, enteredAt: 101_500 };
  assert.equal(nextAction(entered, 103_000), null);
  assert.equal(nextAction(entered, 106_600), 'enter'); // one retry
  assert.equal(nextAction({ ...entered, enters: 2, enteredAt: 106_600 }, 120_000), null); // never a third
  assert.equal(nextAction({ ...typed, echoed: true, enters: 0 }, 110_000), null); // the user got there first: leave it alone
  assert.equal(nextAction({ ...entered, enters: 2, enteredAt: 125_000 }, 131_000), 'nudge'); // retyped 30s after the nudge
  assert.equal(nextAction({ ...base, status: 'busy' }, 100_000), null);
  assert.equal(nextAction({ ...base, unread: false }, 100_000), null);
  assert.equal(nextAction({ ...base, gateClear: false }, 100_000), null);
});

test('nextAction: a stop request wins over unread messages and follows the same typing protocol', () => {
  const base = { status: 'idle', unread: true, stop: true, gateClear: true, quietFor: 10_000, typed: null, typedAt: 0, echoed: false, enters: 0, enteredAt: 0 };
  assert.equal(nextAction(base, 100_000), 'stop');
  assert.equal(nextAction({ ...base, unread: false }, 100_000), 'stop');
  assert.equal(nextAction({ ...base, status: 'busy' }, 100_000), null); // waits for the turn to end
  assert.equal(nextAction({ ...base, gateClear: false }, 100_000), null); // and for the user's draft to go
  assert.equal(nextAction({ ...base, quietFor: 500 }, 100_000), null); // and for the screen to stop moving
  // a nudge was typed 5s ago and is still in the box: do not type /exit on top of it; wait for it to clear or expire
  const nudging = { ...base, typed: 'nudge' as const, typedAt: 95_000, echoed: true, enters: 1, enteredAt: 96_500 };
  assert.equal(nextAction(nudging, 100_000), null);
  assert.equal(nextAction(nudging, 126_000), 'stop'); // expired: type the exit command
  // the exit command is never followed by a second Enter: the tool is quitting, or has put up a dialogue
  const stopping = { ...base, typed: 'stop' as const, typedAt: 100_000, echoed: true, enters: 1, enteredAt: 101_500 };
  assert.equal(nextAction(stopping, 107_000), null);
  assert.equal(nextAction({ ...stopping, echoed: false }, 107_000), null);
  assert.equal(nextAction(stopping, 131_000), 'stop'); // retyped only once the first attempt has expired
  assert.deepEqual(EXIT_COMMAND, { claude: '/exit', codex: '/quit' });
  assert.ok(exitDeclined('\x1b[1m Background work is running\x1b[0m\n The following will stop when you exit: shell\n 1. Exit and stop tasks\n 2. Stay'));
  assert.ok(exitDeclined('The following\x1b[2C will stop\nwhen you   exit'));
  assert.ok(!exitDeclined('Resume this session with:\nclaude --resume 398b26ab'));
});

test('TitleFilter drops the tool\'s title sequences, keeps everything else and holds a split sequence', () => {
  const f = new TitleFilter();
  assert.equal(f.push('a\x1b]0;Claude Code\x07b\x1b]2;x\x1b\\c'), 'abc');
  assert.equal(f.push('\x1b]7501;state=idle:app=codex\x1b\\ok'), '\x1b]7501;state=idle:app=codex\x1b\\ok'); // Codex state reports pass
  assert.equal(f.push('\x1b[31mred\x1b[0m'), '\x1b[31mred\x1b[0m');
  assert.equal(f.push('x\x1b]0;half a ti'), 'x'); // unfinished title: held
  assert.equal(f.push('tle\x07y'), 'y'); // completed and dropped
  assert.equal(f.push('p\x1b]'), 'p'); assert.equal(f.push('0;t\x07q'), 'q'); // split right after the introducer
  assert.equal(f.push('m\x1b]0;t\x1b'), 'm'); assert.equal(f.push('\\n'), 'n'); // split inside the ST terminator
  assert.equal(f.push('\x1b]7501;sta'), '\x1b]7501;sta'); // not a title: not held
  assert.equal(titleFor('claude-ab12', null), 'chord claude-ab12');
  assert.equal(titleFor('claude-ab12', '  fix   the\nfooter '), 'chord claude-ab12 · fix the footer');
  assert.equal(titleFor('a', 'x'.repeat(100)).length, 'chord a · '.length + 80);
  assert.equal(titleSequence('t\x07i\x1btle'), '\x1b]0;t i tle\x07');
});

test('typedEchoed sees the text through re-rendering, wrapping and escape sequences, and not when a dialog ate it', () => {
  assert.equal(typedEchoed('\x1b[?25l\x1b[2K\r> [chord] You have new\r\n  messages from other agents;\x1b[?25h', NUDGE), true);
  assert.equal(typedEchoed('\x1b[1;1H› [ch\x1b[Kord] You ha\x1b[Kve new messag\x1b[Kes from', NUDGE), true);
  assert.equal(typedEchoed('Hooks need review\n› 1. Review hooks\n  2. Trust all and continue', NUDGE), false);
  assert.equal(typedEchoed('', NUDGE), false);
  assert.equal(typedEchoed('\x1b[2K> /exit\x1b[K', '/exit'), true);
  assert.equal(typedEchoed('> /ex', '/exit'), false);
  assert.equal(stripAnsi('a\x1b]7501;state=idle:app=codex\x1b\\b\x1b[31mc\x1b[0m\x1bPq..\x1b\\d\x1b(Be'), 'abcde');
});

test('oscState reads the last Codex state report in a chunk', () => {
  assert.equal(oscState('text\x1b]7501;state=working:app=codex\x1b\\more'), 'busy');
  assert.equal(oscState('\x1b]7501;state=working:app=codex\x1b\\..\x1b]7501;state=idle:app=codex\x1b\\'), 'idle');
  assert.equal(oscState('no report here'), null);
});

test('whereIs scans PATH without where.exe', { skip: process.platform !== 'win32' }, () => {
  const exists = (p: string) => p === 'C:\\tools\\codex.cmd' || p === 'C:\\bin\\claude.exe';
  assert.equal(whereIs('codex', 'C:\\nothing;C:\\tools', exists), 'C:\\tools\\codex.cmd');
  assert.equal(whereIs('claude', 'C:\\bin', exists), 'C:\\bin\\claude.exe');
  assert.equal(whereIs('nope', 'C:\\bin', exists), undefined);
});

test('resolveCommand unwraps npm, pnpm and yarn .cmd shims on windows', { skip: process.platform !== 'win32' }, () => {
  const npm = '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
  const r = resolveCommand('codex', () => npm, () => 'C:\\npm\\codex.cmd');
  assert.equal(r.file, process.execPath);
  assert.deepEqual(r.args, ['C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js']);
  const pnpm = '@SETLOCAL\r\nnode "%~dp0\\node_modules\\x\\bin\\x.js" %*\r\n';
  assert.deepEqual(resolveCommand('x', () => pnpm, () => 'C:\\p\\x.cmd').args, ['C:\\p\\node_modules\\x\\bin\\x.js']);
  assert.deepEqual(resolveCommand('claude', () => '', () => 'C:\\bin\\claude.exe'), { file: 'C:\\bin\\claude.exe', args: [] });
  assert.throws(() => resolveCommand('nope', () => '', () => undefined), /not found/);
});
