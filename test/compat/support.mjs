import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

export const repository = resolve(import.meta.dirname, '../..')

// Require an explicit, existing output root. Never discover the user's real DSH home.
export async function scratch(prefix) {
  const root = process.env.DSH_MCP_TEST_ROOT
  assert.ok(root && isAbsolute(root), 'Set DSH_MCP_TEST_ROOT to an existing absolute scratch directory')
  const directory = await mkdtemp(join(await realpath(root), prefix + '-'))
  return { directory, dispose: () => rm(directory, { recursive: true, force: true }) }
}

export function bridge(endpointFile, { env = {}, args = [], cwd } = {}) {
  const child = spawn(process.execPath, [join(repository, 'bin/dsh-mcp-stdio.mjs'),
    '--endpoint-file', endpointFile, '--client', 'synthetic-compat-test', ...args], {
    cwd, env: { PATH: '/usr/bin:/bin', ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = '', stderr = '', next = 0
  const pending = new Map()
  child.stdout.on('data', data => {
    buffer += data
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const reply = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      pending.get(reply.id)?.resolve(reply); pending.delete(reply.id)
    }
  })
  child.stderr.on('data', data => { stderr += data })
  child.on('error', error => { for (const item of pending.values()) item.reject(error) })
  child.on('exit', () => { for (const item of pending.values()) item.reject(new Error('Bridge exited before reply')) })
  return {
    request(method = 'ping', params = {}) {
      const id = ++next
      let timer
      return new Promise((resolve, reject) => {
        timer = setTimeout(() => { pending.delete(id); reject(new Error('Bridge reply timed out')) }, 5000)
        pending.set(id, { resolve, reject })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      }).finally(() => clearTimeout(timer))
    },
    get stderr() { return stderr },
    async dispose() {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise(resolve => child.once('exit', resolve))
      child.stdin.end(); child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
      try { await exited } finally { clearTimeout(timer) }
    },
  }
}
