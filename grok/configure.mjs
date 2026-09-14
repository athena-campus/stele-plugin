#!/usr/bin/env node
import { readFile, mkdir, open, unlink, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from './mcp-client.mjs';

const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function renderConfiguration(config, configFile) {
  const command = [process.execPath, path.join(path.dirname(fileURLToPath(import.meta.url)), 'hook.mjs'), '--config', path.resolve(configFile)].map(shellQuote).join(' ');
  const events = ['UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','Stop','StopFailure','StopCancelled','SessionEnd'];
  const hooks = Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: 'command', command, timeout: 12 }] }]]));
  hooks.Notification = [{ matcher: 'idle_prompt', hooks: [{ type: 'command', command, timeout: 12 }] }];
  const toml = `[mcp_servers.stele]\nurl = ${JSON.stringify(config.endpoint)}\nheaders = { Authorization = ${JSON.stringify('Bearer ${' + config.credentialEnv + '}')} }\nstartup_timeout_sec = 15\ntool_timeout_sec = 30\n`;
  return { hooks: JSON.stringify({ hooks }, null, 2) + '\n', toml };
}

export async function configure(configFile, preview = false) {
  const config = normalizeConfig(JSON.parse(await readFile(configFile, 'utf8')));
  const rendered = renderConfiguration(config, configFile);
  if (preview) return rendered;
  // Grok 1.0.30 does not discover project hooks outside a Git root, even
  // though project MCP configuration is discovered there.
  try {
    const gitRoot = execFileSync('git', ['-C',config.projectRoot,'rev-parse','--show-toplevel'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim();
    if (await realpath(gitRoot) !== await realpath(config.projectRoot)) throw new Error('wrong_root');
  } catch { throw new Error('git_root_required'); }
  const root = path.join(config.projectRoot, '.grok');
  await mkdir(path.join(root, 'hooks'), { recursive: true, mode: 0o700 });
  const files = [[path.join(root, 'config.toml'), rendered.toml], [path.join(root, 'hooks/stele.json'), rendered.hooks]];
  const created = [];
  try {
    for (const [file, content] of files) {
      const handle = await open(file, 'wx', 0o600);
      created.push(file);
      try { await handle.writeFile(content); } finally { await handle.close(); }
    }
  } catch (error) {
    for (const file of created) await unlink(file);
    throw error;
  }
  return { created };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await configure(process.argv[2], process.argv.includes('--preview')), null, 2) + '\n'); }
  catch { process.stderr.write('Stele configuration not installed. Check inputs; existing files are preserved. Use --preview to merge manually.\n'); process.exitCode = 1; }
}
