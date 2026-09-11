/**
 * [shell] Bounded in-memory rate limiter over the pure token bucket.
 *
 * Single-instance state. For multi-instance deployments this must move into the
 * Store (shared counters); noted as a known limitation, not yet needed.
 */

import { consumeToken, type BucketPolicy, type TokenBucket } from './core.ts'

const SWEEP_THRESHOLD = 10_000

export type RateLimiter<K> = {
  tryConsume(key: K, at?: number): boolean
  delete(key: K): void
  size(): number
}

export function createRateLimiter<K>(
  policy: BucketPolicy,
  now: () => number = () => Date.now(),
): RateLimiter<K> {
  const buckets = new Map<K, TokenBucket>()

  function sweep(at: number): void {
    const idleMs =
      policy.refillPerSec > 0 ? (policy.capacity / policy.refillPerSec) * 1000 * 2 : Infinity
    for (const [key, bucket] of buckets) {
      const refilled = Math.min(
        policy.capacity,
        bucket.tokens + ((at - bucket.updatedAt) / 1000) * policy.refillPerSec,
      )
      if (refilled >= policy.capacity && at - bucket.updatedAt > idleMs) buckets.delete(key)
    }
  }

  return {
    tryConsume(key, at = now()) {
      const { allowed, bucket } = consumeToken(buckets.get(key), policy, at)
      buckets.set(key, bucket)
      if (buckets.size > SWEEP_THRESHOLD) sweep(at)
      return allowed
    },
    delete(key) {
      buckets.delete(key)
    },
    size() {
      return buckets.size
    },
  }
}
