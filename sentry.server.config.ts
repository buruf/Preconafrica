import * as Sentry from '@sentry/nextjs'
import { sentryDsn, sentryOptions } from '@/sentry.shared'

/**
 * Node-runtime errors: every server action, every service, every API route, the
 * PDF renderer and the cron sweep.
 *
 * This is the runtime that matters most here. A failure in a server action is
 * the one the owner currently hears about from a phone call — "I clicked record
 * payment and nothing happened" — and it is also the runtime holding the
 * connection string, the blob token and whatever was in the request body, which
 * is why `beforeSend` is not optional. See @/domain/sentry-scrub.
 *
 * Nothing is initialised without a DSN. See the note in sentry.client.config.ts.
 */
const dsn = sentryDsn()

if (dsn) {
  Sentry.init(sentryOptions(dsn))
}
