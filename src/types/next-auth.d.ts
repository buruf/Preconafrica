import type { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface User {
    orgId: string
    role: 'ADMIN' | 'AGENT' | 'BUYER'
    buyerId: string | null
    /**
     * Which door this session came through.
     *
     * A platform operator has no organisation, and every query in this app is
     * scoped by one taken from the session — so the two session types must be
     * impossible to confuse. The guards in server/session.ts read this claim
     * before touching either table.
     *
     * Optional, and absence means 'user': a token minted before this claim
     * existed carries none, so developer sessions survive the deploy, and
     * nothing can be promoted to 'platform' by omission.
     */
    kind?: 'user' | 'platform'
  }

  interface Session {
    user: {
      id: string
      orgId: string
      role: 'ADMIN' | 'AGENT' | 'BUYER'
      buyerId: string | null
      /** See `User.kind` above. Absence means a developer's session. */
      kind?: 'user' | 'platform'
      /**
       * When this session began, in whole seconds — the JWT's `authTime`
       * claim, not its `iat` (which Auth.js rewrites on every session read;
       * see the session callback in auth.ts). Surfaced so `requireUser` can
       * compare it against `User.passwordChangedAt`. Optional because a token
       * without the claim is a shape worth typing for:
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
    /** See `User.kind`. Absence means a developer's session. */
    kind?: 'user' | 'platform'
    /**
     * Seconds since the epoch at which this session was created, stamped once
     * in the jwt callback's sign-in branch. Optional: tokens minted before
     * this claim existed do not carry it, and must be read as unprovable
     * rather than as new.
     */
    authTime?: number
  }
}
