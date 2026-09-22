/**
 * [pure] Kkachi server core. No I/O, no clock, no SDK. Same input -> same
 * output. Shell code (poller.ts, server.ts) only combines these.
 */

import {
  GIFT_WRAP_KIND,
  HTTP_AUTH_KIND,
  isInboxPub,
  type InboxPub,
  type NostrEvent,
} from 'kkachi/protocol'

/** Longest jitter offset applied to a base poll interval. */
export const DEFAULT_POLL_BASE_MS = 60_000
export const DEFAULT_POLL_SPREAD_MS = 15_000
export const DEFAULT_MAX_P_TAGS = 10
export const DEFAULT_AUTH_MAX_SKEW_SEC = 60

/** Collect the values of every `p` tag on an event. */
export function pTags(ev: NostrEvent): string[] {
  const out: string[] = []
  for (const tag of ev.tags) {
    if (tag[0] === 'p' && typeof tag[1] === 'string') out.push(tag[1])
  }
  return out
}

/** A hostile relay can attach unbounded tags; reject the event outright. */
export function withinMaxPTags(ev: NostrEvent, max: number = DEFAULT_MAX_P_TAGS): boolean {
  let count = 0
  for (const tag of ev.tags) {
    if (tag[0] === 'p') {
      count += 1
      if (count > max) return false
    }
  }
  return true
}

/** Return the active inboxPub this event addresses, or null if none. */
export function matchInbox(
  activeInboxPubSet: ReadonlySet<InboxPub>,
  event: NostrEvent,
): InboxPub | null {
  for (const tag of event.tags) {
    if (tag[0] !== 'p') continue
    const value = tag[1]
    if (typeof value === 'string' && isInboxPub(value) && activeInboxPubSet.has(value)) {
      return value
    }
  }
  return null
}

/** One push per target per window. */
export function aggregate<T>(hits: T[]): T[] {
  return [...new Set(hits)]
}

export type BucketPolicy = {
  /** Burst size. */
  capacity: number
  /** Steady-state refill rate. */
  refillPerSec: number
}

export type TokenBucket = {
  tokens: number
  updatedAt: number
}

/**
 * Pure token bucket. Returns whether one token was available and the updated
 * bucket. Used for both outbound push limiting (per target) and inbound API
 * limiting (per signer).
 */
export function consumeToken(
  bucket: TokenBucket | undefined,
  policy: BucketPolicy,
  nowMs: number,
): { allowed: boolean; bucket: TokenBucket } {
  const current = bucket ?? { tokens: policy.capacity, updatedAt: nowMs }
  const elapsedSec = Math.max(0, nowMs - current.updatedAt) / 1000
  const refilled = Math.min(policy.capacity, current.tokens + elapsedSec * policy.refillPerSec)
  const allowed = refilled >= 1
  return {
    allowed,
    bucket: { tokens: allowed ? refilled - 1 : refilled, updatedAt: nowMs },
  }
}

/**
 * base +/- spread from a uniform random r in [0, 1).
 */
export function jitter(
  r: number,
  base: number = DEFAULT_POLL_BASE_MS,
  spread: number = DEFAULT_POLL_SPREAD_MS,
): number {
  return base + (r * 2 - 1) * spread
}

export type Nip98Claim = {
  url: string
  method: string
  payloadHash?: string
}

export type CheckResult = { ok: true } | { ok: false; reason: string }

/**
 * Pure NIP-98 claim checks (kind, freshness, u/method/payload tags). The
 * signature itself is verified by the shell with nostr-tools.
 */
export function checkNip98(
  ev: NostrEvent,
  claim: Nip98Claim,
  nowSec: number,
  maxSkewSec: number = DEFAULT_AUTH_MAX_SKEW_SEC,
): CheckResult {
  if (ev.kind !== HTTP_AUTH_KIND) return { ok: false, reason: 'wrong kind' }
  if (!Number.isFinite(ev.created_at)) return { ok: false, reason: 'bad created_at' }
  if (Math.abs(nowSec - ev.created_at) > maxSkewSec) return { ok: false, reason: 'stale' }

  const tag = (name: string) => ev.tags.find((t) => t[0] === name)?.[1]
  if (tag('u') !== claim.url) return { ok: false, reason: 'url mismatch' }
  if ((tag('method') ?? '').toUpperCase() !== claim.method.toUpperCase()) {
    return { ok: false, reason: 'method mismatch' }
  }
  if (claim.payloadHash !== undefined && tag('payload') !== claim.payloadHash) {
    return { ok: false, reason: 'payload hash mismatch' }
  }
  return { ok: true }
}

/** Server only ever reads gift-wrap events. */
export function isGiftWrap(ev: NostrEvent): boolean {
  return ev.kind === GIFT_WRAP_KIND
}

export type PageDecision = { done: true } | { done: false; until: number }

/** Decide whether to fetch another page for one relay, and the next `until`. */
export function nextPage(input: {
  batch: NostrEvent[]
  effectiveLimit: number
  since: number
  until: number
}): PageDecision {

  const { batch, effectiveLimit, since, until } = input

  //guard
  if (effectiveLimit <= 0) return { done: true }

  // 값이 0이면 이미 검색 끝
  if (batch.length === 0) return { done: true }
  // effectiveLimit 보다 작으면 더 없다는 뜻
  if (batch.length < effectiveLimit) return { done: true }

  var oldest = Infinity
  // 배열은 최신순임.
  for (const ev of batch) {
    if (ev.created_at < oldest) oldest = ev.created_at
  }

  if (oldest <= since) return { done: true }

  // relay ignored the cursor -> stop
  if (oldest > until) return {done: true}
  return { done: false, until: oldest - 1 }
}
