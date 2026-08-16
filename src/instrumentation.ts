/**
 * Next 14's server-startup hook, enabled by `experimental.instrumentationHook`.
 *
 * It lives under `src/` because this project keeps `app/` there; Next looks for
 * it beside the app directory, and a copy at the repository root would simply
 * never run.
 *
 * It runs once per server runtime, before anything else, which is the only
 * place error reporting can be installed early enough to catch a failure during
 * module initialisation. The imports are dynamic and inside the runtime checks
 * on purpose: that is what keeps the Node config out of the edge bundle and the
 * edge config out of the Node one. A static import would put both in both — and
 * would put the whole Sentry package into `src/middleware.ts`'s edge bundle
 * even with no DSN configured, which is precisely the "inert" claim this is
 * supposed to be able to make.
 *
 * With no DSN this file is never compiled at all. `instrumentationHook` in
 * next.config.mjs is itself gated on the DSN, because the flag is what makes
 * Next look at this file, and looking at it makes webpack follow the imports
 * below and pull the whole Sentry Node SDK — OpenTelemetry and
 * require-in-the-middle included — into the server bundle. That is a build-time
 * decision no runtime `if (!dsn) return` can undo: bundling does not care that
 * a branch is never taken. Gating the flag is what lets "inert without a DSN"
 * mean absent rather than merely quiet, and it is why a build with no Sentry
 * project prints no warnings. The DSN checks inside the two configs stay
 * regardless, so a future reason to enable the hook cannot start a client by
 * accident.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config')
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config')
  }
}
