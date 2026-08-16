import { PrismaClient } from '@prisma/client'
import { auditImmutabilityMiddleware } from '@/server/audit/immutability'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

/**
 * True inside Next's Edge bundle — today, `src/middleware.ts`, which imports
 * `@/server/auth` and therefore transitively imports this module.
 *
 * Prisma has no Edge build here, so what that bundle actually gets is a browser
 * stub whose every property access throws "PrismaClient is not configured to
 * run in Edge Runtime". Constructing it is harmless (and has always happened);
 * *touching* it is not, and installing middleware touches it. Without this
 * check the app 404s every route with that error before any page runs.
 *
 * Skipping the guard there costs nothing, because the stub cannot execute a
 * query of any kind: there is no database access at the edge to guard. The
 * middleware is inert by design (see src/middleware.ts) and nothing in it
 * reads or writes a row.
 */
const IS_EDGE_RUNTIME = process.env.NEXT_RUNTIME === 'edge'

function createClient(): PrismaClient {
  const client = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']
  })

  // Installed on the client, so it covers interactive transaction clients too —
  // which is where every audit write actually happens. See
  // @/server/audit/immutability for why this is middleware rather than a client
  // extension, and why the database trigger, not this, is the real guarantee.
  if (!IS_EDGE_RUNTIME) client.$use(auditImmutabilityMiddleware)

  return client
}

// Reused across hot reloads in development, as before. The guard is installed
// inside the factory rather than beside it, so a client taken from the global
// cannot end up with it registered twice.
export const prisma = globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
