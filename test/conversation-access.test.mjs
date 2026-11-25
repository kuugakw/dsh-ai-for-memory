import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MemoryScopes, sessionKey } from '../lib/scopes.js';
import {
  closedConversationCount, memorySources, readableConversations, scopeVisibleTo,
} from '../index.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aim-access-'));
}

function makeScopes(root) {
  return new MemoryScopes(root, { dshSessionsDir: path.join(root, 'no-dsh-sessions') });
}

/** Conversation keys of a `memorySources` result, in read order. */
function sourceKeys(sources) {
  return sources.filter((source) => source.scope === 'session').map((source) => source.key);
}

test('conversation access: setViewers keeps a clean allowlist and drops self', async () => {
  const root = tempRoot();
  try {
    const scopes = makeScopes(root);
    const keyA = scopes.ensureSession('conv-a', { label: 'A' });
    scopes.ensureSession('conv-b', { label: 'B' });
    await scopes.setViewers(keyA, ['conv-b', 'conv-b', '', 'conv-a', 42, ' conv-c ']);

    const row = scopes.listSessions().find((candidate) => candidate.key === keyA);
    // Duplicates collapse, blanks and non-strings are dropped, self is dropped,
    // and surrounding whitespace is trimmed.
    assert.deepEqual(row.viewers, ['conv-b', 'conv-c']);
    assert.deepEqual(scopes.readMeta(keyA).viewers, ['conv-b', 'conv-c']);
    assert.equal(row.public, false);

    await scopes.setViewers(keyA, []);
    const cleared = scopes.listSessions().find((candidate) => candidate.key === keyA);
    assert.deepEqual(cleared.viewers, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('conversation access: self, public and named viewers decide visibility', () => {
  const row = { key: 'k1', sessionId: 's1', public: false, viewers: ['s2', 'k3'] };

  assert.equal(scopeVisibleTo(row, 'k1', 's1'), true);
  assert.equal(scopeVisibleTo(row, 'k2', 's2'), true);
  // A key grant works even when the stored id form differs.
  assert.equal(scopeVisibleTo(row, 'k3', 's9'), true);
  assert.equal(scopeVisibleTo(row, 'k4', 's4'), false);
  assert.equal(scopeVisibleTo({ ...row, public: true }, 'k4', 's4'), true);
  assert.equal(scopeVisibleTo({ key: 'k1', sessionId: 's1', public: false, viewers: [] }, 'k2', 's2'), false);
});

test('conversation access: a named-viewer conversation is readable only by its viewers', async () => {
  const root = tempRoot();
  try {
    const scopes = makeScopes(root);
    const keyA = scopes.ensureSession('conv-a', { label: 'A' });
    const keyB = scopes.ensureSession('conv-b', { label: 'B' });
    const keyC = scopes.ensureSession('conv-c', { label: 'C' });
    await scopes.setViewers(keyA, ['conv-b']);

    // B may read A; C may not.
    assert.deepEqual(sourceKeys(memorySources({ scopes, sessionId: 'conv-b' }, 'all')).sort(),
      [keyA, keyB].sort());
    assert.deepEqual(sourceKeys(memorySources({ scopes, sessionId: 'conv-c' }, 'all')), [keyC]);

    // Opening A to everyone adds it for C, and the named list is irrelevant.
    await scopes.setPublic(keyA, true);
    assert.deepEqual(sourceKeys(memorySources({ scopes, sessionId: 'conv-c' }, 'all')).sort(),
      [keyA, keyC].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('conversation access: summaries count only readable conversations', async () => {
  const root = tempRoot();
  try {
    const scopes = makeScopes(root);
    const keyA = scopes.ensureSession('conv-a', { label: 'A' });
    const keyB = scopes.ensureSession('conv-b', { label: 'B' });
    scopes.ensureSession('conv-c', { label: 'C' });
    await scopes.setViewers(keyA, ['conv-b']);

    const forB = { scopes, sessionId: 'conv-b' };
    assert.deepEqual(readableConversations(forB).map((row) => row.key).sort(),
      [keyA, keyB].sort());
    assert.equal(closedConversationCount(forB), 1);

    const forC = { scopes, sessionId: 'conv-c' };
    assert.equal(readableConversations(forC).length, 1);
    assert.equal(closedConversationCount(forC), 2);

    // A conversation always reads itself even with an empty allowlist.
    assert.equal(readableConversations({ scopes, sessionId: 'conv-a' }).length, 1);
    assert.equal(sessionKey('conv-a') !== keyA, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
