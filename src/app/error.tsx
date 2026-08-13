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
      <div className="w-full rounded-card border border-line bg-surface p-6 shadow-card">
        <h1 className="text-xl font-semibold text-navy-900">Something went wrong</h1>
        <p className="mt-2 text-[15px] text-muted">
          Please try again. If it keeps happening, contact us.
        </p>
        <a
          href="/"
          className="mt-4 inline-flex min-h-11 items-center justify-center rounded-btn bg-navy-900 px-4 text-sm font-semibold text-surface hover:bg-navy-800"
        >
          Go to the home page
        </a>
      </div>
    </main>
  )
}
