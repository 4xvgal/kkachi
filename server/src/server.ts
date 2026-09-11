/**
 * [shell] HTTP surface: /push/subscribe, /push/unsubscribe, /healthz.
 *
 * Authentication is NIP-98 signed by the epoch inbox key. The signer's pubkey
 * must equal the filter `#p` value and becomes the storage key. No account, no
 * npub, no IP logging.
 */

import { verifyEvent } from 'nostr-tools'
import {
  isInboxPub,
  isSubscribeReq,
  PROTOCOL_VERSION,
  sha256Hex,
  type InboxPub,
  type NostrEvent,
} from 'kkachi/protocol'
import { checkNip98, type Nip98Claim } from './core.ts'
import { createRateLimiter, type RateLimiter } from './rate-limit.ts'
import type { Config } from './config.ts'
import { createStore, type Store } from './store.ts'
import { createRelayClient } from './relay-client.ts'
import { createWebPushSender } from './push-sender.ts'
import { createPoller } from './poller.ts'
import { loadConfig } from './config.ts'

export type HandlerDeps = {
  store: Store
  config: Config
  now?: () => number
  /** Per-signer API limiter (server self-protection). Injectable for tests. */
  apiLimiter?: RateLimiter<string>
  /** Override max stored subscriptions. Defaults to config.maxSubs. */
  maxSubs?: number
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function decodeBase64(input: string): string {
  const binary = atob(input)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function isNostrEvent(value: unknown): value is NostrEvent {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.pubkey === 'string' &&
    typeof v.created_at === 'number' &&
    typeof v.kind === 'number' &&
    typeof v.sig === 'string' &&
    Array.isArray(v.tags) &&
    typeof v.content === 'string'
  )
}

function parseAuthHeader(header: string | null): NostrEvent | null {
  if (!header || !header.startsWith('Nostr ')) return null
  try {
    const parsed = JSON.parse(decodeBase64(header.slice('Nostr '.length).trim()))
    return isNostrEvent(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** NIP-98 `u` is an absolute URL; behind a proxy, rewrite to PUBLIC_URL. */
function canonicalUrl(req: Request, config: Config): string {
  const url = new URL(req.url)
  if (config.publicUrl) {
    const base = new URL(config.publicUrl)
    url.protocol = base.protocol
    url.host = base.host
  }
  return url.toString()
}

async function authenticate(
  req: Request,
  config: Config,
  nowSec: number,
  rawBody?: string,
): Promise<InboxPub | null> {
  const event = parseAuthHeader(req.headers.get('authorization'))
  if (!event) return null
  if (!verifyEvent(event)) return null

  const claim: Nip98Claim = { url: canonicalUrl(req, config), method: req.method }
  if (rawBody !== undefined) claim.payloadHash = await sha256Hex(rawBody)

  if (!checkNip98(event, claim, nowSec, config.authMaxSkewSec).ok) return null
  return isInboxPub(event.pubkey) ? event.pubkey : null
}

export function createRequestHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const {
    store,
    config,
    now = () => Date.now(),
    apiLimiter = createRateLimiter<string>(
      { capacity: config.apiRateBurst, refillPerSec: config.apiRateRefillPerMin / 60 },
      now,
    ),
    maxSubs = config.maxSubs,
  } = deps

  // CORS: ACAO accepts a single origin (or `*`), never a list. Match the
  // request's Origin against the allowlist and echo just that one back.
  const allowedOrigins = config.corsOrigins

  function corsFor(req: Request): Record<string, string> | null {
    if (allowedOrigins.length === 0) return null
    const origin = req.headers.get('origin')
    if (!origin) return null
    if (!allowedOrigins.includes('*') && !allowedOrigins.includes(origin)) return null
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '600',
      vary: 'origin',
    }
  }

  function withCors(res: Response, cors: Record<string, string> | null): Response {
    if (!cors) return res
    const headers = new Headers(res.headers)
    for (const [k, v] of Object.entries(cors)) headers.set(k, v)
    return new Response(res.body, { status: res.status, headers })
  }

  async function route(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url)
    const nowSec = Math.floor(now() / 1000)

    if (req.method === 'GET' && pathname === '/healthz') {
      return json({ ok: true, v: PROTOCOL_VERSION, records: await store.countSubs() })
    }

    if (req.method === 'POST' && pathname === '/push/subscribe') {
      const raw = await req.text()
      const signer = await authenticate(req, config, nowSec, raw)
      if (!signer) return json({ error: 'unauthorized' }, 401)

      if (!apiLimiter.tryConsume(signer, now())) {
        return json({ error: 'rate limited' }, 429)
      }

      let body: unknown
      try {
        body = JSON.parse(raw)
      } catch {
        return json({ error: 'invalid json' }, 400)
      }
      if (!isSubscribeReq(body)) return json({ error: 'invalid subscribe request' }, 400)
      if (body.filter['#p'][0] !== signer) {
        return json({ error: 'signer must equal filter #p' }, 400)
      }

      const existing = await store.getSub(signer)
      if (!existing && (await store.countSubs()) >= maxSubs) {
        return json({ error: 'subscription capacity reached' }, 503)
      }

      await store.upsertSub({
        inboxPub: signer,
        filter: body.filter,
        push: body.push,
        relays: body.relays,
        createdAt: now(),
      })
      return json({ ok: true })
    }

    if (req.method === 'POST' && pathname === '/push/unsubscribe') {
      const signer = await authenticate(req, config, nowSec)
      if (!signer) return json({ error: 'unauthorized' }, 401)
      if (!apiLimiter.tryConsume(signer, now())) {
        return json({ error: 'rate limited' }, 429)
      }
      await store.deleteSub(signer)
      return json({ ok: true })
    }

    return json({ error: 'not found' }, 404)
  }

  return async function handle(req: Request): Promise<Response> {
    const cors = corsFor(req)
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors ?? {} })
    }
    return withCors(await route(req), cors)
  }
}

export type RunningServer = Awaited<ReturnType<typeof startServer>>

export async function startServer(config: Config) {
  const store = await createStore(config.databaseUrl)
  const relayClient = createRelayClient(undefined, {
    timeoutMs: config.relayTimeoutMs,
    onRelayError: (relay, err) =>
      console.warn(`[relay] ${relay}:`, err instanceof Error ? err.message : err),
  })
  const sender = createWebPushSender(config.vapid)
  const poller = createPoller({ store, relayClient, sender, config })
  const server = Bun.serve({
    port: config.port,
    ...(config.tls
      ? { tls: { certFile: config.tls.certFile, keyFile: config.tls.keyFile } }
      : {}),
    fetch: createRequestHandler({ store, config }),
  })
  poller.start()

  return {
    server,
    store,
    poller,
    async stop(close = true) {
      poller.stop()
      relayClient.close()
      server.stop(close)
      await store.close()
    },
  }
}

if (import.meta.main) {
  const config = loadConfig()
  if (!config.vapid.publicKey || !config.vapid.privateKey) {
    console.error('kkachi: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required')
    process.exit(1)
  }
  const app = await startServer(config)
  // Public key is not secret (clients receive it). Logs help compare with the
  // browser subscription's applicationServerKey on VapidPkHashMismatch.
  console.log(`kkachi: VAPID public ${config.vapid.publicKey}`)
  console.log(`kkachi: listening on ${config.tls ? 'https' : 'http'}://localhost:${app.server.port}`)
}
