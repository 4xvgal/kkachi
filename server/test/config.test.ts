import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../src/config.ts'

describe('loadConfig (.env driven)', () => {
  test('reads port, domain, relays, polling and store from env', () => {
    const c = loadConfig({
      PORT: '9999',
      PUBLIC_URL: 'https://push.example',
      RELAYS: 'ws://a.example, ws://b.example',
      RELAY_TIMEOUT_MS: '1234',
      POLL_LOOKBACK_SEC: '200000',
      POLL_LIMIT: '50',
      POLL_MAX_PAGES: '3',
      MAX_SUBS: '5',
      DATABASE_URL: 'sqlite::memory:',
      CORS_ORIGIN: 'https://a.example, https://b.example',
    })
    expect(c.port).toBe(9999)
    expect(c.publicUrl).toBe('https://push.example')
    expect(c.relays).toEqual(['ws://a.example', 'ws://b.example'])
    expect(c.relayTimeoutMs).toBe(1234)
    expect(c.pollLookbackSec).toBe(200000)
    expect(c.pollLimit).toBe(50)
    expect(c.pollMaxPages).toBe(3)
    expect(c.maxSubs).toBe(5)
    expect(c.databaseUrl).toBe('sqlite::memory:')
    expect(c.corsOrigins).toEqual(['https://a.example', 'https://b.example'])
  })

  test('caps poll spread at base (no negative jitter)', () => {
    const c = loadConfig({ POLL_BASE_MS: '5000', POLL_SPREAD_MS: '15000' })
    expect(c.pollBaseMs).toBe(5000)
    expect(c.pollSpreadMs).toBe(5000)
  })

  test('applies defaults when env is empty', () => {
    const c = loadConfig({})
    expect(c.port).toBe(8787)
    expect(c.publicUrl).toBeUndefined()
    expect(c.relays).toEqual(['ws://localhost:4444/relay'])
    expect(c.relayTimeoutMs).toBe(10_000)
    expect(c.pollLookbackSec).toBe(2 * 24 * 60 * 60 + 3600)
    expect(c.pollLimit).toBe(500)
    expect(c.pollMaxPages).toBe(10)
    expect(c.maxSubs).toBe(10_000)
    expect(c.databaseUrl).toBeUndefined()
    expect(c.corsOrigins).toEqual([])
  })
})
