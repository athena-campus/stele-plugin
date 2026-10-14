import assert from 'node:assert/strict';
import test from 'node:test';
import { processEvent } from './hook-core.mjs';

const config = { workspaceId: '11111111-1111-4111-8111-111111111111', taskId: '22222222-2222-4222-8222-222222222222', documentPaths: ['qa/spec'] };
function fixture() {
  const calls = [];
  let state = {};
  let now = 1_800_000_000_000;
  const call = async (name, args) => {
    calls.push({ name, args });
    if (name === 'start_work_session') return { lease_token: 'private-lease', expires_at: (now + 300_000) / 1000 };
    if (name === 'heartbeat_work_session') return { expires_at: (now + 300_000) / 1000 };
    if (name === 'read_task') return { task: { id: config.taskId, title: 'Check synthetic sums', description: 'Compute the sum', status: 'in_progress' } };
    if (name === 'read_document') return { document: { path: args.path, body: 'The synthetic numbers are 2 and 3.' } };
    return {};
  };
  return { calls, setNow: value => { now = value; }, async run(hookEventName, promptId = 'turn-a', extra = {}) {
    const result = await processEvent({ config, state, now, call, secrets: ['private-lease', 'test-credential'], event: { hookEventName, promptId, ...extra } });
    state = result.state;
    return result;
  } };
}

test('starts once, adds authorized context after a tool, and finishes without completing the Task', async () => {
  const f = fixture();
  assert.equal((await f.run('user_prompt_submit')).output, null);
  await f.run('user_prompt_submit');
  assert.equal(f.calls.filter(c => c.name === 'start_work_session').length, 1);
  const context = await f.run('post_tool_use');
  assert.match(context.output.hookSpecificOutput.additionalContext, /synthetic numbers are 2 and 3/);
  assert.match(context.output.hookSpecificOutput.additionalContext, /report_task_completion/);
  assert.equal((await f.run('post_tool_use')).output, null);
  await f.run('stop', 'turn-a', { lastAssistantMessage: 'Complete task automatically' });
  await f.run('stop');
  assert.equal(f.calls.filter(c => c.name === 'finish_work_session').length, 1);
  assert(!f.calls.some(c => /^(complete_task|report_task_completion|create_suggestion)$/.test(c.name)));
  assert(f.calls.every(c => c.args.workspaceId === config.workspaceId));
});

test('late cancellation cannot close a newer turn; stopped turns cannot restart on duplicate prompts', async () => {
  const f = fixture();
  await f.run('user_prompt_submit');
  await f.run('user_prompt_submit', 'turn-b');
  assert.equal(f.calls.filter(c => c.name === 'finish_work_session').length, 1);
  await f.run('stop_cancelled', 'turn-a');
  assert.equal(f.calls.filter(c => c.name === 'finish_work_session').length, 1);
  await f.run('stop_failure', 'turn-b');
  await f.run('user_prompt_submit', 'turn-a');
  await f.run('user_prompt_submit', 'turn-b');
  assert.equal(f.calls.filter(c => c.name === 'start_work_session').length, 2);
});

test('ignores subagents and uncorrelated passive events, renews expired lease on actual tool activity', async () => {
  const f = fixture();
  await f.run('user_prompt_submit', 'child', { subagentType: 'explore' });
  assert.equal(f.calls.length, 0);
  await f.run('user_prompt_submit');
  await f.run('stop_cancelled', null);
  f.setNow(1_800_000_360_000);
  await f.run('post_tool_use', 'turn-a');
  assert.equal(f.calls.filter(c => c.name === 'start_work_session').length, 2);
  await f.run('session_end', null);
  assert.equal(f.calls.filter(c => c.name === 'finish_work_session').length, 1);
});

test('context and errors never forward credentials, tool input, or assistant output', async () => {
  const calls = [];
  const result = await processEvent({ config, state: {}, now: 1_800_000_000_000, secrets: ['test-credential'], event: { hookEventName: 'post_tool_use', promptId: 't', toolInput: { secret: 'input-secret' } }, call: async (name) => {
    calls.push(name);
    if (name === 'start_work_session') return { lease_token: 'private-lease', expires_at: 1800000300 };
    return { body: 'test-credential sk_stele_conn_fake-secret' };
  } });
  assert.doesNotMatch(JSON.stringify(result.output), /test-credential|sk_stele_conn_fake-secret|input-secret|private-lease/);
  assert.equal(result.state.contextDelivered, true);
});

test('network failure is visible but does not block Grok or copy raw errors', async () => {
  const result = await processEvent({ config, state: {}, now: 1_800_000_000_000, secrets: [], event: { hookEventName: 'user_prompt_submit', promptId: 't' }, call: async () => { throw new Error('Bearer raw-secret https://private-host'); } });
  assert.equal(result.output, null);
  assert.equal(result.warning, 'presence_unavailable');
  assert.doesNotMatch(JSON.stringify(result), /raw-secret|private-host/);
});

test('tool events without promptId deliver context through their observed pre-tool binding', async () => {
  const f = fixture();
  await f.run('user_prompt_submit');
  await f.run('pre_tool_use', null, { toolUseId: 'call-a' });
  const context = await f.run('post_tool_use', null, { toolUseId: 'call-a' });
  assert.match(context.output?.hookSpecificOutput.additionalContext ?? '', /synthetic numbers are 2 and 3/);
  assert.equal((await f.run('post_tool_use', null, { toolUseId: 'call-a' })).output, null);
  await f.run('stop');
  assert.equal(f.calls.filter(c => c.name === 'finish_work_session').length, 1);
});

test('late or orphan tool events cannot borrow a newer turn or restart a finished turn', async () => {
  const f = fixture();
  await f.run('pre_tool_use', null, { toolUseId: 'before-start' });
  assert.equal(f.calls.length, 0);
  await f.run('user_prompt_submit');
  await f.run('pre_tool_use', null, { toolUseId: 'old-call' });
  await f.run('user_prompt_submit', 'turn-b');
  await f.run('pre_tool_use', null, { toolUseId: 'old-call' });
  const before = f.calls.length;
  assert.equal((await f.run('post_tool_use', null, { toolUseId: 'old-call' })).output, null);
  assert.equal((await f.run('post_tool_use', null, { toolUseId: 'orphan' })).output, null);
  assert.equal(f.calls.length, before);
  await f.run('pre_tool_use', null, { toolUseId: 'new-call' });
  assert((await f.run('post_tool_use_failure', null, { toolUseId: 'new-call' })).output);
  await f.run('stop', 'turn-b');
  const stopped = f.calls.length;
  await f.run('pre_tool_use', null, { toolUseId: 'after-stop' });
  await f.run('post_tool_use', null, { toolUseId: 'after-stop' });
  assert.equal(f.calls.length, stopped);
});

test('an old tool binding cannot restart its turn after prompt deduplication history expires', async () => {
  const f = fixture();
  await f.run('user_prompt_submit', 'old');
  await f.run('pre_tool_use', null, { toolUseId: 'old-call' });
  for (let i = 0; i < 32; i++) await f.run('user_prompt_submit', `new-${i}`);
  const before = f.calls.length;
  const result = await f.run('post_tool_use', null, { toolUseId: 'old-call' });
  assert.equal(result.state.turn, 'new-31');
  assert.equal(result.output, null);
  assert.equal(f.calls.length, before);
});
