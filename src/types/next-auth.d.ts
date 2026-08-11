import type { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface User {
    orgId: string
    role: 'ADMIN' | 'AGENT' | 'BUYER'
    buyerId: string | null
  }

  interface Session {
    user: {
      id: string
      orgId: string
      role: 'ADMIN' | 'AGENT' | 'BUYER'
      buyerId: string | null
      /**
       * The JWT's `iat`, in whole seconds, surfaced so `requireUser` can
       * compare it against `User.passwordChangedAt`. Optional because a token
       * without an `iat` is a shape worth typing for:
       * `sessionOutdatedByPasswordChange` reads `undefined` as "cannot prove
       * this session postdates the change" and revokes it.
       */
      tokenIssuedAt?: number
    } & DefaultSession['user']
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    orgId: string
    role: 'ADMIN' | 'AGENT' | 'BUYER'
    buyerId: string | null
  }
}
