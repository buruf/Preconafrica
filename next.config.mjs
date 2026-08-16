import { withSentryConfig } from '@sentry/nextjs'

/**
 * The one switch. Everything Sentry — the build wrap, the instrumentation hook,
 * the three runtime configs — is gated on this and nothing else, so the SDK is
 * either wholly present or wholly absent and there is no half-installed state
 * to reason about. See the note above the export for what each half does.
 */
const sentryDsn = process.env.NEXT_PUBLIC_SENTRY_DSN ?? process.env.SENTRY_DSN

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['@react-pdf/renderer', '@prisma/client', 'bcryptjs'],
    /**
     * Turns on src/instrumentation.ts, which is where error reporting is
     * installed. Next 14 needs this flag; Next 15 made it the default.
     *
     * Gated on the DSN, not simply `true`, because the flag is what makes Next
     * *compile* src/instrumentation.ts — and compiling it makes webpack follow
     * the `import('../sentry.server.config')` inside it and pull the entire
     * Sentry Node SDK, OpenTelemetry and require-in-the-middle into the server
     * bundle. A runtime `if (!dsn) return` cannot prevent that: bundling
     * happens at build time and does not care that the branch is never taken.
     * The visible symptom was two "Critical dependency" warnings on every
     * build of an app with no Sentry project, which is exactly the cost this
     * install is supposed not to have. With the flag off, Next never looks at
     * the file and the dependency graph is the one it was before.
     */
    instrumentationHook: Boolean(sentryDsn)
  },
  async headers() {
    return [
      {
        // Every path. /reset-password is the one that forced the issue — it
        // carries the raw reset token in its query string, and it links away
        // (to /login, and to whatever a browser extension or a future footer
        // link points at), so the whole URL, token included, would be sent as
        // the `Referer` on the next request. Same-origin is enough to leak it:
        // an access log, an APM trace or a proxy is all it takes for a live
        // credential to end up written down somewhere nobody is guarding.
        //
        // Applied globally rather than to that one route because nothing in
        // this app reads a referrer — no analytics attribution, no
        // referrer-based CSRF check, no "back to where you came from" — so
        // there is nothing to weigh against it, and a header scoped to one
        // path is a header someone forgets to extend to the next one.
        source: '/:path*',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }]
      }
    ]
  }
}

/**
 * Sentry is wrapped around the build only when a DSN exists.
 *
 * The owner has not created a Sentry project yet, and the requirement is that
 * the app builds, runs and tests today exactly as it did before — no warnings,
 * no network calls, no bundle growth. `withSentryConfig` is what injects
 * `sentry.client.config.ts` into the client bundle and installs the source-map
 * plugin; both are unwanted work with nothing to report to. Calling it
 * unconditionally and relying on "an undefined DSN disables the SDK" would
 * still ship the SDK to every browser, and would still print its
 * "no auth token, skipping upload" notice on every build.
 *
 * So the wrap is conditional, and the condition is the same one the
 * instrumentation hook above and the three runtime configs check. Setting
 * NEXT_PUBLIC_SENTRY_DSN turns the whole thing on — hook, configs, client
 * bundle, source maps — with no code change.
 *
 * Source maps: `widenClientFileUpload` and friends are deliberately left at
 * their defaults, and nothing is uploaded without SENTRY_AUTH_TOKEN. That means
 * a DSN alone gives readable server stack traces and minified client ones;
 * adding the org, project and token turns on the upload. It is opt-in twice
 * because an upload step is the part of a Sentry install that lengthens a build
 * and can fail it, and neither is worth it until someone is actually reading
 * the reports.
 */
export default sentryDsn
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      // No upload without a token, and no complaint about not having one.
      silent: true,
      sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
      // The tunnel route proxies browser reports through this app's own origin
      // to get past ad blockers. Off: it turns every client error into a
      // request this app has to serve, and it is not worth a route on a
      // platform where the only browsers are staff and buyers who are signed
      // in and not being counted.
      tunnelRoute: undefined,
      disableLogger: true
    })
  : nextConfig
