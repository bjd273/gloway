// Speaks each turn twice: a warning while there is still time to change lanes,
// and the instruction itself as the junction arrives.
//
// The words are Valhalla's, not ours. `verbal_transition_alert_instruction` and
// `verbal_pre_transition_instruction` are written for exactly these two moments
// and read far better aloud than the on-screen text ("Turn right onto South
// Cooper Street, FM 157" rather than "Turn right onto South Cooper Street/FM
// 157. Continue on FM 157."). They were arriving in every response and being
// discarded.
import type { RouteStep } from './api'
import type { ManeuverProgress } from './maneuvers'
import type { SpeechPriority } from './voice'

/** ~half a mile: far enough out to change lanes or think about an exit. */
const ALERT_METERS = 800
/** ~150 feet: the turn is happening now. */
const PRE_METERS = 46

type Say = (text: string, priority: SpeechPriority) => void

export class TurnAnnouncer {
  private readonly alerted = new Set<number>()
  private readonly preSpoken = new Set<number>()
  private readonly lastMeters = new Map<number, number>()
  private readonly suppressAlertFor = new Set<number>()

  private readonly steps: RouteStep[]
  private readonly say: Say
  private readonly enabled: () => boolean

  constructor(steps: RouteStep[], say: Say, enabled: () => boolean) {
    this.steps = steps
    this.say = say
    this.enabled = enabled
  }

  update({ stepIndex, metersToManeuver }: ManeuverProgress): void {
    const firstSighting = !this.lastMeters.has(stepIndex)
    const previous = this.lastMeters.get(stepIndex) ?? Infinity
    this.lastMeters.set(stepIndex, metersToManeuver)

    // Seeing a step for the first time already inside the warning distance is
    // not an approach — it is the drive starting a few hundred metres from its
    // first turn, or a reroute landing the driver mid-route. Announcing "in a
    // half mile" then would be wrong about the distance and would fire while
    // the car is still on the driveway, so the warning is marked spent. The
    // turn itself is still announced when its own threshold is crossed.
    if (firstSighting && metersToManeuver <= ALERT_METERS) this.alerted.add(stepIndex)

    // Muting still tracks distance, so unmuting mid-drive doesn't immediately
    // fire every threshold the drive has already passed.
    if (!this.enabled()) return

    const step = this.steps[stepIndex]
    if (!step) return

    /**
     * Did this update cross the threshold, coming down?
     *
     * A level test ("are we under 800m?") would be wrong twice over. The first
     * maneuver is routinely less than half a mile from where the car is parked,
     * so it would announce "in a half mile, turn right" the instant the driver
     * tapped Start while still on the driveway. And at 8x simulation a single
     * tick covers 160m, so any level test fires on a tick that has already
     * blown past the threshold anyway.
     */
    const crossed = (threshold: number) =>
      previous > threshold && metersToManeuver <= threshold

    // Pre before alert, deliberately. When one update jumps past both — an 8x
    // sim tick, or a GPS gap through an underpass — the urgent line is the one
    // worth saying, and marking the alert spent stops a "in a half mile..."
    // arriving after the turn it was warning about.
    if (crossed(PRE_METERS) && !this.preSpoken.has(stepIndex)) {
      this.preSpoken.add(stepIndex)
      this.alerted.add(stepIndex)
      this.say(this.textFor(step, 'pre'), 'turn')
      // verbal_multi_cue means this line already named the following maneuver
      // ("turn right onto Cooper, then turn left"). Alerting for that one 800m
      // later would say the same sentence twice.
      if (step.verbalMultiCue) this.suppressAlertFor.add(stepIndex + 1)
      return
    }

    if (
      crossed(ALERT_METERS) &&
      !this.alerted.has(stepIndex) &&
      !this.suppressAlertFor.has(stepIndex)
    ) {
      this.alerted.add(stepIndex)
      this.say(this.textFor(step, 'alert'), 'turn')
    }
  }

  /** Valhalla omits the verbal forms on some maneuvers and builds; falling back
   * to the display text reads a little clunkier than going silent, and going
   * silent is the worse failure. */
  private textFor(step: RouteStep, moment: 'alert' | 'pre'): string {
    if (moment === 'pre') return step.verbalPre ?? step.verbalSuccinct ?? step.text
    return step.verbalAlert ?? step.verbalSuccinct ?? step.text
  }
}
