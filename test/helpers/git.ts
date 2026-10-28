// Fixtures the tests share: git with a fixed identity, and temporary folders holding a repository.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** git in `cwd` as a test user; trimmed stdout. */
export const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();

/** A fresh temporary folder, by its real path (temp folders hide behind links on some machines). */
export const tmp = (p: string) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), p)));

/** A repository with one empty commit on main, at `dir`. */
export function initRepo(dir: string): void { fs.mkdirSync(dir, { recursive: true }); git(dir, 'init', '-q', '-b', 'main'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'init'); }

/** A project folder with one child repository named repo. */
export function tempProject(): string { const proj = tmp('chord-proj-'); initRepo(path.join(proj, 'repo')); return proj; }
