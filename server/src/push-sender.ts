/**
 * [shell] Web Push delivery (VAPID). The payload is always content-less; this
 * sender never sees or builds content.
 */

import webpush from 'web-push'
import type { PushMaterial } from 'kkachi/protocol'
import type { VapidConfig } from './config.ts'

export class PushGoneError extends Error {
  readonly endpoint: string
  constructor(endpoint: string) {
    super(`push subscription gone: ${endpoint}`)
    this.name = 'PushGoneError'
    this.endpoint = endpoint
  }
}

export type PushSender = (sub: PushMaterial, payload: string) => Promise<void>

export function createWebPushSender(vapid: VapidConfig): PushSender {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey)
  return async (sub, payload) => {
    try {
      await webpush.sendNotification(sub, payload, { TTL: 60, urgency: 'normal' })
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) throw new PushGoneError(sub.endpoint)
      throw err
    }
  }
}
