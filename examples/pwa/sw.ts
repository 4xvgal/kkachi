/**
 * Service worker: show a generic notification on push (content-less), focus the
 * app on click.
 */

/// <reference lib="webworker" />

self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('새 알림 도착', {
      tag: 'kkachi-incoming',
      silent: true,
      data: { url: '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      const existing = clients[0]
      return existing ? existing.focus() : self.clients.openWindow('/')
    }),
  )
})
