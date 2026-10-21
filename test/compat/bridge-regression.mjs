import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { bridge, scratch } from './support.mjs'

const temporary = await scratch('bridge'), file = join(temporary.directory, 'endpoint.json')
let token = randomUUID(), hits = 0, redirected = 0
const server = createServer(async (req, res) => {
  if (req.url === '/sink') { redirected++; res.writeHead(500); res.end(); return }
  hits++
  assert.equal(req.headers.authorization, `Bearer ${token}`)
  if (req.url === '/redirect') { res.writeHead(302, { location: '/sink' }); res.end(); return }
  let body = ''; for await (const chunk of req) body += chunk
  const message = JSON.parse(body)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { accepted: true } }))
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const url = `http://127.0.0.1:${server.address().port}/mcp`
async function publish(value) {
  await writeFile(file + '.new', JSON.stringify(value), { mode: 0o600 })
  await rename(file + '.new', file)
}
async function refused(value, options = {}) {
  await publish(value)
  const client = bridge(file, { cwd: temporary.directory, args: ['--expected-profile', 'desktop'], ...options })
  const before = hits
  try {
    const reply = await client.request()
    assert.equal(reply.error.code, -32000)
    assert.equal(hits, before, 'Rejected configuration must not send HTTP')
    assert.ok(!client.stderr.includes(token))
  } finally { await client.dispose() }
}
try {
  await refused({ url, token, profile: 'web' }); console.log('PASS Web profile rejected before transport')
  await refused({ url, token }); console.log('PASS missing profile rejected before transport')
  await refused({ url, token, profile: 'desktop' }, { env: { DSH_MCP_URL: url, DSH_MCP_TOKEN: token } })
  console.log('PASS environment override without profile cannot bypass Desktop binding')
  for (const value of [{ url, profile: 'desktop' }, { url: 'not a URL', token, profile: 'desktop' },
    { url: 'https://example.invalid/mcp', token, profile: 'desktop' }, { url: url + '?credential=no', token, profile: 'desktop' }]) await refused(value)
  console.log('PASS incomplete, invalid, nonloopback and query-bearing discovery rejected')
  await publish({ url, token, profile: 'desktop' })
  const client = bridge(file, { cwd: temporary.directory, args: ['--expected-profile', 'desktop'] })
  try {
    assert.equal((await client.request()).result.accepted, true)
    token = randomUUID(); await publish({ url, token, profile: 'desktop' })
    assert.equal((await client.request()).result.accepted, true)
    assert.ok(!client.stderr.includes(token))
    console.log('PASS same bridge rereads rotated discovery credentials')
    await publish({ url: url.replace('/mcp', '/redirect'), token, profile: 'desktop' })
    assert.equal((await client.request()).error.code, -32000)
    assert.equal(redirected, 0)
    console.log('PASS authenticated transport refuses redirects')
  } finally { await client.dispose() }
} finally {
  await new Promise(resolve => server.close(resolve))
  await temporary.dispose()
}
