// chord clean: remove the workspaces, worktrees and branches of agents that are gone.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import * as db from './db.ts';
import { setupMarker } from './launch.ts';
import type { Project } from './project.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: db.gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export interface CleanResult { removed: string[]; kept: { name: string; why: string }[] }

/** Remove offline agents (all of them, or the named ones). An agent whose branch has commits that are not on
 *  main, or whose worktree has uncommitted work, is kept unless `force`; an online agent is always kept. Directories
 *  under chord/agents/ with no database row (a launch that died before the tool started) are treated the same way. */
export function clean(project: Project, d: DatabaseSync, names: string[] = [], force = false): CleanResult {
  db.sweep(d);
  const main = git(project.repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  const agents = db.listAgents(d).filter(a => (names.length ? names.includes(a.name) : a.status === 'offline'));
  const result: CleanResult = { removed: [], kept: [] };
  const kept = (name: string, why: string) => result.kept.push({ name, why });

  const agentsDir = path.join(project.dir, 'chord', 'agents');
  const remove = (a: { name: string; status: string; worktree: string }, hasRow: boolean) => {
    const dir = path.join(agentsDir, a.name); // by name, never by the stored cwd: a row pointing elsewhere must not take that folder with it
    try {
      if (a.status !== 'offline') { kept(a.name, 'still online'); return; }
      const branch = `chord/${a.name}`;
      const hasBranch = git(project.repo, 'branch', '--list', branch) !== '';
      if (hasBranch && !force) {
        let merged = true;
        try { git(project.repo, 'merge-base', '--is-ancestor', branch, main); } catch { merged = false; }
        if (!merged) { kept(a.name, `unmerged commits on ${branch}`); return; }
      }
      // work that was never committed (an agent stopped half-way) is just as much work as an unmerged commit
      if (!force && fs.existsSync(path.join(a.worktree, '.git'))) {
        let dirty = '';
        try { dirty = git(a.worktree, 'status', '--porcelain'); } catch { /* a broken worktree holds nothing to keep */ }
        if (dirty) { kept(a.name, `uncommitted changes in ${path.relative(project.dir, a.worktree).split(path.sep).join('/')}`); return; }
      }
      // The directory goes first. On Windows a directory some process is using (a shell left open in it) cannot be
      // removed; then the branch and the database row stay too, so the next clean sees the agent whole.
      if (fs.existsSync(a.worktree)) { try { git(project.repo, 'worktree', 'remove', '--force', a.worktree); } catch { /* fall through to rm */ } }
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* checked below */ }
      git(project.repo, 'worktree', 'prune');
      if (fs.existsSync(dir)) { kept(a.name, `${dir} could not be removed, probably because a process is using it; close it and run clean again`); return; }
      if (hasBranch) git(project.repo, 'branch', '-D', branch);
      fs.rmSync(setupMarker(project, a.name), { force: true });
      if (hasRow) db.removeAgent(d, a.name);
      result.removed.push(a.name);
    } catch (e) {
      kept(a.name, `error: ${(e as Error).message.split('\n')[0]}`);
    }
  };

  for (const missing of names.filter(n => !agents.some(a => a.name === n) && !fs.existsSync(path.join(project.dir, 'chord', 'agents', n)))) kept(missing, 'no such agent');
  for (const a of agents) remove(a, true);
  // directories with no row: a launch that died before the tool registered, or a database that was deleted
  const known = new Set(db.listAgents(d).map(a => a.name.toLowerCase()));
  let orphans: string[] = [];
  try { orphans = fs.readdirSync(agentsDir).filter(n => !known.has(n.toLowerCase()) && (!names.length || names.includes(n))); } catch { /* no agents directory yet */ }
  for (const n of orphans) remove({ name: n, status: 'offline', worktree: path.join(agentsDir, n, project.repoName) }, false);
  return result;
}
