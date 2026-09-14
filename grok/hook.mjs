#!/usr/bin/env node
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { normalizeConfig, createClient } from './mcp-client.mjs';
import { processEvent } from './hook-core.mjs';
import { acquireLock } from './state-lock.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
let releaseLock;
try {
  if (process.argv[2] !== '--config' || !process.argv[3]) throw new Error('config_required');
  const config = normalizeConfig(JSON.parse(await readFile(process.argv[3], 'utf8')));
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 1_000_000) throw new Error('hook_input_too_large');
  }
  const event = JSON.parse(raw);
  if (typeof event.sessionId !== 'string' || !event.sessionId || event.sessionId.length > 300) throw new Error('session_missing');
  if (typeof event.promptId === 'string') event.promptId = hash(event.promptId);
  if (typeof event.toolUseId === 'string') event.toolUseId = hash(event.toolUseId);
  const root = await realpath(config.projectRoot);
  const cwd = await realpath(event.cwd);
  const relative = path.relative(root, cwd);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('wrong_project');
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(config.stateDirectory);
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) || directoryStat.uid !== process.getuid?.()) throw new Error('state_directory_not_private');
  const directory = await realpath(config.stateDirectory);
  const stateRelative = path.relative(root, directory);
  if (!stateRelative || (!stateRelative.startsWith(`..${path.sep}`) && stateRelative !== '..' && !path.isAbsolute(stateRelative))) throw new Error('unsafe_state_directory');
  const credential = process.env[config.credentialEnv];
  if (!credential) throw new Error('credential_missing');
  const key = hash(JSON.stringify(config) + hash(credential) + event.sessionId);
  const file = path.join(directory, `${key}.json`);
  releaseLock = await acquireLock(path.join(directory, `${key}.lock`));
  if (!releaseLock) throw new Error('hook_busy');
  let state = {};
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('state_unreadable'); }
  const client = createClient(config, credential);
  const result = await processEvent({ config, event, state, secrets: [credential], call: client.call });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(result.state), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
  if (result.output) process.stdout.write(JSON.stringify(result.output));
  // Never serialize raw errors, tool payloads, prompts, credentials or leases.
  if (result.warning) process.stderr.write(`Stele hook: ${result.warning}\n`);
} catch {
  process.stderr.write('Stele hook unavailable; check configuration or connection.\n');
} finally {
  if (releaseLock) await releaseLock();
}
