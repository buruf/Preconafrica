import * as Sentry from '@sentry/nextjs'
import { sentryDsn, sentryOptions } from '@/sentry.shared'

/**
 * Edge-runtime errors.
 *
 * The only thing this app runs at the edge is `src/middleware.ts`, which is
 * deliberately inert — so this config exists mostly so that a future edge route
 * is covered the day it is written rather than the day someone notices it is
 * not. It is initialised on exactly the same terms as the other two: no DSN,
 * no client, nothing sent.
 */
const dsn = sentryDsn()

if (dsn) {
  Sentry.init(sentryOptions(dsn))
}
