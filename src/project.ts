// A chord project is the folder `chord` is run in. It contains the git repository as a child
// directory and a `chord/` directory for agent workspaces; chord's own state lives under ~/.chord.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Project {
  dir: string;      // the project folder, absolute
  repo: string;     // the repository's main checkout, a child of dir
  repoName: string; // basename of repo
  stateDir: string; // ~/.chord/projects/<encoded dir>
}

/** Thrown when the folder is a repository root: chord offers to move it into a child directory. */
export class NeedsRestructure extends Error {
  dir: string;
  suggestedName: string;
  constructor(dir: string, suggestedName: string) {
    super(`${dir} is itself a git repository; chord needs the repository in a child directory of the project`);
    this.dir = dir;
    this.suggestedName = suggestedName;
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function repoRootOf(dir: string): string | null {
  try { return fs.realpathSync.native(git(dir, 'rev-parse', '--show-toplevel')); } catch { return null; }
}

/** Same encoding Claude Code uses for its projects directory: path separators and colons become dashes. */
export const encodeProjectPath = (dir: string) => dir.replace(/[\\/:]/g, '-');

export const stateDirFor = (dir: string) => path.join(process.env.CHORD_HOME ?? path.join(os.homedir(), '.chord'), 'projects', encodeProjectPath(dir));

/** Default name for the repository directory: the origin remote's name, else the folder's own name. */
export function suggestedRepoName(repo: string): string {
  try {
    const url = git(repo, 'remote', 'get-url', 'origin');
    const m = /([^/:]+?)(?:\.git)?\/?$/.exec(url);
    if (m) return m[1];
  } catch { /* no origin */ }
  return path.basename(repo);
}

export function resolveProject(cwd: string): Project {
  const dir = fs.realpathSync.native(cwd);
  const enclosing = repoRootOf(dir);
  if (enclosing && enclosing.toLowerCase() === dir.toLowerCase()) throw new NeedsRestructure(dir, suggestedRepoName(dir));
  if (enclosing) throw new Error(`${dir} is inside the repository ${enclosing}; run chord in ${enclosing} and it will set the project layout up`);
  const children = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== 'chord' && fs.existsSync(path.join(dir, e.name, '.git')))
    .map(e => e.name);
  if (children.length === 0) throw new Error(`${dir} contains no git repository; a chord project is a folder with the repository in a child directory`);
  if (children.length > 1) throw new Error(`${dir} contains several repositories (${children.join(', ')}); chord supports one per project for now`);
  const repo = path.join(dir, children[0]);
  return { dir, repo, repoName: children[0], stateDir: stateDirFor(dir) };
}

/** Move everything in `dir` (except chord/) into `dir/name`, so the repository becomes a child. Rolls back on failure. */
export function restructure(dir: string, name: string): string {
  const target = path.join(dir, name);
  if (fs.existsSync(target)) throw new Error(`${target} already exists`);
  const entries = fs.readdirSync(dir).filter(e => e !== 'chord');
  fs.mkdirSync(target);
  const moved: string[] = [];
  try {
    for (const e of entries) { fs.renameSync(path.join(dir, e), path.join(target, e)); moved.push(e); }
  } catch (e) {
    for (const m of moved) fs.renameSync(path.join(target, m), path.join(dir, m));
    fs.rmdirSync(target);
    throw new Error(`could not move ${dir} into ${target}: ${(e as Error).message}. Close programs that have files open there and try again.`);
  }
  return target;
}

/** Every project that has state under ~/.chord/projects, for `chord ls --all`. */
export function knownProjects(): { stateDir: string; dbFile: string; dir: string | null }[] {
  const root = path.dirname(stateDirFor('x'));
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).map(name => {
    const stateDir = path.join(root, name);
    let dir: string | null = null;
    try { dir = fs.readFileSync(path.join(stateDir, 'path'), 'utf8').trim(); } catch { /* unknown */ }
    return { stateDir, dbFile: path.join(stateDir, 'chord.db'), dir };
  }).filter(p => fs.existsSync(p.dbFile));
}

/** Create the state directory and remember the project's real path (the encoding is not reversible). */
export function ensureStateDir(p: Project): void {
  fs.mkdirSync(p.stateDir, { recursive: true });
  fs.writeFileSync(path.join(p.stateDir, 'path'), p.dir);
}
