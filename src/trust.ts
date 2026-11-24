// What the user has told Claude Code and Codex to trust, read from their own config files. Agents run in the
// project folder, which the user trusts (or not) in Claude Code themselves; chord writes no trust of its own.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const claudeConfigPath = () => path.join(os.homedir(), '.claude.json');
// Claude Code keys projects by the cwd with forward slashes, even on Windows
const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();

/** Whether the user has answered yes to Claude Code's "do you trust this folder?" dialogue for `dir`. */
export function claudeTrusts(dir: string, file = claudeConfigPath()): boolean {
  try {
    const projects = JSON.parse(fs.readFileSync(file, 'utf8')).projects ?? {};
    const key = Object.keys(projects).find(k => norm(k) === norm(dir));
    return key !== undefined && projects[key]?.hasTrustDialogAccepted === true;
  } catch { return false; }
}

/** Which of a repository's .mcp.json servers the user has approved or rejected in Claude Code, and whether they
 *  approved them all at once. Claude asks per server when it runs in the repository; chord has no prompt, so it only
 *  starts what the user has already approved there. Claude Code 2.1.323 and later keep the answers in the folder's
 *  .claude/settings.local.json (the user's ~/.claude/settings.json may hold some too); older ones kept them in
 *  ~/.claude.json, still read for whoever has not migrated. A server disabled in any of them stays off. */
export function claudeMcpChoices(dir: string, file = claudeConfigPath(), userSettings = path.join(os.homedir(), '.claude', 'settings.json')): { all: boolean; enabled: string[]; disabled: string[] } {
  const read = (f: string) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) ?? {}; } catch { return {}; } };
  const projects = read(file).projects ?? {};
  const key = Object.keys(projects).find(k => norm(k) === norm(dir));
  const sources = [read(path.join(dir, '.claude', 'settings.local.json')), read(userSettings), key ? projects[key] : {}];
  const list = (k: string) => [...new Set(sources.flatMap(s => Array.isArray(s?.[k]) ? s[k] as string[] : []))];
  return { all: sources.some(s => s?.enableAllProjectMcpServers === true), enabled: list('enabledMcpjsonServers'), disabled: list('disabledMcpjsonServers') };
}

const codexConfigPath = () => path.join(os.homedir(), '.codex', 'config.toml');

/** Codex keeps a trust hash and an on/off switch per hook in ~/.codex/config.toml. One keypress in its
 *  "Hooks need review" screen switches a hook off, and chord then silently loses the feature behind it, so
 *  chord names the switched-off hooks at launch. Returns Codex event names such as "session_start". */
export function disabledCodexHooks(file = codexConfigPath()): string[] {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const off: string[] = [];
  let event: string | null = null; // the chord hook whose [hooks.state...] table we are in, if any
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      const m = /^\[hooks\.state\.['"].*<session-flags>.*:([a-z_]+):\d+:\d+['"]\]/.exec(line);
      event = m ? m[1] : null;
    } else if (event && /^enabled\s*=\s*false\b/.test(line)) off.push(event);
  }
  return off;
}

const hasCodexState = (home: string) => { try { return fs.readdirSync(home).some(f => /^state_\d+\.sqlite$/.test(f)); } catch { return false; } };

/** Codex creates and migrates its state database (~/.codex/state_N.sqlite) on its first start, and when two start at
 *  once the second exits with "local database appears to be damaged". Until that database exists, launches take
 *  turns: the first holds a lock while its Codex creates it, the others wait for the lock. Call the returned
 *  function once Codex has been spawned; it lets go of the lock when the database is there, or after a minute. */
export async function codexFirstStart(home = path.join(os.homedir(), '.codex')): Promise<() => void> {
  if (hasCodexState(home)) return () => {};
  const lock = path.join(home, '.chord-first-start');
  const t0 = Date.now();
  try { fs.mkdirSync(home, { recursive: true }); } catch { return () => {}; }
  for (;;) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return () => {};
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) { fs.unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() - t0 > 90_000) return () => {}; // a launch that never lets go must not hold this one up for good
      await new Promise(r => setTimeout(r, 250));
    }
  }
  const unlock = () => { try { fs.unlinkSync(lock); } catch { /* gone */ } };
  if (hasCodexState(home)) { unlock(); return () => {}; } // the launch before this one created it
  return () => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (!hasCodexState(home) && Date.now() - started < 60_000) return;
      clearInterval(poll);
      setTimeout(unlock, 2000).unref(); // the file appears before its migrations have run
    }, 250);
    poll.unref();
  };
}
