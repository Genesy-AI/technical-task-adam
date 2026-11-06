import { describe, it, expect } from 'vitest'
import { toCountryCode } from './countryCodes'

describe('toCountryCode', () => {
  it('normalises known ISO 3166-1 alpha-2 codes', () => {
    expect(toCountryCode('us')).toBe('US')
    expect(toCountryCode(' es ')).toBe('ES')
    expect(toCountryCode('UK')).toBe('UK')
  })

  it('returns null for unknown or empty values', () => {
    for (const value of ['XXX', '12', 'ZZ', '', undefined, null]) {
      expect(toCountryCode(value)).toBeNull()
    }
  })
})
