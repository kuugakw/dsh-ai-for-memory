/**
 * Schema validation tests: the JSON Schemas advertised to the model are now
 * enforced at the two entry points (DSH tool registration and MCP tools/call).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateArgumentsMessage, validateValue } from '../lib/schema.js';
import { toRegistrableTool } from '../lib/tools.js';
import { handleMcpMessage } from '../lib/mcp.js';

test('validateValue covers the keywords the plugin uses', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 2 },
      count: { type: 'integer', minimum: 1, maximum: 10 },
      mode: { type: 'string', enum: ['a', 'b'] },
      tags: { type: 'array', items: { type: 'string' } },
      nested: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    },
    required: ['name'],
    additionalProperties: false,
  };

  assert.deepEqual(validateValue(schema, { name: 'ok' }), []);
  assert.match(validateValue(schema, {}).join('\n'), /name 是必填项/);
  assert.match(validateValue(schema, { name: 'x' }).join('\n'), /至少 2 个字符/);
  assert.match(validateValue(schema, { name: 'ok', count: 0 }).join('\n'), /不能小于 1/);
  assert.match(validateValue(schema, { name: 'ok', count: 1.5 }).join('\n'), /应为 integer/);
  assert.match(validateValue(schema, { name: 'ok', mode: 'c' }).join('\n'), /必须是/);
  assert.match(validateValue(schema, { name: 'ok', tags: ['a', 2] }).join('\n'), /tags\[1\] 应为 string/);
  assert.match(validateValue(schema, { name: 'ok', nested: {} }).join('\n'), /nested\.ok 是必填项/);
  assert.match(validateValue(schema, { name: 'ok', extra: 1 }).join('\n'), /不是允许的参数/);
  assert.deepEqual(validateValue({ type: ['string', 'null'] }, null), []);
});

test('validateArgumentsMessage renders one actionable message', () => {
  const message = validateArgumentsMessage({ type: 'object', required: ['q'] }, {}, '查询参数');
  assert.match(message, /查询参数校验失败/);
  assert.match(message, /- q 是必填项/);
  assert.match(message, /请修正参数后重试/);
  assert.equal(validateArgumentsMessage({ type: 'object' }, {}), '');
});

test('registered tools reject invalid arguments before the handler runs', async () => {
  let called = 0;
  const raw = {
    name: 'aim_test',
    parameters: {
      n: { type: 'number', required: true },
      label: { type: 'string' },
    },
    execute: async (args) => {
      called += 1;
      return `ok:${args.n}`;
    },
  };
  const tool = toRegistrableTool(raw);
  const invalid = await tool.execute({ n: 'not-a-number' }, {});
  assert.match(String(invalid), /aim_test 参数校验失败/);
  assert.equal(called, 0);

  assert.equal(await tool.execute({ n: 2 }, {}), 'ok:2');
  assert.equal(called, 1);
});

test('MCP tools/call rejects type violations with -32602', async () => {
  const reply = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'aim_search', arguments: { query: 42, root: '/tmp/x' } },
  }, {
    version: '0.0.0-test',
    listRoots: () => [{ root: '/tmp/x' }],
    runTool: async () => 'should-not-run',
  });
  assert.equal(reply.error?.code, -32602);
  assert.match(reply.error?.message ?? '', /校验失败/);
  assert.match(reply.error?.message ?? '', /query 应为 string/);
});
