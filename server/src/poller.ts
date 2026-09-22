/**
 * [shell] Firehose poller.
 *
 * NIP-59/17 randomize gift-wrap `created_at` up to 2 days into the past, so a
 * `since=cursor` incremental sync would miss late-arriving events. Instead every
 * tick rescans a fixed lookback window and dedups by event id via the Store.
 * The Store also retains seen ids for the whole window, keyed by *observation
 * time* (not the event's randomized/forged created_at), so a hostile relay
 * cannot make retention flap and re-push.
 */

import {
  buildPushPayload,
  GIFT_WRAP_KIND,
  isAllowedRelayUrl,
  type InboxPub,
} from 'kkachi/protocol'
import { aggregate, isGiftWrap, jitter, matchInbox, withinMaxPTags } from './core.ts'
import { createRateLimiter, type RateLimiter } from './rate-limit.ts'
import type { Config } from './config.ts'
import type { Store, StoredSub } from './store.ts'
import { PushGoneError, type PushSender } from './push-sender.ts'
import type { RelayClient } from './relay-client.ts'

export type PollerDeps = {
  store: Store
  relayClient: RelayClient
  sender: PushSender
  config: Config
  now?: () => number
  random?: () => number
  onGone?: (endpoint: string) => void
  onError?: (err: unknown) => void
  /** Per-target outbound limiter (relay-injection defense). Injectable for tests. */
  pushLimiter?: RateLimiter<string>
}

export type TickResult = {
  scanned: number
  fresh: number
  targets: number
  pushed: number
  rateLimited: number
}

export type Poller = ReturnType<typeof createPoller>

export function createPoller(deps: PollerDeps) {
  const {
    store,
    relayClient,
    sender,
    config,
    now = () => Date.now(),
    random = () => Math.random(),
    onGone,
    onError = (err) => console.error('[poller]', err),
    pushLimiter = createRateLimiter<string>(
      { capacity: config.pushRateBurst, refillPerSec: config.pushRateRefillPerMin / 60 },
      now,
    ),
  } = deps

  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false

  /**
   * Union of per-subscriber relays, falling back to the global set. Client
   * relays are accepted at registration but SSRF-filtered here, where we
   * actually connect: private/loopback endpoints are dropped (global set is
   * operator-trusted and used as-is).
   */
  function relaysFor(subs: StoredSub[]): string[] {
    const set = new Set<string>()
    for (const sub of subs) {
      const custom = (sub.relays ?? []).filter(isAllowedRelayUrl)
      const relays = custom.length > 0 ? custom : config.relays
      for (const relay of relays) set.add(relay)
    }
    return [...set]
  }

  async function tick(): Promise<TickResult> {
    const subs = await store.listSubs()
    if (subs.length === 0) return { scanned: 0, fresh: 0, targets: 0, pushed: 0, rateLimited: 0 }

    const activeInbox = new Set<InboxPub>(subs.map((s) => s.inboxPub))
    const byInbox = new Map<InboxPub, StoredSub>(subs.map((s) => [s.inboxPub, s]))
    const nowSec = Math.floor(now() / 1000)
    const since = nowSec - config.pollLookbackSec

    // Per-relay pagination and policy live in the relay client.
    const events = await relayClient.querySync(relaysFor(subs), {
      kinds: [GIFT_WRAP_KIND],
      since,
      until: nowSec,
      limit: config.pollLimit,
    })
    const usable = events.filter((ev) => isGiftWrap(ev) && withinMaxPTags(ev, config.maxPTags))

    const unseen = await store.filterUnseen(usable.map((ev) => ev.id))
    const fresh = usable.filter((ev) => unseen.has(ev.id))
    await store.markSeen(fresh.map((ev) => ({ id: ev.id, seenAt: nowSec })))
    await store.pruneSeen(since)

    const hits = fresh
      .map((ev) => matchInbox(activeInbox, ev))
      .filter((inbox): inbox is InboxPub => inbox !== null)
    const targets = aggregate(hits)

    let pushed = 0
    let rateLimited = 0
    for (const inbox of targets) {
      const sub = byInbox.get(inbox)
      if (!sub) continue
      // Relay-injection defense: cap pushes per target regardless of event count.
      if (!pushLimiter.tryConsume(inbox, now())) {
        rateLimited += 1
        continue
      }
      try {
        await sender(sub.push, JSON.stringify(buildPushPayload(sub.message)))
        pushed += 1
      } catch (err) {
        if (err instanceof PushGoneError) {
          await store.deleteSub(sub.inboxPub)
          pushLimiter.delete(inbox)
          onGone?.(err.endpoint)
        } else {
          onError(err)
        }
      }
    }

    if (pushed > 0) console.log(`[poller] pushed ${pushed}/${targets.length}`)

    return { scanned: events.length, fresh: fresh.length, targets: targets.length, pushed, rateLimited }
  }

  function schedule(): void {
    if (!running) return
    const delay = Math.max(250, jitter(random(), config.pollBaseMs, config.pollSpreadMs))
    timer = setTimeout(() => {
      void tick()
        .catch(onError)
        .finally(schedule)
    }, delay)
  }

  return {
    tick,
    start(): void {
      if (running) return
      running = true
      schedule()
    },
    stop(): void {
      running = false
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}
