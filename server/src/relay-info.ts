/**
 * [shell] Per-relay NIP-11 policy: max_limit clamp + skip relays that require
 * auth/payment (a firehose REQ can't authenticate). Cached with a TTL.
 */

import { nip11 } from 'nostr-tools'

export type RelayInfoDoc = {
  limitation?: {
    max_limit?: number
    auth_required?: boolean
    payment_required?: boolean
  }
}

export type FetchRelayInfo = (url: string) => Promise<RelayInfoDoc>

export type RelayPolicy = {
  url: string
  maxLimit?: number
  authRequired: boolean
  paymentRequired: boolean
}

export type RelayInfoCache = {
  policyFor(url: string): Promise<RelayPolicy>
  clear(): void
}

export function createRelayInfoCache(opts: {
  fetchInfo?: FetchRelayInfo
  ttlMs?: number
  now?: () => number
  onError?: (url: string, err: unknown) => void
} = {}): RelayInfoCache {
  const {
    fetchInfo = nip11.fetchRelayInformation as unknown as FetchRelayInfo,
    ttlMs = 3_600_000,
    now = () => Date.now(),
    onError,
  } = opts
  const cache = new Map<string, { at: number; policy: RelayPolicy }>()

  return {
    async policyFor(url) {
      const hit = cache.get(url)
      if (hit && now() - hit.at < ttlMs) return hit.policy

      let policy: RelayPolicy = { url, authRequired: false, paymentRequired: false }
      try {
        const info = await fetchInfo(url)
        const lim = info.limitation ?? {}
        policy = {
          url,
          maxLimit: typeof lim.max_limit === 'number' ? lim.max_limit : undefined,
          authRequired: lim.auth_required === true,
          paymentRequired: lim.payment_required === true,
        }
      } catch (err) {
        onError?.(url, err)
      }
      cache.set(url, { at: now(), policy })
      return policy
    },
    clear() {
      cache.clear()
    },
  }
}
