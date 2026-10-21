import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDshCapabilities } from '../../lib/dsh-capabilities.js'
import { EVENT_TYPES, eventOptions, observeEvents, projectEvent } from '../../lib/session-events.js'
import { McpGateway } from '../../lib/protocol.js'
import { createMcpHttpHandler } from '../../lib/http-route.js'
import { bridge, scratch } from './support.mjs'

// Synthetic data only. No user profile, provider, real Session or credential reads.
const event = (seq, type = 'step/end', data = { turn: 1, step: seq }) => ({ seq, time: 1000 + seq, type, data })
const records = events => events.map(event => ({ type: 'event', event }))
const options = args => eventOptions({ sessionId: 'synthetic-session', ...args }, true)
function fixture(history, { window = history.length, live = [], close = false, fault = false, afterSnapshot } = {}) {
  let open = 0, closed = 0, cancelled = 0, paged = 0
  const controller = {
    async cancel() { cancelled++; throw new Error('Observation must never cancel') },
    async page(request, signal) {
      paged++; signal.throwIfAborted()
      assert.equal(request.throughSeq, history.at(-1)?.seq ?? -1)
      assert.equal(request.address.sessionId, 'synthetic-session')
      const end = history.findIndex(row => row.seq === request.beforeSeq)
      const older = end < 0 ? history : history.slice(0, end)
      return { records: records(older.slice(-2)), hasMore: older.length > 2 }
    },
    async *follow(request, signal) {
      assert.equal(request.assistantStream, undefined)
      assert.equal(request.afterSeq, undefined, 'Do not invent unsupported native arguments')
      open++
      try {
        yield { type: 'snapshot', cursor: history.at(-1)?.seq ?? -1,
          records: records(history.slice(-window)), hasMore: history.length > window }
        await afterSnapshot?.()
        for (const row of live) {
          await delay(10, undefined, { signal })
          yield { type: 'event', event: row }
        }
        if (fault) throw new Error('private Host diagnostic must not be returned')
        if (close) return
        await new Promise(resolve => {
          if (signal.aborted) return resolve()
          signal.addEventListener('abort', resolve, { once: true })
        })
      } finally { closed++ }
    },
  }
  return { controller, assertClosed() { assert.equal(open, closed); assert.equal(cancelled, 0) }, get paged() { return paged } }
}
let count = 0
async function check(name, run) {
  // Native deadlines are unref'ed. A real HTTP caller keeps a socket alive;
  // synthetic iterators need an equivalent handle for timeout assertions.
  const keepAlive = setInterval(() => {}, 1000)
  try { await run(); console.log(`PASS events: ${name}`); count++ }
  finally { clearInterval(keepAlive) }
}

await check('native snapshot and page backfill, exclusive seq0 cursor, no duplicates', async () => {
  const f = fixture(Array.from({ length: 9 }, (_, seq) => event(seq)), { window: 2 })
  const result = await observeEvents(f.controller, options({ afterSeq: 0 }))
  assert.deepEqual(result.events.map(row => row.seq), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(result.nextAfterSeq, 8); assert.equal(result.headSeq, 8)
  assert.ok(f.paged > 0); f.assertClosed()
})
await check('empty durable log and first event at seq0', async () => {
  for (const history of [[], [event(0)]]) {
    const f = fixture(history)
    const result = await observeEvents(f.controller, options({}))
    assert.equal(result.nextAfterSeq, history.length - 1)
    assert.equal(result.returned, history.length); f.assertClosed()
  }
})
await check('limit never skips matching events; filtered suffix advances safely', async () => {
  const rows = [event(0), event(1, 'system/message'), event(2), event(3, 'system/message'), event(4)]
  const f = fixture(rows)
  const a = await observeEvents(f.controller, options({ limit: 1 }))
  assert.equal(a.nextAfterSeq, 1); assert.equal(a.hasMore, true)
  const b = await observeEvents(f.controller, options({ limit: 1, afterSeq: a.nextAfterSeq }))
  const c = await observeEvents(f.controller, options({ limit: 1, afterSeq: b.nextAfterSeq }))
  assert.deepEqual([...a.events, ...b.events, ...c.events].map(row => row.seq), [0, 2, 4])
  assert.equal(c.nextAfterSeq, 4); assert.equal(c.hasMore, false); f.assertClosed()
})
await check('byte budget pagination and UTF-8 data preserve every event identity', async () => {
  const rows = Array.from({ length: 8 }, (_, seq) => event(seq, 'tool/result', {
    message: { toolCallId: `call-${seq}`, content: [{ type: 'text', text: '測試🙂'.repeat(300) }] },
  }))
  const f = fixture(rows), found = []
  let cursor = -1
  do {
    const result = await observeEvents(f.controller, options({ afterSeq: cursor, maxBytes: 4096, maxChars: 2000 }))
    assert.ok(result.returned > 0)
    assert.ok(Buffer.byteLength(JSON.stringify(result.events)) <= 4096)
    assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(result.events)))
    assert.ok(!JSON.stringify(result.events).includes('�'))
    assert.ok(!JSON.stringify(result.events).match(/\\u[dD][89aAbB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F])/))
    found.push(...result.events.map(row => row.seq)); cursor = result.nextAfterSeq
    if (!result.hasMore) break
  } while (found.length < 20)
  assert.deepEqual(found, rows.map(row => row.seq)); f.assertClosed()
})
await check('oversized event has explicit omission; deep/long/multiple text fields stay bounded', async () => {
  const row = event(0, 'tool/call', { name: 'fixture', callId: 'call-0', arguments: JSON.stringify({ values: Array(50).fill('a'.repeat(1000)) }) })
  const f = fixture([row])
  const result = await observeEvents(f.controller, options({ maxBytes: 4096, maxChars: 2000 }))
  assert.equal(result.events[0].truncated, true); assert.match(result.events[0].omitted, /maxBytes/)
  assert.equal(result.nextAfterSeq, 0); f.assertClosed()
  const deep = { a: { a: { a: { a: { a: { a: { sensitive: 'not inspected' } } } } } } }
  assert.equal(projectEvent(event(1, 'tool/call', { arguments: JSON.stringify(deep) }), 128).truncated, true)
  const long = projectEvent(event(2, 'assistant/message', { message: { content: [{ type: 'text', text: '🙂'.repeat(1000) }] } }), 128)
  assert.equal(Array.from(long.data.text).length, 128)
})
await check('credentials in JSON arguments and tool text are redacted before clipping', async () => {
  const secret = 'synthetic-secret-value'
  const args = { command: `echo API_KEY=${secret}`, nested: { authorization: `Bearer ${secret}`, env: { SAFE: 'hidden too' } }, password: secret }
  const call = projectEvent(event(0, 'tool/call', { arguments: JSON.stringify(args), name: 'bash', callId: 'pair' }), 2000)
  const result = projectEvent(event(1, 'tool/result', {
    message: { toolCallId: 'pair', isError: true, content: [{ type: 'text', text: `Authorization: Bearer ${secret}\napi_key="${secret}"\nhttps://user:${secret}@example.invalid\n` }, { type: 'reasoning', text: 'private-reasoning' }] },
    error: { name: 'FixtureError', code: 'FAILED', reason: `password=${secret}` }, meta: { private: 'private-meta' },
  }), 2000)
  const text = JSON.stringify([call, result])
  for (const blocked of [secret, 'private-meta', 'private-reasoning']) assert.equal(text.includes(blocked), false)
  assert.equal(call.redacted, true); assert.equal(result.redacted, true)
  assert.equal(call.data.callId, result.data.callId); assert.equal(result.data.isError, true)
  const split = projectEvent(event(2, 'tool/result', { message: { content: [
    { type: 'text', text: 'password=' }, { type: 'text', text: secret },
  ] } }), 2000)
  assert.equal(JSON.stringify(split).includes(secret), false)
})
await check('raw attempt/assistant stream, headers, usage and opaque fields are never projected', async () => {
  for (const type of ['assistant/attempt', 'assistant/message']) {
    const row = projectEvent(event(0, type, { turn: 1, step: 2, stream: ['private-stream'], headers: { key: 'private-header' }, usage: { private: 'private-usage' }, message: { content: [{ type: 'reasoning', text: 'private-reasoning' }, { type: 'text', text: 'public text' }] } }), 2000)
    assert.equal(JSON.stringify(row).includes('private-'), false)
  }
  const f = fixture([event(0, 'request/header', { key: 'private-header' })])
  const result = await observeEvents(f.controller, options({}))
  assert.equal(result.returned, 0); assert.equal(result.nextAfterSeq, 0); f.assertClosed()
})
await check('large unbroken text avoids redaction regex backtracking and CLI secrets are hidden', async () => {
  const started = performance.now()
  const row = projectEvent(event(0, 'tool/result', { message: { content: [{ type: 'text', text: 'a'.repeat(500000) }] } }), 2000)
  assert.equal(row.truncated, true)
  assert.equal(row.data.text.length, 2000)
  assert.ok(performance.now() - started < 2000, 'Redaction must not block the Host on large ordinary text')
  const cli = projectEvent(event(1, 'tool/call', { arguments: JSON.stringify({ command: 'fixture --api-key synthetic-cli-credential' }) }), 2000)
  assert.equal(JSON.stringify(cli).includes('synthetic-cli-credential'), false)
  assert.equal(cli.redacted, true)
})
await check('job registration/settlement correlation is separate from tool success', async () => {
  const f = fixture([
    event(0, 'tool/result', { message: { toolCallId: 'call', content: [{ type: 'text', text: '{"jobId":"job"}' }] } }),
    event(1, 'job/registered', { jobId: 'job', owner: 'synthetic-session', toolCall: { callId: 'nested', rootCallId: 'call' } }),
    event(2, 'job/settled', { jobId: 'job', status: 'failed', detail: 'exit code: 3' }),
  ])
  const result = await observeEvents(f.controller, options({}))
  assert.equal(result.events[0].data.isError, false)
  assert.equal(result.events[1].data.toolCall.rootCallId, 'call')
  assert.equal(result.events[2].data.status, 'failed'); f.assertClosed()
})
await check('native bash nonzero exit remains completed/isError false with explicit failure details', async () => {
  const f = fixture([
    event(0, 'tool/call', { callId: 'bash-call', name: 'bash', arguments: '{"command":"exit 23"}' }),
    event(1, 'job/settled', { jobId: 'bash-job', status: 'completed', detail: 'exit code: 23', toolCall: { callId: 'bash-call', rootCallId: 'bash-call' } }),
    event(2, 'tool/result', { message: { toolCallId: 'bash-call', isError: false, content: [{ type: 'text', text: '[stderr]\ncontrolled failure\n[exit code: 23]' }] } }),
  ])
  const result = await observeEvents(f.controller, options({}))
  const [call, job, tool] = result.events
  assert.equal(job.data.status, 'completed'); assert.equal(job.data.detail, 'exit code: 23')
  assert.equal(tool.data.isError, false); assert.match(tool.data.text, /\n\[exit code: 23\]$/)
  assert.equal(call.data.callId, job.data.toolCall.rootCallId)
  assert.equal(call.data.callId, tool.data.callId); f.assertClosed()
})
await check('live events after opening cut are observed and observer returns promptly', async () => {
  const f = fixture([event(0)], { live: [event(1, 'request/header'), event(2, 'tool/call', { callId: 'live', name: 'fixture', arguments: '{}' })] })
  const result = await observeEvents(f.controller, options({ afterSeq: 0 }), { follow: true })
  assert.equal(result.status, 'events'); assert.deepEqual(result.events.map(row => row.seq), [2])
  assert.equal(result.nextAfterSeq, 2); f.assertClosed()
})
await check('timeout and caller disconnection release subscription and never cancel work', async () => {
  for (const abort of [false, true]) {
    const f = fixture([event(0)]), caller = new AbortController()
    const timer = abort ? setTimeout(() => caller.abort(), 25) : undefined
    try {
      const result = await observeEvents(f.controller, options({ afterSeq: 0, timeoutMs: 100 }), { follow: true, signal: caller.signal })
      assert.equal(result.status, abort ? 'cancelled' : 'timedOut')
      assert.equal(result.nextAfterSeq, 0); f.assertClosed()
    } finally { clearTimeout(timer) }
  }
})
await check('opening/page reads obey observation deadline too', async () => {
  const f = fixture([event(0)])
  const original = f.controller.follow
  f.controller.follow = async function* (request, signal) {
    await delay(5000, undefined, { signal }); yield* original(request, signal)
  }
  const result = await observeEvents(f.controller, options({ timeoutMs: 100 }), { follow: true })
  assert.equal(result.status, 'timedOut'); assert.equal(result.nextAfterSeq, -1); f.assertClosed()
})
await check('premature close/Host exception never means completed; reconnect replays only new seq', async () => {
  for (const config of [{ close: true }, { fault: true }]) {
    const f = fixture([event(0)], config)
    const result = await observeEvents(f.controller, options({ afterSeq: 0 }), { follow: true })
    assert.equal(result.status, 'disconnected'); assert.equal(result.nextAfterSeq, 0)
    assert.equal(JSON.stringify(result).includes('private Host'), false); f.assertClosed()
    const restarted = fixture([event(0), event(1), event(2)], { window: 1 })
    const replay = await observeEvents(restarted.controller, options({ afterSeq: result.nextAfterSeq }))
    assert.deepEqual(replay.events.map(row => row.seq), [1, 2]); restarted.assertClosed()
  }
})
await check('durable and live gaps preserve last safe cursor; ahead cursor is explicit', async () => {
  for (const [history, config, afterSeq, expected] of [
    [[event(0), event(2)], {}, -1, 0],
    [[event(0)], { live: [event(2)] }, 0, 0],
  ]) {
    const f = fixture(history, config)
    const result = await observeEvents(f.controller, options({ afterSeq }), { follow: true })
    assert.equal(result.status, 'gap'); assert.equal(result.nextAfterSeq, expected); f.assertClosed()
  }
  const f = fixture([event(0)])
  const result = await observeEvents(f.controller, options({ afterSeq: 10 }))
  assert.equal(result.status, 'cursorAhead'); assert.equal(result.nextAfterSeq, 10); f.assertClosed()
})
await check('history page holes and incompatible API fail without a false healthy cursor', async () => {
  const f = fixture([event(0), event(1), event(2)], { window: 1 })
  f.controller.page = () => ({ records: [], hasMore: false })
  const result = await observeEvents(f.controller, options({}))
  assert.equal(result.status, 'gap'); assert.equal(result.nextAfterSeq, -1); f.assertClosed()
  await assert.rejects(() => observeEvents({}, options({})), /required Session follow\/page/)
})
await check('strict validation rejects unsupported filters, bounds and arguments', async () => {
  for (const args of [
    { eventTypes: [] }, { eventTypes: ['system/message'] }, { limit: 0 }, { afterSeq: -2 },
    { afterSeq: '1' }, { maxBytes: 1 }, { maxChars: 0 }, { timeoutMs: 30001 }, { token: 'never' },
    { sessionId: '' }, { sessionId: 'a'.repeat(257) },
  ]) assert.throws(() => options(args))
  assert.equal(EVENT_TYPES.includes('tool/result'), true)
})
await check('foreign owner rejected before any Host access; new tools carry read-only annotations', async () => {
  let touched = 0
  const f = fixture([event(0)])
  const caps = createDshCapabilities({ get(name) { touched++; return name === 'sessionController' ? f.controller : undefined } }, {
    sessionOwners: { ownerOf: () => ({ ownerId: 'owner', ownerName: 'fixture owner' }) }, restrictToOwner: true, logger() {},
  })
  const before = touched
  for (const name of ['dsh_read_events', 'dsh_follow_events']) {
    await assert.rejects(() => caps.callTool(name, { sessionId: 'synthetic-session' }, { caller: { id: 'foreign' } }), /restrictToOwner/)
    assert.equal(touched, before)
    assert.equal(caps.tools.find(row => row.name === name).annotations.readOnlyHint, true)
  }
  const reply = await caps.callTool('dsh_read_events', { sessionId: 'synthetic-session' }, { caller: { id: 'owner' } })
  assert.equal(reply.structuredContent.events[0].seq, 0); f.assertClosed()
})
await check('actual HTTP/stdio transport publishes both tools and carries bounded event results', async () => {
  const temporary = await scratch('events-transport')
  const f = fixture([event(0), event(1, 'tool/result', { message: { toolCallId: 'call', isError: true, content: [{ type: 'text', text: 'controlled failure' }] } })])
  const caps = createDshCapabilities({ get: name => name === 'sessionController' ? f.controller : undefined }, { logger() {} })
  const gateway = new McpGateway({ serverInfo: { name: 'synthetic-events', version: '1' }, listTools: () => caps.tools, callTool: (name, args, context) => caps.callTool(name, args, context) })
  const handler = createMcpHttpHandler({ gateway, authorize: req => ({ ok: req.headers.authorization === 'Bearer synthetic-transport-credential', status: 401 }) })
  const server = createServer(handler)
  let client
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const file = join(temporary.directory, 'endpoint.json'), url = `http://127.0.0.1:${server.address().port}/mcp`
    await writeFile(file, JSON.stringify({ url, token: 'synthetic-transport-credential', profile: 'desktop' }), { mode: 0o600 })
    client = bridge(file, { cwd: temporary.directory, args: ['--expected-profile', 'desktop'] })
    const listed = await client.request('tools/list')
    assert.ok(listed.result.tools.some(row => row.name === 'dsh_read_events'))
    assert.ok(listed.result.tools.some(row => row.name === 'dsh_follow_events'))
    const reply = await client.request('tools/call', { name: 'dsh_read_events', arguments: { sessionId: 'synthetic-session', eventTypes: ['tool/result'] } })
    assert.equal(reply.result.structuredContent.events[0].data.isError, true)
    assert.equal(reply.result.structuredContent.nextAfterSeq, 1)
    assert.ok(!client.stderr.includes('synthetic-transport-credential'))
    const caller = new AbortController()
    const request = fetch(url, { method: 'POST', headers: { authorization: 'Bearer synthetic-transport-credential' }, signal: caller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'dsh_follow_events', arguments: { sessionId: 'synthetic-session', afterSeq: 1, timeoutMs: 1000 } } }) })
    await delay(30); caller.abort()
    await assert.rejects(request, /abort/iu)
    await delay(30); f.assertClosed()
  } finally {
    await client?.dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await temporary.dispose()
  }
})
console.log(`PASS ${count} native event observation regression groups`)
