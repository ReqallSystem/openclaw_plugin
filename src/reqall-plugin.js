/**
 * Reqall native plugin for OpenClaw.
 *
 * - before_prompt_build: Reqall policy as cacheable system context, plus
 *   recall for each non-trivial prompt as prepended context
 * - after_tool_call: tracks unpersisted edits; Reqall writes clear them
 * - before_agent_finalize: one revision pass asking the agent to persist
 * - session_end: drops session state
 *
 * MCP tools come from the manifest's `reqall` server (or the operator's
 * `mcp.servers.reqall`). Every Reqall call fails open.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractProjectHint, resolveProjectBinding } from '../lib/project-policy.mjs';
import {
  ReqallClient,
  bindingNote,
  intentDirective,
  isMutatingTool,
  isReqallWriteTool,
  isTrivialPrompt,
  persistDirective,
  recallContext,
  sessionLabel,
} from '../lib/reqall.mjs';

const HOST = 'OpenClaw';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function policy() {
  try {
    return readFileSync(join(ROOT, 'REQALL.md'), 'utf8').trim();
  } catch {
    return 'Use Reqall memory: load context before non-trivial work, record agreed intent, and persist outcomes before finishing.';
  }
}

function lower(value, fallback) {
  return value === undefined || value === null || value === '' ? fallback : String(value).toLowerCase();
}

/** Build the plugin entry. Tests inject `env` and `fetch`. */
export function createReqallPlugin({ env: baseEnv = process.env, fetch: fetchImpl } = {}) {
  return {
    id: 'reqall',
    name: 'Reqall',
    description: 'Persistent semantic project memory: recall before work, persist before done.',

    register(api) {
      const cfg = api.pluginConfig || {};
      // Environment wins over the host-scoped project setting (naming contract step 1).
      const env = { ...baseEnv };
      if (!env.REQALL_PROJECT_NAME?.trim() && typeof cfg.projectName === 'string' && cfg.projectName.trim()) {
        env.REQALL_PROJECT_NAME = cfg.projectName.trim();
      }
      const reqall = new ReqallClient({ env, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
      const autoContext = lower(cfg.autoContext ?? env.REQALL_AUTO_CONTEXT, 'inject');
      const autoPersist = lower(cfg.autoPersist ?? env.REQALL_AUTO_PERSIST, 'revise');
      const contextLimit = Number(cfg.contextLimit ?? env.REQALL_CONTEXT_LIMIT) || 5;
      const openLimit = Number(cfg.openLimit ?? env.REQALL_OPEN_LIMIT) || 10;
      const guidance = policy();
      const sessions = new Map();

      const keyOf = (ctx = {}) => ctx.sessionKey || ctx.sessionId || '';
      function session(key) {
        if (!sessions.has(key)) sessions.set(key, { project: '', selected: '', turn: 0, dirty: false, nudgedTurn: 0 });
        return sessions.get(key);
      }

      api.on('before_prompt_build', async (event = {}, ctx = {}) => {
        const key = keyOf(ctx);
        if (!key || /heartbeat|cron/i.test(String(ctx.trigger || ''))) return undefined;
        const prompt = String(event.currentUserMessage ?? event.prompt ?? '').trim();
        const state = session(key);
        state.turn += 1;
        state.selected = extractProjectHint(prompt) || state.selected;
        state.project = resolveProjectBinding(ctx.workspaceDir || process.cwd(), env, prompt, state.selected).name;
        const result = { appendSystemContext: guidance };
        if (!prompt || isTrivialPrompt(prompt) || autoContext === 'off') return result;

        const label = sessionLabel('openclaw', key);
        let context = bindingNote(state.project, label, HOST);
        if (autoContext === 'inject' && reqall.configured) {
          context = (await recallContext(reqall, {
            projectName: state.project, query: prompt.slice(0, 500), label, host: HOST, contextLimit, openLimit,
          })).text;
        }
        return { ...result, prependContext: `${context}\n\n${intentDirective(state.project)}` };
      }, { timeoutMs: 15_000 });

      api.on('after_tool_call', (event = {}, ctx = {}) => {
        const key = keyOf(ctx);
        if (!key || event.error) return;
        const state = session(key);
        if (isReqallWriteTool(event.toolName)) state.dirty = false;
        else if (isMutatingTool(event.toolName, event.params)) state.dirty = true;
      });

      api.on('before_agent_finalize', (event = {}, ctx = {}) => {
        const key = event.sessionKey || event.sessionId || keyOf(ctx);
        const state = sessions.get(key);
        if (!state?.dirty || event.stopHookActive || autoPersist === 'off' || state.nudgedTurn === state.turn) return undefined;
        state.nudgedTurn = state.turn;
        return {
          action: 'revise',
          reason: 'Reqall: this turn changed files or ran commands that are not yet persisted.',
          retry: {
            instruction: persistDirective(state.project, sessionLabel('openclaw', key)),
            idempotencyKey: `reqall-persist:${key}:${state.turn}`,
            maxAttempts: 1,
          },
        };
      });

      api.on('session_end', (event = {}, ctx = {}) => {
        sessions.delete(event.sessionKey || event.sessionId || keyOf(ctx));
      });
    },
  };
}
