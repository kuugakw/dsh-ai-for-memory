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
let provenanceCommit = '';
let provenanceDigest = '';
if (dist.attestations?.url) {
  try {
    const attestation = await (await fetch(dist.attestations.url, {
      headers: { 'user-agent': 'dsh-ai-for-memory-release-verify' },
    })).json();
    const slsa = (attestation.attestations ?? [])
      .find((item) => item.predicateType === 'https://slsa.dev/provenance/v1');
    if (slsa?.bundle?.dsseEnvelope?.payload) {
      const payload = JSON.parse(Buffer.from(slsa.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
      provenanceCommit = payload.predicate?.buildDefinition?.resolvedDependencies?.[0]?.digest?.gitCommit ?? '';
      provenanceDigest = payload.subject?.[0]?.digest?.sha512 ?? '';
    }
  } catch {
    // The local checks still cover version/integrity/trusted publisher.
  }
}
if (!pass(Boolean(dist.attestations?.url && provenance?.predicateType), 'npm provenance attestation',
  dist.attestations?.url ?? 'missing')) {
  problems.push('no npm provenance: publish with --provenance from GitHub Actions');
}
if (!pass(Boolean(dist.integrity), 'tarball integrity', dist.integrity ?? 'missing')) {
  problems.push('registry has no tarball integrity');
}
if (provenanceDigest && typeof dist.integrity === 'string' && dist.integrity.startsWith('sha512-')) {
  const actual = Buffer.from(dist.integrity.slice('sha512-'.length), 'base64').toString('hex');
  if (!pass(actual === provenanceDigest, 'provenance subject digest matches tarball')) {
    problems.push('provenance subject digest does not match registry integrity');
  }
}

const trusted = doc._npmUser?.trustedPublisher;
if (!pass(trusted?.id === 'github', 'OIDC trusted publisher', trusted ? 'github' : 'missing (token publish?)')) {
  problems.push('published without the GitHub OIDC trusted publisher');
}

const registryHead = String(dist.gitHead ?? doc.gitHead ?? '');
const head = registryHead || provenanceCommit;
const local = git('rev-parse', '--verify', `${tag}^{}`);
if (!local) {
  warnings.push(`local tag ${tag} is not present; cannot compare gitHead`);
} else if (head === '') {
  warnings.push('neither registry gitHead nor provenance commit is available');
} else {
  const source = registryHead ? 'gitHead' : 'provenance commit';
  if (!pass(head === local, `${source} matches tag commit`, head.slice(0, 12))) {
    problems.push(`${source} ${head} != ${tag} commit ${local}`);
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
