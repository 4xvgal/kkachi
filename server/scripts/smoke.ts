/**
 * End-to-end HTTP smoke test against a running server (local, Docker, or remote).
 *
 *   KKACHI_URL=http://localhost:8787 bun run server/scripts/smoke.ts
 *
 * Exercises the real SDK registration path: NIP-98 sign -> subscribe -> verify
 * record -> unsubscribe.
 */

import { deriveInboxPub } from 'kkachi/inbox-key'
import { createInboxSigner, subscribe, unsubscribe } from 'kkachi/register'
import type { PushMaterial } from 'kkachi/protocol'

const base = process.env.KKACHI_URL ?? 'http://localhost:8787'
const seed = new Uint8Array(32).map((_, i) => (i * 3 + 1) % 256)
const push: PushMaterial = {
  endpoint: 'https://push.example/smoke',
  keys: { p256dh: 'BPs', auth: 'AUs' },
}

async function health(): Promise<{ ok: boolean; records: number }> {
  const res = await fetch(`${base}/healthz`)
  if (!res.ok) throw new Error(`healthz ${res.status}`)
  return (await res.json()) as { ok: boolean; records: number }
}

const before = await health()
const signer = await createInboxSigner(seed, '2026-09')
const inbox = await deriveInboxPub(seed, '2026-09')

const sub = await subscribe(base, signer, push)
if (!sub.ok) throw new Error(`subscribe failed: ${sub.status} ${await sub.text()}`)
const afterSub = await health()
if (afterSub.records !== before.records + 1) {
  throw new Error(`record not added: ${before.records} -> ${afterSub.records}`)
}

const unsub = await unsubscribe(base, signer)
if (!unsub.ok) throw new Error(`unsubscribe failed: ${unsub.status}`)
const afterUnsub = await health()
if (afterUnsub.records !== before.records) {
  throw new Error(`record not removed: ${afterSub.records} -> ${afterUnsub.records}`)
}

console.log(`smoke ok: inbox=${inbox.slice(0, 12)}… records=${afterSub.records}`)
