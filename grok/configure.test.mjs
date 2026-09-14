import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { configure } from './configure.mjs';

test('isolated project setup uses credential indirection and preserves existing configuration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stele-grok-config-'));
  try {
    const project = path.join(root, 'project');
    await mkdir(project);
    const file = path.join(root, 'config.json');
    await writeFile(file, JSON.stringify({ version: 1, endpoint: 'http://127.0.0.1:8788/api/mcp', workspaceId: '11111111-1111-4111-8111-111111111111', taskId: '22222222-2222-4222-8222-222222222222', projectRoot: project, stateDirectory: path.join(root,'state'), credentialEnv: 'STELE_MCP_TOKEN', documentPaths: [] }));
    await assert.rejects(configure(file), /git_root_required/);
    execFileSync('git', ['-c','init.templateDir=','init','-q',project]);
    const result = await configure(file);
    assert.equal(result.created.length, 2);
    const toml = await readFile(result.created[0], 'utf8');
    assert.match(toml, /Bearer \$\{STELE_MCP_TOKEN\}/);
    assert.equal((await stat(result.created[0])).mode & 0o777, 0o600);
    await assert.rejects(configure(file));
    assert.equal(await readFile(result.created[0], 'utf8'), toml);
    assert.equal(JSON.parse(await readFile(result.created[1], 'utf8')).hooks.Stop[0].hooks[0].timeout, 12);
  } finally { await rm(root, { recursive: true, force: true }); }
});
