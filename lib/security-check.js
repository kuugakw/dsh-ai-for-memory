/**
 * Security self-check: a small, read-only inspection of the memory directory.
 *
 * It answers one question the panel can show: are the on-disk protections the
 * ones this plugin promises (0700 roots, 0600 files, no unexplained MCP egress,
 * backups present, schema current)? It never fails an operation; a failing
 * check is information for the user.
 */

import fs from 'node:fs';
import path from 'node:path';

import { MCP_TOKEN_FILE } from './mcp-token.js';
import { SCHEMA_VERSION } from './util.js';

const MODE_MASK = 0o777;

function modeOf(target) {
  try {
    return fs.statSync(target).mode & MODE_MASK;
  } catch {
    return null;
  }
}

function octal(mode) {
  return mode === null ? '?' : `0${mode.toString(8).padStart(3, '0')}`;
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * @param {{root: string, config: any, registryDir: string}} input
 * @returns {{ok: boolean, checkedAt: string, checks: Array<{id: string, ok: boolean, detail: string}>}}
 */
export function runSecurityCheck(input = /** @type {any} */ ({})) {
  const root = typeof input.root === 'string' ? input.root : '';
  const config = input.config ?? {};
  const registryDir = typeof input.registryDir === 'string' ? input.registryDir : '';
  const checks = [];
  const push = (id, ok, detail) => checks.push({ id, ok, detail });

  // 1. The memory root and its sub-directories are private to the account.
  if (root !== '') {
    const rootMode = modeOf(root);
    if (rootMode === null) {
      push('root-mode', true, `记忆目录尚未创建：${root}（首次使用时以 0700 创建）`);
    } else {
      push('root-mode', (rootMode & 0o077) === 0, `记忆根目录权限 ${octal(rootMode)}（期望 0700）`);
    }
    for (const name of ['knowledge', 'snapshots', 'context', 'exports', 'archive', 'staging']) {
      const dir = path.join(root, name);
      const mode = modeOf(dir);
      if (mode === null) continue;
      push(`${name}-mode`, (mode & 0o077) === 0, `${name}/ 权限 ${octal(mode)}（期望 0700）`);
    }

    // 2. Knowledge files are 0600; sample up to 20 so a big library stays cheap.
    const knowledgeDir = path.join(root, 'knowledge');
    const files = listFiles(knowledgeDir).slice(0, 20);
    if (files.length > 0) {
      const loose = files.filter((file) => {
        const mode = modeOf(file);
        return mode !== null && (mode & 0o077) !== 0;
      });
      push('knowledge-file-modes', loose.length === 0,
        loose.length === 0
          ? `${files.length} 个知识文件均为 0600`
          : `${loose.length}/${files.length} 个知识文件权限不是 0600（例如 ${path.basename(loose[0])}）`);
    }

    // 3. Backups are rollback, not a failure; only report their presence.
    const backupsDir = path.join(root, 'backups');
    const backups = fs.existsSync(backupsDir)
      ? fs.readdirSync(backupsDir).filter((name) => name.startsWith('schema-v'))
      : [];
    push('backups', true, backups.length === 0
      ? '没有迁移备份（首次升级时创建）'
      : `迁移备份 ${backups.length} 份（含脱敏前明文，确认无误后可删）`);

    // 4. Schema version matches the code; a mismatch means a pending migration.
    try {
      const metaFile = path.join(root, 'meta.json');
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      push('schema-version', meta.schema_version === SCHEMA_VERSION,
        `schema_version=${meta.schema_version}（当前 ${SCHEMA_VERSION}）`);
    } catch {
      push('schema-version', true, '尚无 meta.json（尚未初始化）');
    }
  }

  // 5. MCP is a second HTTP surface; it must be granted, not just enabled.
  if (config.mcpEnabled === true) {
    if (config.capabilityMcp !== true) {
      push('mcp-capability', false, 'mcpEnabled=true 但没有 capabilityMcp：MCP 实际不会启动');
    } else {
      const tokenFile = registryDir === '' ? '' : path.join(registryDir, MCP_TOKEN_FILE);
      const hasToken = tokenFile !== '' && fs.existsSync(tokenFile);
      push('mcp-token', hasToken, hasToken
        ? `MCP 已启用，token 文件存在（${tokenFile}）`
        : 'MCP 已启用但 token 文件缺失（重启插件后会重新生成）');
    }
  } else {
    push('mcp-disabled', true, 'MCP 出口未启用');
  }

  // 6. The audit log holds capability decisions; it must be 0600 as well.
  if (registryDir !== '') {
    const auditFile = path.join(registryDir, 'audit.jsonl');
    const mode = modeOf(auditFile);
    if (mode !== null) {
      push('audit-mode', (mode & 0o077) === 0, `audit.jsonl 权限 ${octal(mode)}（期望 0600）`);
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    checkedAt: new Date().toISOString(),
    checks,
  };
}
