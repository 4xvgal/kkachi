/**
 * Service worker: show the client-registered push message (plaintext or hash
 * token — resolved locally by the app) on push, focus the app on click.
 *
 * The token→text map is persisted in IndexedDB: SW scope has no localStorage,
 * and Safari restarts SWs freely, so a memory-only map would show raw tokens
 * after any restart. The page re-syncs the map on every load via postMessage.
 */

/// <reference lib="webworker" />

import { decodePushPayload } from 'kkachi/protocol'

/** SW global scope — typed so push/notification events resolve their maps. */
const sw = self as unknown as ServiceWorkerGlobalScope

/** token→text map (hash path), synced by the page via postMessage. */
let labels: Record<string, string> = {}

const IDB_NAME = 'kkachi-labels'
const IDB_STORE = 'labels'
const IDB_KEY = 'map'

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function loadLabelsFromIdb(): Promise<Record<string, string>> {
  try {
    const db = await idbOpen()
    return await new Promise((resolve, reject) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(IDB_KEY)
      req.onsuccess = () => resolve((req.result as Record<string, string>) ?? {})
      req.onerror = () => reject(req.error)
    })
  } catch {
    return {}
  }
}

async function saveLabelsToIdb(map: Record<string, string>): Promise<void> {
  try {
    const db = await idbOpen()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      tx.objectStore(IDB_STORE).put(map, IDB_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // in-memory fallback only
  }
}

sw.addEventListener('message', (event) => {
  if (event.data?.type === 'kkachi-labels' && event.data.labels) {
    labels = event.data.labels
    void saveLabelsToIdb(labels)
  }
})

sw.addEventListener('push', (event) => {
  if (!event.data) return
  const data = event.data
  event.waitUntil(
    (async () => {
      const { m } = decodePushPayload(data.text())
      // SW may have restarted since the page synced the map — recover from IDB.
      if (Object.keys(labels).length === 0) labels = await loadLabelsFromIdb()
      // Hash path: resolve the obfuscated token to the registered text. Plaintext
      // path: show it directly. Unknown token → show it as-is.
      const title = m ? (labels[m] ?? m) : '새 알림 도착'
      console.log('[sw] push #', m, '→', title, '(maps:', Object.keys(labels).length, ')')
      await sw.registration.showNotification(title, {
        tag: m ? `kkachi-${m}` : 'kkachi-incoming',
        silent: true,
        data: { url: '/' },
      })
    })(),
  )
})

sw.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    sw.clients.matchAll({ type: 'window' }).then((clients) => {
      const existing = clients[0]
      return existing ? existing.focus() : sw.clients.openWindow('/')
    }),
  )
})

// Dev-friendly: skipWaiting + take over on next load instead of waiting for
// all tabs to close (avoids "old SW still active" confusion during dev).
sw.addEventListener('install', () => {
  sw.skipWaiting()
})
sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim())
})