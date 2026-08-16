import type { init as sentryInit } from '@sentry/nextjs'
import { scrubEvent } from '@/domain/sentry-scrub'

/**
 * The one place the three Sentry runtimes agree about how this app reports
 * errors — and about the fact that, today, it reports none.
 *
 * The owner has not created a Sentry project yet. Everything here is written so
 * that the absence of a DSN is the *normal* state and costs nothing: no
 * warning, no failed build, no network call, and (because next.config.mjs only
 * wraps the config when a DSN is present) not one byte in the client bundle.
 * The day a DSN appears in the environment, this starts working with no code
 * change.
 */

type SentryOptions = Parameters<typeof sentryInit>[0]

/**
 * The public DSN, read from either spelling.
 *
 * `NEXT_PUBLIC_SENTRY_DSN` is the one the browser can see — a client bundle
 * cannot read a server-only variable, so the client config has no other option.
 * `SENTRY_DSN` is what the server and edge runtimes prefer. Setting only the
 * public one configures all three, which is the sane default; setting only the
 * private one deliberately leaves the browser silent, which is a reasonable
 * thing to want and should not be an error.
 *
 * A DSN is not a secret — it is embedded in every client bundle that uses one —
 * so there is nothing lost by reading the public name on the server too.
 */
export function sentryDsn(): string | undefined {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN ?? process.env.SENTRY_DSN
  return dsn && dsn.trim() !== '' ? dsn.trim() : undefined
}

/**
 * Options shared by the browser, the server and the edge.
 *
 * `beforeSend` is the whole point. It runs `scrubEvent` from `@/domain`, which
 * is tested directly rather than trusted here: see sentry-scrub.test.ts. This
 * app holds contracts and payment history, so an error report is a document
 * that leaves the building and it gets read before it goes.
 *
 * `sendDefaultPii` is left off (its default) and `beforeSend` drops
 * `event.user` outright, so no buyer's name or email travels with a stack
 * trace. That is a judgement call made in the negative on purpose — see the
 * comment on `scrubEvent`.
 *
 * Tracing is off. Performance data is a second stream of URLs and payloads to
 * have to scrub, and nobody has asked a question it would answer. The owner
 * needs to find out that production broke without waiting for a phone call;
 * that is errors.
 */
export function sentryOptions(dsn: string): SentryOptions {
  return {
    dsn,
    tracesSampleRate: 0,
    // Breadcrumbs still go through beforeSend as part of the event, so they are
    // scrubbed with everything else.
    sendDefaultPii: false,
    // No casts either way. `ScrubbableEvent` is written as a supertype of
    // Sentry's own event, and `scrubEvent` is generic in what it is given, so
    // an `ErrorEvent` goes in and an `ErrorEvent` comes back out. See the note
    // on `ScrubbableEvent` for why the obvious shape did not typecheck.
    beforeSend(event) {
      return scrubEvent(event)
    }
  }
}
