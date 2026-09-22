/**
 * [shell] Multi-relay firehose client: firehose-only (never `#p`, L1), per-relay
 * NIP-11 policy + pagination, isolated failures, merged/deduped results.
 */

import { SimplePool, verifyEvent } from 'nostr-tools'
import type { NostrEvent } from 'kkachi/protocol'
import { nextPage } from './core.ts'
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

export type RelayStat = {
  relay: string
  pages: number
  events: number
  done: boolean
  error?: string
}

export type RelayClientOptions = {
  timeoutMs?: number
  /** Max pages per relay. */
  maxPages?: number
  /** Global cap on collected events across all relays. */
  maxEvents?: number
  relayInfo?: RelayInfoCache
  onRelayError?: (relay: string, err: unknown) => void
  onRelayStat?: (stat: RelayStat) => void
}

const DEFAULT_LIMIT = 500

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
  opts: RelayClientOptions = {},
): RelayClient & {
  close(): void
} {
  const maxWait = opts.timeoutMs ?? 10_000
  const maxPages = opts.maxPages ?? 10
  const maxEvents = opts.maxEvents ?? Number.POSITIVE_INFINITY
  const relayInfo = opts.relayInfo ?? createRelayInfoCache()

  return {
    async querySync(relays, filter) {
      assertFirehose(filter)
      const byId = new Map<string, NostrEvent>()
      const upperBound = filter.until ?? Math.floor(Date.now() / 1000)

      await Promise.all(
        relays.map(async (relay) => {
          const policy = await relayInfo.policyFor(relay)
          if (policy.authRequired || policy.paymentRequired) {
            opts.onRelayStat?.({ relay, pages: 0, events: 0, done: true })
            return
          }

          const effectiveLimit = clampLimit(filter.limit, policy.maxLimit) ?? DEFAULT_LIMIT
          let until = upperBound
          let pages = 0
          let count = 0

          try {
            for (let page = 0; page < maxPages; page++) {
              const pageFilter: FirehoseFilter = { ...filter, limit: effectiveLimit, until }
              const batch = await pool.querySync([relay], pageFilter, { maxWait })
              pages += 1

              for (const event of batch) {
                if (event.id && !byId.has(event.id) && verifyEvent(event)) {
                  byId.set(event.id, event as unknown as NostrEvent)
                  count += 1
                }
              }

              if (byId.size >= maxEvents) {
                opts.onRelayStat?.({ relay, pages, events: count, done: false })
                return
              }

              const decision = nextPage({
                batch: batch as unknown as NostrEvent[],
                effectiveLimit,
                since: filter.since,
                until,
              })
              if (decision.done) {
                opts.onRelayStat?.({ relay, pages, events: count, done: true })
                return
              }
              until = decision.until
            }
            opts.onRelayStat?.({ relay, pages, events: count, done: false })
          } catch (err) {
            opts.onRelayError?.(relay, err)
            opts.onRelayStat?.({ relay, pages, events: count, done: false, error: String(err) })
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
