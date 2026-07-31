import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import type { RouteStep } from './api'
import { TurnAnnouncer } from './navAnnounce'
import type { SpeechPriority } from './voice'

const step = (over: Partial<RouteStep> = {}): RouteStep => ({
  text: 'Turn right onto Cooper Street/FM 157.',
  miles: 1,
  seconds: 60,
  verbalAlert: 'Turn right onto Cooper Street.',
  verbalPre: 'Turn right onto Cooper Street, FM 157.',
  ...over,
})

let say: Mock<(text: string, priority: SpeechPriority) => void>

beforeEach(() => {
  say = vi.fn()
})

/** Drive step `index` down through a series of distances. */
function approach(announcer: TurnAnnouncer, index: number, meters: number[]) {
  for (const m of meters) {
    announcer.update({ stepIndex: index, metersToManeuver: m, nextStepIndex: index + 1 })
  }
}

describe('TurnAnnouncer', () => {
  it('warns once on the way down through half a mile', () => {
    const announcer = new TurnAnnouncer([step()], say, () => true)
    approach(announcer, 0, [1200, 900, 700, 500])
    expect(say).toHaveBeenCalledTimes(1)
    expect(say).toHaveBeenCalledWith('Turn right onto Cooper Street.', 'turn')
  })

  it('speaks the instruction itself as the junction arrives', () => {
    const announcer = new TurnAnnouncer([step()], say, () => true)
    approach(announcer, 0, [1200, 700, 100, 30])
    expect(say.mock.calls.map((c) => c[0])).toEqual([
      'Turn right onto Cooper Street.',
      'Turn right onto Cooper Street, FM 157.',
    ])
  })

  it('stays silent when the drive begins already inside the warning distance', () => {
    // The reason this fires on crossings rather than levels: the first maneuver
    // is routinely a few hundred metres from where the car is parked, and a
    // level test would announce it the instant the driver tapped Start.
    const announcer = new TurnAnnouncer([step()], say, () => true)
    approach(announcer, 0, [400, 300, 200])
    expect(say).not.toHaveBeenCalled()
  })

  it('says only the urgent line when one update jumps past both thresholds', () => {
    // An 8x simulation tick covers 160m; a GPS gap under an overpass covers
    // more. Announcing the half-mile warning after the turn would be absurd.
    const announcer = new TurnAnnouncer([step()], say, () => true)
    approach(announcer, 0, [1200, 20])
    expect(say).toHaveBeenCalledTimes(1)
    expect(say).toHaveBeenCalledWith('Turn right onto Cooper Street, FM 157.', 'turn')
  })

  it('never repeats a step’s announcement, even if the distance rises again', () => {
    const announcer = new TurnAnnouncer([step()], say, () => true)
    approach(announcer, 0, [1200, 700, 900, 700, 600])
    expect(say).toHaveBeenCalledTimes(1)
  })

  it('suppresses the next alert when the spoken line already named that turn', () => {
    // verbal_multi_cue: "Turn right onto Cooper, then turn left." Alerting for
    // the left 800m later says the same sentence twice.
    const steps = [step({ verbalMultiCue: true }), step({ verbalAlert: 'Turn left.' })]
    const announcer = new TurnAnnouncer(steps, say, () => true)
    approach(announcer, 0, [1200, 700, 20])
    say.mockClear()

    approach(announcer, 1, [1200, 700])
    expect(say).not.toHaveBeenCalled()

    // The turn itself is still spoken — only the redundant warning is dropped.
    approach(announcer, 1, [20])
    expect(say).toHaveBeenCalledTimes(1)
  })

  it('falls back to the display text when Valhalla emitted no spoken form', () => {
    const bare = step({ verbalAlert: undefined, verbalPre: undefined })
    const announcer = new TurnAnnouncer([bare], say, () => true)
    approach(announcer, 0, [1200, 700])
    expect(say).toHaveBeenCalledWith(bare.text, 'turn')
  })

  it('prefers the succinct form over the on-screen text', () => {
    const succinct = step({
      verbalAlert: undefined,
      verbalPre: undefined,
      verbalSuccinct: 'Turn right.',
    })
    const announcer = new TurnAnnouncer([succinct], say, () => true)
    approach(announcer, 0, [1200, 700])
    expect(say).toHaveBeenCalledWith('Turn right.', 'turn')
  })

  it('says nothing at all while muted', () => {
    const announcer = new TurnAnnouncer([step()], say, () => false)
    approach(announcer, 0, [1200, 700, 20])
    expect(say).not.toHaveBeenCalled()
  })

  it('does not replay missed thresholds when unmuted mid-approach', () => {
    // Distance is tracked while muted, so unmuting is not a trigger.
    let enabled = false
    const announcer = new TurnAnnouncer([step()], say, () => enabled)
    approach(announcer, 0, [1200, 700, 500])
    enabled = true
    approach(announcer, 0, [400, 300])
    expect(say).not.toHaveBeenCalled()
    // ...but the turn still gets announced when its own threshold is crossed.
    approach(announcer, 0, [20])
    expect(say).toHaveBeenCalledTimes(1)
  })

  it('speaks nothing for steps a reroute dropped the driver past', () => {
    // A fresh announcer is built on every (re)start of navigation. If the first
    // fix lands mid-route on step 3, steps 0-2 were never seen above a
    // threshold, so nothing crosses and nothing is spoken.
    const steps = [step(), step(), step(), step()]
    const announcer = new TurnAnnouncer(steps, say, () => true)
    announcer.update({ stepIndex: 3, metersToManeuver: 300, nextStepIndex: null })
    expect(say).not.toHaveBeenCalled()
  })

  it('ignores a step index the route does not have', () => {
    const announcer = new TurnAnnouncer([step()], say, () => true)
    expect(() =>
      announcer.update({ stepIndex: 9, metersToManeuver: 10, nextStepIndex: null }),
    ).not.toThrow()
    expect(say).not.toHaveBeenCalled()
  })
})
