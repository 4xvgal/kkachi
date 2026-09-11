import { beforeEach, describe, expect, test } from 'bun:test'
import { finalizeEvent } from 'nostr-tools'
import {
  buildSubscribeReq,
  HTTP_AUTH_KIND,
  isInboxPub,
  type InboxPub,
  type PushMaterial,
} from 'kkachi/protocol'
import { createInboxSigner, nip98Header } from 'kkachi/register'
import { deriveInboxPub } from 'kkachi/inbox-key'
import { createRequestHandler } from '../src/server.ts'
import { createMemoryStore, type Store } from '../src/store.ts'
import { createRateLimiter } from '../src/rate-limit.ts'
import type { Config } from '../src/config.ts'

const seed = new Uint8Array(32).map((_, i) => (i * 7) % 256)
const OTHER = ('9'.repeat(64)) as InboxPub
const SUB_URL = 'http://localhost/push/subscribe'
const UNSUB_URL = 'http://localhost/push/unsubscribe'

const PUSH: PushMaterial = {
  endpoint: 'https://push.example/abc',
  keys: { p256dh: 'BP', auth: 'AU' },
}
const PUSH_OTHER: PushMaterial = {
  endpoint: 'https://other.example/xyz',
  keys: { p256dh: 'X', auth: 'Y' },
}

function config(): Config {
  return {
    port: 0,
    relays: ['ws://relay.test'],
    vapid: { publicKey: 'p', privateKey: 's', subject: 'mailto:x@y' },
    pollBaseMs: 60_000,
    pollSpreadMs: 15_000,
    pollLookbackSec: 2 * 24 * 60 * 60,
    pollLimit: 500,
    pollMaxPages: 10,
    relayTimeoutMs: 10_000,
    maxPTags: 10,
    authMaxSkewSec: 60,
    pushRateBurst: 5,
    pushRateRefillPerMin: 5,
    apiRateBurst: 10,
    apiRateRefillPerMin: 10,
    maxSubs: 10_000,
  }
}

let store: Store
let handle: (req: Request) => Promise<Response>

beforeEach(() => {
  store = createMemoryStore()
  handle = createRequestHandler({ store, config: config() })
})

function post(
  handler: (req: Request) => Promise<Response>,
  opts: { body?: string; header?: string; url?: string } = {},
): Promise<Response> {
  const { body, header, url = SUB_URL } = opts
  return handler(
    new Request(url, {
      method: 'POST',
      headers: header ? { authorization: header } : {},
      body,
    }),
  )
}

async function signBody(
  inboxPub: InboxPub,
  push: PushMaterial = PUSH,
  relays?: string[],
  epoch = '2026-09',
): Promise<{ body: string; header: string }> {
  const signer = await createInboxSigner(seed, epoch)
  const body = JSON.stringify(buildSubscribeReq(inboxPub, push, relays))
  const header = await nip98Header(signer, SUB_URL, 'POST', body)
  return { body, header }
}

function toBase64(json: string): string {
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

async function staleAuth(): Promise<{ body: string; header: string }> {
  const signer = await createInboxSigner(seed, '2026-09')
  const body = JSON.stringify(buildSubscribeReq(signer.inboxPub, PUSH))
  const event = finalizeEvent(
    {
      kind: HTTP_AUTH_KIND,
      created_at: 1,
      tags: [['u', SUB_URL], ['method', 'POST']],
      content: '',
    },
    signer.secretKey,
  )
  return { body, header: `Nostr ${toBase64(JSON.stringify(event))}` }
}

async function forgedAuth(): Promise<{ body: string; header: string }> {
  const inbox = await deriveInboxPub(seed, '2026-09')
  const { body, header } = await signBody(inbox)
  const event = JSON.parse(atob(header.slice('Nostr '.length)))
  event.sig = '0'.repeat(128)
  return { body, header: `Nostr ${toBase64(JSON.stringify(event))}` }
}

describe('GET /healthz', () => {
  test('reports ok and record count without auth', async () => {
    const res = await handle(new Request('http://localhost/healthz'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, v: 1, records: 0 })
  })
})

describe('POST /push/subscribe — success', () => {
  test('registers a NIP-98 signed subscription', async () => {
    const inbox = await deriveInboxPub(seed, '2026-09')
    const { body, header } = await signBody(inbox)
    const res = await post(handle, { body, header })
    expect(res.status).toBe(200)
    expect(await store.countSubs()).toBe(1)
    expect(isInboxPub(inbox)).toBe(true)
    expect((await store.getSub(inbox))?.push).toEqual(PUSH)
  })

  test('stores per-subscriber inbox relays', async () => {
    const inbox = await deriveInboxPub(seed, '2026-09')
    const { body, header } = await signBody(inbox, PUSH, ['wss://inbox.example'])
    expect((await post(handle, { body, header })).status).toBe(200)
    expect((await store.getSub(inbox))?.relays).toEqual(['wss://inbox.example'])
  })
})

describe('POST /push/subscribe — rejections', () => {
  const cases: Array<{ name: string; status: number; make: () => Promise<{ body?: string; header?: string }> }> = [
    {
      name: 'signer != filter #p',
      status: 400,
      make: () => signBody(OTHER),
    },
    {
      name: 'private/loopback relay url (SSRF)',
      status: 400,
      make: async () => signBody(await deriveInboxPub(seed, '2026-09'), PUSH, ['ws://127.0.0.1/relay']),
    },
    {
      name: 'tampered body (payload hash mismatch)',
      status: 401,
      make: async () => {
        const { body, header } = await signBody(await deriveInboxPub(seed, '2026-09'))
        return { body: JSON.stringify({ ...JSON.parse(body), push: PUSH_OTHER }), header }
      },
    },
    { name: 'stale NIP-98 event', status: 401, make: staleAuth },
    { name: 'forged signature', status: 401, make: forgedAuth },
    {
      name: 'malformed authorization header',
      status: 401,
      make: async () => ({ body: '{}', header: 'Bearer abc' }),
    },
    {
      name: 'invalid subscribe body',
      status: 400,
      make: async () => {
        const body = JSON.stringify({ nope: true })
        const header = await nip98Header(await createInboxSigner(seed, '2026-09'), SUB_URL, 'POST', body)
        return { body, header }
      },
    },
  ]

  test('rejects invalid/unsafe requests with the expected status', async () => {
    for (const c of cases) {
      const { body, header } = await c.make()
      const res = await post(handle, { body, header })
      expect(res.status, c.name).toBe(c.status)
    }
  })

  test('GET is not routed', async () => {
    expect((await handle(new Request(SUB_URL))).status).toBe(404)
  })
})

describe('POST /push/subscribe — limits', () => {
  test('rate limits a signer (server self-protection)', async () => {
    const limited = createRequestHandler({
      store,
      config: config(),
      apiLimiter: createRateLimiter({ capacity: 2, refillPerSec: 0 }),
    })
    const { body, header } = await signBody(await deriveInboxPub(seed, '2026-09'))
    expect((await post(limited, { body, header })).status).toBe(200)
    expect((await post(limited, { body, header })).status).toBe(200)
    expect((await post(limited, { body, header })).status).toBe(429)
  })

  test('rejects new signer when subscription capacity is reached', async () => {
    const capped = createRequestHandler({ store, config: config(), maxSubs: 1 })
    const first = await signBody(await deriveInboxPub(seed, '2026-09'), PUSH, undefined, '2026-09')
    const second = await signBody(await deriveInboxPub(seed, '2026-10'), PUSH, undefined, '2026-10')
    expect((await post(capped, first)).status).toBe(200)
    expect((await post(capped, second)).status).toBe(503)
  })
})

describe('POST /push/unsubscribe', () => {
  test('removes the record for the signer', async () => {
    const inbox = await deriveInboxPub(seed, '2026-09')
    const { body, header } = await signBody(inbox)
    await post(handle, { body, header })
    expect(await store.countSubs()).toBe(1)

    const signer = await createInboxSigner(seed, '2026-09')
    const auth = await nip98Header(signer, UNSUB_URL, 'POST')
    const res = await post(handle, { header: auth, url: UNSUB_URL })
    expect(res.status).toBe(200)
    expect(await store.countSubs()).toBe(0)
  })
})
