/**
 * Demo app: derive an epoch inbox key, subscribe to browser push, and register
 * with the kkachi server using the SDK.
 */

import { deriveInboxPub } from 'kkachi/inbox-key'
import { createInboxSigner, subscribe, unsubscribe } from 'kkachi/register'
import { isAllowedRelayUrl, isPushMaterial, type PushMaterial } from 'kkachi/protocol'
import { finalizeEvent, generateSecretKey, SimplePool } from 'nostr-tools'

type DemoConfig = { serverUrl: string; vapidPublicKey: string; relayUrl: string }

const RELAY_STORAGE_KEY = 'kkachi-demo-relay'

/** Relay to publish to: runtime override (localStorage) wins over config.js. */
function getRelay(): string {
  return localStorage.getItem(RELAY_STORAGE_KEY) || window.KKACHI_CONFIG.relayUrl
}

declare global {
  interface Window {
    KKACHI_CONFIG: DemoConfig
  }
}

const EPOCH = '2026-09'
const logEl = document.getElementById('log') as HTMLPreElement

function log(message: unknown): void {
  const line = typeof message === 'string' ? message : JSON.stringify(message)
  logEl.textContent += `${line}\n`
  console.log(message)
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(normalized)
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Existing subscription is bound to a VAPID key; a different key must resubscribe. */
function keyMatches(subscription: PushSubscription, vapidPublicKey: string): boolean {
  const key = subscription.options?.applicationServerKey
  if (!key) return false
  return toBase64Url(new Uint8Array(key)) === vapidPublicKey
}

/** Demo seed persisted in localStorage so the inbox is stable across reloads. */
function getSeed(): Uint8Array {
  const stored = localStorage.getItem('kkachi-demo-seed')
  if (stored) return Uint8Array.from(atob(stored), (c) => c.charCodeAt(0))
  const seed = crypto.getRandomValues(new Uint8Array(32))
  localStorage.setItem('kkachi-demo-seed', btoa(String.fromCharCode(...seed)))
  return seed
}

async function enable(): Promise<void> {
  const cfg = window.KKACHI_CONFIG
  log(`server: ${cfg.serverUrl}`)

  const permission = await Notification.requestPermission()
  log(`permission: ${permission}`)
  if (permission !== 'granted') return

  const registration = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready

  const seed = getSeed()
  const signer = await createInboxSigner(seed, EPOCH)
  log(`inboxPub: ${await deriveInboxPub(seed, EPOCH)}`)

  // Reuse an existing subscription only if it was created with the current
  // VAPID key; otherwise the browser throws InvalidStateError on subscribe().
  let subscription = await registration.pushManager.getSubscription()
  if (subscription && !keyMatches(subscription, cfg.vapidPublicKey)) {
    log('existing subscription uses a different VAPID key → resubscribing')
    await subscription.unsubscribe()
    subscription = null
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(cfg.vapidPublicKey),
    })
  }

  const push = subscription.toJSON() as PushMaterial
  if (!isPushMaterial(push)) throw new Error('unexpected push subscription shape')
  log(`endpoint: ${push.endpoint.slice(0, 48)}…`)

  // Public relay → tell the server to poll it for this subscriber. A local/private
  // relay is rejected by the server's SSRF guard, so it must be in RELAYS instead.
  const relay = getRelay()
  const relays = isAllowedRelayUrl(relay) ? [relay] : undefined
  log(relays ? `relay: ${relay}` : `relay: ${relay} (local/private → must be in server RELAYS)`)

  const res = await subscribe(cfg.serverUrl, signer, push, relays)
  log(`subscribe → ${res.status} ${await res.text()}`)
}

async function disable(): Promise<void> {
  const cfg = window.KKACHI_CONFIG
  const signer = await createInboxSigner(getSeed(), EPOCH)
  const res = await unsubscribe(cfg.serverUrl, signer)
  log(`unsubscribe → ${res.status}`)
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  if (subscription) await subscription.unsubscribe()
}

/** Publish a kind:1059 gift-wrap addressed to this device's inbox. */
async function sendToSelf(): Promise<void> {
  const cfg = window.KKACHI_CONFIG
  const relay = getRelay()
  const inboxPub = await deriveInboxPub(getSeed(), EPOCH)
  const event = finalizeEvent(
    {
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', inboxPub]],
      content: '',
    },
    generateSecretKey(),
  )
  log(`publishing to ${inboxPub.slice(0, 12)}… via ${relay}`)

  const pool = new SimplePool()
  try {
    const results = await Promise.allSettled(pool.publish([relay], event))
    const ok = results.filter((r) => r.status === 'fulfilled').length
    log(`publish → ${ok}/${results.length} accepted`)
    if (ok === 0) log(`error: relay rejected ${event.id}`)
  } finally {
    pool.close([])
  }
}

const relayInput = document.getElementById('relay') as HTMLInputElement | null
if (relayInput) relayInput.value = getRelay()

document.getElementById('enable')?.addEventListener('click', () => {
  void enable().catch((err) => log(`error: ${String(err)}`))
})
document.getElementById('disable')?.addEventListener('click', () => {
  void disable().catch((err) => log(`error: ${String(err)}`))
})
document.getElementById('send')?.addEventListener('click', () => {
  void sendToSelf().catch((err) => log(`error: ${String(err)}`))
})
document.getElementById('saveRelay')?.addEventListener('click', () => {
  const value = relayInput?.value.trim() ?? ''
  if (!/^wss?:\/\//.test(value)) {
    log('relay: must start with ws:// or wss://')
    return
  }
  localStorage.setItem(RELAY_STORAGE_KEY, value)
  log(`relay saved: ${value}`)
  log('public relay → click "Enable notifications" to update the server; local relay → must be in server RELAYS')
})

log(`ready — server ${window.KKACHI_CONFIG.serverUrl}, relay ${getRelay()}`)
