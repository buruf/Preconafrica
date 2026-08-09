import { describe, expect, it } from 'vitest'

describe('test harness', () => {
  it('runs and supports BigInt literals', () => {
    expect(25_000_000_000n + 1n).toBe(25_000_000_001n)
  })
})
