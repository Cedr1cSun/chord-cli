// Claude Code asks "do you trust this folder?" once per working directory and records the answer in
// ~/.claude.json. Every agent workspace is a new directory, so without this each launch asks again.
// The workspace only holds a worktree of a repository the user already chose to run chord in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const claudeConfigPath = () => path.join(os.homedir(), '.claude.json');

/** Mark `workspace` as trusted for Claude Code. Returns false when Claude Code has no config yet (nothing to do)
 *  or the entry was already there. Writes atomically; other fields of the file are left untouched. */
export function pretrustClaude(workspace: string, file = claudeConfigPath()): boolean {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return false; }
  let cfg: Record<string, any>;
  try { cfg = JSON.parse(raw); } catch { return false; } // not ours to repair
  if (typeof cfg !== 'object' || cfg === null) return false;
  const projects = (cfg.projects ??= {});
  const key = Object.keys(projects).find(k => k.toLowerCase() === workspace.toLowerCase()) ?? workspace;
  if (projects[key]?.hasTrustDialogAccepted === true) return false;
  projects[key] = projects[key]
    ? { ...projects[key], hasTrustDialogAccepted: true } // existing entry: flip the flag, keep everything else
    : { allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [], hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false };
  const tmp = `${file}.chord-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
  return true;
}
