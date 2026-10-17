import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/db.ts';
import { ensureWorktree, pickName, claudeArgs, codexArgs, prepare, hookCommand, mergeProjectSettings } from '../src/launch.ts';
import { NeedsRestructure, resolveProject, restructure, encodeProjectPath, knownProjects } from '../src/project.ts';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'ignore' });
const tmp = (p: string) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), p)));
function initRepo(dir: string) { fs.mkdirSync(dir, { recursive: true }); git(dir, 'init', '-q', '-b', 'main'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'init'); }
/** A project folder with one child repository. */
function tempProject() { const proj = tmp('chord-proj-'); initRepo(path.join(proj, 'repo')); return proj; }
process.env.CHORD_HOME = tmp('chord-home-'); // keep test state out of ~/.chord

test('resolveProject: one child repo is the project', () => {
  const proj = tempProject();
  const p = resolveProject(proj);
  assert.equal(p.dir, proj); assert.equal(p.repo, path.join(proj, 'repo')); assert.equal(p.repoName, 'repo');
  assert.equal(p.stateDir, path.join(process.env.CHORD_HOME!, 'projects', encodeProjectPath(proj)));
});

test('resolveProject: repo root asks for restructure, inside-repo and odd folders are refused', () => {
  const root = tmp('chord-root-'); initRepo(root);
  assert.throws(() => resolveProject(root), NeedsRestructure);
  fs.mkdirSync(path.join(root, 'src'));
  assert.throws(() => resolveProject(path.join(root, 'src')), /is inside the repository/);
  const empty = tmp('chord-empty-');
  assert.throws(() => resolveProject(empty), /contains no git repository/);
  const two = tmp('chord-two-'); initRepo(path.join(two, 'a')); initRepo(path.join(two, 'b'));
  assert.throws(() => resolveProject(two), /several repositories \(a, b\)/);
});

test('restructure moves a repository root into a child directory', () => {
  const root = tmp('chord-move-'); initRepo(root);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'n'); fs.mkdirSync(path.join(root, 'chord')); // chord/ stays put
  const target = restructure(root, 'app');
  assert.equal(target, path.join(root, 'app'));
  assert.ok(fs.existsSync(path.join(target, '.git')) && fs.existsSync(path.join(target, 'notes.txt')));
  assert.ok(fs.existsSync(path.join(root, 'chord')) && !fs.existsSync(path.join(target, 'chord')));
  assert.equal(resolveProject(root).repoName, 'app');
  assert.throws(() => restructure(root, 'app'), /already exists/);
});

test('encodeProjectPath is readable and collision-free', () => {
  assert.match(encodeProjectPath('D:\\chord-agents\\x'), /^D--chord-agents-x-[0-9a-f]{6}$/);
  assert.match(encodeProjectPath('/home/u/p'), /^-home-u-p-[0-9a-f]{6}$/);
  assert.notEqual(encodeProjectPath('D:\\a-b'), encodeProjectPath('D:\\a\\b')); // same dashes, different folders
});

test('ensureWorktree creates the branch and is idempotent', () => {
  const proj = tempProject(); const repo = path.join(proj, 'repo');
  const wt = ensureWorktree(repo, path.join(proj, 'chord', 'agents', 'x', 'repo'), 'x');
  assert.equal(ensureWorktree(repo, wt, 'x'), wt);
  assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim(), 'chord/x');
  assert.equal(db.mainRoot(wt), repo);
});

test('pickName derives from tool and project, refuses an online duplicate', () => {
  const d = db.openDb(':memory:');
  assert.match(pickName(d, 'claude', '/x/My Repo'), /^claude-my-repo-[0-9a-f]{4}$/);
  db.addAgent(d, { name: 'busy', tool: 'codex', pid: process.pid, cwd: '/' });
  assert.throws(() => pickName(d, 'codex', '/x', 'busy'), /already online/);
  db.setStatus(d, 'busy', 'offline');
  assert.equal(pickName(d, 'codex', '/x', 'busy'), 'busy');
});

test('claudeArgs carries hooks in --settings and the server in --mcp-config', () => {
  const env = { CHORD_AGENT_ID: 'a', CHORD_DB: '/db', CHORD_TOOL: 'claude', CHORD_WORKTREE: '/w/repo' };
  const args = claudeArgs(env);
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['Notification', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit');
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, hookCommand('pre-tool-use'));
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].timeout, 10);
  const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
  assert.equal(mcp.mcpServers.chord.command, 'node');
  assert.deepEqual(mcp.mcpServers.chord.env, env);
  assert.ok(!args.includes('--strict-mcp-config'));
});

test('codexArgs is a list of -c TOML overrides', () => {
  const args = codexArgs({ CHORD_AGENT_ID: 'a', CHORD_DB: '/db', CHORD_TOOL: 'codex' });
  assert.equal(args.filter(a => a === '-c').length, 7);
  const pre = args.find(a => a.startsWith('hooks.PreToolUse='))!;
  assert.ok(pre.includes('matcher="^apply_patch$"'));
  assert.ok(pre.includes(`command=${JSON.stringify(hookCommand('pre-tool-use'))}`));
  assert.ok(args.find(a => a.startsWith('mcp_servers.chord='))!.includes('env={CHORD_AGENT_ID="a",CHORD_DB="/db",CHORD_TOOL="codex"}'));
  // paths with quotes, spaces and non-ASCII survive as TOML basic strings
  const odd = codexArgs({ CHORD_AGENT_ID: 'a', CHORD_DB: "C:/repo o'brien/仓库/.git/chord.db", CHORD_TOOL: 'codex' });
  assert.ok(odd.find(a => a.startsWith('mcp_servers.chord='))!.includes(`CHORD_DB="C:/repo o'brien/仓库/.git/chord.db"`));
});

test('prepare builds the workspace, the worktree inside it and the state dir', () => {
  const proj = tempProject();
  const l = prepare('codex', proj);
  assert.equal(l.cwd, path.join(proj, 'chord', 'agents', l.name));
  assert.equal(l.worktree, path.join(l.cwd, 'repo'));
  assert.ok(fs.existsSync(path.join(l.worktree, '.git')));
  assert.ok(fs.existsSync(l.dbFile) && l.dbFile.startsWith(process.env.CHORD_HOME!));
  assert.equal(l.env.CHORD_AGENT_ID, l.name);
  assert.equal(l.env.CHORD_WORKTREE, l.worktree.split(path.sep).join('/'));
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: l.project.repo, encoding: 'utf8' }).trim(), ''); // repo untouched
  assert.ok(knownProjects().some(p => p.dir === proj));
  const empty = tmp('chord-nocommit-'); fs.mkdirSync(path.join(empty, 'r')); git(path.join(empty, 'r'), 'init', '-q', '-b', 'main');
  assert.throws(() => prepare('claude', empty), /no commits yet/);
});

test('claude gets --add-dir for the worktree and codex a long tool timeout', () => {
  const env = { CHORD_AGENT_ID: 'a', CHORD_DB: '/db', CHORD_TOOL: 'claude', CHORD_WORKTREE: '/w/repo' };
  const c = claudeArgs(env);
  assert.equal(c[c.indexOf('--add-dir') + 1], '/w/repo');
  assert.ok(codexArgs(env).find(a => a.startsWith('mcp_servers.chord='))!.includes('tool_timeout_sec=600'));
});

test('pickName refuses invalid names and case-only variants of existing names', () => {
  const d = db.openDb(':memory:');
  db.addAgent(d, { name: 'Alice', tool: 'claude', pid: process.pid, cwd: '/' });
  assert.throws(() => pickName(d, 'codex', '/x', 'alice'), /differ in more than case/);
  assert.throws(() => pickName(d, 'codex', '/x', 'bad name'), /letters, digits/);
  assert.throws(() => pickName(d, 'codex', '/x', 'a/b'), /letters, digits/);
  assert.equal(pickName(d, 'codex', '/x', 'alice-2'), 'alice-2');
});

test('ensureWorktree recovers a deleted workspace and a moved project, and refuses a foreign directory', () => {
  const proj = tempProject(); const repo = path.join(proj, 'repo');
  const ws = path.join(proj, 'chord', 'agents', 'x');
  const wt = ensureWorktree(repo, path.join(ws, 'repo'), 'x');
  fs.rmSync(ws, { recursive: true, force: true }); // user deleted the workspace by hand; git still lists it
  assert.equal(ensureWorktree(repo, path.join(ws, 'repo'), 'x'), wt);
  assert.ok(fs.existsSync(path.join(wt, '.git')));
  // the whole project moves: the worktree's .git file points at the old location
  const moved = proj + '-moved'; fs.renameSync(proj, moved);
  const wt2 = ensureWorktree(path.join(moved, 'repo'), path.join(moved, 'chord', 'agents', 'x', 'repo'), 'x');
  assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt2, encoding: 'utf8' }).trim(), 'chord/x');
  // a directory that is not a worktree is not silently taken over
  const foreign = path.join(moved, 'chord', 'agents', 'y', 'repo'); fs.mkdirSync(foreign, { recursive: true }); fs.writeFileSync(path.join(foreign, 'stuff.txt'), '1');
  assert.throws(() => ensureWorktree(path.join(moved, 'repo'), foreign, 'y'), /not a git worktree/);
});

test('post-tool-use runs for every tool and codex hooks that attach context get a higher limit', () => {
  const env = { CHORD_AGENT_ID: 'a', CHORD_DB: '/db', CHORD_TOOL: 'claude' };
  const settings = JSON.parse(claudeArgs(env)[1]);
  assert.equal(settings.hooks.PostToolUse[0].matcher, undefined);
  const c = codexArgs(env);
  assert.ok(c.find(a => a.startsWith('hooks.PostToolUse='))!.includes('additionalContextLimit=16000'));
  assert.ok(!c.find(a => a.startsWith('hooks.PostToolUse='))!.includes('matcher='));
  assert.ok(c.find(a => a.startsWith('hooks.SessionStart='))!.includes('additionalContextLimit=16000'));
  assert.ok(!c.find(a => a.startsWith('hooks.Stop='))!.includes('additionalContextLimit'));
});

test('the repository\'s own Claude settings and .mcp.json ride along; Codex gets no Notification hook', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'chord-wt-'));
  fs.mkdirSync(path.join(wt, '.claude'));
  fs.writeFileSync(path.join(wt, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }], PreCompact: [{ hooks: [{ type: 'command', command: 'echo pc' }] }] } }));
  fs.writeFileSync(path.join(wt, '.claude', 'settings.local.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo local' }] }] } }));
  fs.writeFileSync(path.join(wt, '.mcp.json'), '{"mcpServers":{}}');
  const env = { CHORD_AGENT_ID: 'a', CHORD_DB: '/db', CHORD_TOOL: 'claude', CHORD_WORKTREE: wt };
  // without the user's trust in the repository nothing of its own rides along
  const bare = claudeArgs(env);
  assert.equal(JSON.parse(bare[1]).model, undefined);
  assert.ok(!bare.some(a => a.endsWith('.mcp.json')));
  const args = claudeArgs(env, true);
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.deepEqual(settings.permissions, { allow: ['Bash(npm test)'] });
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.hooks.Stop.map((h: any) => h.hooks[0].command), [hookCommand('stop'), 'echo theirs', 'echo local']);
  assert.equal(settings.hooks.PreCompact[0].hooks[0].command, 'echo pc');
  assert.equal(settings.hooks.Notification[0].matcher, 'idle_prompt');
  assert.ok(args.includes(path.join(wt, '.mcp.json')), 'repo .mcp.json passed to --mcp-config');
  assert.ok(args.indexOf(path.join(wt, '.mcp.json')) > args.indexOf('--mcp-config'));
  // a broken settings file is skipped, not fatal
  fs.writeFileSync(path.join(wt, '.claude', 'settings.json'), '{oops');
  assert.equal(mergeProjectSettings({ hooks: {} }, wt).model, 'opus');
  assert.deepEqual(mergeProjectSettings({ hooks: { X: [1] } }), { hooks: { X: [1] } });
  // without a .mcp.json nothing extra is passed
  fs.rmSync(path.join(wt, '.mcp.json'));
  assert.ok(!claudeArgs(env, true).some(a => a.endsWith('.mcp.json')));
  assert.ok(!codexArgs(env).some(a => a.includes('Notification')));
});

test('the setup command from <project>/chord/config.json runs once per new worktree; a failure aborts and removes the worktree', () => {
  const proj = tempProject();
  fs.mkdirSync(path.join(proj, 'chord'), { recursive: true });
  const cfg = (c: unknown) => fs.writeFileSync(path.join(proj, 'chord', 'config.json'), typeof c === 'string' ? c : JSON.stringify(c));
  cfg({ setup: `node -e "require('fs').appendFileSync('setup-ran.txt', process.env.CHORD_AGENT_ID + ';')"` });
  const l = prepare('codex', proj, 'one');
  assert.equal(fs.readFileSync(path.join(l.worktree, 'setup-ran.txt'), 'utf8'), 'one;'); // ran in the worktree with chord's env
  prepare('codex', proj, 'one'); // the same workspace again: no rerun
  assert.equal(fs.readFileSync(path.join(l.worktree, 'setup-ran.txt'), 'utf8'), 'one;');
  cfg({ setup: 'node -e "process.exit(3)"' });
  assert.throws(() => prepare('codex', proj, 'two'), /setup command failed with exit code 3/);
  assert.ok(!fs.existsSync(path.join(proj, 'chord', 'agents', 'two', 'repo')));
  assert.equal(execFileSync('git', ['branch', '--list', 'chord/two'], { cwd: l.project.repo, encoding: 'utf8' }).trim(), '');
  assert.ok(fs.existsSync(l.worktree)); // other agents' worktrees untouched
  cfg('{oops');
  assert.throws(() => prepare('codex', proj, 'three'), /not valid JSON/);
  cfg({ setup: ['npm', 'install'] });
  assert.throws(() => prepare('codex', proj, 'three'), /"setup" must be a string/);
  cfg({});
  assert.ok(prepare('codex', proj, 'three').worktree); // no setup configured: nothing runs
});
