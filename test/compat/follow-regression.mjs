import assert from 'node:assert/strict'
import { createDshCapabilities } from '../../lib/dsh-capabilities.js'
import { scratch } from './support.mjs'

const temporary = await scratch('follow')
function fixture(kind) {
  let request
  const controller = {
    async create({ sessionId }) { return { sessionId } },
    async prompt(value) { request = value; return { accepted: true } },
    async *follow(_value, signal) {
      const user = { seq: 3, type: 'user/message', data: { source: { kind: 'user', rpcId: request.requestId }, content: request.content } }
      const reply = { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'own reply' }] } } }
      const end = { seq: 5, type: 'turn/end', data: { reason: { kind: 'completed' } } }
      if (kind === 'snapshot') {
        yield { type: 'snapshot', records: [user, reply, end].map(event => ({ type: 'event', event })) }
        throw new Error('Snapshot completion must stop before the next frame')
      }
      if (kind === 'queue') {
        yield { type: 'event', event: { ...reply, seq: 1, data: { message: { content: [{ type: 'text', text: 'previous reply' }] } } } }
        yield { type: 'event', event: { ...end, seq: 2 } }
        for (const event of [user, reply, end]) yield { type: 'event', event }
        return
      }
      yield { type: 'snapshot', records: [] }
      if (kind === 'premature') return
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      // The real controller may finish the iterator normally after abort.
    },
  }
  return createDshCapabilities({ get: name => name === 'sessionController' ? controller : undefined }, {
    logger() {}, groupSessions: false, turnTimeoutMs: 1000, startedAt: Date.now(),
  })
}
try {
  for (const kind of ['snapshot', 'queue']) {
    const result = await fixture(kind).callTool('dsh_run_prompt', { prompt: 'own prompt', cwd: temporary.directory, timeoutMs: 1000 }, {})
    assert.equal(result.structuredContent.status, 'completed')
    assert.equal(result.structuredContent.text, 'own reply')
    console.log(`PASS ${kind}: matching prompt completes, including snapshot turn/end`)
  }
  const keepAlive = setInterval(() => {}, 500)
  try {
    const result = await fixture('abort').callTool('dsh_run_prompt', { prompt: 'own prompt', cwd: temporary.directory, timeoutMs: 1000 }, {})
    assert.equal(result.structuredContent.status, 'timeout')
    console.log('PASS normal iterator return after abort is timeout, never false completed')
  } finally { clearInterval(keepAlive) }
  await assert.rejects(() => fixture('premature').callTool('dsh_run_prompt', { prompt: 'own prompt', cwd: temporary.directory }, {}), /completion is unconfirmed/)
  console.log('PASS premature stream close never reports completion')
} finally { await temporary.dispose() }
