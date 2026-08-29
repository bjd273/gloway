// The one string in the add-stop bar a driver actually reads at speed.
//
// The stores are mocked purely to keep the import graph node-safe: pulling in
// useTripStore reaches lib/voice.ts, which touches `window` at module load, and
// vitest runs this suite in node with no DOM. Nothing here renders a component.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../stores/useTripStore', () => ({
  useTripStore: Object.assign(() => undefined, { getState: () => ({}) }),
}))
vi.mock('../stores/useSheetStore', () => ({ useSheetStore: () => undefined }))

const { formatStopMeta } = await import('./AddStopBar')

const hit = (along_meters: number, detour_meters: number) => ({
  name: 'Somewhere',
  lat: 32.72,
  lon: -97.13,
  along_meters,
  detour_meters,
})

describe('formatStopMeta', () => {
  it('leads with how far ahead, because that is the decision', () => {
    expect(formatStopMeta(hit(3218, 0))).toMatch(/^2\.0 mi ahead/)
  })

  it('calls a place on the road you are already on "on the way"', () => {
    // Under 80m of offset is a forecourt you drive straight into. Reporting it
    // as "260 ft off route" reads as a warning about nothing.
    expect(formatStopMeta(hit(3218, 79))).toBe('2.0 mi ahead · on the way')
  })

  it('reports a real detour in distance, never in minutes', () => {
    // The backend sends a perpendicular offset, not a routed cost — wording it
    // as "+3 min" would be a number we never computed.
    expect(formatStopMeta(hit(3218, 400))).toBe('2.0 mi ahead · 0.2 mi off route')
  })

  it('switches to feet at short range, via formatMiles', () => {
    expect(formatStopMeta(hit(160, 200))).toBe('525 ft ahead · 656 ft off route')
  })

  it('says "right here" rather than "0 ft ahead"', () => {
    // A place beside the car projects onto the route at ~zero metres along.
    // This shipped once as "0 ft ahead · 382 ft off route".
    expect(formatStopMeta(hit(0.4, 116))).toBe('right here · 381 ft off route')
  })
})
