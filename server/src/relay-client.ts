/**
 * [shell] Multi-relay firehose client.
 *
 * The signature deliberately accepts only firehose filters (kinds + since).
 * A `#p` filter is refused at runtime so no caller can ever create a per-user
 * REQ that would enumerate users to a hostile relay (architecture L1).
 */

import { SimplePool, verifyEvent } from 'nostr-tools'
import type { NostrEvent } from 'kkachi/protocol'

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

export function createRelayClient(
  pool: SimplePool = new SimplePool(),
  opts: { timeoutMs?: number } = {},
): RelayClient & {
  close(): void
} {
  const maxWait = opts.timeoutMs ?? 10_000
  return {
    async querySync(relays, filter) {
      assertFirehose(filter)
      // maxWait bounds a slow/hung relay so one bad relay can't stall the tick.
      const events = await pool.querySync(relays, filter, { maxWait })
      return events.filter((ev) => verifyEvent(ev)) as unknown as NostrEvent[]
    },
    close() {
      pool.close([])
    },
  }
}
