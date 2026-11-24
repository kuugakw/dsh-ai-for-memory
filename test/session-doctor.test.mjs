import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { encodeZstdLog, readSessionLog, validateSessionEvents, zstdAvailable } from '../lib/session-repair.js';
import {
  DOCTOR_LOG_NAME, doctorSessions, formatDoctorReport, placeholderArtifact, readProjection, readWorkspaceIndex,
} from '../lib/session-doctor.js';

const BUCKET = '--D-ai-~5DE5~4F5C~533A--';
const WORKSPACE = 'D:\\ai\\工作区';
// Writing a session artifact needs zstd (Node 22.15+); the CI matrix also runs Node 20.
const skipZstd = zstdAvailable() ? false : 'requires Node 22.15+ (zstd)';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aim-doctor-'));
}

/** Header plus the three presets DSH writes for a brand-new session. */
function blankLog(id) {
  return {
    header: {
      type: 'session',
      version: 4,
      id,
      createdAt: 1700000000000,
      cwd: WORKSPACE,
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'standard',
    },
    events: [
      { type: 'permission/preset', seq: 0, time: 1700000000000, data: { preset: 'workspace-write' } },
      { type: 'sandbox/mode', seq: 1, time: 1700000000000, data: { mode: 'workspace-write' } },
      { type: 'approval/policy', seq: 2, time: 1700000000000, data: { policy: 'ask' } },
    ],
  };
}

function writeLog(home, id, { header, events }) {
  const file = path.join(home, 'sessions', BUCKET, id, DOCTOR_LOG_NAME);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodeZstdLog([
    `${JSON.stringify(header)}\n`,
    events.map((event) => `${JSON.stringify(event)}\n`).join(''),
  ]));
  return file;
}

function writeIndex(home, sessionIds) {
  const file = path.join(home, 'storages', 'workspace.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId: 'ws-1',
      workspaceIds: ['ws-1'],
      archivedSessionIds: [...sessionIds],
      pinnedSessionIds: [...sessionIds],
    },
    tables: {
      workspaces: {
        'ws-1': {
          path: WORKSPACE,
          title: '工作区',
          sessionIds: [...sessionIds],
          createdAt: '2026-11-07T03:55:49.328Z',
          updatedAt: '2026-11-23T12:55:21.891Z',
        },
      },
    },
  }, null, 2)}\n`, 'utf8');
  return file;
}

function writeProjection(home, id, seq) {
  const file = path.join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    version: 7,
    record: {
      identity: { formatVersion: 4, createdAt: 1700000000000, cwd: WORKSPACE, isSeeded: false, inheritedEventCount: 0 },
      rows: {
        turnBoundary: { ver: 2, seq, val: { openTurnStartSeq: null, lastStepStartSeq: null, lastStepBoundary: null, lastTurn: 1 } },
        title: { ver: 1, seq, val: '旧标题' },
        turnOutline: { ver: 2, seq, val: { turns: [{ turn: 1, seq: 0, prompt: 'p', response: '' }], draft: '' } },
      },
    },
  }, null, 2)}\n`, 'utf8');
  return file;
}

test('session doctor: reports a seq gap and truncates it only when asked', { skip: skipZstd }, async () => {
  const home = tempHome();
  try {
    const id = 'session-gap';
    // A valid prefix plus one event carrying a live host's sequence number: the
    // exact shape a restored artifact gets when DSH appends from memory.
    const log = blankLog(id);
    log.events.push({ type: 'session/end-seed', seq: 99, time: 1700000000000, data: {} });
    const file = writeLog(home, id, log);

    const before = await doctorSessions({ env: { DSH_HOME: home }, repairLogs: true });
    assert.equal(before.counts.gap, 1);
    assert.equal(before.counts.ok, 0);
    assert.match(before.rows[0].detail, /第 4 个事件的 seq=99/);
    assert.match(formatDoctorReport(before), /预演/);
    assert.equal(fs.readFileSync(file).length > 0, true);

    const report = await doctorSessions({ env: { DSH_HOME: home }, repairLogs: true, apply: true });
    assert.equal(report.actions[0].kind, 'truncate');
    const after = await doctorSessions({ env: { DSH_HOME: home }, repairLogs: true });
    assert.equal(after.counts.gap, 0);
    const repaired = await readSessionLog(file);
    assert.equal(repaired.events.length, 3);
    assert.deepEqual(validateSessionEvents(repaired.header, repaired.events), { ok: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('session doctor: a message without an id is reported and repaired in place', { skip: skipZstd }, async () => {
  const home = tempHome();
  try {
    const id = 'session-no-id';
    // Sequence is intact and the turn is closed; the only defect is the message
    // identity, which the seq check cannot see and the format validator accepts.
    const log = blankLog(id);
    log.events.push(
      { type: 'turn/start', seq: 3, time: 1700000000000, data: { turn: 1 } },
      { type: 'step/start', seq: 4, time: 1700000000000, data: { turn: 1, step: 1 } },
      {
        type: 'user/message', seq: 5, time: 1700000000000, surfaceOp: 'append',
        data: { role: 'user', source: { kind: 'ai-for-memory' }, content: [{ type: 'text', text: '恢复的上下文' }] },
      },
      { type: 'step/end', seq: 6, time: 1700000000000, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 7, time: 1700000000000, data: { turn: 1, reason: { kind: 'completed' } } },
    );
    const file = writeLog(home, id, log);

    const before = await doctorSessions({ env: { DSH_HOME: home }, repairLogs: true });
    assert.equal(before.counts.invalid, 1);
    assert.equal(before.counts.ok, 0);
    assert.equal(before.rows[0].state, 'invalid');
    assert.match(before.rows[0].detail, /缺少消息 id/);
    assert.match(formatDoctorReport(before), /消息身份缺失 1/);
    assert.match(formatDoctorReport(before), /预演/);

    const report = await doctorSessions({ env: { DSH_HOME: home }, repairLogs: true, apply: true });
    assert.equal(report.actions[0].kind, 'identity');
    assert.match(report.actions[0].detail, /补齐 1 条消息的身份/);

    const after = await doctorSessions({ env: { DSH_HOME: home }, repairLogs: true });
    assert.equal(after.counts.invalid, 0);
    assert.equal(after.counts.ok, 1);
    const repaired = await readSessionLog(file);
    assert.equal(repaired.events.length, log.events.length);
    assert.equal(typeof repaired.events[5].data.id, 'string');
    assert.ok(repaired.events[5].data.id.length > 0);
    assert.deepEqual(repaired.events[5].data.content, log.events[5].data.content);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('session doctor: a missing log gets a placeholder so the conversation opens', { skip: skipZstd }, async () => {
  const home = tempHome();
  try {
    const id = 'session-ghost';
    writeIndex(home, [id]);

    const preview = await doctorSessions({ env: { DSH_HOME: home } });
    assert.equal(preview.counts.missing, 1);
    assert.equal(fs.existsSync(path.join(home, 'sessions', BUCKET, id)), false);

    const report = await doctorSessions({ env: { DSH_HOME: home }, apply: true, ghosts: 'placeholder' });
    assert.equal(report.actions[0].kind, 'placeholder');
    const file = path.join(home, 'sessions', BUCKET, id, DOCTOR_LOG_NAME);
    const log = await readSessionLog(file);
    assert.equal(log.header.id, id);
    assert.equal(log.events.length, 3);
    assert.deepEqual(validateSessionEvents(log.header, log.events), { ok: true });

    // Re-running must not overwrite the artifact it just wrote.
    const again = await doctorSessions({ env: { DSH_HOME: home }, apply: true, ghosts: 'placeholder' });
    assert.equal(again.counts.missing, 0);
    assert.equal(again.actions.length, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('session doctor: prune removes the dangling index entry and keeps a backup', { skip: skipZstd }, async () => {
  const home = tempHome();
  try {
    const file = writeIndex(home, ['session-ghost', 'session-alive']);
    const alive = blankLog('session-alive');
    writeLog(home, 'session-alive', alive);

    const report = await doctorSessions({ env: { DSH_HOME: home }, apply: true, ghosts: 'prune' });
    assert.equal(report.counts.ok, 1);
    assert.equal(report.counts.missing, 1);
    assert.equal(report.actions.at(-1).kind, 'prune');

    const index = readWorkspaceIndex(file);
    const ids = index.doc.tables.workspaces['ws-1'].sessionIds;
    assert.deepEqual(ids, ['session-alive']);
    assert.deepEqual(index.doc.global.archivedSessionIds, ['session-alive']);
    assert.deepEqual(index.doc.global.pinnedSessionIds, ['session-alive']);
    const backups = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith('workspace.json.bak-'));
    assert.equal(backups.length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('session doctor: a projection ahead of its log is moved aside', { skip: skipZstd }, async () => {
  const home = tempHome();
  try {
    const id = 'session-ahead';
    writeLog(home, id, blankLog(id));
    const projection = writeProjection(home, id, 9);
    assert.equal(readProjection(projection).seq, 9);

    const preview = await doctorSessions({ env: { DSH_HOME: home } });
    assert.equal(preview.counts.ok, 1);
    assert.match(preview.rows[0].detail, /投影 seq=9 比日志末尾 2 新/);

    const report = await doctorSessions({ env: { DSH_HOME: home }, apply: true, cache: 'clear' });
    assert.equal(report.actions[0].kind, 'cache');
    assert.equal(fs.existsSync(projection), false);
    const moved = fs.readdirSync(path.dirname(projection)).filter((name) => name.includes('.bak-'));
    assert.equal(moved.length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('session doctor: a dry run writes nothing at all', { skip: skipZstd }, async () => {
  const home = tempHome();
  try {
    writeIndex(home, ['session-ghost']);
    writeProjection(home, 'session-ghost', 5);
    const filesBefore = fs.readdirSync(home, { recursive: true }).sort();

    const report = await doctorSessions({ env: { DSH_HOME: home } });
    assert.equal(report.counts.missing, 1);
    assert.equal(report.counts.projections, 1);
    assert.deepEqual(report.actions, []);
    assert.deepEqual(fs.readdirSync(home, { recursive: true }).sort(), filesBefore);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('session doctor: placeholder artifact is a valid empty session for any id shape', { skip: skipZstd }, async () => {
  for (const id of ['0f0e0d0c-0000-4000-8000-000000000000', 'session-0f0e0d0c-0000-4000-8000-000000000000']) {
    const dir = tempHome();
    try {
      const file = path.join(dir, DOCTOR_LOG_NAME);
      fs.writeFileSync(file, placeholderArtifact({ id, createdAt: 1700000000000, cwd: WORKSPACE }));
      const log = await readSessionLog(file);
      assert.equal(log.header.id.startsWith('session-'), true);
      assert.deepEqual(validateSessionEvents(log.header, log.events), { ok: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** Register one memory root holding a scope for `sessionId` reaching `lastTurn`. */
function writeMemoryScope(home, sessionId, lastTurn) {
  const root = path.join(home, 'memory');
  const scope = path.join(root, 'sessions', 's_test');
  fs.mkdirSync(path.join(scope, 'snapshots'), { recursive: true });
  fs.writeFileSync(path.join(scope, 'session.json'), `${JSON.stringify({
    format: 1, session_id: sessionId, key: 's_test', workspace: WORKSPACE,
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(scope, 'snapshots', `auto-snapshot-t${lastTurn}_20260101_000000.json`), '{}\n');
  const registry = path.join(home, 'ai-for-memory', 'roots.json');
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, `${JSON.stringify({
    version: 1, roots: [{ root, workspace: WORKSPACE, label: '工作区' }],
  }, null, 2)}\n`, 'utf8');
  return scope;
}

test('session doctor: auto keeps archived conversations and prunes the rest', { skip: skipZstd }, async () => {
  const home = tempHome();
  try {
    writeIndex(home, ['session-kept', 'session-forgotten']);
    writeMemoryScope(home, 'session-kept', 42);

    const report = await doctorSessions({ env: { DSH_HOME: home }, apply: true });
    assert.equal(report.ghosts, 'auto');
    assert.equal(report.counts.missing, 2);
    assert.equal(report.counts.withMemory, 1);
    assert.equal(report.plan.keep, 1);
    assert.equal(report.plan.prune, 1);

    assert.equal(fs.existsSync(path.join(home, 'sessions', BUCKET, 'session-kept', DOCTOR_LOG_NAME)), true);
    assert.equal(fs.existsSync(path.join(home, 'sessions', BUCKET, 'session-forgotten')), false);
    const index = readWorkspaceIndex(path.join(home, 'storages', 'workspace.json'));
    assert.deepEqual(index.doc.tables.workspaces['ws-1'].sessionIds, ['session-kept']);
    const kinds = report.actions.map((action) => action.kind);
    assert.deepEqual(kinds, ['placeholder', 'prune']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('session doctor: a log shorter than its memory store is reported', { skip: skipZstd }, async () => {
  const home = tempHome();
  try {
    const id = 'session-short';
    const log = blankLog(id);
    log.events.push(
      { type: 'turn/start', seq: 3, time: 1700000000000, data: { turn: 1 } },
      { type: 'turn/end', seq: 4, time: 1700000000000, data: { turn: 1, reason: { kind: 'completed' } } },
    );
    writeLog(home, id, log);
    writeMemoryScope(home, id, 5);

    const report = await doctorSessions({ env: { DSH_HOME: home } });
    assert.equal(report.rows[0].state, 'ok');
    assert.equal(report.rows[0].logLastTurn, 1);
    assert.equal(report.rows[0].coverageGap, 4);
    assert.match(report.rows[0].detail, /日志只到第 1 轮，插件存档到第 5 轮（日志少 4 轮）/);
    assert.equal(report.plan.coverage, 1);
    assert.match(formatDoctorReport(report), /aim_context restore/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
