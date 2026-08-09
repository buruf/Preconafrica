export { auth as middleware } from '@/server/auth'

export const config = {
  matcher: ['/projects/:path*', '/sales/:path*', '/arrears/:path*', '/dashboard/:path*']
}
