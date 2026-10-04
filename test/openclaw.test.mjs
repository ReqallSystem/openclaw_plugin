import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import entry from '../index.js';
import { createReqallPlugin } from '../src/reqall-plugin.js';
import { SAMPLE_RECORDS, fakeReqall, testEnv } from './fake-reqall.mjs';

const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function load({ config = {}, env = {} } = {}) {
  const fake = fakeReqall({ records: SAMPLE_RECORDS });
  const handlers = {};
  const options = {};
  const api = {
    pluginConfig: config,
    on(name, handler, opts) {
      handlers[name] = handler;
      options[name] = opts;
    },
  };
  createReqallPlugin({ env: testEnv(env), fetch: fake.fetch }).register(api);
  return { handlers, options, fake };
}

const ctx = { sessionKey: 'agent:main:chat-1', sessionId: 's1', workspaceDir: '/tmp' };

test('entry and manifest agree and stay out of the memory slot', () => {
  assert.equal(entry.id, manifest.id);
  assert.equal(typeof entry.register, 'function');
  assert.equal(manifest.kind, undefined);
  assert.deepEqual(manifest.skills, ['./skills']);
  assert.equal(manifest.mcpServers.reqall.transport, 'streamable-http');
  assert.equal(manifest.configSchema.type, 'object');
  assert.deepEqual(pkg.openclaw.extensions, ['./index.js']);
  assert.ok(pkg.files.includes('openclaw.plugin.json'));
  assert.equal(manifest.version, pkg.version);
});

test('registers the lifecycle hooks it relies on', () => {
  const { handlers, options } = load();
  assert.deepEqual(Object.keys(handlers).sort(), ['after_tool_call', 'before_agent_finalize', 'before_prompt_build', 'session_end']);
  assert.equal(options.before_prompt_build.timeoutMs, 15000);
});

test('before_prompt_build adds policy and per-prompt recall', async () => {
  const { handlers, fake } = load();
  const result = await handlers.before_prompt_build({ prompt: 'Add CSV export to widgets', messages: [] }, ctx);
  assert.match(result.appendSystemContext, /Reqall Memory Autopilot/);
  assert.match(result.prependContext, /#7 spec\/open/);
  assert.match(result.prependContext, /session_id="openclaw:[0-9a-f]{32}"/);
  assert.match(result.prependContext, /reqall-intend/);
  assert.equal(fake.calls.find((c) => c.name === 'upsert_project').args.name, 'acme/widgets');

  const trivial = await handlers.before_prompt_build({ prompt: 'thanks', messages: [] }, ctx);
  assert.equal(trivial.prependContext, undefined);
  assert.equal(await handlers.before_prompt_build({ prompt: 'Implement x', messages: [] }, { ...ctx, trigger: 'heartbeat' }), undefined);
});

test('configured projectName applies only when the environment has none', async () => {
  const configured = load({ config: { projectName: 'acme/assistant' }, env: { REQALL_PROJECT_NAME: '' } });
  await configured.handlers.before_prompt_build({ prompt: 'Plan the week', messages: [] }, ctx);
  assert.equal(configured.fake.calls.find((c) => c.name === 'upsert_project').args.name, 'acme/assistant');
  const env = load({ config: { projectName: 'acme/assistant' } });
  await env.handlers.before_prompt_build({ prompt: 'Plan the week', messages: [] }, ctx);
  assert.equal(env.fake.calls.find((c) => c.name === 'upsert_project').args.name, 'acme/widgets');
});

test('finalize asks for one persistence pass after unrecorded edits', async () => {
  const { handlers } = load();
  await handlers.before_prompt_build({ prompt: 'Refactor the exporter', messages: [] }, ctx);
  const finalize = { sessionId: 's1', sessionKey: ctx.sessionKey, stopHookActive: false };
  assert.equal(handlers.before_agent_finalize(finalize, ctx), undefined, 'clean turn finalizes');

  handlers.after_tool_call({ toolName: 'exec', params: { command: 'git status' } }, ctx);
  assert.equal(handlers.before_agent_finalize(finalize, ctx), undefined, 'read-only exec is not work');

  handlers.after_tool_call({ toolName: 'edit', params: { path: 'src/a.ts' }, error: 'denied' }, ctx);
  assert.equal(handlers.before_agent_finalize(finalize, ctx), undefined, 'failed edits are not work');

  handlers.after_tool_call({ toolName: 'apply_patch', params: {} }, ctx);
  const decision = handlers.before_agent_finalize(finalize, ctx);
  assert.equal(decision.action, 'revise');
  assert.match(decision.retry.instruction, /reqall-persist/);
  assert.equal(decision.retry.maxAttempts, 1);
  assert.equal(handlers.before_agent_finalize(finalize, ctx), undefined, 'once per turn');

  handlers.after_tool_call({ toolName: 'reqall__upsert_record', params: {} }, ctx);
  await handlers.before_prompt_build({ prompt: 'Now add tests', messages: [] }, ctx);
  assert.equal(handlers.before_agent_finalize(finalize, ctx), undefined, 'persisted');
});

test('autoPersist off and stopHookActive never revise; session_end clears state', async () => {
  const off = load({ config: { autoPersist: 'off' } });
  await off.handlers.before_prompt_build({ prompt: 'Refactor', messages: [] }, ctx);
  off.handlers.after_tool_call({ toolName: 'write', params: { path: 'a' } }, ctx);
  assert.equal(off.handlers.before_agent_finalize({ sessionKey: ctx.sessionKey }, ctx), undefined);

  const { handlers } = load();
  await handlers.before_prompt_build({ prompt: 'Refactor', messages: [] }, ctx);
  handlers.after_tool_call({ toolName: 'write', params: { path: 'a' } }, ctx);
  assert.equal(handlers.before_agent_finalize({ sessionKey: ctx.sessionKey, stopHookActive: true }, ctx), undefined);
  handlers.session_end({ sessionKey: ctx.sessionKey, sessionId: 's1', reason: 'reset' }, ctx);
  assert.equal(handlers.before_agent_finalize({ sessionKey: ctx.sessionKey }, ctx), undefined);
});
