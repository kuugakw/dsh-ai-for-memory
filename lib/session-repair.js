/**
 * DSH session-log health check and repair.
 *
 * DSH keeps every conversation as a concatenated-Zstandard JSONL artifact:
 * one checksummed frame for the header line, then one frame per committed
 * append batch. `dsh-session-persistence-jsonl` rescans the complete frames and
 * refuses the whole conversation when one complete frame violates the current
 * Session format (`stored log is corrupt`); the seam has no deletion or repair
 * API, so a single misplaced event makes a conversation permanently unloadable.
 *
 * This module fills that gap for the plugin. It never rewrites committed
 * history silently:
 *
 *   salvage   an orphaned `developer/message` written by an older
 *             ai-for-memory release is re-admitted as the equivalent
 *             `user/message` notice, so every later event survives untouched;
 *   truncate  anything else is cut at the first structural violation and closed
 *             with DSH's own synthetic tail events (tool results, `step/end`,
 *             `turn/end`).
 *
 * Validation prefers the installed DSH packages
 * (`restoreReleasedV4Artifact` + `KNOWN_SESSION_EVENT_TYPES`) resolved through
 * `DSH_INSTALL_DIR`, because those are the exact rules the reader will apply.
 * When they cannot be resolved (unit tests, a future layout) a local lifecycle
 * replay covers dense sequences, turn/step ownership, surface binding and tool
 * lifecycle. The original artifact is always backed up before an atomic
 * replacement, and a candidate is written only after it validates.
 *
 * The module imports Node builtins and one sibling module; the DSH import is
 * optional and dynamically resolved, so the plugin still loads outside DSH.
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import { decodeWorkspaceBucket, resolveWorkspacePath } from './dsh-workspace.js';

/** Canonical artifact suffix DSH selects as the current generation. */
export const SESSION_LOG_SUFFIX = '.jsonl.zstd';

/** Session format this build understands; other versions are reported, not rewritten. */
export const SESSION_LOG_VERSION = 4;

/** A logical log above this size is flagged for the user even when it is structurally valid. */
export const OVERSIZE_BYTES = 64 * 1024 * 1024;

/** An event count above this bound is flagged the same way. */
export const OVERSIZE_EVENTS = 20000;

const ZSTD_MAGIC = 0xFD2FB528;
const ZSTD_CHECKSUM = 1;
const DEFAULT_MAX_DECODED_BYTES = 1024 * 1024 * 1024;
const LOG_NAME_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/;

/** Node 22.15+/23.8+ exposes zstd; older runtimes can still list logs but cannot decode them. */
function requireZstd() {
  if (typeof zlib.zstdDecompressSync !== 'function' || typeof zlib.zstdCompressSync !== 'function') {
    throw new Error('当前 Node 不支持 zstd（需要 Node 22.15+），无法读取或改写 DSH 会话日志');
  }
}

const SURFACE_TYPES = new Set([
  'system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result',
]);
const STEP_EVENT_TYPES = new Set(['system/message', 'developer/message', 'assistant/attempt']);

// ---- Zstandard container -------------------------------------------------

/**
 * Locate complete Zstandard frames without decompressing their blocks.
 *
 * The artifact is a concatenation of independent frames, and Node's one-shot
 * `zstdDecompress*` stops after the first one, so every reader here must walk
 * frames explicitly. An invalid complete frame rejects; EOF inside the final
 * frame reports its start so a torn tail can be reported (DSH repairs those
 * itself on the next append).
 *
 * @param {Buffer} buffer
 * @returns {{frames: Array<{start: number, end: number}>, tornStart?: number}}
 */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`不是有效的 zstd 帧：偏移 ${offset} 处的魔数不正确`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) throw new Error(`zstd 帧头保留位非零：偏移 ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) throw new Error(`zstd 块类型非法：偏移 ${offset - 3}`);
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/**
 * Decode every complete frame in one artifact.
 *
 * @param {Buffer} buffer
 * @param {{maxDecodedBytes?: number}} [options]
 * @returns {{text: string, frames: Array<{start: number, end: number}>, tornStart?: number}}
 */
export function decodeZstdLog(buffer, options = {}) {
  requireZstd();
  const { frames, tornStart } = scanZstdFrames(buffer);
  const cap = options.maxDecodedBytes ?? DEFAULT_MAX_DECODED_BYTES;
  const parts = [];
  let total = 0;
  for (const frame of frames) {
    const part = zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end));
    total += part.length;
    if (total > cap) throw new Error(`解压后的日志超过 ${cap} 字节上限，已停止读取`);
    parts.push(part);
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames, tornStart };
}

/**
 * Encode JSONL chunks as independent checksummed frames, matching the physical
 * layout DSH writes (header frame first, then append batches).
 *
 * @param {string[]} chunks
 * @returns {Buffer}
 */
export function encodeZstdLog(chunks) {
  requireZstd();
  const params = { [zlib.constants.ZSTD_c_checksumFlag]: ZSTD_CHECKSUM };
  return Buffer.concat(chunks
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => zlib.zstdCompressSync(Buffer.from(chunk, 'utf8'), { params })));
}

// ---- sourceEventSeqs storage form ---------------------------------------

function isSeq(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Expand the lossless `sourceEventSeqs` storage form (plain numbers and
 * inclusive `[start, end]` runs) into the in-memory sequence array.
 *
 * @param {unknown} value
 * @returns {number[]}
 */
export function decodeSeqRanges(value) {
  if (!Array.isArray(value)) throw new Error('sourceEventSeqs 必须是数组');
  const decoded = [];
  for (const entry of value) {
    if (typeof entry === 'number') {
      if (!isSeq(entry)) throw new Error('sourceEventSeqs 含有非法序号');
      decoded.push(entry);
      continue;
    }
    if (!Array.isArray(entry) || entry.length !== 2 || !isSeq(entry[0]) || !isSeq(entry[1]) || entry[1] < entry[0]) {
      throw new Error('sourceEventSeqs 的区间必须是 [start, end]');
    }
    for (let seq = entry[0]; seq <= entry[1]; seq += 1) decoded.push(seq);
  }
  return decoded;
}

/**
 * Collapse strictly increasing runs of at least three into `[start, end]`
 * pairs, matching DSH's storage form.
 *
 * @param {number[]} values
 * @returns {Array<number|[number, number]>}
 */
export function encodeSeqRanges(values) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const increasing = values.every((value, index) => index === 0 || value > values[index - 1]);
  if (!increasing) return values.slice();
  const encoded = [];
  for (let start = 0; start < values.length;) {
    let end = start;
    while (end + 1 < values.length && values[end + 1] === values[end] + 1) end += 1;
    if (end - start >= 2) {
      encoded.push([values[start], values[end]]);
    } else {
      for (let index = start; index <= end; index += 1) encoded.push(values[index]);
    }
    start = end + 1;
  }
  return encoded;
}

// ---- parsing -------------------------------------------------------------

/**
 * Split decoded artifact text into the header line and one raw row per event.
 * Raw rows are retained so untouched events are re-emitted byte-for-byte.
 *
 * @param {string} text
 * @returns {{header: object, headerLine: string, rows: object[], rawRows: string[]}}
 */
export function parseSessionLog(text) {
  const lines = text.split('\n');
  if (lines.length === 0 || lines[0].trim() === '') throw new Error('会话日志为空');
  const headerLine = lines[0];
  let header;
  try {
    header = JSON.parse(headerLine);
  } catch (error) {
    throw new Error(`会话头不是合法 JSON：${error?.message ?? error}`);
  }
  if (header?.type !== 'session' || typeof header.version !== 'number') {
    throw new Error('会话头缺少 type=session/version');
  }
  const rows = [];
  const rawRows = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`第 ${index} 行不是合法 JSON：${error?.message ?? error}`);
    }
    rawRows.push(line);
  }
  return { header, headerLine, rows, rawRows };
}

/** Expand one physical row's `sourceEventSeqs` for validation. */
export function expandRow(row) {
  if (!row || !Array.isArray(row.sourceEventSeqs)) return row;
  return { ...row, sourceEventSeqs: decodeSeqRanges(row.sourceEventSeqs) };
}

/** Serialize one event back to a physical row, re-encoding range pairs. */
export function encodeRow(event, encoder = encodeSeqRanges) {
  const copy = { ...event };
  if (Array.isArray(copy.sourceEventSeqs)) copy.sourceEventSeqs = encoder(copy.sourceEventSeqs);
  return JSON.stringify(copy);
}

// ---- locating logs -------------------------------------------------------

/**
 * Read the header line of one artifact without decoding the whole event body.
 *
 * @param {string} file
 * @param {Buffer} [buffer]
 */
function readHeaderOnly(file, buffer = fs.readFileSync(file)) {
  requireZstd();
  const { frames } = scanZstdFrames(buffer);
  if (frames.length === 0) throw new Error('文件里没有完整的 zstd 帧');
  const first = frames[0];
  const text = zlib.zstdDecompressSync(buffer.subarray(first.start, first.end)).toString('utf8');
  const line = text.split('\n')[0];
  const header = JSON.parse(line);
  return { header, headerLine: line, frames: frames.length, physicalBytes: buffer.length };
}

/**
 * Enumerate every canonical session artifact under a DSH sessions directory.
 *
 * @param {string} sessionsDir
 * @returns {Array<{id: string, bucket: string, workspace: string, dir: string,
 *   file: string, version: number, physicalBytes: number, modifiedAt: string}>}
 */
export function findSessionLogs(sessionsDir) {
  let buckets = [];
  try {
    buckets = fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const logs = [];
  for (const bucket of buckets) {
    const workspace = resolveWorkspacePath(decodeWorkspaceBucket(bucket));
    let children = [];
    try {
      children = fs.readdirSync(path.join(sessionsDir, bucket), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const child of children) {
      let files = [];
      try {
        files = fs.readdirSync(path.join(sessionsDir, bucket, child));
      } catch {
        continue;
      }
      let best = null;
      for (const name of files) {
        const match = LOG_NAME_RE.exec(name);
        if (match === null) continue;
        const version = match[1] === undefined ? 0 : Number(match[1]);
        if (best === null || version > best.version) best = { name, version };
      }
      if (best === null) continue;
      const file = path.join(sessionsDir, bucket, child, best.name);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      logs.push({
        id: child,
        bucket,
        workspace,
        dir: path.join(sessionsDir, bucket, child),
        file,
        version: best.version,
        physicalBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }
  }
  logs.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  return logs;
}

/**
 * Read one artifact: header, raw rows and expanded events.
 *
 * @param {string} file
 * @param {{maxDecodedBytes?: number}} [options]
 */
export function readSessionLog(file, options = {}) {
  const buffer = fs.readFileSync(file);
  const { text, frames, tornStart } = decodeZstdLog(buffer, options);
  const { header, headerLine, rows, rawRows } = parseSessionLog(text);
  return {
    file,
    physicalBytes: buffer.length,
    logicalBytes: Buffer.byteLength(text, 'utf8'),
    frameCount: frames.length,
    tornStart,
    header,
    headerLine,
    rows,
    rawRows,
    events: rows.map(expandRow),
  };
}

// ---- validation ----------------------------------------------------------

let validatorCache;

/**
 * Resolve the installed DSH validator once.
 *
 * `DSH_INSTALL_DIR` names the running CLI package; resolving the two sibling
 * packages from there uses the reader's own rules. The import fails cleanly
 * outside DSH (plain `node --test`, future layouts), and every caller falls back
 * to {@link validateSessionEvents}.
 *
 * @returns {Promise<null | {ok: boolean, known: Set<string>,
 *   validate: Function, closers: Function, encodeSeqRanges: Function}>}
 */
export async function resolveDshValidator() {
  if (validatorCache !== undefined) return validatorCache;
  validatorCache = null;
  try {
    const install = String(process.env.DSH_INSTALL_DIR ?? '').trim();
    if (install === '') return validatorCache;
    const requireFromDsh = createRequire(path.join(install, 'package.json'));
    const sessionUrl = pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-session')).href;
    const formatUrl = pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href;
    const session = await import(sessionUrl);
    const format = await import(formatUrl);
    if (typeof format.restoreReleasedV4Artifact !== 'function') return validatorCache;
    if (!(session.KNOWN_SESSION_EVENT_TYPES instanceof Set)) return validatorCache;
    validatorCache = {
      ok: true,
      known: session.KNOWN_SESSION_EVENT_TYPES,
      validate: format.restoreReleasedV4Artifact,
      closers: typeof session.interruptedTurnClosers === 'function' ? session.interruptedTurnClosers : null,
      encodeSeqRanges: typeof session.encodeSeqRanges === 'function' ? session.encodeSeqRanges : encodeSeqRanges,
    };
  } catch {
    validatorCache = null;
  }
  return validatorCache;
}

/** Reset the resolved-validator cache (tests). */
export function resetDshValidatorCache() {
  validatorCache = undefined;
}

/** Header without the physical `type: "session"` marker that logical V4 rejects. */
function logicalHeader(header) {
  if (header === null || typeof header !== 'object') return header;
  const { type, ...rest } = header;
  return rest;
}

/**
 * Inherited cut for a seeded artifact: the seq of its final inherited
 * `session/end-seed` marker. Unseeded artifacts always use 0.
 */
function inheritedCut(header, events) {
  if (header?.isSeeded !== true) return 0;
  let cut = 0;
  events.forEach((event, index) => {
    if (event?.type === 'session/end-seed' && event.data?.inherited === true) cut = index;
  });
  return cut;
}

/**
 * Validate one candidate artifact.
 *
 * @returns {Promise<{ok: boolean, error?: string, index?: number, source: string}>}
 */
export async function validateSessionArtifact(header, events, validator = null) {
  const resolved = validator ?? await resolveDshValidator();
  if (resolved !== null && resolved?.ok === true) {
    try {
      resolved.validate({
        header: logicalHeader(header),
        inheritedEventCount: inheritedCut(header, events),
        events,
      }, resolved.known);
      return { ok: true, source: 'dsh' };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), source: 'dsh' };
    }
  }
  const local = validateSessionEvents(header, events);
  return { ...local, source: 'local' };
}

/**
 * Local lifecycle replay: the invariants the DSH reader checks in order.
 *
 * It intentionally covers the structural class this repair can fix (dense
 * sequence, turn/step ownership, surface binding, tool lifecycle) and leaves
 * provider-level payload checks to the installed validator.
 *
 * @param {object} header
 * @param {object[]} events
 * @returns {{ok: boolean, error?: string, index?: number}}
 */
export function validateSessionEvents(header, events) {
  if (header?.version !== SESSION_LOG_VERSION) {
    return { ok: false, error: `不支持的会话格式版本 v${String(header?.version)}` };
  }
  let turn = null;
  let step = null;
  let nextTurn = 1;
  let nextStep = 1;
  const tools = new Map();
  const surface = [];
  let protectedHead;

  const fail = (index, message) => ({ ok: false, error: message, index });

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') {
      return fail(index, '事件不是对象或缺少 type');
    }
    if (event.seq !== index) {
      return fail(index, `事件序号不连续：第 ${index} 个事件的 seq=${String(event.seq)}`);
    }
    const data = event.data;
    if (!STEP_EVENT_TYPES.has(event.type) && !SURFACE_TYPES.has(event.type)
      && !['turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call', 'request/header', 'request/context'].includes(event.type)) {
      continue;
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return fail(index, `${event.type} 的 data 必须是对象`);
    }
    if (STEP_EVENT_TYPES.has(event.type)) {
      if (turn === null || step === null || data.turn !== turn || data.step !== step) {
        return fail(index, `${event.type} 不属于当前打开回合/步骤（open turn=${String(turn)} step=${String(step)}；事件 turn=${String(data.turn)} step=${String(data.step)}）`);
      }
    }
    if (SURFACE_TYPES.has(event.type)) {
      const operation = event.surfaceOp;
      if (operation === 'append') {
        if (event.type === 'system/message' && surface.length > 0 && protectedHead === undefined) {
          return fail(index, 'system/message 需要受保护的首个 surface 节点');
        }
        if (event.type === 'system/message' && surface.length === 0) protectedHead = event.seq;
        surface.push(event.seq);
      } else if (operation !== null && typeof operation === 'object' && operation.op === 'replace') {
        const startSeq = operation.startSeq;
        const endSeq = operation.endSeq;
        if (!isSeq(startSeq) || !isSeq(endSeq) || startSeq >= event.seq || endSeq >= event.seq || endSeq < startSeq) {
          return fail(index, `${event.type} 的 replace 区间非法`);
        }
        const first = surface.indexOf(startSeq);
        const last = surface.indexOf(endSeq);
        if (first < 0 || last < first) return fail(index, `${event.type} 的 replace 区间不在当前 surface 上`);
        const removed = surface.slice(first, last + 1);
        const sources = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : [];
        if (removed.some((seq) => !sources.includes(seq))) {
          return fail(index, 'replace 的 sourceEventSeqs 未覆盖被遮蔽的节点');
        }
        surface.splice(first, removed.length, event.seq);
      } else {
        return fail(index, `${event.type} 缺少合法的 surfaceOp`);
      }
    }
    switch (event.type) {
      case 'turn/start':
        if (turn !== null || data.turn !== nextTurn) {
          return fail(index, `turn/start 未打开预期回合（期望 ${nextTurn}，当前 open=${String(turn)}）`);
        }
        turn = nextTurn;
        step = null;
        nextStep = 1;
        tools.clear();
        break;
      case 'turn/end':
        if (turn === null || data.turn !== turn || step !== null) {
          return fail(index, 'turn/end 与当前打开回合不匹配，或仍有步骤未关闭');
        }
        if (tools.size !== 0) return fail(index, `turn/end 前仍有未完成的工具调用 ${[...tools.keys()][0]}`);
        turn = null;
        nextTurn += 1;
        break;
      case 'step/start':
        if (turn === null || data.turn !== turn || step !== null || data.step !== nextStep) {
          return fail(index, `step/start 与当前回合/下一步骤不匹配（期望 step ${nextStep}）`);
        }
        step = nextStep;
        break;
      case 'step/end':
        if (turn === null || step === null || data.turn !== turn || data.step !== step) {
          return fail(index, 'step/end 与当前打开步骤不匹配');
        }
        if (tools.size !== 0) return fail(index, `step/end 前仍有未完成的工具调用 ${[...tools.keys()][0]}`);
        step = null;
        nextStep += 1;
        break;
      case 'assistant/message': {
        if (event.surfaceOp === 'append' && (turn === null || step === null || data.turn !== turn || data.step !== step)) {
          return fail(index, 'assistant/message 不属于当前步骤');
        }
        const content = Array.isArray(data.message?.content) ? data.message.content : [];
        for (const block of content) {
          if (block?.type === 'tool-call' && typeof block.id === 'string') {
            tools.set(block.id, { name: block.name, started: false });
          }
        }
        break;
      }
      case 'tool/call': {
        if (turn === null || step === null || data.turn !== turn || data.step !== step) {
          return fail(index, 'tool/call 不属于当前步骤');
        }
        const pending = tools.get(data.callId);
        if (pending !== undefined) pending.started = true;
        break;
      }
      case 'tool/result': {
        if (event.surfaceOp !== 'append') {
          if (turn === null) return fail(index, 'tool/result 不在打开的回合内');
          break;
        }
        if (turn === null || step === null || data.turn !== turn || data.step !== step) {
          return fail(index, 'tool/result 不属于当前步骤');
        }
        const callId = data.message?.toolCallId;
        if (typeof callId === 'string') tools.delete(callId);
        break;
      }
      case 'request/header':
      case 'request/context':
        if (turn === null) return fail(index, `${event.type} 不在打开的回合内`);
        break;
      default:
        break;
    }
  }
  return { ok: true };
}

/**
 * Index of the first structurally invalid event.
 *
 * The installed validator does not report coordinates, so a local replay
 * supplies the hint and is checked against the real rules: when the two
 * disagree the boundary is found by prefix bisection on the real validator.
 *
 * @returns {Promise<number|null>} null when the artifact validates
 */
async function locateFirstBadIndex(header, events, validator, firstFailure) {
  if (firstFailure?.index !== undefined) return firstFailure.index;
  if (validator === null || validator?.ok !== true) return null;
  const local = validateSessionEvents(header, events);
  if (!local.ok && local.index !== undefined) return local.index;

  const validatePrefix = async (length) => {
    if (header?.isSeeded === true && inheritedCut(header, events) >= length) return { ok: false };
    return validateSessionArtifact(header, events.slice(0, length), validator);
  };
  let low = 0;
  let high = events.length;
  const full = await validatePrefix(high);
  if (full.ok) return null;
  const empty = await validatePrefix(0);
  if (!empty.ok) return 0;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    const result = await validatePrefix(mid);
    if (result.ok) low = mid; else high = mid;
  }
  return low;
}

// ---- repair planning -----------------------------------------------------

/**
 * Re-admit every orphaned ai-for-memory `developer/message` as the equivalent
 * `user/message` notice in one replay.
 *
 * The 0.1.x line wrote request anchors / clear notes as `developer/message`,
 * which V4 only admits inside an open step. The current line already writes
 * `user/message` notices, so those events are stale carriers, not real harness
 * developer updates: keeping their text as tagged user notices preserves the
 * history while satisfying the format. A long-lived conversation can hold many
 * of them, and fixing only the first would just move the failure down the log.
 *
 * @returns {Map<number, object>} reclassified event by index
 */
function salvageNotices(events) {
  const edits = new Map();
  let turn = null;
  let step = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    switch (event?.type) {
      case 'turn/start':
        turn = event.data?.turn ?? null;
        step = null;
        break;
      case 'turn/end':
        turn = null;
        step = null;
        break;
      case 'step/start':
        step = event.data?.step ?? null;
        break;
      case 'step/end':
        step = null;
        break;
      default:
        break;
    }
    if (event?.type !== 'developer/message') continue;
    const data = event.data;
    if (turn !== null && step !== null && data?.turn === turn && data?.step === step) continue;
    const salvaged = salvageNotice(events, index);
    if (salvaged !== null) edits.set(index, salvaged);
  }
  return edits;
}

/**
 * Convert one legacy ai-for-memory developer notice into the equivalent
 * `user/message` notice, or return null when the event is not such a notice.
 */
function salvageNotice(events, index) {
  const event = events[index];
  if (!event || event.type !== 'developer/message') return null;
  const message = event.data?.message;
  if (message === null || typeof message !== 'object') return null;
  const source = message.source;
  if (source === null || typeof source !== 'object' || source.kind !== 'ai-for-memory') return null;
  const content = Array.isArray(message.content) ? message.content : null;
  if (content === null || content.length === 0) return null;
  if (!content.every((block) => block && block.type === 'text' && typeof block.text === 'string')) return null;
  return {
    type: 'user/message',
    seq: event.seq,
    time: event.time,
    surfaceOp: 'append',
    data: {
      id: typeof message.id === 'string' && message.id !== '' ? message.id : randomUUID(),
      role: 'user',
      content,
      source: {
        ...source,
        form: typeof source.form === 'string' && source.form !== '' ? source.form : 'notice',
        summary: typeof source.summary === 'string' && source.summary !== '' ? source.summary : '开发者便条',
      },
    },
  };
}

/** Replay enough state to synthesize a valid tail. */
function tailState(events) {
  let turn = null;
  let step = null;
  const pending = new Set();
  let lastClosed = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    switch (event?.type) {
      case 'turn/start':
        turn = event.data?.turn ?? turn;
        step = null;
        pending.clear();
        break;
      case 'turn/end':
        turn = null;
        step = null;
        pending.clear();
        break;
      case 'step/start':
        step = event.data?.step ?? step;
        pending.clear();
        break;
      case 'step/end':
        step = null;
        pending.clear();
        break;
      case 'assistant/message': {
        const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
        for (const block of content) {
          if (block?.type === 'tool-call' && typeof block.id === 'string') pending.add(block.id);
        }
        break;
      }
      case 'tool/result': {
        const callId = event.data?.message?.toolCallId;
        if (typeof callId === 'string') pending.delete(callId);
        break;
      }
      default:
        break;
    }
    if (turn === null && step === null) lastClosed = index + 1;
  }
  const last = events.at(-1);
  return { turn, step, pending, lastClosed, lastSeq: last?.seq ?? -1, lastTime: last?.time ?? Date.now() };
}

/** Synthetic closers when the installed DSH helpers are unavailable. */
function fallbackTailClosers(events) {
  const state = tailState(events);
  if (state.turn === null && state.step === null) return [];
  if (state.pending.size > 0) return null;
  const closers = [];
  let seq = state.lastSeq + 1;
  if (state.step !== null && state.turn !== null) {
    closers.push({ type: 'step/end', seq, time: state.lastTime, data: { turn: state.turn, step: state.step } });
    seq += 1;
  }
  if (state.turn !== null) {
    closers.push({ type: 'turn/end', seq, time: state.lastTime, data: { turn: state.turn, reason: { kind: 'interrupted' } } });
  }
  return closers;
}

/** Tail closers from DSH itself when available, else the local equivalent. */
function tailClosers(events, validator) {
  if (events.length === 0) return [];
  if (validator?.closers) {
    try {
      return validator.closers(events);
    } catch {
      return null;
    }
  }
  return fallbackTailClosers(events);
}

/**
 * Build a repaired event list for the first invalid event.
 *
 * @returns {Promise<null | {strategy: 'salvage'|'truncate', events: object[],
 *   edits: Map<number, object>, closers: object[], dropped: number}>}
 */
async function buildPlan(header, events, badIndex, strategy, validator) {
  if (strategy === 'auto' || strategy === 'salvage') {
    const edits = salvageNotices(events);
    if (edits.size > 0) {
      const candidate = events.slice();
      for (const [index, event] of edits) candidate[index] = event;
      const validation = await validateSessionArtifact(header, candidate, validator);
      if (validation.ok) {
        return {
          strategy: 'salvage', events: candidate, keep: events.length,
          edits, closers: [], dropped: 0,
        };
      }
    }
    if (strategy === 'salvage') return null;
  }

  let cut = badIndex;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const prefix = events.slice(0, cut);
    const closers = tailClosers(prefix, validator);
    if (closers !== null) {
      const candidate = prefix.concat(closers);
      const validation = await validateSessionArtifact(header, candidate, validator);
      if (validation.ok) {
        return {
          strategy: 'truncate',
          events: candidate,
          keep: cut,
          edits: new Map(),
          closers,
          dropped: events.length - candidate.length,
        };
      }
    }
    const state = tailState(prefix);
    if (state.lastClosed <= 0 || state.lastClosed >= cut) return null;
    cut = state.lastClosed;
  }
  return null;
}

// ---- writing -------------------------------------------------------------

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Copy the artifact next to itself; DSH ignores generations with other suffixes. */
function backupFile(file) {
  const backup = `${file}.bak-${timestampSlug()}`;
  fs.copyFileSync(file, backup);
  return backup;
}

/** Write bytes to a temp file in the same directory and atomically replace. */
function replaceAtomically(file, buffer) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  let handle;
  try {
    handle = fs.openSync(temp, 'w');
    fs.writeSync(handle, buffer, 0, buffer.length, 0);
    fs.fsyncSync(handle);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // best effort
    }
    throw error;
  }
}

// ---- public operations ---------------------------------------------------

/** Encode header + rows as checksummed frames, 200 rows per frame. */
function encodeArtifact(headerLine, lines) {
  const chunks = [`${headerLine}\n`];
  const batchSize = 200;
  for (let start = 0; start < lines.length; start += batchSize) {
    chunks.push(lines.slice(start, start + batchSize).map((line) => `${line}\n`).join(''));
  }
  return encodeZstdLog(chunks);
}

/** Replace an artifact, then read back and validate the written bytes. */
async function publishArtifact(file, buffer, validator) {
  replaceAtomically(file, buffer);
  const written = readSessionLog(file);
  const verified = await validateSessionArtifact(written.header, written.events, validator);
  if (!verified.ok) return { ok: false, error: verified.error };
  return { ok: true, written };
}

/**
 * Repair one artifact, or re-frame a valid one to reclaim physical size.
 *
 * @param {string} file
 * @param {{strategy?: 'auto'|'salvage'|'truncate', apply?: boolean,
 *   backup?: boolean, compact?: boolean, maxDecodedBytes?: number}} [options]
 */
export async function repairSessionLog(file, options = {}) {
  const absolute = path.resolve(file);
  const strategy = options.strategy ?? 'auto';
  if (!['auto', 'salvage', 'truncate'].includes(strategy)) {
    throw new Error(`未知修复策略：${String(strategy)}`);
  }
  if (!fs.existsSync(absolute)) throw new Error(`会话日志不存在：${absolute}`);
  const log = readSessionLog(absolute, { maxDecodedBytes: options.maxDecodedBytes });
  const validator = await resolveDshValidator();
  const before = {
    physicalBytes: log.physicalBytes,
    logicalBytes: log.logicalBytes,
    events: log.events.length,
    frames: log.frameCount,
  };
  const first = await validateSessionArtifact(log.header, log.events, validator);
  if (first.ok && options.compact !== true) {
    return {
      ok: true,
      repaired: false,
      valid: true,
      file: absolute,
      session: log.header.id,
      before,
      after: before,
      validator: first.source,
      message: '这份会话日志结构有效，不需要修复。',
    };
  }

  // A valid log can still be physically wasteful: DSH appends one frame per
  // write batch, so a long conversation ends up with tens of thousands of tiny
  // frames. Re-encoding the same rows in larger batches never changes an event.
  if (first.ok && options.compact === true) {
    const buffer = encodeArtifact(log.headerLine, log.rawRows);
    const frames = Math.ceil(log.rawRows.length / 200) + 1;
    const compact = {
      ok: true,
      repaired: false,
      valid: true,
      file: absolute,
      session: log.header.id,
      strategy: 'compact',
      before,
      after: { ...before, physicalBytes: buffer.length, frames },
      dryRun: options.apply !== true,
      validator: first.source,
      backupPath: '',
      message: '',
    };
    if (buffer.length >= before.physicalBytes) {
      compact.message = `这份日志已经是紧凑布局（${formatBytes(before.physicalBytes)}，${before.frames} 个帧），不需要重排。`;
      return compact;
    }
    if (options.apply !== true) {
      compact.message = `可重排：事件不变，物理 ${formatBytes(before.physicalBytes)} → ${formatBytes(buffer.length)}（帧 ${before.frames} → ${frames}）。`;
      return compact;
    }
    const backupPath = options.backup === false ? '' : backupFile(absolute);
    const published = await publishArtifact(absolute, buffer, validator);
    if (!published.ok) {
      if (backupPath !== '') {
        try {
          fs.copyFileSync(backupPath, absolute);
        } catch {
          // the backup stays next to the artifact either way
        }
      }
      return { ...compact, ok: false, dryRun: false, backupPath, error: `写回后复验失败，已还原原文件：${published.error}` };
    }
    const written = published.written;
    return {
      ...compact,
      repaired: true,
      dryRun: false,
      backupPath,
      after: {
        physicalBytes: written.physicalBytes,
        logicalBytes: written.logicalBytes,
        events: written.events.length,
        frames: written.frameCount,
      },
      message: `已重排：事件未改，物理 ${formatBytes(before.physicalBytes)} → ${formatBytes(written.physicalBytes)}`
        + `（帧 ${before.frames} → ${written.frameCount}）。原文件已备份。`,
    };
  }

  const badIndex = await locateFirstBadIndex(log.header, log.events, validator, first);
  if (badIndex === null) {
    return {
      ok: false,
      repaired: false,
      valid: false,
      file: absolute,
      session: log.header.id,
      before,
      validator: first.source,
      error: `无法定位损坏事件：${first.error}`,
    };
  }

  const plan = await buildPlan(log.header, log.events, badIndex, strategy, validator);
  if (plan === null) {
    return {
      ok: false,
      repaired: false,
      valid: false,
      file: absolute,
      session: log.header.id,
      before,
      validator: first.source,
      error: `第 ${badIndex} 个事件损坏（${first.error}），但没有找到能通过校验的修复方案`,
      badIndex,
    };
  }

  const encodeSeqs = validator?.encodeSeqRanges ?? encodeSeqRanges;
  const rowFor = (event) => encodeRow(event, encodeSeqs);
  const lines = [];
  const keep = Number.isInteger(plan.keep) ? plan.keep : plan.events.length;
  for (let index = 0; index < plan.events.length; index += 1) {
    const edited = plan.edits.get(index);
    if (edited !== undefined) lines.push(rowFor(edited));
    else if (index < keep && index < log.rawRows.length) lines.push(log.rawRows[index]);
    else lines.push(rowFor(plan.events[index]));
  }

  const after = {
    physicalBytes: 0,
    logicalBytes: log.headerLine.length + 1 + lines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0),
    events: plan.events.length,
    frames: 0,
  };
  const report = {
    ok: true,
    repaired: false,
    valid: false,
    dryRun: options.apply !== true,
    file: absolute,
    session: log.header.id,
    strategy: plan.strategy,
    badIndex,
    before,
    after,
    dropped: plan.dropped,
    salvaged: plan.edits.size,
    validator: first.source,
    originalError: first.error,
    backupPath: '',
    message: '',
  };

  if (options.apply !== true) {
    report.message = plan.strategy === 'salvage'
      ? `可修复：把 ${plan.edits.size} 个旧 developer 便条改写成 user 便条，保留全部 ${plan.events.length} 个事件。`
      : `可修复：截断到第 ${badIndex} 个事件之前，并补写 ${plan.closers.length} 个收尾事件，将丢弃 ${plan.dropped} 个事件。`;
    return report;
  }

  if (options.backup !== false) report.backupPath = backupFile(absolute);
  const buffer = encodeArtifact(log.headerLine, lines);
  const published = await publishArtifact(absolute, buffer, validator);
  if (!published.ok) {
    if (report.backupPath !== '') {
      try {
        fs.copyFileSync(report.backupPath, absolute);
      } catch {
        // the backup stays next to the artifact either way
      }
    }
    return {
      ...report,
      ok: false,
      repaired: false,
      error: `写回后复验失败，已还原原文件：${published.error}`,
    };
  }
  const written = published.written;
  after.physicalBytes = written.physicalBytes;
  after.logicalBytes = written.logicalBytes;
  after.events = written.events.length;
  after.frames = written.frameCount;
  return {
    ...report,
    repaired: true,
    valid: true,
    dryRun: false,
    after,
    expected: report.after,
    message: plan.strategy === 'salvage'
      ? `已修复：${plan.edits.size} 个旧 developer 便条改写为 user 便条，保留全部 ${after.events} 个事件。原文件已备份。`
      : `已修复：截断到第 ${badIndex} 个事件之前并补齐收尾事件，丢弃 ${plan.dropped} 个事件。原文件已备份。`,
  };
}

/** Read at most `length` bytes from the start of a file. */
function readPrefix(file, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(length, 4));
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Scan every artifact under a DSH sessions directory.
 *
 * Shallow scans read only the header frame (cheap, works on 150 MiB logs);
 * `deep` decodes the body and validates it.
 *
 * @param {string} sessionsDir
 * @param {{deep?: boolean, maxDecodedBytes?: number, limit?: number}} [options]
 */
export async function scanSessionLogs(sessionsDir, options = {}) {
  const deep = options.deep === true;
  const files = findSessionLogs(sessionsDir);
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : files.length;
  const validator = deep ? await resolveDshValidator() : null;
  const rows = [];
  for (const entry of files.slice(0, limit)) {
    const row = {
      id: entry.id,
      session: entry.id.replace(/^session-/, ''),
      bucket: entry.bucket,
      workspace: entry.workspace,
      file: entry.file,
      version: entry.version,
      physicalBytes: entry.physicalBytes,
      modifiedAt: entry.modifiedAt,
      logicalBytes: null,
      events: null,
      frames: null,
      status: 'unknown',
      error: '',
      anomalies: [],
    };
    try {
      // The header lives in the first frame; a shallow scan must not pull a
      // 150 MiB artifact into memory just to read one line. Fall back to the
      // full file only when the prefix did not contain a complete frame.
      let buffer = readPrefix(entry.file, Math.min(entry.physicalBytes, 1 << 20));
      let header;
      try {
        header = readHeaderOnly(entry.file, buffer).header;
      } catch {
        buffer = fs.readFileSync(entry.file);
        header = readHeaderOnly(entry.file, buffer).header;
      }
      row.header = {
        id: header.id,
        version: header.version,
        createdAt: header.createdAt,
        cwd: header.cwd,
        isSeeded: header.isSeeded,
      };
      if (header.version !== SESSION_LOG_VERSION) {
        row.status = 'unsupported';
        row.error = `格式 v${String(header.version)}，本工具只处理 v${SESSION_LOG_VERSION}`;
      }
      if (deep) {
        const log = readSessionLog(entry.file, { maxDecodedBytes: options.maxDecodedBytes });
        const validation = await validateSessionArtifact(log.header, log.events, validator);
        row.logicalBytes = log.logicalBytes;
        row.events = log.events.length;
        row.frames = log.frameCount;
        row.status = validation.ok ? 'ok' : 'corrupt';
        row.error = validation.ok ? '' : validation.error;
        if (log.tornStart !== undefined) row.anomalies.push('torn-tail');
        if (row.logicalBytes > OVERSIZE_BYTES) row.anomalies.push('oversized');
        if (row.events > OVERSIZE_EVENTS) row.anomalies.push('many-events');
      }
    } catch (error) {
      row.status = 'unreadable';
      row.error = String(error?.message ?? error);
    }
    rows.push(row);
  }
  return {
    sessionsDir,
    deep,
    scannedAt: new Date().toISOString(),
    total: rows.length,
    logs: rows,
  };
}

/**
 * Resolve a user-supplied session id, id prefix, or artifact path to one file.
 *
 * @param {string} sessionsDir
 * @param {string} value
 * @returns {{file: string, id: string, workspace?: string}}
 */
export function resolveSessionLogTarget(sessionsDir, value) {
  const wanted = String(value ?? '').trim();
  if (wanted === '') throw new Error('缺少会话 id 或日志路径');
  if (path.isAbsolute(wanted) || wanted.includes('/') || wanted.includes('\\')) {
    let absolute = path.resolve(wanted);
    if (!fs.existsSync(absolute)) throw new Error(`日志路径不存在：${absolute}`);
    if (fs.statSync(absolute).isDirectory()) {
      const names = fs.readdirSync(absolute).filter((name) => LOG_NAME_RE.test(name)).sort();
      if (names.length === 0) throw new Error(`目录里没有会话日志：${absolute}`);
      absolute = path.join(absolute, names.at(-1));
    }
    return { file: absolute, id: path.basename(path.dirname(absolute)) };
  }
  const logs = findSessionLogs(sessionsDir);
  const normalize = (id) => id.replace(/^session-/, '');
  const key = normalize(wanted);
  const hits = logs.filter((entry) => entry.id === wanted || normalize(entry.id) === key);
  const matches = hits.length > 0 ? hits : logs.filter((entry) => normalize(entry.id).startsWith(key));
  if (matches.length === 0) throw new Error(`没有找到会话 ${wanted}；先用 aim_repair action=scan 查看列表`);
  if (matches.length > 1) {
    throw new Error(`会话 id 前缀 ${wanted} 不唯一：${matches.slice(0, 5).map((entry) => entry.id).join('、')}`);
  }
  return { file: matches[0].file, id: matches[0].id, workspace: matches[0].workspace };
}

// ---- reporting -----------------------------------------------------------

/** Human-readable byte size. */
export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

/**
 * Format one repair report for a tool result.
 *
 * @param {object} report
 */
export function formatRepairReport(report) {
  const lines = [];
  const session = report.session ?? '';
  lines.push(`会话：${session}`);
  lines.push(`文件：${report.file}`);
  if (report.before) {
    lines.push(`修复前：物理 ${formatBytes(report.before.physicalBytes)}，逻辑 ${formatBytes(report.before.logicalBytes)}，事件 ${report.before.events}`);
  }
  if (report.valid === true && report.repaired !== true) {
    lines.push(report.message ?? '结构有效，不需要修复。');
    return lines.join('\n');
  }
  if (report.ok === false) {
    lines.push(`修复失败：${report.error}`);
    return lines.join('\n');
  }
  if (report.originalError) lines.push(`检测到的问题：${report.originalError}`);
  if (report.dryRun === true) {
    lines.push('（未写入，这是预演；带 apply=true 才会真正修复）');
  }
  lines.push(report.message);
  if (report.backupPath) lines.push(`备份：${report.backupPath}`);
  lines.push(`校验器：${report.validator === 'dsh' ? 'DSH 安装包内置规则' : '本地生命周期回放'}`);
  return lines.join('\n');
}

/**
 * Format one scan result for a tool result.
 *
 * @param {object} scan
 * @param {{limit?: number}} [options]
 */
export function formatScanReport(scan, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 40;
  if (scan.logs.length === 0) return `没有在 ${scan.sessionsDir} 下找到会话日志。`;
  const lines = [
    `会话日志目录：${scan.sessionsDir}`,
    scan.deep
      ? `深度体检 ${scan.total} 份（解压并校验事件结构）`
      : `快速扫描 ${scan.total} 份（只读头部；带 deep=true 才解压校验）`,
  ];
  for (const row of scan.logs.slice(0, limit)) {
    const size = row.logicalBytes === null
      ? `物理 ${formatBytes(row.physicalBytes)}`
      : `逻辑 ${formatBytes(row.logicalBytes)} / 物理 ${formatBytes(row.physicalBytes)}`;
    const events = row.events === null ? '' : `，${row.events} 个事件`;
    const status = row.status === 'ok' ? '正常'
      : row.status === 'corrupt' ? '结构损坏'
        : row.status === 'unreadable' ? '无法读取'
          : row.status === 'unsupported' ? '版本不支持' : '未体检';
    const flags = row.anomalies.length > 0 ? `，标记：${row.anomalies.join('/')}` : '';
    lines.push(`- ${row.id}｜${status}｜${size}${events}${flags}${row.error ? `｜${row.error}` : ''}`);
  }
  if (scan.logs.length > limit) lines.push(`…还有 ${scan.logs.length - limit} 份未列出`);
  return lines.join('\n');
}
