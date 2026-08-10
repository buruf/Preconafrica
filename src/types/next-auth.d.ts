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
