import { commaString } from '@/utils/commaString'

describe('commaString', () => {
  it('returns just the digits for a small number under 1000', () => {
    expect(commaString(42)).toBe('42')
  })

  it('returns a single comma group for exactly 1000', () => {
    expect(commaString(1000)).toBe('1,000')
  })

  it('inserts multiple comma separators for a large number', () => {
    expect(commaString(1234567)).toBe('1,234,567')
  })

  it('returns "0" for zero via the falsy-value branch', () => {
    expect(commaString(0)).toBe('0')
  })

  it('preserves the minus sign and only inserts commas among the digits for a negative number', () => {
    expect(commaString(-5000)).toBe('-5,000')
  })
})
