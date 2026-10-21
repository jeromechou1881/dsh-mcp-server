/** Bounded, projected observations of the official DSH Session follow/page API. */
import { ERROR_CODES, McpError } from './protocol.js'

export const EVENT_TYPES = Object.freeze([
  'tool/call', 'tool/result', 'step/start', 'step/end', 'turn/start', 'turn/end',
  'assistant/message', 'assistant/attempt', 'job/registered', 'job/settled',
  'approval/asked', 'approval/decided',
])
const allowed = new Set(EVENT_TYPES)
const sensitiveKey = /^(?:key|env)$/iu
const sensitivePart = /authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|private[-_]?key|headers?/iu
const MAX_SOURCE_CHARS = 1024 * 1024
const MAX_HISTORY_EVENTS = 100000
const MAX_HISTORY_PAGES = 256

function invalid(message) { throw new McpError(ERROR_CODES.invalidParams, message) }
function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`"${name}" must be an integer from ${min} to ${max}.`)
  return value
}

export function eventOptions(args, follow = false) {
  if (typeof args.sessionId !== 'string' || !args.sessionId || args.sessionId.length > 256) invalid('"sessionId" must be a nonempty string of at most 256 characters.')
  const keys = new Set(['sessionId', 'afterSeq', 'limit', 'eventTypes', 'maxBytes', 'maxChars', ...(follow ? ['timeoutMs'] : [])])
  if (Object.keys(args).some(key => !keys.has(key))) invalid('Unknown event observation argument.')
  const types = args.eventTypes ?? EVENT_TYPES
  if (!Array.isArray(types) || types.length === 0 || types.length > EVENT_TYPES.length || types.some(type => !allowed.has(type))) invalid('"eventTypes" must be a nonempty array of supported public event types.')
  return {
    sessionId: args.sessionId,
    afterSeq: integer(args.afterSeq, -1, -1, Number.MAX_SAFE_INTEGER - 1, 'afterSeq'),
    limit: integer(args.limit, 30, 1, 200, 'limit'),
    maxBytes: integer(args.maxBytes, 16384, 4096, 65536, 'maxBytes'),
    maxChars: integer(args.maxChars, 2000, 128, 20000, 'maxChars'),
    eventTypes: [...new Set(types)],
    timeoutMs: follow ? integer(args.timeoutMs, 10000, 100, 30000, 'timeoutMs') : 10000,
  }
}

/** Conservative pattern redaction, not a guarantee for arbitrary unlabeled secrets. */
function redact(text) {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s"',;]+/giu, '[REDACTED AUTH]')
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{12,}|github_pat_[\w]{12,}|xox[baprs]-[\w-]{10,})/gu, '[REDACTED TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '[REDACTED JWT]')
    .replace(/\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[REDACTED]@')
    .replace(/(--(?:api[-_]?key|token|password|passwd|secret|authorization|cookie)(?:=|\s+))(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}\]]+)/giu, '$1[REDACTED]')
    // A bounded key at a word boundary avoids quadratic scans of long tool
    // output. Never use unanchored \w* on both sides of a credential name.
    .replace(/((?<![\w-])["']?[\w-]{0,64}(?:api[_-]?key|token|password|passwd|secret|credential|authorization|cookie)[\w-]{0,64}["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}\]]+)/giu, '$1[REDACTED]')
}

function utf8Prefix(text, maxBytes) {
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}

/** All strings pass redaction before clipping; raw model streams never reach here. */
function projector(maxChars) {
  let redacted = false, truncated = false
  function text(value) {
    if (typeof value !== 'string') return undefined
    if (value.length > MAX_SOURCE_CHARS) { truncated = true; return '[OMITTED OVERSIZED CONTENT]' }
    const safe = redact(value)
    redacted ||= safe !== value
    const clipped = utf8Prefix(safe, maxChars * 4)
    // Array.from respects surrogate pairs; preserve valid Unicode in JSON and text.
    const bounded = Array.from(clipped).slice(0, maxChars).join('')
    truncated ||= bounded !== safe
    return bounded
  }
  function value(input, depth = 0) {
    if (typeof input === 'string') return text(input)
    if (input === null || typeof input === 'boolean' || (typeof input === 'number' && Number.isFinite(input))) return input
    if (!input || typeof input !== 'object') return undefined
    if (depth >= 6) { truncated = true; return '[OMITTED DEPTH]' }
    if (Array.isArray(input)) {
      truncated ||= input.length > 50
      return input.slice(0, 50).map(item => value(item, depth + 1))
    }
    const entries = Object.entries(input)
    truncated ||= entries.length > 50
    return Object.fromEntries(entries.slice(0, 50).map(([key, item]) => {
      if (sensitiveKey.test(key) || sensitivePart.test(key)) { redacted = true; return [text(key), '[REDACTED]'] }
      return [text(key), value(item, depth + 1)]
    }))
  }
  function content(parts) {
    const blocks = Array.isArray(parts) ? parts : []
    const texts = []
    for (const block of blocks) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      if (texts.length === 50) { truncated = true; break }
      texts.push(text(block.text))
    }
    return text(texts.join('\n'))
  }
  return { text, value, content, flags: () => ({ ...(redacted ? { redacted: true } : {}), ...(truncated ? { truncated: true } : {}) }) }
}

/** Explicit schema per event: do not spread Host data or opaque tool metadata. */
export function projectEvent(event, maxChars) {
  const p = projector(maxChars), d = event.data ?? {}, data = {}
  const string = (key, source = d[key]) => { if (typeof source === 'string') data[key] = p.text(source) }
  const number = key => { if (Number.isSafeInteger(d[key]) && d[key] >= 0) data[key] = d[key] }
  number('turn'); number('step')
  switch (event.type) {
    case 'tool/call': {
      string('callId'); string('name')
      if (typeof d.arguments === 'string' && d.arguments.length <= MAX_SOURCE_CHARS) {
        try { data.arguments = p.value(JSON.parse(d.arguments)) }
        catch { data.arguments = p.text(d.arguments); data.argumentsInvalidJson = true }
      } else { data.arguments = '[OMITTED OVERSIZED CONTENT]'; data.truncated = true }
      break
    }
    case 'tool/result':
      string('callId', d.message?.toolCallId)
      data.isError = d.message?.isError === true
      data.text = p.content(d.message?.content)
      if (d.error) data.error = { name: p.text(d.error.name), code: p.text(d.error.code), reason: p.text(d.error.reason) }
      break
    case 'assistant/message':
      data.text = p.content(d.message?.content)
      if (d.interrupted === true) data.interrupted = true
      break
    case 'assistant/attempt': data.contentOmitted = true; break
    case 'turn/end':
      data.reason = { kind: p.text(d.reason?.kind) }
      if (typeof d.reason?.reason?.kind === 'string') data.reason.cause = p.text(d.reason.reason.kind)
      break
    case 'job/registered':
    case 'job/settled':
      for (const key of ['jobId', 'owner', 'kind', 'label', 'status', 'cause', 'detail']) string(key)
      number('startedAt'); number('finishedAt')
      if (typeof d.producerReported === 'boolean') data.producerReported = d.producerReported
      if (d.toolCall) data.toolCall = { callId: p.text(d.toolCall.callId), rootCallId: p.text(d.toolCall.rootCallId) }
      break
    case 'approval/asked':
    case 'approval/decided':
      for (const key of ['id', 'toolName', 'callId', 'reason', 'outcome']) string(key)
      break
  }
  return { seq: event.seq, type: event.type, ...(Number.isFinite(event.time) ? { time: event.time } : {}), data, ...p.flags() }
}

/** Race a cooperative service read with the observer's deadline/disconnection. */
async function interruptedRead(read, signal) {
  signal.throwIfAborted()
  let listener
  const interrupted = new Promise((_, reject) => {
    listener = () => reject(signal.reason)
    signal.addEventListener('abort', listener, { once: true })
  })
  try { return await Promise.race([Promise.resolve().then(read), interrupted]) }
  finally { signal.removeEventListener('abort', listener) }
}

function recordsOf(records) {
  if (!Array.isArray(records) || records.some(record => record?.type !== 'event' || !Number.isSafeInteger(record.event?.seq) || record.event.seq < 0)) {
    throw new McpError(ERROR_CODES.internalError, 'Invalid Session history records; cursor was not advanced.')
  }
  return records.map(record => record.event)
}

/** Observe only. Never prompt, cancel, kill, read jobs, or touch model defaults. */
export async function observeEvents(controller, options, { follow = false, signal: callerSignal } = {}) {
  const started = Date.now(), observer = new AbortController()
  const deadline = AbortSignal.timeout(options.timeoutMs)
  const signal = AbortSignal.any([observer.signal, deadline, ...(callerSignal ? [callerSignal] : [])])
  const selected = new Set(options.eventTypes), events = []
  const address = { kind: 'session', sessionId: options.sessionId }
  let iterator, cursor = options.afterSeq, headSeq, bytes = 2, gap
  let status = follow ? 'events' : 'read', hasMore = false
  const result = () => ({
    sessionId: options.sessionId, status, events, returned: events.length,
    nextAfterSeq: cursor, ...(headSeq === undefined ? {} : { headSeq }), hasMore,
    eventTypes: options.eventTypes, bytes, ...(gap ? { gap } : {}), elapsedMs: Date.now() - started,
  })
  function consume(event) {
    if (event.seq <= cursor) return true
    headSeq = Math.max(headSeq ?? -1, event.seq)
    if (event.seq !== cursor + 1) {
      gap = { expectedSeq: cursor + 1, receivedSeq: event.seq }
      status = 'gap'; hasMore = true; return false
    }
    if (selected.has(event.type)) {
      if (events.length >= options.limit) { hasMore = true; return false }
      let row = projectEvent(event, options.maxChars)
      let size = Buffer.byteLength(JSON.stringify(row))
      if (size + 2 > options.maxBytes) {
        // A single huge event still advances safely, with its omission explicit.
        row = { seq: event.seq, type: event.type, data: {}, truncated: true, omitted: 'event exceeds maxBytes' }
        size = Buffer.byteLength(JSON.stringify(row))
      }
      const extra = size + (events.length ? 1 : 0)
      if (bytes + extra > options.maxBytes) { hasMore = true; return false }
      events.push(row); bytes += extra
    }
    cursor = event.seq
    return true
  }
  try {
    if (typeof controller?.follow !== 'function' || typeof controller?.page !== 'function') {
      throw new McpError(ERROR_CODES.internalError, 'This DSH Host does not provide the required Session follow/page APIs.')
    }
    iterator = controller.follow({ address, maxMessages: 50 }, signal)[Symbol.asyncIterator]()
    const opening = await interruptedRead(() => iterator.next(), signal)
    if (opening.done || opening.value?.type !== 'snapshot' || !Number.isSafeInteger(opening.value.cursor) || opening.value.cursor < -1) {
      status = 'disconnected'; return result()
    }
    const snapshot = opening.value
    headSeq = snapshot.cursor
    if (cursor > headSeq) {
      status = 'cursorAhead'; gap = { expectedSeq: cursor, receivedSeq: headSeq }; return result()
    }
    let history = recordsOf(snapshot.records), hasOlder = snapshot.hasMore, pages = 0
    if ((history.at(-1)?.seq ?? -1) !== headSeq) {
      status = 'gap'; hasMore = true; gap = { expectedSeq: headSeq, receivedSeq: history.at(-1)?.seq ?? -1 }; return result()
    }
    while ((history[0]?.seq ?? headSeq + 1) > cursor + 1 && hasOlder) {
      if (++pages > MAX_HISTORY_PAGES || history.length > MAX_HISTORY_EVENTS) {
        throw new McpError(ERROR_CODES.invalidParams, 'Session history backfill exceeds the observation safety limit; use a more recent afterSeq.')
      }
      const beforeSeq = history[0]?.seq ?? headSeq + 1
      const page = await interruptedRead(() => controller.page({ address, throughSeq: headSeq, beforeSeq, maxMessages: 100 }, signal), signal)
      const older = recordsOf(page?.records)
      if (!older.length || older.at(-1).seq !== beforeSeq - 1 || older[0].seq >= beforeSeq) {
        status = 'gap'; hasMore = true; gap = { expectedSeq: cursor + 1, receivedSeq: history[0]?.seq ?? headSeq + 1 }; return result()
      }
      history = older.concat(history); hasOlder = page.hasMore
    }
    if (history.length > MAX_HISTORY_EVENTS) throw new McpError(ERROR_CODES.invalidParams, 'Session history backfill exceeds the observation safety limit; use a more recent afterSeq.')
    for (const event of history) if (!consume(event)) return result()
    if (cursor !== headSeq) {
      status = 'gap'; hasMore = true; gap = { expectedSeq: cursor + 1, receivedSeq: headSeq }; return result()
    }
    if (!follow || events.length) { status = follow ? 'events' : 'read'; return result() }
    while (true) {
      const frame = await interruptedRead(() => iterator.next(), signal)
      if (frame.done) { status = 'disconnected'; return result() }
      if (frame.value?.type !== 'event') {
        throw new McpError(ERROR_CODES.internalError, 'Unexpected Session follow frame; cursor was not advanced.')
      }
      const event = frame.value.event
      if (!Number.isSafeInteger(event?.seq) || event.seq < 0) throw new McpError(ERROR_CODES.internalError, 'Invalid Session event sequence.')
      if (!consume(event)) return result()
      // Return at the first interesting live event, letting the model act now.
      if (events.length) { status = 'events'; return result() }
    }
  } catch (error) {
    if (callerSignal?.aborted) status = 'cancelled'
    else if (deadline.aborted) status = 'timedOut'
    else if (error instanceof McpError) throw error
    else status = 'disconnected' // Host diagnostics may contain private payloads.
    return result()
  } finally {
    observer.abort()
    // The native controller releases subscriptions on abort. Bound cleanup for
    // a future incompatible service rather than leaving an MCP request hanging.
    if (iterator?.return) {
      let timer
      try { await Promise.race([Promise.resolve().then(() => iterator.return()), new Promise(resolve => { timer = setTimeout(resolve, 1000) })]) }
      catch { /* observation already has a resumable cursor */ }
      finally { clearTimeout(timer) }
    }
  }
}
