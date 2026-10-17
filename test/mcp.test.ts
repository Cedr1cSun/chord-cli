import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db.ts';
import { handle } from '../src/mcp.ts';
import { tools } from '../src/tools.ts';

function setup() {
  const d = db.openDb(':memory:');
  db.addAgent(d, { name: 'a', tool: 'claude', pid: process.pid, cwd: '/a' });
  db.addAgent(d, { name: 'b', tool: 'codex', pid: process.pid, cwd: '/b' });
  const call = (agent: string, name: string, args: Record<string, unknown> = {}) => {
    const res = handle(tools({ db: d, agent, cwd: '/' + agent }), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) as any;
    return { text: res.result.content[0].text as string, isError: !!res.result.isError };
  };
  return { d, call };
}

test('initialize, ping, tools/list, unknown method, notification', () => {
  const t = tools({ db: db.openDb(':memory:'), agent: 'a', cwd: '/a' });
  const init = handle(t, { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }) as any;
  assert.equal(init.result.serverInfo.name, 'chord');
  assert.ok(init.result.capabilities.tools);
  assert.deepEqual((handle(t, { jsonrpc: '2.0', id: 1, method: 'ping' }) as any).result, {});
  const names = (handle(t, { jsonrpc: '2.0', id: 2, method: 'tools/list' }) as any).result.tools.map((x: any) => x.name);
  assert.deepEqual(names, ['register', 'list_agents', 'claim', 'release', 'send', 'inbox', 'finish']);
  assert.equal((handle(t, { jsonrpc: '2.0', id: 3, method: 'nope' }) as any).error.code, -32601);
  assert.equal(handle(t, { jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
});

test('register records task and returns peers; list_agents excludes self', () => {
  const { d, call } = setup();
  const r = JSON.parse(call('a', 'register', { task: 'build api', scope: 'src/api' }).text);
  assert.equal(r.registered, 'a');
  assert.deepEqual(r.peers.map((p: any) => p.name), ['b']);
  assert.equal(db.getAgent(d, 'a')!.task, 'build api');
  const l = JSON.parse(call('b', 'list_agents').text);
  assert.deepEqual(l.map((p: any) => [p.name, p.task]), [['a', 'build api']]);
  assert.equal(call('a', 'register', {}).isError, true);
});

test('send and inbox round trip, unknown recipient rejected', () => {
  const { call } = setup();
  assert.equal(call('a', 'send', { to: 'b', message: 'hi b' }).isError, false);
  assert.equal(call('a', 'send', { to: ['b', 'zz'], message: 'x' }).isError, true);
  const inbox = JSON.parse(call('b', 'inbox').text);
  assert.deepEqual(inbox.map((m: any) => [m.from, m.message]), [['a', 'hi b']]);
  assert.deepEqual(JSON.parse(call('b', 'inbox').text), []);
});

test('tool calls sweep dead agents', () => {
  const { d, call } = setup();
  db.addAgent(d, { name: 'ghost', tool: 'codex', pid: 999_999_999, cwd: '/g' });
  const l = JSON.parse(call('a', 'list_agents').text);
  assert.equal(l.find((p: any) => p.name === 'ghost').status, 'offline');
});

test('send refuses offline recipients; a relaunch drops stale unread messages', () => {
  const { d, call } = setup();
  db.send(d, 'a', ['b'], 'before b died');
  db.setStatus(d, 'b', 'offline');
  assert.match(call('a', 'send', { to: 'b', message: 'x' }).text, /b is offline/);
  db.addAgent(d, { name: 'b', tool: 'codex', pid: process.pid, cwd: '/b' }); // relaunch
  assert.equal(db.hasUnread(d, 'b'), false);
  assert.equal(call('a', 'send', { to: 'b', message: 'fresh' }).isError, false);
});
