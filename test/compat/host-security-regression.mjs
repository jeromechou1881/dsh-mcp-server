import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile, stat, access } from 'node:fs/promises'
import { join } from 'node:path'
import { apply } from '../../index.js'
import { scratch } from './support.mjs'

const temporary = await scratch('host'), routes = new Map(), disposers = []
const endpointFile = join(temporary.directory, 'endpoint.json')
const anchor = join(temporary.directory, 'runtime-package.json')
await writeFile(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' }))
let created = 0, permissionWrites = 0, prompted = 0
const services = {
  profileContext: { name: 'desktop', installAnchor: anchor },
  agentDefaultModel: { currentSelection: () => ({ provider: 'synthetic', model: 'fixture', reasoningEffort: 'max' }) },
  connection: { requestRejection: ({ headers }) => headers.cookie === 'synthetic-browser-cookie' ? undefined : { status: 401 } },
  sessions: { get: () => ({ header: { id: 'synthetic-live', cwd: temporary.directory } }) },
  permissionPresets: {
    current: () => 'read-only',
    resolve: name => ({ sandbox: ['read-only', 'workspace-write', 'danger-full-access'].includes(name) ? name : undefined }),
    set: () => { permissionWrites++ },
    catalog: () => ({ defaultPreset: 'workspace-write', options: [] }),
  },
  sessionController: {
    create: () => { created++; return { sessionId: 'synthetic-created' } },
    prompt: () => { prompted++; return { accepted: true } },
    list: () => ({ items: [] }),
  },
}
const server = createServer((req, res) => {
  const handler = routes.get(new URL(req.url, 'http://localhost').pathname)
  if (handler) void handler(req, res)
  else { res.writeHead(404); res.end() }
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const origin = `http://127.0.0.1:${server.address().port}`
services.webServer = { host: '127.0.0.1', port: server.address().port, register: route => {
  routes.set(route.path, route.handler); return () => routes.delete(route.path)
} }
const ctx = {
  ...services, get: name => services[name], on: () => () => {},
  logger: () => ({ info() {}, debug() {}, warn() {}, error() {} }),
  effect: create => { const dispose = create(); disposers.push(dispose); return dispose },
  inject: (names, callback) => { if (names.every(name => services[name] !== undefined)) callback(ctx) },
}
try {
  apply(ctx, { dshHome: temporary.directory, endpointFile, exposeToDsh: false, exposeToDshPage: true,
    allowConnectionAuth: false, answerUserRequests: false, syncOnStart: false, groupSessions: false,
    createGroups: false, restrictToOwner: true, loopbackOnly: true, requireConfigAuth: true,
    maxPermissionPreset: 'workspace-write' })
  const endpoint = JSON.parse(await readFile(endpointFile, 'utf8'))
  assert.equal(endpoint.profile, 'desktop')
  assert.equal((await stat(endpointFile)).mode & 0o777, 0o600)
  console.log('PASS atomic endpoint is private and records actual Desktop profile')
  let id = 0
  const rpc = async (name, args = {}) => {
    const response = await fetch(origin + '/mcp', { method: 'POST', headers: {
      authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json', 'x-dsh-mcp-client': 'synthetic-compat-test',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) })
    return (await response.json()).result
  }
  const status = (await rpc('dsh_status')).structuredContent
  assert.equal(status.dshVersion, '0.2.1-rc.2')
  assert.equal(status.profile, 'desktop')
  assert.deepEqual(status.defaultModel, { provider: 'synthetic', model: 'fixture', reasoningEffort: 'max' })
  console.log('PASS runtime version/profile and default Max reasoning survive plugin apply')
  assert.equal((await fetch(origin + '/mcp', { method: 'POST', body: '{}' })).status, 401)
  assert.equal((await fetch(origin + '/mcp', { method: 'POST', headers: { cookie: 'synthetic-browser-cookie' }, body: '{}' })).status, 401)
  assert.equal((await fetch(origin + '/mcp-config')).status, 401)
  assert.equal((await fetch(origin + '/mcp-config', { headers: { cookie: 'synthetic-browser-cookie' } })).status, 200)
  console.log('PASS MCP requires Bearer while config accepts normal authenticated browser access')
  assert.equal((await fetch(origin + '/mcp-config', { method: 'POST', headers: {
    authorization: `Bearer ${endpoint.token}`, origin: 'https://untrusted.invalid', 'content-type': 'application/json',
  }, body: '{"exposeToDsh":true}' })).status, 403)
  assert.equal((await fetch(origin + '/mcp-config', { method: 'POST', headers: {
    authorization: `Bearer ${endpoint.token}`, 'content-type': 'text/plain',
  }, body: '{"exposeToDsh":true}' })).status, 415)
  console.log('PASS config refuses foreign Origin and non-JSON mutations')
  let remoteStatus
  await routes.get('/mcp')({ method: 'POST', url: '/mcp', socket: { remoteAddress: '203.0.113.1' }, headers: {
    authorization: `Bearer ${endpoint.token}`,
  } }, { writeHead: value => { remoteStatus = value }, end() {} })
  assert.equal(remoteStatus, 403)
  console.log('PASS nonloopback socket gate rejects even a valid Bearer (unit-level socket fixture)')
  for (const preset of ['danger-full-access', 'unknown-custom']) {
    const refused = await rpc('dsh_run_prompt', { prompt: 'must not be admitted', cwd: temporary.directory, permissionPreset: preset, wait: false })
    assert.equal(refused.isError, true); assert.match(refused.content[0].text, /authority ceiling/)
  }
  assert.equal(created, 0)
  const owner = await rpc('dsh_list_sessions', { owner: 'someone-else' })
  assert.equal(owner.isError, true); assert.match(owner.content[0].text, /restrictToOwner/)
  console.log('PASS excessive/unknown authority is rejected before create and owner filter cannot override restriction')
  const slash = await rpc('dsh_run_command', { sessionId: 'synthetic-live', line: '/permission danger-full-access' })
  assert.equal(slash.isError, true); assert.match(slash.content[0].text, /restricted/)
  const resumed = await rpc('dsh_continue_session', { sessionId: 'synthetic-live', prompt: 'keep lower authority', wait: false })
  assert.equal(resumed.structuredContent.status, 'started')
  assert.equal(prompted, 1); assert.equal(permissionWrites, 0)
  console.log('PASS slash escalation denied and implicit continuation preserves read-only')
} finally {
  for (const dispose of disposers.reverse()) await dispose?.()
  await new Promise(resolve => server.close(resolve))
  try { await access(endpointFile); assert.fail('Disposed endpoint must be removed') } catch (error) { if (error.code !== 'ENOENT') throw error }
  await temporary.dispose()
}
console.log('PASS dispose removes its own discovery file')
