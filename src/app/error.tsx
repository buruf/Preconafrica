'use client'

/**
 * The root error boundary. The (staff) and (buyer) groups each have their own,
 * phrased for the role failure that is by far the likeliest cause there — but
 * the routes outside those groups (/login, and anything added there later) had
 * none, so an unexpected throw in one reached Next's default error screen. The
 * public buy flow, which is what originally motivated this file, is gone —
 * staff sell now and every sale page lives inside (staff). This is the
 * generic backstop: it cannot assume the visitor is signed in, so the way home
 * is a plain <a> to '/', which routes to the right place per role on the server.
 */
export default function RootError() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center p-5 text-center">
      <div className="w-full rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-slate-500">
          Please try again. If it keeps happening, contact us.
        </p>
        <a
          href="/"
          className="mt-4 inline-flex min-h-11 items-center justify-center rounded-lg bg-slate-900 px-4 text-sm font-medium text-white"
        >
          Go to the home page
        </a>
      </div>
    </main>
  )
}
