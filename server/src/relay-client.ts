/**
 * [shell] Multi-relay firehose client.
 *
 * - Signature accepts only firehose filters (kinds + since/until/limit). A `#p`
 *   filter is refused at runtime so no caller can enumerate users (L1).
 * - Queries each relay separately (isolated failures), applying NIP-11 policy:
 *   skip auth/payment relays, clamp `limit` to the relay's `max_limit`, and
 *   dedup events across relays.
 */

import { SimplePool, verifyEvent } from 'nostr-tools'
import type { NostrEvent } from 'kkachi/protocol'
import { createRelayInfoCache, type RelayInfoCache } from './relay-info.ts'

export type FirehoseFilter = {
  kinds: number[]
  since: number
  until?: number
  limit?: number
}

export type RelayClient = {
  querySync(relays: string[], filter: FirehoseFilter): Promise<NostrEvent[]>
}

export function assertFirehose(filter: FirehoseFilter): void {
  if (Object.prototype.hasOwnProperty.call(filter, '#p')) {
    throw new Error('relay client refuses #p filters (firehose only)')
  }
  if (!Array.isArray(filter.kinds) || filter.kinds.length === 0) {
    throw new Error('firehose filter requires kinds')
  }
}

export function clampLimit(limit?: number, max?: number): number | undefined {
  if (limit === undefined) return max
  if (max === undefined) return limit
  return Math.min(limit, max)
}

export function createRelayClient(
  pool: SimplePool = new SimplePool(),
  opts: {
    timeoutMs?: number
    relayInfo?: RelayInfoCache
    onRelayError?: (relay: string, err: unknown) => void
  } = {},
): RelayClient & {
  close(): void
} {
  const maxWait = opts.timeoutMs ?? 10_000
  const relayInfo = opts.relayInfo ?? createRelayInfoCache()

  return {
    async querySync(relays, filter) {
      assertFirehose(filter)
      const byId = new Map<string, NostrEvent>()

      await Promise.all(
        relays.map(async (relay) => {
          const policy = await relayInfo.policyFor(relay)
          if (policy.authRequired || policy.paymentRequired) return

          const perRelay: FirehoseFilter = { ...filter }
          const limit = clampLimit(filter.limit, policy.maxLimit)
          if (limit !== undefined) perRelay.limit = limit

          try {
            const events = await pool.querySync([relay], perRelay, { maxWait })
            for (const event of events) {
              if (event.id && !byId.has(event.id) && verifyEvent(event)) {
                byId.set(event.id, event as unknown as NostrEvent)
              }
            }
          } catch (err) {
            opts.onRelayError?.(relay, err)
          }
        }),
      )

      return [...byId.values()]
    },
    close() {
      pool.close([])
    },
  }
}
