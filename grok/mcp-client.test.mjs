import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, createClient } from './mcp-client.mjs';

const input = { version: 1, endpoint: 'http://127.0.0.1:8788/api/mcp', workspaceId: '11111111-1111-4111-8111-111111111111', taskId: '22222222-2222-4222-8222-222222222222', projectRoot: '/tmp/fixture', stateDirectory: '/tmp/private-state', credentialEnv: 'STELE_MCP_TOKEN', documentPaths: ['qa/spec'] };
test('configuration requires explicit scope, bounded sources, credential indirection and a secure endpoint', () => {
  assert.equal(normalizeConfig(input).taskId, input.taskId);
  for (const patch of [{ endpoint: 'http://example.com/api/mcp' }, { endpoint: 'https://user:secret@example.com/api/mcp' }, { endpoint: 'https://example.com/api/mcp?secret=x' }, { workspaceId: '' }, { documentPaths: ['../secrets'] }, { documentPaths: ['a','b','c','d'] }, { credentialEnv: 'literal-token' }, { token: 'literal' }, { stateDirectory: '/tmp/fixture/state' }]) assert.throws(() => normalizeConfig({ ...input, ...patch }));
});

test('client negotiates, checks the public routing schema and never follows redirects or calls a write tool', async () => {
  const requests = [];
  const client = createClient(normalizeConfig(input), 'unit-credential', async (_url, init) => {
    requests.push(init);
    const req = JSON.parse(init.body);
    const result = req.method === 'initialize' ? { protocolVersion: '2025-11-25' } : req.method === 'tools/list' ? { tools: [{ name: 'read_task', inputSchema: { properties: { workspaceId: {}, taskId: {} }, required: ['workspaceId','taskId'] } }] } : { content: [{ type: 'text', text: '{"task":{"title":"fixture"}}' }] };
    return new Response(req.id ? JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) : null, { status: req.id ? 200 : 202, headers: { 'content-type': 'application/json' } });
  });
  const result = await client.call('read_task', { workspaceId: input.workspaceId, taskId: input.taskId });
  assert.equal(result.task.title, 'fixture');
  assert.deepEqual(requests.map(r => JSON.parse(r.body).method), ['initialize','notifications/initialized','tools/list','tools/call']);
  assert(requests.every(r => r.redirect === 'error'));
  await assert.rejects(client.call('read_task', { workspaceId: 'other', taskId: input.taskId }));
  await assert.rejects(client.call('complete_task', { workspaceId: input.workspaceId, taskId: input.taskId }));
  assert.equal(requests.length, 4);
});
