/**
 * Session-store doctor.
 *
 * DSH spreads one conversation over three places, and each of them can drift
 * away from the others:
 *
 *   sessions/<bucket>/session-<id>/session.vN.jsonl.zstd   the artifact (source of truth)
 *   storages/workspace.json                                the index the sidebar lists
 *   storages/session_projcache/sessions/session-<id>.json  the cached projection
 *
 * The failure classes seen in practice:
 *
 * - `gap`: the artifact's `seq` is not `0..n-1`. Restoring an older artifact
 *   while a Host process still holds the newer Session in memory makes DSH
 *   append its memory numbering (e.g. 77248) after the restored prefix (53239);
 *   the reader then refuses the whole artifact and the UI shows an empty chat.
 * - `missing`: the index still lists a conversation whose artifact is gone
 *   (deleted state directory). The UI shows a "missing session log" notice.
 * - `stale`: the cached projection is *ahead* of its artifact, or has no
 *   artifact at all, so the sidebar shows numbers the log cannot back.
 * - `open`: the artifact ends inside a turn, i.e. it was cut off mid-write.
 *
 * `doctor` reports all four and repairs the ones that are safe to repair:
 * truncating a gap at the discontinuity (through the same tested path as
 * `aim_repair repair`), moving a stale projection aside, and either writing a
 * placeholder artifact for a missing log (so the conversation opens empty
 * instead of failing) or dropping the dangling index entry.
 */
import fs from 'node:fs';
import path from 'node:path';

import { encodeWorkspace } from './dsh-workspace.js';
import { dshHome } from './util.js';
import {
  SESSION_LOG_VERSION, encodeZstdLog, findSessionLogs, formatBytes, readSessionLog,
  repairSessionLog,
} from './session-repair.js';

/** Artifact file name of the supported format generation. */
export const DOCTOR_LOG_NAME = `session.v${SESSION_LOG_VERSION}.jsonl.zstd`;

/** States a conversation can be in, worst-first for report ordering. */
const SEVERITY = ['missing', 'gap', 'open', 'unreadable', 'ok'];

/**
 * Resolve the three stores under one DSH home.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{home: string, sessionsDir: string, workspaceFile: string, projcacheDir: string}}
 */
export function doctorPaths(env = process.env) {
  const home = dshHome(env);
  return {
    home,
    sessionsDir: path.join(home, 'sessions'),
    workspaceFile: path.join(home, 'storages', 'workspace.json'),
    projcacheDir: path.join(home, 'storages', 'session_projcache', 'sessions'),
  };
}

/** `session-<uuid>` → `<uuid>`; anything else is returned unchanged. */
function bare(id) {
  return String(id ?? '').replace(/^session-/, '');
}

/** The canonical directory name for a session id. */
function dirName(id) {
  const value = String(id ?? '');
  return value.startsWith('session-') ? value : `session-${value}`;
}

/**
 * Read the workspace index without insisting on a shape we know.
 *
 * A missing or unparsable file yields an empty index: the doctor must still be
 * able to inspect artifacts, and a broken index is itself reported as a
 * warning instead of aborting the run.
 *
 * @param {string} file
 * @returns {{doc: object|null, bySession: Map<string, {workspace: string, title: string, workspaceId: string}>, problem: string}}
 */
export function readWorkspaceIndex(file) {
  const empty = { doc: null, bySession: new Map(), problem: '' };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { ...empty, problem: '没有 workspace.json（DSH 还没写过索引）' };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    return { ...empty, problem: `workspace.json 不是合法 JSON：${String(error?.message ?? error)}` };
  }
  const bySession = new Map();
  const tables = doc?.tables?.workspaces ?? {};
  for (const [workspaceId, workspace] of Object.entries(tables)) {
    const workspacePath = typeof workspace?.path === 'string' ? workspace.path : '';
    const title = typeof workspace?.title === 'string' ? workspace.title : workspacePath;
    for (const id of Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []) {
      bySession.set(bare(id), { workspace: workspacePath, title, workspaceId });
    }
  }
  return { doc, bySession, problem: '' };
}

/**
 * Read one cached projection just far enough to know how far ahead it is.
 *
 * @param {string} file
 * @returns {null | {seq: number, createdAt: number|null, cwd: string, title: string, turns: number}}
 */
export function readProjection(file) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const rows = doc?.record?.rows ?? {};
  let seq = -1;
  for (const row of Object.values(rows)) {
    if (Number.isSafeInteger(row?.seq) && row.seq > seq) seq = row.seq;
  }
  const identity = doc?.record?.identity ?? {};
  const title = typeof rows?.title?.val === 'string' ? rows.title.val : '';
  const turns = Array.isArray(rows?.turnOutline?.val?.turns) ? rows.turnOutline.val.turns.length : 0;
  return {
    seq,
    createdAt: Number.isFinite(identity.createdAt) ? identity.createdAt : null,
    cwd: typeof identity.cwd === 'string' ? identity.cwd : '',
    title,
    turns,
  };
}

/**
 * Build the smallest artifact DSH accepts as an empty conversation.
 *
 * It mirrors what DSH itself writes for a brand-new session: the header plus the
 * three presets a session starts with, and no turn. Opening it shows an empty
 * chat instead of a missing-log failure, which is the honest state of a
 * conversation whose log was deleted — the content is gone, the entry need not
 * be broken too.
 *
 * @param {{id: string, createdAt?: number|null, cwd?: string, agentPreset?: string}} input
 * @returns {Buffer}
 */
export function placeholderArtifact({ id, createdAt = null, cwd = '', agentPreset = 'standard' }) {
  const time = Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now();
  const sessionId = dirName(id);
  const header = {
    type: 'session',
    version: SESSION_LOG_VERSION,
    id: sessionId,
    createdAt: time,
    cwd: String(cwd ?? ''),
    isSeeded: false,
    delegationDepth: 0,
    agentPreset,
  };
  const events = [
    { type: 'permission/preset', seq: 0, time, data: { preset: 'workspace-write' } },
    { type: 'sandbox/mode', seq: 1, time, data: { mode: 'workspace-write' } },
    { type: 'approval/policy', seq: 2, time, data: { policy: 'ask' } },
  ];
  return encodeZstdLog([
    `${JSON.stringify(header)}\n`,
    `${events.map((event) => `${JSON.stringify(event)}\n`).join('')}`,
  ]);
}

/** Write a file through a sibling temp name so a crash cannot leave it torn. */
function writeAtomic(file, buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temp, buffer);
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

/** Move a file aside; DSH ignores suffixes other than the artifact name. */
function moveAside(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${file}.bak-${stamp}`;
  fs.renameSync(file, target);
  return target;
}

/**
 * Inspect every conversation the log directory, the index, or the projection
 * cache knows about.
 *
 * Read-only unless `apply: true`. `apply` never touches an artifact that is
 * being appended to (that guard lives in {@link repairSessionLog}) and never
 * deletes one: gaps are truncated, projections are renamed aside, and a missing
 * log is replaced by a placeholder only when it is still missing.
 *
 * @param {object} [options]
 * @param {boolean} [options.apply] - write the repairs (default false)
 * @param {'placeholder'|'prune'|'keep'} [options.ghosts] - missing-log policy
 * @param {'clear'|'keep'} [options.cache] - stale-projection policy
 * @param {boolean} [options.repairLogs] - truncate artifacts whose seq is not dense
 * @param {number} [options.maxDecodedBytes] - bound for one artifact decode
 * @param {NodeJS.ProcessEnv} [options.env]
 */
export async function doctorSessions(options = {}) {
  const paths = doctorPaths(options.env ?? process.env);
  const apply = options.apply === true;
  const ghosts = ['placeholder', 'prune', 'keep'].includes(options.ghosts) ? options.ghosts : 'placeholder';
  const cacheMode = options.cache === 'keep' ? 'keep' : 'clear';
  const repairLogs = options.repairLogs === true;

  const index = readWorkspaceIndex(paths.workspaceFile);
  const logs = findSessionLogs(paths.sessionsDir);
  const logById = new Map(logs.map((entry) => [bare(entry.id), entry]));

  const projections = new Map();
  let projectionFiles = [];
  try {
    projectionFiles = fs.readdirSync(paths.projcacheDir).filter((name) => /^session-.+\.json$/.test(name));
  } catch {
    projectionFiles = [];
  }
  for (const name of projectionFiles) {
    const id = name.replace(/^session-/, '').replace(/\.json$/, '');
    const file = path.join(paths.projcacheDir, name);
    projections.set(id, { file, ...(readProjection(file) ?? { seq: -1, createdAt: null, cwd: '', title: '', turns: 0 }) });
  }

  const ids = new Set([...logById.keys(), ...index.bySession.keys(), ...projections.keys()]);
  const rows = [];
  const actions = [];
  const warnings = index.problem !== '' ? [index.problem] : [];
  const pruneFrom = [];

  for (const id of ids) {
    const entry = logById.get(id) ?? null;
    const projection = projections.get(id) ?? null;
    const indexed = index.bySession.get(id) ?? null;
    const row = {
      id: `session-${id}`,
      state: 'ok',
      detail: '',
      workspace: indexed?.workspace ?? entry?.workspace ?? projection?.cwd ?? '',
      title: projection?.title ?? '',
      file: entry?.file ?? '',
      events: null,
      physicalBytes: entry?.physicalBytes ?? 0,
      projectionSeq: projection?.seq ?? null,
      turns: projection?.turns ?? 0,
    };

    if (entry === null) {
      row.state = 'missing';
      row.detail = projection === null
        ? '索引里有、磁盘上没有日志'
        : `日志缺失；投影缓存 seq=${String(projection.seq)}${projection.title === '' ? '' : `「${projection.title}」`}`;
    } else {
      try {
        const log = await readSessionLog(entry.file, {
          maxDecodedBytes: options.maxDecodedBytes,
        });
        const events = log.events;
        row.events = events.length;
        row.physicalBytes = log.physicalBytes;
        const badIndex = events.findIndex((event, position) => event?.seq !== position);
        const lastType = events.length > 0 ? events[events.length - 1]?.type : '';
        const lastSeq = events.length > 0 ? events[events.length - 1]?.seq : -1;
        // A session that never started a turn (a brand-new conversation) ends on
        // a preset event, which is a complete artifact, not an interrupted turn.
        const hasTurn = events.some((event) => event?.type === 'turn/start');
        if (badIndex >= 0) {
          row.state = 'gap';
          row.detail = `第 ${badIndex + 1} 个事件的 seq=${String(events[badIndex]?.seq)}（应为 ${badIndex}），共 ${events.length} 个事件`;
          if (repairLogs && apply) {
            const report = await repairSessionLog(entry.file, { strategy: 'auto', apply: true });
            actions.push({
              kind: 'truncate',
              id: row.id,
              detail: report.ok === false
                ? `未能修复：${report.error ?? '未知原因'}`
                : `截断到断点，事件 ${events.length} → ${report.after?.events ?? '?'}${report.backupPath ? `，备份 ${path.basename(report.backupPath)}` : ''}`,
            });
          }
        } else if (hasTurn && lastType !== 'turn/end' && lastType !== 'session/end-seed') {
          row.state = 'open';
          row.detail = `最后一个事件是 ${lastType === '' ? '空' : lastType}（seq=${String(lastSeq)}），回合没有收尾`;
        }
        if (projection !== null && projection.seq > lastSeq) {
          row.detail = [row.detail, `投影 seq=${String(projection.seq)} 比日志末尾 ${String(lastSeq)} 新`]
            .filter((part) => part !== '').join('；');
        }
      } catch (error) {
        row.state = 'unreadable';
        row.detail = String(error?.message ?? error);
      }
    }

    if (row.state === 'missing' && ghosts === 'prune') pruneFrom.push(id);

    if (row.state === 'missing' && ghosts === 'placeholder' && apply) {
      const target = path.join(
        paths.sessionsDir,
        encodeWorkspace(row.workspace === '' ? (indexed?.workspace ?? process.cwd()) : row.workspace),
        dirName(id),
        DOCTOR_LOG_NAME,
      );
      if (fs.existsSync(target)) {
        actions.push({ kind: 'skip', id: row.id, detail: '已有日志，未覆盖' });
      } else {
        writeAtomic(target, placeholderArtifact({
          id,
          createdAt: projection?.createdAt ?? null,
          cwd: row.workspace,
        }));
        actions.push({ kind: 'placeholder', id: row.id, detail: `写入 ${formatBytes(fs.statSync(target).size)} 的占位日志，打开后是空对话` });
      }
    }

    const stale = projection !== null
      && (entry === null || projection.seq > (row.events === null ? -1 : row.events - 1));
    if (stale && cacheMode === 'clear' && apply) {
      try {
        const moved = moveAside(projection.file);
        actions.push({ kind: 'cache', id: row.id, detail: `投影缓存改名为 ${path.basename(moved)}` });
      } catch (error) {
        warnings.push(`${row.id}: 无法移动投影缓存：${String(error?.message ?? error)}`);
      }
    }

    rows.push(row);
  }

  if (pruneFrom.length > 0 && apply && index.doc !== null) {
    const removed = new Set(pruneFrom);
    let touched = false;
    const tables = index.doc?.tables?.workspaces;
    if (tables !== null && typeof tables === 'object') {
      for (const workspace of Object.values(tables)) {
        if (!Array.isArray(workspace?.sessionIds)) continue;
        const kept = workspace.sessionIds.filter((id) => !removed.has(bare(id)));
        if (kept.length !== workspace.sessionIds.length) {
          workspace.sessionIds = kept;
          touched = true;
        }
      }
    }
    const global = index.doc?.global;
    for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
      if (!Array.isArray(global?.[key])) continue;
      const kept = global[key].filter((id) => !removed.has(bare(id)));
      if (kept.length !== global[key].length) {
        global[key] = kept;
        touched = true;
      }
    }
    if (touched) {
      const backup = moveAside(paths.workspaceFile);
      writeAtomic(paths.workspaceFile, Buffer.from(`${JSON.stringify(index.doc, null, 2)}\n`, 'utf8'));
      actions.push({
        kind: 'prune',
        id: `${String(pruneFrom.length)} 个`,
        detail: `从 workspace.json 移除缺日志的会话；备份 ${path.basename(backup)}`,
      });
    }
  }

  rows.sort((left, right) => {
    const bySeverity = SEVERITY.indexOf(left.state) - SEVERITY.indexOf(right.state);
    return bySeverity !== 0 ? bySeverity : left.id.localeCompare(right.id);
  });

  const count = (state) => rows.filter((row) => row.state === state).length;
  return {
    paths,
    apply,
    ghosts,
    cache: cacheMode,
    repairLogs,
    scannedAt: new Date().toISOString(),
    counts: {
      sessions: rows.length,
      ok: count('ok'),
      gap: count('gap'),
      open: count('open'),
      missing: count('missing'),
      unreadable: count('unreadable'),
      projections: projections.size,
    },
    rows,
    actions,
    warnings,
  };
}

/**
 * Render a doctor run as the compact text a tool result (or the panel) shows.
 *
 * @param {Awaited<ReturnType<typeof doctorSessions>>} report
 * @param {{limit?: number}} [options]
 */
export function formatDoctorReport(report, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 40;
  const counts = report.counts;
  const lines = [`会话存储体检（DSH_HOME=${report.paths.home}）`];
  lines.push(`会话 ${counts.sessions} 个：正常 ${counts.ok}、序号断层 ${counts.gap}、回合未收尾 ${counts.open}、`
    + `缺日志 ${counts.missing}、读不出 ${counts.unreadable}；投影缓存 ${counts.projections} 份`);
  const notable = report.rows.filter((row) => row.state !== 'ok');
  for (const row of notable.slice(0, limit)) {
    const title = row.title === '' ? '' : `｜「${row.title}」`;
    const events = row.events === null ? '' : `｜${row.events} 个事件/${formatBytes(row.physicalBytes)}`;
    lines.push(`- ${row.state} ${row.id}${title}${events}｜${row.detail}`);
  }
  if (notable.length > limit) lines.push(`… 另有 ${notable.length - limit} 条同类记录未列出`);
  if (report.warnings.length > 0) {
    lines.push('', '注意事项：');
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }
  if (report.apply) {
    lines.push('', '已执行：');
    if (report.actions.length === 0) lines.push('- 没有需要写入的修复');
    for (const action of report.actions) lines.push(`- ${action.kind} ${action.id}：${action.detail}`);
  } else {
    const plan = [];
    if (counts.gap > 0 && report.repairLogs) plan.push(`截断 ${counts.gap} 份断档日志（repairLogs=true）`);
    if (counts.missing > 0) {
      plan.push(report.ghosts === 'prune'
        ? `从 workspace.json 移除 ${counts.missing} 个缺日志的会话条目`
        : `为 ${counts.missing} 个缺日志的会话写入占位日志（打开是空对话，正文已丢失）`);
    }
    if (report.cache === 'clear') plan.push('把比日志新的投影缓存改名归档');
    lines.push('', '预演：未写入任何文件。apply=true 时的计划：');
    if (plan.length === 0) lines.push('- 无需修复');
    for (const step of plan) lines.push(`- ${step}`);
    if (counts.gap > 0 && !report.repairLogs) {
      lines.push('- 序号断层需要显式传 repairLogs=true（先确认那份会话没有在别的标签页运行）');
    }
  }
  return lines.join('\n');
}
