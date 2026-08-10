import { describe, expect, it } from 'vitest'
import { CreateAgentSchema } from '@/server/services/team'

const valid = { fullName: 'Tunde Bakare', email: 'tunde@sunrise.test', password: 'password123' }

describe('CreateAgentSchema', () => {
  it('accepts a valid agent', () => {
    expect(CreateAgentSchema.safeParse(valid).success).toBe(true)
  })

  it('lowercases the email', () => {
    expect(CreateAgentSchema.parse({ ...valid, email: 'Tunde@Sunrise.TEST' }).email)
      .toBe('tunde@sunrise.test')
  })

  it('requires a password of at least 8 characters', () => {
    expect(CreateAgentSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false)
  })

  it('rejects an invalid email', () => {
    expect(CreateAgentSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(false)
  })

  it('rejects a blank name', () => {
    expect(CreateAgentSchema.safeParse({ ...valid, fullName: ' ' }).success).toBe(false)
  })
})
