import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED = new Set(['start_work_session', 'heartbeat_work_session', 'finish_work_session', 'read_task', 'read_plan', 'read_document']);
const KEYS = new Set(['version','endpoint','workspaceId','taskId','planId','documentPaths','projectRoot','stateDirectory','credentialEnv']);
export function normalizeConfig(value) {
  if (!value || value.version !== 1 || Object.keys(value).some(key => !KEYS.has(key))) throw new Error('invalid_config');
  const endpoint = new URL(value.endpoint);
  if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname))) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('invalid_endpoint');
  if (!UUID.test(value.workspaceId ?? '') || !UUID.test(value.taskId ?? '') || (value.planId && !UUID.test(value.planId))) throw new Error('invalid_scope');
  if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(value.credentialEnv ?? '')) throw new Error('invalid_credential_env');
  if (![value.projectRoot, value.stateDirectory].every(v => typeof v === 'string' && path.isAbsolute(v))) throw new Error('absolute_paths_required');
  const relative = path.relative(value.projectRoot, value.stateDirectory);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('state_must_be_outside_project');
  const reverse = path.relative(value.stateDirectory, value.projectRoot);
  if (!reverse.startsWith(`..${path.sep}`) && reverse !== '..' && !path.isAbsolute(reverse)) throw new Error('state_must_not_contain_project');
  if (!Array.isArray(value.documentPaths) || value.documentPaths.length > 3 || new Set(value.documentPaths).size !== value.documentPaths.length || value.documentPaths.some(p => typeof p !== 'string' || p.length > 1000 || !/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/.test(p))) throw new Error('invalid_document_paths');
  return { ...value, endpoint: endpoint.href, projectRoot: path.resolve(value.projectRoot), stateDirectory: path.resolve(value.stateDirectory) };
}

export function createClient(config, credential, request = fetch) {
  if (typeof credential !== 'string' || !credential || /[\r\n]/.test(credential)) throw new Error('credential_missing');
  let seq = 0, initialized;
  const deadline = AbortSignal.timeout(10_000);
  async function rpc(method, params, notification = false) {
    const id = notification ? undefined : ++seq;
    const response = await request(config.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([deadline, AbortSignal.timeout(2_500)]),
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }),
    });
    if (!response.ok) throw new Error('mcp_http_error');
    if (notification) return;
    let text = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      text += decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(text) > 256_000) throw new Error('mcp_response_too_large');
    }
    text += decoder.decode();
    if (response.headers.get('content-type')?.includes('text/event-stream')) text = text.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? '';
    const body = JSON.parse(text);
    if (body.id !== id || body.error || !body.result) throw new Error('mcp_rpc_error');
    return body.result;
  }
  async function initialize() {
    const result = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'stele-grok-hooks', version: '1.0.0' } });
    if (result.protocolVersion !== '2025-11-25') throw new Error('unsupported_mcp_protocol');
    await rpc('notifications/initialized', {}, true);
    return (await rpc('tools/list', {})).tools;
  }
  return { async call(name, args) {
    if (!ALLOWED.has(name) || args.workspaceId !== config.workspaceId) throw new Error('hook_scope_denied');
    if (name === 'read_task' && args.taskId !== config.taskId) throw new Error('hook_task_denied');
    if (name === 'read_plan' && args.planId !== config.planId) throw new Error('hook_plan_denied');
    if (name === 'read_document' && !config.documentPaths.includes(args.path)) throw new Error('hook_document_denied');
    const tools = await (initialized ??= initialize());
    const schema = tools.find(tool => tool.name === name)?.inputSchema;
    if (!schema?.properties?.workspaceId || Object.keys(args).some(key => !Object.hasOwn(schema.properties, key)) || (schema.required ?? []).some(key => args[key] === undefined)) throw new Error('unsupported_public_schema');
    const result = await rpc('tools/call', { name, arguments: args });
    if (result.isError) throw new Error('mcp_tool_error');
    const text = result.content?.find(item => item.type === 'text')?.text;
    if (!text) throw new Error('mcp_result_missing');
    return JSON.parse(text);
  } };
}
