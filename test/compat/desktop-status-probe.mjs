// Explicitly selected, read-only live probe. It never creates or modifies a Session.
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { bridge, scratch } from './support.mjs'

const file = process.env.DSH_MCP_DESKTOP_ENDPOINT_FILE
assert.ok(file && isAbsolute(file), 'Set DSH_MCP_DESKTOP_ENDPOINT_FILE explicitly; no default Host discovery')
const discovery = JSON.parse(await readFile(file, 'utf8'))
assert.equal(discovery.profile, 'desktop')
assert.equal((await stat(file)).mode & 0o777, 0o600)
const temporary = await scratch('desktop-status')
const client = bridge(file, { cwd: temporary.directory, args: ['--expected-profile', 'desktop'] })
try {
  const initialized = await client.request('initialize', { protocolVersion: '2024-11-05',
    capabilities: {}, clientInfo: { name: 'synthetic-compat-test', version: '1' } })
  assert.equal(initialized.result.serverInfo.name, 'dsh-mcp-server')
  const result = await client.request('tools/call', { name: 'dsh_status', arguments: {} })
  assert.ok(result.result && !result.result.isError, 'Live Desktop status unavailable')
  const status = result.result.structuredContent
  assert.equal(status.profile, 'desktop')
  assert.equal(status.dshVersion, '0.2.1-rc.2')
  assert.equal(status.toolNames.length, 21)
  assert.equal(status.dshTools.enabled, false)
  assert.equal(status.sync.enabled, false)
  assert.ok(!client.stderr.includes(discovery.token))
  console.log('PASS explicitly selected Desktop Host: 0.2.1-rc.2, 21 tools, reviewed safe surface')
} finally {
  await client.dispose()
  await temporary.dispose()
}
