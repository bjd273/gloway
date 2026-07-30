import { beforeEach, describe, expect, it, vi } from 'vitest'

import { describePlace, lookupPlaceLabel, rememberPlaceLabel } from './placeLabels'

// The suite runs in vitest's default node environment (no jsdom installed), so
// stand up just enough of the Storage API. Class-based so the tests below can
// spy on Storage.prototype the same way they would in a browser.
class MemoryStorage {
  private data = new Map<string, string>()
  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value))
  }
  removeItem(key: string): void {
    this.data.delete(key)
  }
  clear(): void {
    this.data.clear()
  }
}

const store = new MemoryStorage()
Object.defineProperty(globalThis, 'Storage', { value: MemoryStorage, configurable: true })
Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true })

beforeEach(() => {
  store.clear()
  vi.restoreAllMocks()
})

describe('placeLabels', () => {
  it('round-trips a label for the coordinates it was saved at', () => {
    rememberPlaceLabel(32.7513, -97.0829, '1200 Ballpark Way')
    expect(lookupPlaceLabel(32.7513, -97.0829)).toBe('1200 Ballpark Way')
  })

  it('still matches after float wobble within ~11 m', () => {
    // The backend round-trips coordinates through JSON and Postgres; the value
    // that comes back is not bit-identical to the one that was picked.
    rememberPlaceLabel(32.75131111, -97.08289999, 'Globe Life Field')
    expect(lookupPlaceLabel(32.7513, -97.0829)).toBe('Globe Life Field')
  })

  it('does not match a genuinely different address', () => {
    rememberPlaceLabel(32.7513, -97.0829, 'Globe Life Field')
    expect(lookupPlaceLabel(32.7601, -97.1155)).toBeNull()
  })

  it('ignores an empty or whitespace label', () => {
    rememberPlaceLabel(32.75, -97.08, '   ')
    expect(lookupPlaceLabel(32.75, -97.08)).toBeNull()
  })

  it('trims what it stores', () => {
    rememberPlaceLabel(32.75, -97.08, '  Home  ')
    expect(lookupPlaceLabel(32.75, -97.08)).toBe('Home')
  })

  it('keeps labels for different places side by side', () => {
    rememberPlaceLabel(32.7513, -97.0829, 'Globe Life Field')
    rememberPlaceLabel(32.7357, -97.1081, 'UTA')
    expect(lookupPlaceLabel(32.7513, -97.0829)).toBe('Globe Life Field')
    expect(lookupPlaceLabel(32.7357, -97.1081)).toBe('UTA')
  })
})

describe('describePlace', () => {
  it('prefers the remembered name', () => {
    rememberPlaceLabel(32.7513, -97.0829, '1200 Ballpark Way')
    expect(describePlace(32.7513, -97.0829)).toBe('1200 Ballpark Way')
  })

  it('falls back to coordinates on a cold cache', () => {
    // A new device has no cache — the row must still say something true
    // rather than blank.
    expect(describePlace(32.7513, -97.0829)).toBe('32.7513, -97.0829')
  })
})

describe('storage failures', () => {
  it('treats unreadable storage as simply having no label', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: private mode')
    })
    expect(() => describePlace(32.75, -97.08)).not.toThrow()
    expect(describePlace(32.75, -97.08)).toBe('32.7500, -97.0800')
    vi.restoreAllMocks()
  })

  it('survives hand-edited junk in storage', () => {
    localStorage.setItem('gloway:placeLabels', 'not json')
    expect(lookupPlaceLabel(32.75, -97.08)).toBeNull()
  })

  it('does not throw when writing is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => rememberPlaceLabel(32.75, -97.08, 'Home')).not.toThrow()
    vi.restoreAllMocks()
  })
})
