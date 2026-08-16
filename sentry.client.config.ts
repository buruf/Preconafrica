import * as Sentry from '@sentry/nextjs'
import { sentryDsn, sentryOptions } from '@/sentry.shared'

/**
 * Browser errors.
 *
 * `init` is not called at all without a DSN, rather than called with an
 * undefined one. Sentry treats a missing DSN as "disabled" either way, but
 * "disabled" still means an initialised client, integrations installed, and
 * global handlers patched onto `window` — work for a service that is not
 * configured. Skipping the call entirely is the difference between inert and
 * merely quiet.
 *
 * This file is only bundled when `withSentryConfig` wraps next.config.mjs, and
 * that only happens when a DSN is present — so with no DSN the guard below is
 * belt and braces on a file the build never reaches, and the client bundle is
 * byte-for-byte what it was before Sentry was added.
 */
const dsn = sentryDsn()

if (dsn) {
  Sentry.init({
    ...sentryOptions(dsn),
    // Session replay stays off. A replay of a page showing a buyer's contract
    // and payment history is exactly the kind of thing this app should not be
    // shipping to a third party, and no question anyone has asked needs it.
    replaysOnErrorSampleRate: 0,
    replaysSessionSampleRate: 0
  })
}
