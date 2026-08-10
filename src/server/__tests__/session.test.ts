import { describe, expect, it } from 'vitest'
import { AuthorizationError, assertRole, type SessionActor } from '@/server/session'

const actor = (role: SessionActor['role'], buyerId: string | null = null): SessionActor => ({
  userId: 'u1',
  orgId: 'o1',
  role,
  buyerId,
  fullName: 'Test User',
  email: 'test@example.com'
})

describe('assertRole', () => {
  it('allows a permitted role', () => {
    expect(() => assertRole(actor('ADMIN'), ['ADMIN', 'AGENT'])).not.toThrow()
    expect(() => assertRole(actor('AGENT'), ['ADMIN', 'AGENT'])).not.toThrow()
  })

  it('rejects a role outside the allowed set', () => {
    expect(() => assertRole(actor('BUYER'), ['ADMIN', 'AGENT'])).toThrow(AuthorizationError)
    expect(() => assertRole(actor('AGENT'), ['ADMIN'])).toThrow(AuthorizationError)
  })

  it('does not leak the allowed roles in the error message', () => {
    try {
      assertRole(actor('BUYER'), ['ADMIN'])
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as Error).message).not.toContain('ADMIN')
    }
  })
})
