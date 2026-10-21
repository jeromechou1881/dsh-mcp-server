import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { followJobOutput, jobOutputOptions, maskOutput } from '../../lib/job-output.js'
import { createDshCapabilities } from '../../lib/dsh-capabilities.js'
import { McpGateway } from '../../lib/protocol.js'
import { createMcpHttpHandler } from '../../lib/http-route.js'
import { scratch, bridge } from './support.mjs'

const options = args => jobOutputOptions({ sessionId: 'synthetic-session', jobId: 'synthetic-job', ...args })
const chunk = (text, channel = 'stdout', at) => ({ text, channel, ...(at === undefined ? {} : { at }) })
function fixture(input = [], config = {}) {
  let at = config.earliest ?? 0, opened = 0, closed = 0, reads = 0, kills = 0, gets = 0
  const position = row => { const result = { ...row, at: row.at ?? at }; at = result.at + Buffer.byteLength(result.text); return result }
  const initial = input.map(position)
  const future = (config.live ?? []).map(position)
  const total = initial.at(-1) ? initial.at(-1).at + Buffer.byteLength(initial.at(-1).text) : config.earliest ?? 0
  const job = { id: 'synthetic-job', owner: config.owner ?? 'synthetic-session', status: config.status ?? 'running',
    label: 'not exposed', output: { earliest: config.earliest ?? 0, total, spillPaths: ['/private/never-read'] } }
  const jobs = {
    get(id, sessionId) { gets++; assert.equal(id, 'synthetic-job'); assert.equal(sessionId, 'synthetic-session'); if (config.missing) throw new Error('private lookup detail'); return structuredClone(job) },
    read() { reads++; throw new Error('Consuming read is forbidden') },
    kill() { kills++; throw new Error('Kill is forbidden') },
  }
  const controller = { async *follow(request, signal) {
    assert.deepEqual(request, { sessionId: 'synthetic-session', jobId: 'synthetic-job', from: 0 })
    opened++
    try {
      yield { type: 'opened', job: structuredClone(job), from: 0 }
      const frames = config.splitInitial ? initial.map(row => [row]) : [initial]
      for (const rows of frames) if (rows.length) yield { type: 'output', chunks: rows, next: rows.at(-1).at + Buffer.byteLength(rows.at(-1).text), ...(config.lossy ? { lossy: true } : {}) }
      for (const row of future) {
        await delay(15, undefined, { signal })
        job.output.total = row.at + Buffer.byteLength(row.text)
        yield { type: 'output', chunks: [row], next: job.output.total }
      }
      if (config.fault) throw new Error('private native follow exception')
      if (config.terminal || ['completed', 'failed', 'killed'].includes(job.status)) {
        job.status = config.terminal ?? job.status
        if (config.removeWithMissingTail) job.output.total += 5
        yield { type: 'status', job: structuredClone(job) }; return
      }
      if (config.close) return
      await new Promise(resolve => {
        if (signal.aborted) return resolve()
        signal.addEventListener('abort', resolve, { once: true })
      })
    } finally { closed++ }
  } }
  return { jobs, controller, job, get gets() { return gets }, check() { assert.equal(opened, closed); assert.equal(reads, 0); assert.equal(kills, 0) } }
}
let count = 0
async function check(name, run) {
  const keep = setInterval(() => {}, 1000)
  try { await run(); count++; console.log('PASS job-output: ' + name) }
  finally { clearInterval(keep) }
}
const read = (f, args = {}, context) => followJobOutput(f.controller, f.jobs, options(args), context)

await check('running stdout/stderr arrive before settlement and consuming cursor is untouched', async () => {
  const f = fixture([chunk('first progress\n'), chunk('warning now\n', 'stderr')])
  const r = await read(f)
  assert.equal(r.status, 'output'); assert.equal(r.job.status, 'running')
  assert.deepEqual(r.chunks.map(x => [x.channel, x.text]), [['stdout', 'first progress\n'], ['stderr', 'warning now\n']])
  assert.equal(r.nextFromByte, Buffer.byteLength('first progress\nwarning now\n'))
  assert.equal(JSON.stringify(r).includes('never-read'), false); assert.equal(JSON.stringify(r).includes('not exposed'), false); f.check()
})
await check('native live follow waits for new complete lines', async () => {
  const f = fixture([], { live: [chunk('fresh progress\n')] })
  const r = await read(f)
  assert.equal(r.chunks[0].text, 'fresh progress\n'); assert.ok(r.elapsedMs >= 10); f.check()
})
await check('capacity pagination uses original bytes and JSON escaping without skipped output', async () => {
  const text = ('測試🙂"\\\t'.repeat(2000)) + '\n', f = fixture([chunk(text)])
  let fromByte = 0, combined = '', pages = 0
  while (fromByte < Buffer.byteLength(text)) {
    const r = await read(f, { fromByte, maxBytes: 4096 })
    assert.ok(r.chunks.length > 0); assert.ok(r.nextFromByte > fromByte)
    assert.ok(Buffer.byteLength(JSON.stringify(r.chunks)) <= 4096)
    assert.equal(r.bytes, Buffer.byteLength(JSON.stringify(r.chunks)))
    assert.ok(!JSON.stringify(r.chunks).includes('�'))
    combined += r.chunks.map(x => x.text).join(''); fromByte = r.nextFromByte
    assert.ok(++pages < 100)
  }
  assert.equal(combined, text); f.check()
})
await check('maxChunks and source ordering remain stable across pages', async () => {
  const f = fixture([chunk('a\n'), chunk('b\n', 'stderr'), chunk('c\n')])
  const a = await read(f, { maxChunks: 1 }), b = await read(f, { fromByte: a.nextFromByte, maxChunks: 1 }), c = await read(f, { fromByte: b.nextFromByte, maxChunks: 1 })
  assert.deepEqual([...a.chunks, ...b.chunks, ...c.chunks].map(x => x.text), ['a\n', 'b\n', 'c\n'])
  assert.equal(c.hasMore, false); f.check()
})
await check('credentials split across native frames are masked without leaking prefixes', async () => {
  const f = fixture([chunk('Authorization: Bearer synthetic-'), chunk('secret-value\n')], { splitInitial: true })
  const r = await read(f)
  assert.equal(JSON.stringify(r.chunks).includes('synthetic-'), false)
  assert.equal(JSON.stringify(r.chunks).includes('secret-value'), false)
  assert.equal(r.nextFromByte, Buffer.byteLength('Authorization: Bearer synthetic-secret-value\n')); f.check()
})
await check('partial secret line is held across MCP calls then resumed with full masking context', async () => {
  const f = fixture([chunk('progress\nAPI_KEY=synthetic-first')])
  const a = await read(f)
  assert.equal(a.chunks.map(x => x.text).join(''), 'progress\n')
  assert.equal(a.nextFromByte, 9); assert.ok(a.pendingBytes > 0); f.check()
  const next = fixture([chunk('progress\nAPI_KEY=synthetic-first'), chunk('-second\n')])
  const b = await read(next, { fromByte: a.nextFromByte })
  const text = b.chunks.map(x => x.text).join('')
  assert.equal(text.includes('synthetic'), false); assert.equal(text.includes('second'), false)
  assert.equal(b.nextFromByte, Buffer.byteLength('progress\nAPI_KEY=synthetic-first-second\n')); next.check()
})
await check('UTF-8 secret masking retains raw cursor alignment at capacity boundaries', async () => {
  const text = 'password=' + '密🙂'.repeat(3000) + '\n', f = fixture([chunk(text)])
  let fromByte = 0
  while (fromByte < Buffer.byteLength(text)) {
    const r = await read(f, { fromByte, maxBytes: 4096 })
    assert.ok(r.nextFromByte > fromByte)
    assert.equal(JSON.stringify(r.chunks).includes('密'), false)
    fromByte = r.nextFromByte
  }
  f.check()
})
await check('PEM and same-channel split secrets are masked; distinct channels are not concatenated', async () => {
  const f = fixture([chunk('-----BEGIN PRIVATE KEY-----\n'), chunk('synthetic-body\n'), chunk('-----END PRIVATE KEY-----\n')])
  const r = await read(f)
  assert.equal(JSON.stringify(r.chunks).includes('synthetic-body'), false); f.check()
  const different = fixture([chunk('Bearer harmless\n'), chunk('ordinary diagnostic\n', 'stderr')])
  const d = await read(different)
  assert.equal(d.chunks[1].text, 'ordinary diagnostic\n'); different.check()
})
await check('timeout and caller abort release observation without stopping a quiet job', async () => {
  for (const abort of [false, true]) {
    const f = fixture([]), caller = new AbortController(), timer = abort ? setTimeout(() => caller.abort(), 25) : undefined
    try {
      const r = await read(f, { timeoutMs: 100 }, { signal: caller.signal })
      assert.equal(r.status, abort ? 'cancelled' : 'timedOut')
      assert.equal(f.job.status, 'running'); f.check()
    } finally { clearTimeout(timer) }
  }
})
await check('unbroken partial output waits safely until terminal', async () => {
  const live = fixture([chunk('not done')])
  const a = await read(live, { timeoutMs: 100 })
  assert.equal(a.status, 'timedOut'); assert.equal(a.chunks.length, 0); assert.equal(a.pendingBytes, 8); live.check()
  const done = fixture([chunk('not done')], { status: 'completed' })
  const b = await read(done)
  assert.equal(b.status, 'settled'); assert.equal(b.chunks[0].text, 'not done'); done.check()
})
await check('retention/source gaps are explicit and context-incomplete text stays masked', async () => {
  for (const config of [{ earliest: 20 }, { lossy: true }]) {
    const f = fixture([chunk('unknown secret suffix\n', 'stdout', config.earliest ?? 0)], config)
    const r = await read(f)
    assert.equal(r.lossy, true); assert.equal(r.contextIncomplete, true)
    assert.equal(JSON.stringify(r).includes('unknown secret suffix'), false); f.check()
  }
})
await check('missing/removed jobs and premature close never fabricate success', async () => {
  const missing = fixture([], { missing: true })
  const m = await read(missing); assert.equal(m.status, 'unavailable'); assert.equal(JSON.stringify(m).includes('private lookup'), false); missing.check()
  for (const cfg of [{ close: true }, { fault: true }]) {
    const f = fixture([], cfg), r = await read(f)
    assert.equal(r.status, 'disconnected'); assert.equal(JSON.stringify(r).includes('private native'), false); f.check()
  }
  const removed = fixture([], { terminal: 'completed', removeWithMissingTail: true })
  const r = await read(removed); assert.equal(r.status, 'gap'); removed.check()
})
await check('oversized masking context is bounded and no raw suffix is released', async () => {
  const f = fixture([chunk('x'.repeat(2 * 1024 * 1024 + 1))])
  const r = await read(f)
  assert.equal(r.status, 'contextLimit'); assert.equal(r.chunks.length, 0)
  assert.equal(r.nextFromByte, 0); f.check()
  const repeated = 'api_key=synthetic-value\n'.repeat(10000)
  const started = performance.now(), masked = maskOutput(repeated)
  assert.equal(masked.includes(Buffer.from('synthetic-value')), false)
  assert.equal(masked.length, Buffer.byteLength(repeated))
  assert.ok(performance.now() - started < 2000, 'Many redactions must not block the Host')
})
await check('deadline covers slow opening and pre-aborted caller never accesses jobs', async () => {
  const f = fixture([]), original = f.controller.follow
  f.controller.follow = async function* (request, signal) { await delay(5000, undefined, { signal }); yield* original(request, signal) }
  const a = await read(f, { timeoutMs: 100 }); assert.equal(a.status, 'timedOut'); f.check()
  const caller = new AbortController(); caller.abort()
  const b = await read(f, {}, { signal: caller.signal })
  assert.equal(b.status, 'cancelled'); assert.equal(f.gets, 1)
})
await check('terminal details and loss state are not command-success claims', async () => {
  const f = fixture([], { status: 'completed' }); f.job.detail = 'exit code: 23'
  const r = await read(f)
  assert.equal(r.status, 'settled'); assert.equal(r.job.detail, 'exit code: 23')
  assert.equal(r.chunks.length, 0); f.check()
})
await check('foreign/unowned jobs refused before following; cursor bounds and malformed params rejected', async () => {
  for (const owner of ['foreign', '']) {
    const f = fixture([], { owner })
    await assert.rejects(() => read(f), /not owned/); f.check()
  }
  const f = fixture([chunk('a\n')])
  assert.equal((await read(f, { fromByte: 100 })).status, 'cursorAhead'); f.check()
  const unicode = fixture([chunk('測試\n')])
  await assert.rejects(() => read(unicode, { fromByte: 1 }), /UTF-8/); unicode.check()
  for (const args of [{ fromByte: -1 }, { fromByte: '0' }, { maxBytes: 0 }, { timeoutMs: 30001 }, { maxChunks: 0 }, { jobId: '' }, { path: '/never/read' }]) assert.throws(() => options(args))
})
await check('caller ownership is checked before resolving any Host job service', async () => {
  let lookups = 0
  const caps = createDshCapabilities({ get() { lookups++; return undefined } }, {
    restrictToOwner: true, sessionOwners: { ownerOf: () => ({ ownerId: 'owner' }) }, logger() {},
  })
  const before = lookups
  await assert.rejects(() => caps.callTool('dsh_follow_job_output', { sessionId: 'synthetic-session', jobId: 'synthetic-job' }, { caller: { id: 'foreign' } }), /restrictToOwner/)
  assert.equal(lookups, before)
  assert.equal(caps.tools.find(x => x.name === 'dsh_follow_job_output').annotations.readOnlyHint, true)
})
await check('actual HTTP/stdio carries live output and HTTP disconnect only closes observer', async () => {
  const temporary = await scratch('job-output'), f = fixture([chunk('visible now\n')])
  const services = { jobs: f.jobs, jobController: f.controller }
  const caps = createDshCapabilities({ get: name => services[name] }, { logger() {} })
  const gateway = new McpGateway({ serverInfo: { name: 'synthetic-job', version: '1' }, listTools: () => caps.tools, callTool: (name, args, context) => caps.callTool(name, args, context) })
  const server = createServer(createMcpHttpHandler({ gateway, authorize: req => ({ ok: req.headers.authorization === 'Bearer synthetic-output-test', status: 401 }) }))
  let client
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const url = `http://127.0.0.1:${server.address().port}/mcp`, file = join(temporary.directory, 'endpoint.json')
    await writeFile(file, JSON.stringify({ url, token: 'synthetic-output-test', profile: 'desktop' }), { mode: 0o600 })
    client = bridge(file, { cwd: temporary.directory, args: ['--expected-profile', 'desktop'] })
    const r = await client.request('tools/call', { name: 'dsh_follow_job_output', arguments: { sessionId: 'synthetic-session', jobId: 'synthetic-job' } })
    assert.equal(r.result.structuredContent.chunks[0].text, 'visible now\n')
    const caller = new AbortController()
    const request = fetch(url, { method: 'POST', headers: { authorization: 'Bearer synthetic-output-test' }, signal: caller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_follow_job_output', arguments: { sessionId: 'synthetic-session', jobId: 'synthetic-job', fromByte: 12 } } }) })
    await delay(30); caller.abort(); await assert.rejects(request, /abort/iu); await delay(30)
    f.check(); assert.ok(!client.stderr.includes('synthetic-output-test'))
  } finally {
    await client?.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await temporary.dispose()
  }
})
console.log(`PASS ${count} job output regression groups`)
