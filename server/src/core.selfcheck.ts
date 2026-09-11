/**
 * Runnable self-check for the pure core. `bun run server/src/core.selfcheck.ts`.
 * No test framework.
 */

import { strict as assert } from 'node:assert'
import {
  aggregate,
  checkNip98,
  jitter,
  matchInbox,
  withinMaxPTags,
} from './core.ts'
import { GIFT_WRAP_KIND, HTTP_AUTH_KIND, type InboxPub, type NostrEvent } from 'kkachi/protocol'

function ev(partial: Partial<NostrEvent>): NostrEvent {
  return {
    id: 'id',
    pubkey: 'pk',
    created_at: 1,
    kind: GIFT_WRAP_KIND,
    tags: [],
    content: '',
    sig: 'sig',
    ...partial,
  }
}

const A = ('a'.repeat(64)) as InboxPub
const B = ('b'.repeat(64)) as InboxPub
const C = ('c'.repeat(64)) as InboxPub
const active = new Set<InboxPub>([A, B])

assert.equal(matchInbox(active, ev({ tags: [['p', C], ['p', B]] })), B)
assert.equal(matchInbox(active, ev({ tags: [['p', C]] })), null)

assert.deepEqual(aggregate(['a', 'a', 'b']), ['a', 'b'])

assert.equal(jitter(0), 45_000)
assert.equal(jitter(1), 75_000)
assert.equal(jitter(0.5), 60_000)

assert.equal(withinMaxPTags(ev({ tags: [['p', 'a'], ['p', 'b']] }), 2), true)
assert.equal(withinMaxPTags(ev({ tags: [['p', 'a'], ['p', 'b'], ['p', 'c']] }), 2), false)

const auth = ev({
  kind: HTTP_AUTH_KIND,
  created_at: 1000,
  tags: [['u', 'https://x/p'], ['method', 'POST'], ['payload', 'abc']],
})
assert.equal(checkNip98(auth, { url: 'https://x/p', method: 'POST', payloadHash: 'abc' }, 1000).ok, true)
assert.equal(checkNip98(auth, { url: 'https://x/p', method: 'POST', payloadHash: 'bad' }, 1000).ok, false)
assert.equal(checkNip98(auth, { url: 'https://y/p', method: 'POST', payloadHash: 'abc' }, 1000).ok, false)
assert.equal(checkNip98(auth, { url: 'https://x/p', method: 'POST', payloadHash: 'abc' }, 10_000).ok, false)

console.log('core.selfcheck: ok')
