import { prisma } from '#/db'
import webPush from 'web-push'

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(
    'mailto:admin@meetandgreet.tech',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  )
}

export async function createNotification(data: {
  userId: string
  type: 'like' | 'match' | 'message' | 'request' | 'request_accepted'
  title: string
  body: string
  link?: string
}) {
  const notification = await prisma.notification.create({ data })

  // Push delivery is one outbound HTTP request per subscribed device. Awaiting
  // it put third-party network latency directly into the response time of
  // sending a message, so it is dispatched without blocking the caller.
  void sendPushNotification(data.userId, {
    title: data.title,
    body: data.body,
    url: data.link,
  }).catch((err) => console.warn('[Push] delivery failed:', err))

  return notification
}

export async function sendPushNotification(
  userId: string,
  payload: {
    title: string
    body: string
    icon?: string
    url?: string
  }
) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.warn('[Push] VAPID keys not configured, skipping push notification')
    return
  }

  const subs = await prisma.pushSubscription.findMany({ where: { userId } })
  if (subs.length === 0) return

  const pushPayload = JSON.stringify(payload)

  const stale: string[] = []

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webPush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.p256dh,
              auth: sub.auth,
            },
          },
          pushPayload,
          { TTL: 60 * 60 },
        )
      } catch (error: any) {
        if (error?.statusCode === 410 || error?.statusCode === 404) {
          // Subscription expired or invalid — collect for one bulk delete.
          stale.push(sub.id)
        } else {
          console.error('[Push] Failed to send notification:', error)
        }
      }
    }),
  )

  if (stale.length > 0) {
    await prisma.pushSubscription
      .deleteMany({ where: { id: { in: stale } } })
      .catch(() => {})
  }
}
