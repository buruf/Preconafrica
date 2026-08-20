import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '@/server/db'

const CredentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
})

// A syntactically valid bcrypt hash of a string nobody will ever type as a
// real password. It exists purely so bcrypt.compare() has real work to do
// when the looked-up user does not exist, keeping the authorize() timing
// indistinguishable from the wrong-password case. Do not replace this with
// a malformed placeholder — bcryptjs short-circuits on malformed hashes and
// returns instantly, which defeats the point.
const DUMMY_PASSWORD_HASH = '$2a$10$d5cxiwZQX8VvbMSD4/KTau1g30eE/3dBWJj747m2FZ2a8JvreB1XC'

export const { handlers, auth, signIn, signOut } = NextAuth({
  // 7 days, down from Auth.js's 30-day default. A JWT carries its own claims
  // and cannot be revoked from the outside, so its lifetime is the outer bound
  // on how long a leaked cookie stays useful. `requireUser` closes the
  // deactivation case per request; this bounds everything it cannot see.
  session: { strategy: 'jwt', maxAge: 60 * 60 * 24 * 7 },
  pages: { signIn: '/login' },
  // Auth.js v5 refuses every request as UntrustedHost outside a recognised
  // proxy. Vercel is auto-trusted via the VERCEL env var, but local
  // `next start` and any other host would be dead without this. The host
  // header carries no auth weight here (JWT sessions, absolute NEXTAUTH_URL),
  // so trusting it unconditionally is safe.
  trustHost: true,
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const parsed = CredentialsSchema.safeParse(raw)
        if (!parsed.success) return null

        const user = await prisma.user.findUnique({
          where: { email: parsed.data.email.toLowerCase() },
          include: { buyer: { select: { id: true } } }
        })

        // Always run a hash comparison, even when the user does not exist, so
        // response timing does not reveal which emails are registered.
        const hash = user?.passwordHash ?? DUMMY_PASSWORD_HASH
        const ok = await bcrypt.compare(parsed.data.password, hash)
        if (!user || !ok) return null

        return {
          id: user.id,
          email: user.email,
          name: user.fullName,
          orgId: user.orgId,
          role: user.role,
          buyerId: user.buyer?.id ?? null,
          kind: 'user' as const
        }
      }
    }),
    /**
     * The platform operator's door, used only by /platform/login.
     *
     * A second provider rather than a branch inside the first, so the two
     * lookups can never fall through to one another: this one reads
     * `PlatformUser` and nothing else, and a developer's email typed here
     * finds nothing however valid their password is. The reverse holds too.
     *
     * The same dummy-hash timing defence, for a sharper reason than usual:
     * this is the account that can create and suspend every developer on the
     * platform, so whether an address belongs to an operator must not be
     * learnable from how fast the form answers.
     */
    Credentials({
      id: 'platform',
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const parsed = CredentialsSchema.safeParse(raw)
        if (!parsed.success) return null

        const admin = await prisma.platformUser.findUnique({
          where: { email: parsed.data.email.toLowerCase() }
        })

        const hash = admin?.passwordHash ?? DUMMY_PASSWORD_HASH
        const ok = await bcrypt.compare(parsed.data.password, hash)
        if (!admin || !ok) return null

        // `orgId` is the empty string and `role` is a placeholder: neither is
        // ever read for a platform session, because `requireUserOrNull`
        // refuses `kind === 'platform'` before either could matter. They exist
        // only to satisfy the shared token shape. `kind` is the real claim.
        return {
          id: admin.id,
          email: admin.email,
          name: admin.fullName,
          orgId: '',
          role: 'ADMIN' as const,
          buyerId: null,
          kind: 'platform' as const
        }
      }
    })
  ],
  callbacks: {
    jwt({ token, user }) {
      // `user` is truthy only on the sign-in call. Every later invocation is a
      // refresh of a token that already exists, and skips this block — which
      // is the entire reason `authTime` can be trusted to mean "when this
      // session began" where `iat` cannot.
      if (user) {
        token.orgId = user.orgId
        token.role = user.role
        token.buyerId = user.buyerId
        // Stamped at sign-in like everything else here, and never widened
        // afterwards: a session cannot change which door it came through.
        token.kind = user.kind ?? 'user'
        token.authTime = Math.floor(Date.now() / 1000)
      }
      return token
    },
    session({ session, token }) {
      session.user.id = token.sub as string
      session.user.orgId = token.orgId as string
      session.user.role = token.role as 'ADMIN' | 'AGENT' | 'BUYER'
      session.user.buyerId = (token.buyerId as string | null) ?? null
      // Absent on tokens minted before this claim existed, and read as a
      // developer's session by both guards. Never defaulted to 'platform'.
      session.user.kind = (token.kind as 'user' | 'platform' | undefined) ?? 'user'
      // Session age comes from our own `authTime` claim, stamped once at
      // sign-in, and deliberately NOT from `iat`.
      //
      // `iat` looks like the right claim and is not: Auth.js re-signs the JWT
      // on every session read, and `jwt.encode` calls `.setIssuedAt()`, so
      // `iat` is rewritten to "now" each time and the refreshed cookie is
      // handed back to the browser — by `GET /api/auth/session`, which is
      // public, and by the middleware, which attaches `set-cookie` even to the
      // redirect that bounced the request. Reading `iat` therefore made
      // revocation self-healing: a stolen cookie needed one request to get a
      // fresh `iat`, after which `passwordChangedAt >= iat` was false forever.
      // A custom claim survives re-encoding untouched because the jwt callback
      // returns the token unchanged on a refresh.
      //
      // There is no `iat` fallback on purpose. A token minted before this
      // claim existed has no provable start time, and
      // `sessionOutdatedByPasswordChange` reads `undefined` as "revoke" —
      // failing closed. The cost is that anyone who has ever changed their
      // password signs in once more after this ships.
      session.user.tokenIssuedAt = token.authTime as number | undefined
      return session
    }
  }
})
