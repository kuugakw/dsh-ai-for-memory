/**
 * Loopback bearer token for the MCP egress.
 *
 * The MCP route is not a browser session: a local process can POST JSON-RPC to
 * it directly. A per-install token is generated once and stored next to the
 * plugin's registry data with owner-only permissions; explicit config wins.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MCP_TOKEN_FILE = 'mcp-token';

export function mcpTokenPath(registryDir) {
  return path.join(registryDir, MCP_TOKEN_FILE);
}

/**
 * Return the effective MCP token and its source.
 *
 * @param {string} registryDir
 * @param {string} configured
 * @returns {{token: string, source: 'config'|'file', file: string}}
 */
export function ensureMcpToken(registryDir, configured = '') {
  const configuredValue = String(configured ?? '').trim();
  const file = mcpTokenPath(registryDir);
  if (configuredValue !== '') return { token: configuredValue, source: 'config', file: '' };

  let token;
  try {
    token = fs.readFileSync(file, 'utf8').trim();
  } catch {
    token = '';
  }
  if (token === '') {
    token = randomBytes(32).toString('hex');
    try {
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    } catch {
      // A read-only registry still leaves the generated token usable for this
      // process; it is simply regenerated on the next start.
    }
  }
  return { token, source: 'file', file };
}
