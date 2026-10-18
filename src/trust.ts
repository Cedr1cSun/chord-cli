// Claude Code asks "do you trust this folder?" once per working directory and records the answer in
// ~/.claude.json. Every agent workspace is a new directory, so without this each launch asks again.
// The workspace only holds a worktree of a repository the user already chose to run chord in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const claudeConfigPath = () => path.join(os.homedir(), '.claude.json');
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

/** Mark `workspace` as trusted for Claude Code. Returns false when Claude Code has no config yet (nothing to do)
 *  or the entry was already there. Writes atomically; other fields of the file are left untouched. */
export function pretrustClaude(workspace: string, file = claudeConfigPath()): boolean {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return false; }
  let cfg: Record<string, any>;
  try { cfg = JSON.parse(raw); } catch { return false; } // not ours to repair
  if (typeof cfg !== 'object' || cfg === null) return false;
  const projects = (cfg.projects ??= {});
  const key = Object.keys(projects).find(k => norm(k) === norm(workspace)) ?? workspace.replace(/\\/g, '/');
  if (projects[key]?.hasTrustDialogAccepted === true) return false;
  projects[key] = projects[key]
    ? { ...projects[key], hasTrustDialogAccepted: true } // existing entry: flip the flag, keep everything else
    : { allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [], hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false };
  const tmp = `${file}.chord-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
  return true;
}

/** Which of a repository's .mcp.json servers the user has approved or rejected in Claude Code, and whether they
 *  approved them all at once. Claude asks per server when it runs in the repository; chord has no prompt, so it only
 *  starts what the user has already approved there. */
export function claudeMcpChoices(dir: string, file = claudeConfigPath()): { all: boolean; enabled: string[]; disabled: string[] } {
  try {
    const projects = JSON.parse(fs.readFileSync(file, 'utf8')).projects ?? {};
    const key = Object.keys(projects).find(k => norm(k) === norm(dir));
    const p = key ? projects[key] : {};
    return { all: p.enableAllProjectMcpServers === true, enabled: p.enabledMcpjsonServers ?? [], disabled: p.disabledMcpjsonServers ?? [] };
  } catch { return { all: false, enabled: [], disabled: [] }; }
}

export const codexConfigPath = () => path.join(os.homedir(), '.codex', 'config.toml');

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
