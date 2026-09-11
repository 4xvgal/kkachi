/**
 * Relay integration runner. Starts `npx fonstr` on RELAY_PORT (default 4444),
 * waits for the relay, then runs the gated relay integration test against it.
 *
 *   bun run test:relay
 */

import { spawn, spawnSync } from 'node:child_process'

const port = Number(process.env.RELAY_PORT ?? 4444)
const relayUrl = `ws://localhost:${port}/relay`
const infoUrl = `http://localhost:${port}/relay/info`

console.log(`[relay-test] npx fonstr ${port}`)
const relay = spawn('npx', ['--yes', 'fonstr', String(port)], {
  stdio: ['ignore', 'inherit', 'inherit'],
})

async function waitReady(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (relay.exitCode !== null) throw new Error(`fonstr exited early (${relay.exitCode})`)
    try {
      const res = await fetch(infoUrl)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`relay not ready after ${timeoutMs}ms`)
}

try {
  await waitReady()
  console.log(`[relay-test] relay ready: ${relayUrl}`)
  const result = spawnSync('bun', ['test', 'server/test/relay.integration.test.ts'], {
    stdio: 'inherit',
    env: { ...process.env, RELAY_URL: relayUrl },
  })
  process.exitCode = result.status ?? 1
} finally {
  relay.kill('SIGTERM')
}
