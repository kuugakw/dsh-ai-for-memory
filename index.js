/**
 * AI for Memory — layered project memory for DeepSeek Harness.
 *
 * Rewritten from the Python project `ai-game-for-memory` (originally
 * MemoryLayer): a rolling process log, an idempotent categorized archive,
 * exact state snapshots, a local BM25 + hashing-vector knowledge search, and
 * risk-reviewed decisions.
 *
 * On top of that, this plugin connects to DSH's `compaction` service so a
 * conversation can be archived, compacted out of the live window, and later
 * restored through `agent.inject()`.
 *
 * The plugin is dependency-free on purpose: it only imports Node builtins and
 * its own modules, then registers plain tool definition objects on `ctx.tools`.
 * That keeps installation working across DSH versions and lets the whole store
 * be tested with `node --test` without booting the Harness.
 */


import { defaultRegistryDir, listRootRows } from './lib/registry.js';
import { runSecurityCheck } from './lib/security-check.js';
import { wrapMemoryData } from './lib/egress.js';
import { installApi } from './lib/api.js';

// The boundary implementation lives in lib/egress.js; re-exported for the
// existing callers and tests that import it from the plugin entry point.
export { wrapMemoryData };
import { restoreLocalEngines } from './lib/local-engine.js';
import { ensureMcpToken } from './lib/mcp-token.js';
import { packageVersion } from './lib/version.js';

export const name = 'dsh-ai-for-memory';

/** Only the tool registry is required; workspace comes from each call. */
export const inject = ['tools'];

// Configuration lives in lib/config.js; re-exported here for existing callers.
import { auditCapability, normalizeConfig } from './lib/config.js';
export { Config, DEFAULTS, NUMERIC_BOUNDS, PROMOTE_BOUNDARY_NOTE, normalizeConfig } from './lib/config.js';
export {
  closedConversationCount, compileParameterSchema, createTools, memoryContext, memorySources,
  readableConversations, scopeVisibleTo, searchWithRag, workspaceOf,
} from './lib/tools.js';

// Tool definitions live in lib/tools.js; re-exported here for existing callers.
import { createTools, toRegistrableTool } from './lib/tools.js';

// Context management lives in lib/context-management.js; re-exported here.
import { installContextManagement } from './lib/context-management.js';
export { installContextManagement, planPrefixReset } from './lib/context-management.js';

export function apply(ctx, config) {
  const resolved = normalizeConfig(config);
  let workingDirectory;
  try {
    workingDirectory = typeof ctx?.get === 'function' ? ctx.get('workingDirectory') : undefined;
  } catch {
    workingDirectory = undefined;
  }
  const registryDir = defaultRegistryDir();
  const getService = (serviceName) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(serviceName) : undefined;
    } catch {
      return undefined;
    }
  };
  const deps = { workingDirectory, registryDir, getService };
  const runtime = { counters: new Map(), pending: new Map(), activity: new Map() };

  // Startup self-check, only when the memory root is fixed in the config: a
  // failing check is reported once and never blocks the plugin. The panel can
  // re-run it at any time through GET /ai-for-memory/api/security/check.
  if (typeof resolved.root === 'string' && resolved.root !== '') {
    try {
      const report = runSecurityCheck({ root: resolved.root, config: resolved, registryDir });
      if (!report.ok) {
        const failed = report.checks.filter((check) => !check.ok).map((check) => check.id).join(', ');
        console.error(`[ai-for-memory] 安全体检未通过：${failed}（面板查看 /api/security/check）`);
        auditCapability('self-check', false, failed, registryDir);
      }
    } catch {
      // A read-only inspection must never prevent startup.
    }
  }

  // Enabling MCP is itself a capability: it opens a second HTTP surface on the
  // loopback listener. Requesting it without the grant keeps it off (and says
  // so), instead of silently exposing the surface.
  if (resolved.mcpEnabled === true && resolved.capabilityMcp !== true) {
    resolved.mcpEnabled = false;
    auditCapability('mcp', false, 'mcpEnabled=true 但没有 capabilityMcp', registryDir);
    console.error('[ai-for-memory] MCP 出口未启用：capabilityMcp 未授权（在配置里设 capabilityMcp: true 后才生效）。');
  }

  /**
   * Run one existing memory tool for an MCP caller. The caller supplies a
   * registered root; the synthetic session is only a carrier for the root and
   * never a real DSH conversation.
   */
  const runMcpTool = async (toolName, args, target = {}) => {
    if (typeof toolName !== 'string' || toolName === '') throw new Error('缺少工具名');
    const root = typeof target.root === 'string' && target.root !== ''
      ? target.root
      : resolved.root;
    const workspace = typeof target.workspace === 'string' && target.workspace !== ''
      ? target.workspace
      : root;
    const tools = createTools({ ...resolved, root }, deps, runtime);
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool || typeof tool.execute !== 'function') throw new Error(`未知工具：${toolName}`);
    let liveAgent = target.agent;
    if (!liveAgent && typeof target.sessionId === 'string' && target.sessionId !== '') {
      const agents = getService('agents');
      if (agents && typeof agents.get === 'function') liveAgent = agents.get(target.sessionId);
    }
    const liveSession = liveAgent?.session
      ?? (target.session || null)
      ?? {
        id: `mcp-${process.pid}`,
        header: { cwd: workspace },
      };
    let injected = null;
    const exec = {
      agent: {
        session: liveSession,
        whenIdle: typeof liveAgent?.whenIdle === 'function' ? liveAgent.whenIdle.bind(liveAgent) : undefined,
        inject: async (payload) => {
          const text = Array.isArray(payload?.content)
            ? payload.content.map((item) => item?.text ?? '').filter(Boolean).join('\n')
            : '';
          if (text !== '') injected = text;
          if (liveAgent && typeof liveAgent.inject === 'function') await liveAgent.inject(payload);
        },
      },
    };
    const output = await tool.execute(args ?? {}, exec);
    return injected ?? output;
  };
  const listMcpRoots = () => listRootRows(registryDir, resolved.root);

  try {
    installContextManagement(ctx, resolved, deps, runtime);
  } catch (error) {
    console.error(`[ai-for-memory] 上下文管理注册失败：${error?.message ?? error}`);
  }

  for (const raw of createTools(resolved, deps, runtime)) {
    const tool = toRegistrableTool(raw);
    try {
      if (typeof ctx?.effect === 'function') {
        ctx.effect(() => ctx.tools.register(tool));
      } else {
        ctx.tools.register(tool);
      }
    } catch (error) {
      console.error(`[ai-for-memory] 工具 ${tool.name} 注册失败：${error?.message ?? error}`);
    }
  }

  // Adopt llama-server processes left by a previous DSH/plugin process before
  // the panel can offer a start button; otherwise a reload can spawn a second
  // server on a new port while the survivor keeps its VRAM. Adoption never
  // starts or stops a model; lifecycle is an explicit user action.
  try {
    void restoreLocalEngines({ scanProcesses: true });
  } catch (error) {
    console.error(`[ai-for-memory] 本地引擎接管失败：${error?.message ?? error}`);
  }

  // The Web panel reads the same store over a small same-origin HTTP API.
  let editor;
  try {
    editor = typeof ctx?.get === 'function' ? ctx.get('configEditor') : undefined;
  } catch {
    editor = undefined;
  }
  try {
    // Only mint the token file when the egress surface is actually enabled:
    // a disabled MCP must not leave a credential on disk.
    const mcpAccess = resolved.mcpEnabled === true
      ? ensureMcpToken(registryDir, resolved.mcpToken)
      : { token: '', file: '' };
    installApi(ctx, {
      config: resolved,
      entry: ctx?.fiber?.entry,
      editor,
      registryDir,
      runtime,
      getService,
      runMcpTool,
      listMcpRoots,
      version: packageVersion(),
      mcpToken: mcpAccess.token,
      mcpTokenFile: mcpAccess.file,
    });
  } catch (error) {
    console.error(`[ai-for-memory] 面板 API 注册失败：${error?.message ?? error}`);
  }
}
