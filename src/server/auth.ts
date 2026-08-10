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
  session: { strategy: 'jwt' },
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
          buyerId: user.buyer?.id ?? null
        }
      }
    })
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.orgId = user.orgId
        token.role = user.role
        token.buyerId = user.buyerId
      }
      return token
    },
    session({ session, token }) {
      session.user.id = token.sub as string
      session.user.orgId = token.orgId as string
      session.user.role = token.role as 'ADMIN' | 'AGENT' | 'BUYER'
      session.user.buyerId = (token.buyerId as string | null) ?? null
      return session
    }
  }
})
