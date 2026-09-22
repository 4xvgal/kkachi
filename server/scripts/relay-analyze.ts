/**
 * Relay analysis: NIP-11 policy + kind:1/1059 write->read round-trip.
 *   bun run server/scripts/relay-analyze.ts <wss://relay> ...
 */
import { finalizeEvent, generateSecretKey, getPublicKey, nip11, SimplePool } from 'nostr-tools'

const relays = process.argv.slice(2)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const randHex = () =>
  Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
  ])
}

for (const relay of relays) {
  const out: Record<string, unknown> = { relay }
  let maxLimit: number | undefined
  try {
    const info = await withTimeout(nip11.fetchRelayInformation(relay), 8000, 'nip11')
    maxLimit = info.limitation?.max_limit
    out.nip11 = {
      name: info.name,
      maxLimit,
      authRequired: info.limitation?.auth_required ?? false,
      paymentRequired: info.limitation?.payment_required ?? false,
      nips: info.supported_nips,
    }
  } catch (e) {
    out.nip11 = { error: String(e) }
  }

  const pool = new SimplePool()
  try {
    const sk = generateSecretKey()
    const pk = getPublicKey(sk)
    const now = Math.floor(Date.now() / 1000)

    const note = finalizeEvent({ kind: 1, created_at: now, tags: [], content: `kkachi-analyze ${now}` }, sk)
    const notePub = await Promise.allSettled([
      withTimeout(Promise.all(pool.publish([relay], note)), 8000, 'pub1'),
    ])
    await sleep(2500)
    const noteBack = await withTimeout(pool.querySync([relay], { authors: [pk], limit: 1 }), 8000, 'q1')
    out.kind1 = {
      published: notePub.some((r) => r.status === 'fulfilled'),
      recall: noteBack.some((e) => e.id === note.id),
    }

    const inbox = randHex()
    const wrap = finalizeEvent(
      { kind: 1059, created_at: now, tags: [['p', inbox]], content: '' },
      generateSecretKey(),
    )
    const wrapPub = await Promise.allSettled([
      withTimeout(Promise.all(pool.publish([relay], wrap)), 8000, 'pub1059'),
    ])
    await sleep(2500)
    const wrapBack = await withTimeout(
      pool.querySync([relay], { kinds: [1059], since: now - 300, limit: maxLimit ?? 300 }),
      8000,
      'q1059',
    )
    out.kind1059 = {
      published: wrapPub.some((r) => r.status === 'fulfilled'),
      recall: wrapBack.some((e) => e.id === wrap.id),
      windowCount: wrapBack.length,
    }
  } catch (e) {
    out.error = String(e)
  } finally {
    pool.close([])
  }

  console.log(JSON.stringify(out, null, 0))
}
