/**
 * MCP egress: expose the memory store to other MCP clients over the DSH Web
 * server's loopback HTTP listener.
 *
 * The transport is stateless Streamable HTTP JSON-RPC: POST a single request (or
 * a batch) and receive JSON. No DSH agent or browser session is required, so
 * Claude Desktop / Cursor / a local script can read the same knowledge base.
 *
 * Tools are intentionally a small, explicit surface:
 *   aim_roots, aim_search, aim_remember, aim_status,
 *   aim_context_list, aim_context_restore
 *
 * `aim_context_restore` returns the archived text; it does not inject anything
 * into a live DSH conversation.
 */

import { samePath } from './registry.js';

export const MCP_PATH = '/ai-for-memory/mcp';

const PROTOCOL_VERSIONS = Object.freeze(['2024-11-05', '2025-03-26', '2025-06-18']);
const LATEST_PROTOCOL = '2025-06-18';

const ROOT_PROPERTY = Object.freeze({
  type: 'string',
  description: '已登记的记忆根目录；省略时使用最近登记/配置的那个。',
});

const TOOL_DEFS = Object.freeze([
  {
    name: 'aim_roots',
    description: '列出 AI for Memory 已登记的记忆根目录，供后续工具选择 root。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'aim_search',
    description: '检索 AI for Memory 知识库（默认跨对话 + 共享层），返回带出处和置信度的条目。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词或自然语言问题。' },
        root: ROOT_PROPERTY,
        scope: { type: 'string', enum: ['all', 'session', 'shared'], description: '默认 all。' },
        category: { type: 'string', description: '只检索某个知识分类。' },
        top_k: { type: 'integer', minimum: 1, maximum: 50, description: '返回条数，默认 5。' },
        mode: { type: 'string', enum: ['bm25', 'vector', 'hybrid'], description: '检索模式。' },
        route: { type: 'string', enum: ['auto', 'sql', 'vector', 'hybrid'], description: '查询路由。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'aim_remember',
    description: '向共享知识库写入一条一句式结论。MCP 写入固定进共享层，避免落到临时会话。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '一条可复用的结论。' },
        root: ROOT_PROPERTY,
        category: { type: 'string', description: '知识分类，默认 project_facts。' },
        tags: { type: 'array', items: { type: 'string' }, description: '最多 8 个标签。' },
        url: { type: 'string', description: '出处链接。' },
        doc_id: { type: 'string', description: '可自定义稳定 id。' },
        confidence: { type: 'number', description: '0~1，默认 0.8。' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'aim_status',
    description: '查看一个记忆根目录的分层统计（过程记录、归档、快照、知识、上下文）。',
    inputSchema: {
      type: 'object',
      properties: { root: ROOT_PROPERTY },
      additionalProperties: false,
    },
  },
  {
    name: 'aim_context_list',
    description: '列出上下文存档（可按本对话/共享/全部范围筛选），用于找到可恢复的 context_id。',
    inputSchema: {
      type: 'object',
      properties: {
        root: ROOT_PROPERTY,
        scope: { type: 'string', enum: ['all', 'session', 'shared'], description: '默认 all。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'aim_context_restore',
    description: '按 context_id 读取上下文存档并返回文本；只返回内容，不注入任何在线对话。',
    inputSchema: {
      type: 'object',
      properties: {
        context_id: { type: 'string', description: '存档 id（支持 id 前缀）。' },
        root: ROOT_PROPERTY,
      },
      required: ['context_id'],
      additionalProperties: false,
    },
  },
]);

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text: String(text ?? '') }], isError };
}

function listRoots(deps) {
  const rows = typeof deps?.listRoots === 'function' ? deps.listRoots() : [];
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row.root === 'string' && row.root !== '')
    .map((row) => ({
      root: row.root,
      workspace: row.workspace ?? null,
      label: row.label || row.root,
      fixed: row.fixed === true,
      updatedAt: row.updatedAt ?? '',
    }));
}

function pickRoot(deps, requested) {
  const roots = listRoots(deps);
  if (roots.length === 0) throw new Error('还没有已登记的记忆根目录；先在 DSH 里使用一次 AI for Memory。');
  if (typeof requested !== 'string' || requested.trim() === '') return roots[0];
  const wanted = requested.trim();
  const match = roots.find((row) => samePath(row.root, wanted))
    ?? roots.find((row) => typeof row.workspace === 'string' && samePath(row.workspace, wanted));
  if (!match) {
    throw new Error(`没有登记这个记忆根目录：${wanted}。可用：${roots.map((row) => row.root).join('、')}`);
  }
  return match;
}

async function callTool(name, args, deps) {
  if (name === 'aim_roots') {
    return JSON.stringify({ roots: listRoots(deps) }, null, 2);
  }
  if (typeof deps?.runTool !== 'function') throw new Error('当前运行环境没有可调用的记忆工具。');
  const row = pickRoot(deps, args?.root);
  const target = { root: row.root, workspace: row.workspace ?? row.root };
  const clean = { ...args };
  delete clean.root;

  if (name === 'aim_search') {
    return deps.runTool('aim_search', clean, target);
  }
  if (name === 'aim_remember') {
    return deps.runTool('aim_memory', {
      ...clean,
      action: 'remember',
      scope: 'shared',
      category: clean.category || 'project_facts',
    }, target);
  }
  if (name === 'aim_status') {
    return deps.runTool('aim_memory', { action: 'status' }, target);
  }
  if (name === 'aim_context_list') {
    return deps.runTool('aim_context', { action: 'list', scope: clean.scope || 'all' }, target);
  }
  if (name === 'aim_context_restore') {
    return deps.runTool('aim_context', {
      action: 'restore',
      context_id: clean.context_id,
      scope: 'all',
    }, target);
  }
  throw Object.assign(new Error(`未知的 MCP 工具：${name}`), { code: -32602 });
}

/**
 * Handle one JSON-RPC message or a batch.
 *
 * @returns {object|Array<object>|null} a response, a batch response, or null for
 *   notifications (which must not be answered).
 */
export async function handleMcpMessage(message, deps = {}) {
  if (Array.isArray(message)) {
    if (message.length === 0) return rpcError(null, -32600, 'JSON-RPC 批次为空');
    const replies = [];
    for (const item of message) {
      const reply = await handleMcpMessage(item, deps);
      if (reply !== null) replies.push(reply);
    }
    return replies.length === 0 ? null : replies;
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, -32600, 'JSON-RPC 请求必须是对象');
  }
  if (message.jsonrpc !== '2.0') return rpcError(message.id, -32600, 'jsonrpc 必须是 2.0');
  if (typeof message.method !== 'string' || message.method === '') {
    return rpcError(message.id, -32600, '缺少 method');
  }
  const hasId = Object.hasOwn(message, 'id') && message.id !== undefined;
  const id = hasId ? message.id : null;

  try {
    if (message.method === 'initialize') {
      const requested = message.params?.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'ai-for-memory', version: deps.version ?? '0.1.0' },
          instructions: 'AI for Memory：可以检索知识库、写入共享知识、查看统计和上下文存档。'
            + '先调用 aim_roots 选择记忆根目录；aim_context_restore 只返回文本，不会注入 DSH 对话。',
        },
      };
    }
    if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
      return null;
    }
    if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (message.method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFS } };
    }
    if (message.method === 'resources/list') {
      return { jsonrpc: '2.0', id, result: { resources: [] } };
    }
    if (message.method === 'prompts/list') {
      return { jsonrpc: '2.0', id, result: { prompts: [] } };
    }
    if (message.method === 'tools/call') {
      const name = message.params?.name;
      if (typeof name !== 'string' || name === '') {
        return rpcError(id, -32602, 'tools/call 缺少 name');
      }
      if (!TOOL_DEFS.some((tool) => tool.name === name)) {
        return rpcError(id, -32602, `未知工具：${name}`);
      }
      const args = message.params?.arguments && typeof message.params.arguments === 'object'
        && !Array.isArray(message.params.arguments)
        ? message.params.arguments
        : {};
      try {
        const output = await callTool(name, args, deps);
        return { jsonrpc: '2.0', id, result: textResult(output) };
      } catch (error) {
        return { jsonrpc: '2.0', id, result: textResult(`错误：${error?.message ?? error}`, true) };
      }
    }
    return rpcError(id, -32601, `未知方法：${message.method}`);
  } catch (error) {
    if (!hasId) return null;
    return rpcError(id, -32603, String(error?.message ?? error));
  }
}

export function mcpToolNames() {
  return TOOL_DEFS.map((tool) => tool.name);
}
