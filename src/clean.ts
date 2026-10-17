// chord clean: remove the workspaces, worktrees and branches of agents that are gone.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import * as db from './db.ts';
import type { Project } from './project.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: db.gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export interface CleanResult { removed: string[]; kept: { name: string; why: string }[] }

/** Remove offline agents (all of them, or the named ones). An agent whose branch has commits that are not on
 *  main is kept unless `force`; an online agent is always kept. */
export function clean(project: Project, d: DatabaseSync, names: string[] = [], force = false): CleanResult {
  db.sweep(d);
  const main = git(project.repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  const agents = db.listAgents(d).filter(a => (names.length ? names.includes(a.name) : a.status === 'offline'));
  const result: CleanResult = { removed: [], kept: [] };
  for (const missing of names.filter(n => !agents.some(a => a.name === n))) result.kept.push({ name: missing, why: 'no such agent' });
  for (const a of agents) {
    if (a.status !== 'offline') { result.kept.push({ name: a.name, why: 'still online' }); continue; }
    const branch = `chord/${a.name}`;
    const hasBranch = git(project.repo, 'branch', '--list', branch) !== '';
    if (hasBranch && !force) {
      let merged = true;
      try { git(project.repo, 'merge-base', '--is-ancestor', branch, main); } catch { merged = false; }
      if (!merged) { result.kept.push({ name: a.name, why: `${branch} has commits that are not on ${main}; use --force to discard them` }); continue; }
    }
    if (fs.existsSync(a.worktree)) { try { git(project.repo, 'worktree', 'remove', '--force', a.worktree); } catch { /* fall through to rm */ } }
    git(project.repo, 'worktree', 'prune');
    if (hasBranch) git(project.repo, 'branch', '-D', branch);
    fs.rmSync(a.cwd, { recursive: true, force: true });
    db.removeAgent(d, a.name);
    result.removed.push(a.name);
  }
  return result;
}
