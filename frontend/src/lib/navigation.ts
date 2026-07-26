// Drives a live position along the selected route and streams it to the
// backend exactly as a real device would — same batch pipeline, same
// /gps-update endpoint. This is the ACTIVE_NAVIGATION source.
//
// In this dev/demo environment the driver (and their browser's real GPS) is
// nowhere near the Arlington tiles, so a real `watchPosition` would sit
// off-map. The controller therefore SIMULATES progress along the route's
// coordinates. On an actual in-region device, swap `tick`'s synthetic step for
// `navigator.geolocation.watchPosition` fixes — everything downstream (the
// buffer, batching, streaming, the live puck) is identical.
import { streamGpsPoints } from './api'

const TICK_MS = 800 // emit a position this often
const FLUSH_MS = 3000 // send buffered points to the backend this often
const TARGET_TICKS = 45 // ~36s to "drive" any route, regardless of coord count

export interface DrivePosition {
  lng: number
  lat: number
}

interface DriveHandlers {
  onPosition: (p: DrivePosition) => void
  onProgress: (fraction: number) => void // 0..1 along the route
  onArrive: () => void
}

export class DriveController {
  private readonly tripId: string
  private readonly coords: [number, number][] // [lng, lat] along the route
  private readonly handlers: DriveHandlers
  private tickTimer?: ReturnType<typeof setInterval>
  private flushTimer?: ReturnType<typeof setInterval>
  private buffer: { lat: number; lon: number; timestamp: string }[] = []
  private idx = 0
  private stride: number
  private done = false

  constructor(tripId: string, coords: [number, number][], handlers: DriveHandlers) {
    this.tripId = tripId
    this.coords = coords
    this.handlers = handlers
    this.stride = Math.max(1, Math.round(coords.length / TARGET_TICKS))
  }

  start(): void {
    if (this.coords.length < 2) {
      this.handlers.onArrive()
      return
    }
    this.tickTimer = setInterval(() => this.tick(), TICK_MS)
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_MS)
  }

  private tick(): void {
    if (this.done) return
    this.idx = Math.min(this.idx + this.stride, this.coords.length - 1)
    const [lng, lat] = this.coords[this.idx]
    this.handlers.onPosition({ lng, lat })
    this.handlers.onProgress(this.idx / (this.coords.length - 1))
    this.buffer.push({ lat, lon: lng, timestamp: new Date().toISOString() })
    if (this.idx >= this.coords.length - 1) this.arrive()
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    const batch = this.buffer
    this.buffer = []
    await streamGpsPoints(this.tripId, batch)
  }

  private arrive(): void {
    if (this.done) return
    this.done = true
    this.clearTimers()
    void this.flush()
    this.handlers.onArrive()
  }

  /** Stop streaming without firing onArrive (user ended the drive manually). */
  stop(): void {
    if (this.done) return
    this.done = true
    this.clearTimers()
    void this.flush()
  }

  private clearTimers(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    if (this.flushTimer) clearInterval(this.flushTimer)
  }
}
