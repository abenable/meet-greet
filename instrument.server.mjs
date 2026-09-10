import * as Sentry from '@sentry/tanstackstart-react'

const sentryDsn = import.meta.env?.VITE_SENTRY_DSN ?? process.env.VITE_SENTRY_DSN

const asRate = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback
}

if (!sentryDsn) {
  console.warn('VITE_SENTRY_DSN is not defined. Sentry is not running.')
} else {
  Sentry.init({
    dsn: sentryDsn,
    environment: process.env.NODE_ENV ?? 'development',

    // This was `sendDefaultPii: true` with 100% traces and 100% session
    // replay. On a dating product that meant recording every user's chats,
    // photos and email address into a third-party service by default — and
    // paying to trace every single request. Sampling is now low by default and
    // tunable per environment; replay is off unless an error occurs.
    sendDefaultPii: false,
    tracesSampleRate: asRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0.05),
    replaysSessionSampleRate: asRate(process.env.SENTRY_REPLAYS_SESSION_SAMPLE_RATE, 0),
    replaysOnErrorSampleRate: asRate(process.env.SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE, 0.1),

    // Belt and braces: strip anything that still looks like a credential or a
    // message body before the event leaves the process.
    beforeSend(event) {
      if (event.request?.cookies) delete event.request.cookies
      if (event.request?.headers) {
        delete event.request.headers.cookie
        delete event.request.headers.authorization
      }
      if (event.request?.data) delete event.request.data
      return event
    },
  })
}
