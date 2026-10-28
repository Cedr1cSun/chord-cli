// A chord project is the folder `chord` is run in. It contains the git repository as a child
// directory and a `chord/` directory for agent workspaces; chord's own state lives under ~/.chord.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './db.ts';

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

// Windows and macOS file systems ignore case: two spellings are one folder
const CASE_INSENSITIVE = process.platform !== 'linux';
const same = (a: string, b: string) => (CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b);

function repoRootOf(dir: string): string | null {
  try { return fs.realpathSync.native(git(dir, 'rev-parse', '--show-toplevel')); } catch { return null; }
}

/** Only a .git *directory* marks a project repository; a .git file is a linked worktree or a submodule. */
const isRepoDir = (dir: string) => { try { return fs.statSync(path.join(dir, '.git')).isDirectory(); } catch { return false; } };

/** Readable like Claude Code's projects directory (separators and colons become dashes), plus a short hash so
 *  that D:\a-b and D:\a\b do not share one state directory. */
export function encodeProjectPath(dir: string): string {
  const key = CASE_INSENSITIVE ? dir.toLowerCase() : dir;
  return `${dir.replace(/[\\/:]/g, '-')}-${createHash('sha1').update(key).digest('hex').slice(0, 6)}`;
}

const stateDirFor = (dir: string) => path.join(process.env.CHORD_HOME ?? path.join(os.homedir(), '.chord'), 'projects', encodeProjectPath(dir));

/** A repository directory name chord can work with: a single path segment that is not chord's own directory. */
export function validateRepoName(name: string): string | null {
  if (!name.trim()) return 'the name is empty';
  if (/[\\/]/.test(name) || name === '.' || name === '..') return 'the name must be a single directory name';
  if (name.toLowerCase() === 'chord') return '"chord" is reserved for chord\'s own directory';
  return null;
}

/** Default name for the repository directory: the origin remote's name, else the folder's own name. */
export function suggestedRepoName(repo: string): string {
  try {
    const url = git(repo, 'remote', 'get-url', 'origin');
    const last = url.split(/[\\/:]/).filter(Boolean).pop() ?? '';
    const name = last.replace(/\.git$/i, '');
    if (name && !validateRepoName(name)) return name;
  } catch { /* no origin */ }
  const own = path.basename(repo);
  return validateRepoName(own) ? 'repo' : own;
}

/** Child directories of `dir` that are repository roots. Looked up with stat, so a junction or symlink to a repository
 *  counts (a Dirent reports those as links, not directories). */
const repoChildren = (dir: string) => fs.readdirSync(dir).filter(n => { const p = path.join(dir, n); try { return fs.statSync(p).isDirectory() && isRepoDir(p); } catch { return false; } });

/** The project `dir` belongs to, when it lies inside one: under the project's chord/ directory (a workspace or a
 *  worktree) or inside its repository. A folder merely beside those, such as a new project created next to an old
 *  one, is not claimed by the ancestor. */
function enclosingProject(dir: string): string | null {
  for (let a = path.dirname(dir); a !== path.dirname(a); a = path.dirname(a)) {
    if (!fs.existsSync(stateDirFor(a)) && !fs.existsSync(path.join(a, 'chord', 'agents'))) continue;
    const inside = (sub: string) => { const rel = path.relative(path.join(a, sub), dir); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
    if (inside('chord') || repoChildren(a).some(inside)) return a;
  }
  return null;
}

export function resolveProject(cwd: string): Project {
  const dir = fs.realpathSync.native(cwd);
  // inside an existing project (its main checkout, a workspace or a worktree): that project is meant
  const parent = enclosingProject(dir);
  if (parent) return resolveProject(parent);
  const enclosing = repoRootOf(dir);
  if (enclosing) {
    if (same(enclosing, dir)) throw new NeedsRestructure(dir, suggestedRepoName(dir));
    throw new Error(`${dir} is inside the repository ${enclosing}; a chord project is the folder that contains the repository, not a folder inside it`);
  }
  const children = repoChildren(dir);
  if (children.some(c => c.toLowerCase() === 'chord')) throw new Error(`${dir}/chord is a git repository, but chord/ is reserved for chord's own directory; rename it`);
  if (children.length === 0) throw new Error(`${dir} contains no git repository; a chord project is a folder with the repository in a child directory`);
  if (children.length > 1) throw new Error(`${dir} contains several repositories (${children.join(', ')}); chord supports one per project for now`);
  const repo = path.join(dir, children[0]);
  return { dir, repo, repoName: children[0], stateDir: stateDirFor(dir) };
}

/** Why `dir` (a repository root) must not be moved into a child directory, or null when it is safe. */
export function restructureBlocker(dir: string): string | null {
  if (same(fs.realpathSync.native(dir), fs.realpathSync.native(os.homedir()))) return 'refusing to move your home directory';
  let worktrees = 1;
  try { worktrees = git(dir, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length; } catch { /* not a repo */ }
  if (worktrees > 1) return `${dir} has linked worktrees (git worktree list); remove them first, moving the repository would break them`;
  try { if (git(dir, 'ls-files', '--', 'chord')) return 'the repository tracks a top-level chord/ directory, which chord needs for itself; rename it first'; } catch { /* ignore */ }
  return null;
}

/** Move everything in `dir` (except chord/) into `dir/name`, so the repository becomes a child. Rolls back on failure. */
export function restructure(dir: string, name: string, rename: (from: string, to: string) => void = fs.renameSync): string {
  const invalid = validateRepoName(name);
  if (invalid) throw new Error(invalid);
  const blocker = restructureBlocker(dir);
  if (blocker) throw new Error(blocker);
  const target = path.join(dir, name);
  if (fs.existsSync(target)) throw new Error(`${target} already exists`);
  const entries = fs.readdirSync(dir).filter(e => e !== 'chord');
  fs.mkdirSync(target);
  const moved: string[] = [];
  try {
    for (const e of entries) { rename(path.join(dir, e), path.join(target, e)); moved.push(e); }
  } catch (e) {
    const stuck: string[] = [];
    for (const m of moved) { try { rename(path.join(target, m), path.join(dir, m)); } catch { stuck.push(m); } }
    if (!stuck.length) { try { fs.rmdirSync(target); } catch { /* leave it */ } }
    const note = stuck.length ? ` Rolling back failed too: ${stuck.join(', ')} are still under ${target}.` : ' Everything was moved back.';
    throw new Error(`could not move ${dir} into ${target}: ${(e as Error).message}.${note} Close programs that have files open there and try again.`);
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
