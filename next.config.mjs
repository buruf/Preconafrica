/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['@react-pdf/renderer', '@prisma/client', 'bcryptjs']
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
export default nextConfig
