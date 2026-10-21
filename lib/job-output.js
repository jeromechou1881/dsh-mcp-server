/** Non-consuming, bounded observation of native job output. No file or job writes. */
import { ERROR_CODES, McpError } from './protocol.js'

const MAX_CONTEXT_BYTES = 2 * 1024 * 1024
const MAX_CONTEXT_CHUNKS = 8192
const terminalStates = new Set(['completed', 'killed', 'failed'])
const states = new Set(['running', 'stopping', ...terminalStates])
const channels = new Set(['stdout', 'stderr', 'log'])
function invalid(message) { throw new McpError(ERROR_CODES.invalidParams, message) }
function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`"${name}" must be an integer from ${min} to ${max}.`)
  return value
}

export function jobOutputOptions(args) {
  for (const name of ['sessionId', 'jobId']) {
    if (typeof args[name] !== 'string' || !args[name] || args[name].length > 256) invalid(`"${name}" must be a nonempty string of at most 256 characters.`)
  }
  if (Object.keys(args).some(key => !['sessionId', 'jobId', 'fromByte', 'timeoutMs', 'maxBytes', 'maxChunks'].includes(key))) invalid('Unknown job output argument.')
  return {
    sessionId: args.sessionId, jobId: args.jobId,
    fromByte: integer(args.fromByte, 0, 0, Number.MAX_SAFE_INTEGER - 1, 'fromByte'),
    timeoutMs: integer(args.timeoutMs, 10000, 100, 30000, 'timeoutMs'),
    maxBytes: integer(args.maxBytes, 16384, 4096, 65536, 'maxBytes'),
    maxChunks: integer(args.maxChunks, 64, 1, 128, 'maxChunks'),
  }
}

/** Replace credential matches with equal-byte masks. Original offsets survive. */
export function maskOutput(text) {
  const raw = Buffer.from(text), safe = Buffer.from(raw)
  const patterns = [
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu,
    /\b(?:Bearer|Basic)\s+[^\s"',;]+/giu,
    /\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{12,}|github_pat_[\w]{12,}|xox[baprs]-[\w-]{10,})/gu,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu,
    /\bhttps?:\/\/[^\s/@]+:[^\s/@]+@/giu,
    /--(?:api[-_]?key|token|password|passwd|secret|authorization|cookie)(?:=|\s+)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}\]]+)/giu,
    /(?<![\w-])["']?[\w-]{0,64}(?:api[_-]?key|token|password|passwd|secret|credential|authorization|cookie)[\w-]{0,64}["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}\]]+)/giu,
  ]
  const ranges = []
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length])
  ranges.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push(range)
  }
  let priorChar = 0, priorByte = 0
  for (const [from, to] of merged) {
    const start = priorByte + Buffer.byteLength(text.slice(priorChar, from))
    const end = start + Buffer.byteLength(text.slice(from, to))
    safe.fill(42, start, end); priorChar = to; priorByte = end
  }
  return safe
}

function checkJob(job, options) {
  if (job?.id !== options.jobId || job?.owner !== options.sessionId) invalid('The requested job is not owned by this Session; unowned and foreign jobs are not exposed.')
  const { earliest, total } = job.output ?? {}
  if (!states.has(job.status) || !Number.isSafeInteger(earliest) || !Number.isSafeInteger(total) || earliest < 0 || total < earliest) {
    throw new McpError(ERROR_CODES.internalError, 'Invalid native Job projection.')
  }
}
function jobView(job) {
  const clean = value => typeof value !== 'string' ? undefined : value.length > 4096
    ? '[OMITTED OVERSIZED METADATA]' : Array.from(maskOutput(value).toString('utf8')).slice(0, 1000).join('')
  return {
    status: job.status, ...(typeof job.detail === 'string' ? { detail: clean(job.detail) } : {}),
    ...(typeof job.progress === 'string' ? { progress: clean(job.progress) } : {}),
    output: { earliest: job.output.earliest, total: job.output.total },
  }
}
async function readWithSignal(read, signal) {
  signal.throwIfAborted()
  let listener
  const abort = new Promise((_, reject) => { listener = () => reject(signal.reason); signal.addEventListener('abort', listener, { once: true }) })
  try { return await Promise.race([Promise.resolve().then(read), abort]) }
  finally { signal.removeEventListener('abort', listener) }
}
function boundary(buffer, offset) { return offset === buffer.length || (buffer[offset] & 0xc0) !== 0x80 }

/** Rebuild bounded channel context before exposing any complete lines. */
function projectRows(rows, { options, earliest, observedThrough, terminal, loss }) {
  const lanes = new Map()
  for (const row of rows) {
    let lane = lanes.get(row.channel)
    if (!lane) { lane = { parts: [], length: 0 }; lanes.set(row.channel, lane) }
    row.laneAt = lane.length
    lane.parts.push(row.raw); lane.length += row.raw.length
  }
  let safeThrough = observedThrough
  for (const lane of lanes.values()) {
    lane.raw = Buffer.concat(lane.parts)
    const newline = lane.raw.lastIndexOf(10)
    // Treat CRLF as a unit. A trailing bare CR waits for LF or terminal.
    const carriage = lane.raw.lastIndexOf(13, Math.max(0, lane.raw.length - 2))
    lane.complete = terminal ? lane.raw.length : Math.max(newline, carriage) + 1
    lane.safe = maskOutput(lane.raw.toString('utf8'))
    // Retention or producer gaps can cut a label/secret. Mask the complete
    // retained prefix conservatively; never release an unknown suffix raw.
    if (loss) lane.safe.fill(42)
  }
  for (const row of rows) {
    const lane = lanes.get(row.channel)
    if (lane.complete < row.laneAt + row.raw.length) safeThrough = Math.min(safeThrough, row.at + Math.max(0, lane.complete - row.laneAt))
  }
  let cursor = Math.max(options.fromByte, earliest), bytes = 2
  const chunks = []
  for (const row of rows) {
    const end = Math.min(row.at + row.raw.length, safeThrough)
    const start = Math.max(row.at, cursor)
    if (end <= start) continue
    if (start > cursor) cursor = start // Explicit loss metadata accompanies gaps.
    const lane = lanes.get(row.channel), offset = start - row.at
    if (!boundary(row.raw, offset)) invalid('fromByte points inside a UTF-8 character; resume with nextFromByte.')
    const safe = lane.safe.subarray(row.laneAt + offset, row.laneAt + end - row.at)
    const raw = row.raw.subarray(offset, end - row.at)
    const redacted = !safe.equals(raw)
    const make = size => ({ at: start, end: start + size, channel: row.channel, text: safe.subarray(0, size).toString('utf8'), ...(redacted ? { redacted: true } : {}) })
    if (chunks.length === options.maxChunks) break
    let size = safe.length, projected = make(size)
    const cost = value => Buffer.byteLength(JSON.stringify(value)) + (chunks.length ? 1 : 0)
    if (bytes + cost(projected) > options.maxBytes) {
      let low = 1, high = safe.length, best = 0
      while (low <= high) {
        const mid = Math.floor((low + high) / 2)
        let cut = mid
        while (cut > 0 && (!boundary(safe, cut) || !boundary(raw, cut))) cut--
        if (bytes + cost(make(cut)) <= options.maxBytes) { best = cut; low = mid + 1 }
        else high = mid - 1
      }
      if (!best) break
      size = best; projected = make(size)
    }
    const extra = cost(projected)
    chunks.push(projected); bytes += extra; cursor = projected.end
    if (size < safe.length) break
  }
  return { chunks, nextFromByte: cursor, bytes, hasMore: cursor < safeThrough, pendingBytes: Math.max(0, observedThrough - Math.max(cursor, safeThrough)) }
}

/** Only native non-consuming follow. The MCP caller never owns task lifetime. */
export async function followJobOutput(controller, jobs, options, { signal: callerSignal } = {}) {
  const start = Date.now(), observer = new AbortController(), deadline = AbortSignal.timeout(options.timeoutMs)
  const signal = AbortSignal.any([observer.signal, deadline, ...(callerSignal ? [callerSignal] : [])])
  let job, iterator, earliest = 0, observedThrough = 0, retainedBytes = 0, loss = false, terminal = false
  let status = 'output', reason, rows = []
  const response = () => {
    const projected = projectRows(rows, { options, earliest, observedThrough, terminal, loss })
    if (terminal && projected.nextFromByte >= observedThrough && !projected.hasMore && status === 'output') status = 'settled'
    return {
      sessionId: options.sessionId, jobId: options.jobId, status,
      ...projected, ...(job ? { job: jobView(job) } : {}),
      lossy: loss, ...(loss ? { contextIncomplete: true } : {}), ...(reason ? { reason } : {}), elapsedMs: Date.now() - start,
    }
  }
  try {
    signal.throwIfAborted()
    if (typeof controller?.follow !== 'function' || typeof jobs?.get !== 'function') throw new McpError(ERROR_CODES.internalError, 'Native Job follow and owner lookup are required.')
    try { job = jobs.get(options.jobId, options.sessionId) }
    catch { status = 'unavailable'; reason = 'Job is missing, removed, or inaccessible; volatile output may not survive Host restart.'; return response() }
    checkJob(job, options)
    earliest = job.output.earliest
    if (options.fromByte > job.output.total) { status = 'cursorAhead'; return response() }
    // Replay retained context for split-secret masking; no model cursor is read.
    iterator = controller.follow({ sessionId: options.sessionId, jobId: options.jobId, from: 0 }, signal)[Symbol.asyncIterator]()
    const opened = await readWithSignal(() => iterator.next(), signal)
    if (opened.done || opened.value?.type !== 'opened') { status = 'disconnected'; return response() }
    job = opened.value.job; checkJob(job, options)
    earliest = job.output.earliest; observedThrough = earliest
    loss = earliest > 0
    if (options.fromByte > job.output.total) { status = 'cursorAhead'; return response() }
    while (true) {
      const next = await readWithSignal(() => iterator.next(), signal)
      if (next.done) { status = 'disconnected'; return response() }
      const frame = next.value
      if (frame?.type === 'status') {
        job = frame.job; checkJob(job, options)
        if (!terminalStates.has(job.status) || observedThrough < job.output.total) { status = 'gap'; loss = true; return response() }
        terminal = true; return response()
      }
      if (frame?.type !== 'output' || !Array.isArray(frame.chunks) || !Number.isSafeInteger(frame.next) || frame.next < observedThrough) {
        throw new McpError(ERROR_CODES.internalError, 'Invalid native Job output frame; cursor not advanced.')
      }
      loss ||= frame.lossy === true
      for (const chunk of frame.chunks) {
        if (!Number.isSafeInteger(chunk?.at) || chunk.at < observedThrough || typeof chunk.text !== 'string') throw new McpError(ERROR_CODES.internalError, 'Invalid native Job chunk; cursor not advanced.')
        const size = Buffer.byteLength(chunk.text)
        if (rows.length >= MAX_CONTEXT_CHUNKS || retainedBytes + size > MAX_CONTEXT_BYTES) {
          status = 'contextLimit'; reason = 'Retained masking context exceeds the observation safety limit; no unverified suffix is exposed.'; return response()
        }
        const raw = Buffer.from(chunk.text)
        loss ||= chunk.gapBefore === true || chunk.at !== observedThrough
        rows.push({ at: chunk.at, channel: channels.has(chunk.channel) ? chunk.channel : 'unknown', raw })
        retainedBytes += raw.length; observedThrough = chunk.at + raw.length
      }
      if (frame.next !== observedThrough) {
        if (frame.lossy !== true || frame.next < observedThrough) throw new McpError(ERROR_CODES.internalError, 'Native Job output skipped bytes without a loss marker.')
        observedThrough = frame.next; loss = true
      }
      // Opening metadata is a watermark, not a terminal guarantee.
      job = { ...job, output: { earliest, total: Math.max(job.output.total, observedThrough) } }
      const projected = response()
      if (projected.chunks.length || loss) return projected
    }
  } catch (error) {
    if (callerSignal?.aborted) status = 'cancelled'
    else if (deadline.aborted) status = 'timedOut'
    else if (error instanceof McpError) throw error
    else status = 'disconnected'
    return response()
  } finally {
    observer.abort()
    if (iterator?.return) {
      let timer
      try { await Promise.race([Promise.resolve().then(() => iterator.return()), new Promise(resolve => { timer = setTimeout(resolve, 1000) })]) }
      catch { /* No raw Host exception or secret is returned. */ }
      finally { clearTimeout(timer) }
    }
  }
}
