import { afterEach, describe, expect, it, vi } from 'vitest'

import { requestCurrentLocation, resolveOrigin } from './geolocate'

const MAP_CENTER = { lng: -97.11, lat: 32.735, label: 'Map center' }
// Inside the Arlington bbox the app is tiled for.
const IN_REGION = { latitude: 32.75, longitude: -97.09 }
// Chicago — well outside it.
const OUT_OF_REGION = { latitude: 41.88, longitude: -87.63 }

function stubGeolocation(
  impl: (ok: PositionCallback, fail: PositionErrorCallback) => void,
) {
  Object.defineProperty(navigator, 'geolocation', {
    value: { getCurrentPosition: impl },
    configurable: true,
  })
}

function removeGeolocation() {
  Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true })
}

const grants = (coords: { latitude: number; longitude: number }) =>
  (ok: PositionCallback) => ok({ coords } as GeolocationPosition)

const rejects = (code: number) => (_ok: PositionCallback, fail: PositionErrorCallback) =>
  fail({ code } as GeolocationPositionError)

afterEach(() => {
  vi.useRealTimers()
  removeGeolocation()
})

describe('resolveOrigin (routing path — never nags)', () => {
  it('uses the device location when it is inside the region', async () => {
    stubGeolocation(grants(IN_REGION))
    await expect(resolveOrigin(MAP_CENTER)).resolves.toMatchObject({
      lat: 32.75,
      lng: -97.09,
      label: 'Current location',
    })
  })

  it('falls back to the map centre when permission is denied', async () => {
    stubGeolocation(rejects(1))
    await expect(resolveOrigin(MAP_CENTER)).resolves.toEqual(MAP_CENTER)
  })

  it('falls back to the map centre when the fix is outside the region', async () => {
    stubGeolocation(grants(OUT_OF_REGION))
    await expect(resolveOrigin(MAP_CENTER)).resolves.toEqual(MAP_CENTER)
  })

  it('falls back when the browser has no geolocation at all', async () => {
    removeGeolocation()
    await expect(resolveOrigin(MAP_CENTER)).resolves.toEqual(MAP_CENTER)
  })
})

describe('requestCurrentLocation (explicit tap — must report failure)', () => {
  it('returns the place when the fix is good and in region', async () => {
    stubGeolocation(grants(IN_REGION))
    const result = await requestCurrentLocation()
    expect(result).toEqual({
      ok: true,
      place: { lat: 32.75, lng: -97.09, label: 'Current location' },
    })
  })

  it('reports denial instead of silently substituting the map centre', async () => {
    // This is the whole point of the second function. If it fell back like
    // resolveOrigin does, tapping "use my current location" with location
    // blocked would save whatever the map happened to be centred on as the
    // user's home address, and say nothing.
    stubGeolocation(rejects(1))
    expect(await requestCurrentLocation()).toEqual({ ok: false, reason: 'denied' })
  })

  it('reports a timeout distinctly from a denial', async () => {
    stubGeolocation(rejects(3))
    expect(await requestCurrentLocation()).toEqual({ ok: false, reason: 'timeout' })
  })

  it('reports position-unavailable as retryable', async () => {
    stubGeolocation(rejects(2))
    expect(await requestCurrentLocation()).toEqual({ ok: false, reason: 'timeout' })
  })

  it('reports an out-of-region fix rather than accepting it', async () => {
    stubGeolocation(grants(OUT_OF_REGION))
    expect(await requestCurrentLocation()).toEqual({ ok: false, reason: 'out-of-region' })
  })

  it('reports unsupported when the browser has no geolocation', async () => {
    removeGeolocation()
    expect(await requestCurrentLocation()).toEqual({ ok: false, reason: 'unsupported' })
  })
})
