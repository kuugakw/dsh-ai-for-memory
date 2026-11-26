// @ts-check
/**
 * The one runtime source for the plugin version.
 *
 * Release tooling should update package.json (and the release metadata), not a
 * hand-maintained string inside the MCP server. Tests and stdio MCP clients can
 * therefore compare `serverInfo.version` with the installed package.
 */

import fs from 'node:fs';

let cached = null;

export function packageVersion() {
  if (cached !== null) return cached;
  try {
    const file = new URL('../package.json', import.meta.url);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    cached = typeof parsed?.version === 'string' && parsed.version.trim() !== ''
      ? parsed.version.trim()
      : '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
