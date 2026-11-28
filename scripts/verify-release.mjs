#!/usr/bin/env node
/**
 * Verify the published artifact's supply-chain record.
 *
 * For a version, this checks:
 *   - npm has a provenance attestation (OIDC trusted publishing, not a token);
 *   - the registry's `gitHead` equals the local tag's commit;
 *   - the local tag is signed (warning by default, `--require-tag-signature`
 *     turns it into an error);
 *   - the registry tarball integrity is present (npm audit covers signatures).
 *
 *   node scripts/verify-release.mjs 0.5.25
 *   node scripts/verify-release.mjs 0.5.25 --require-tag-signature
 *
 * The script is also run by the publish workflow after `npm publish`; a missing
 * provenance attestation or a token-published package fails the release.
 */
import { execFileSync } from 'node:child_process';

const PACKAGE = 'dsh-ai-for-memory';
const args = process.argv.slice(2);
const version = args.find((value) => !value.startsWith('-')) ?? '';
const requireTagSignature = args.includes('--require-tag-signature');

function git(...argv) {
  try {
    return execFileSync('git', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function pass(ok, label, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `：${detail}` : ''}`);
  return ok;
}

if (!version) {
  console.error('usage: node scripts/verify-release.mjs <version> [--require-tag-signature]');
  process.exit(2);
}
const tag = `v${version}`;
const problems = [];
const warnings = [];

const response = await fetch(`https://registry.npmjs.org/${PACKAGE}/${encodeURIComponent(version)}`, {
  headers: { 'user-agent': 'dsh-ai-for-memory-release-verify' },
});
if (!response.ok) {
  console.error(`✗ registry lookup failed: HTTP ${response.status}`);
  process.exit(1);
}
const doc = await response.json();

if (!pass(doc.version === version, 'registry version', doc.version)) {
  problems.push('registry returned a different version');
}
const dist = doc.dist ?? {};
const provenance = dist.attestations?.provenance;
if (!pass(Boolean(dist.attestations?.url && provenance?.predicateType), 'npm provenance attestation',
  dist.attestations?.url ?? 'missing')) {
  problems.push('no npm provenance: publish with --provenance from GitHub Actions');
}
if (!pass(Boolean(dist.integrity), 'tarball integrity', dist.integrity ?? 'missing')) {
  problems.push('registry has no tarball integrity');
}

const trusted = doc._npmUser?.trustedPublisher;
if (!pass(trusted?.id === 'github', 'OIDC trusted publisher', trusted ? 'github' : 'missing (token publish?)')) {
  problems.push('published without the GitHub OIDC trusted publisher');
}

const head = String(dist.gitHead ?? doc.gitHead ?? '');
const local = git('rev-parse', '--verify', `${tag}^{}`);
if (!local) {
  warnings.push(`local tag ${tag} is not present; cannot compare gitHead`);
} else {
  if (!pass(head === local, 'gitHead matches tag commit', head.slice(0, 12))) {
    problems.push(`registry gitHead ${head} != ${tag} commit ${local}`);
  }
  const signed = (() => {
    try {
      execFileSync('git', ['verify-tag', tag], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  pass(signed, 'signed tag', signed ? tag : 'unsigned (annotated only)');
  if (!signed) {
    if (requireTagSignature) problems.push(`${tag} is not signed`);
    else warnings.push(`${tag} is not signed; publish with an SSH/GPG signature for tag verification`);
  }
}

for (const warning of warnings) console.warn(`warning: ${warning}`);
if (problems.length > 0) {
  console.error(`\nrelease verification failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('\nrelease verification passed');
