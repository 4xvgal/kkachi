import { describe, expect, test } from 'bun:test'
import { assertFirehose, createRelayClient, type FirehoseFilter } from '../src/relay-client.ts'

describe('firehose guard (L1: no user enumeration)', () => {
  test('accepts a kinds+since filter', () => {
    expect(() => assertFirehose({ kinds: [1059], since: 0 })).not.toThrow()
  })

  test('refuses any #p filter', () => {
    const leaky = { kinds: [1059], since: 0, '#p': ['a'.repeat(64)] } as unknown as FirehoseFilter
    expect(() => assertFirehose(leaky)).toThrow(/#p/)
  })

  test('querySync refuses #p without touching the pool', async () => {
    let called = false
    const pool = {
      querySync: async () => {
        called = true
        return []
      },
      close: () => {},
    }
    const client = createRelayClient(pool as never)
    const leaky = { kinds: [1059], since: 0, '#p': ['a'.repeat(64)] } as unknown as FirehoseFilter
    await expect(client.querySync(['ws://r'], leaky)).rejects.toThrow(/#p/)
    expect(called).toBe(false)
  })

  test('requires kinds', () => {
    expect(() => assertFirehose({ kinds: [], since: 0 })).toThrow()
  })

  test('passes maxWait so a hung relay cannot stall the tick', async () => {
    let seen: unknown
    const pool = {
      querySync: async (_relays: string[], _filter: unknown, opts: unknown) => {
        seen = opts
        return []
      },
      close: () => {},
    }
    const client = createRelayClient(pool as never, { timeoutMs: 1234 })
    await client.querySync(['ws://r'], { kinds: [1059], since: 0 })
    expect(seen).toEqual({ maxWait: 1234 })
  })
})
