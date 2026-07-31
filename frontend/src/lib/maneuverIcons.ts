// Turn arrows, keyed by Valhalla's maneuver type enum.
//
// Two decisions worth stating:
//
// Only left-handed shapes are drawn. Every right-hand maneuver renders the same
// path mirrored, which halves the geometry to get right and guarantees "turn
// right" is the exact reflection of "turn left" rather than a second drawing
// that nearly matches.
//
// Nothing here reads the instruction text. Picking an arrow by searching the
// English for "left" would break the first time Valhalla rewords a phrase,
// break harder under `language`, and quietly pick wrong on "keep left to stay
// on I-30 toward Dallas". The type enum is the engine telling us what the
// maneuver is; that is what we draw.

/** The shapes actually drawn. 40-odd enum values collapse to these. */
export type IconName =
  | 'start'
  | 'arrive'
  | 'continue'
  | 'slight-left'
  | 'left'
  | 'sharp-left'
  | 'uturn'
  | 'ramp'
  | 'exit'
  | 'merge'
  | 'roundabout'
  | 'ferry'

export interface ManeuverIconSpec {
  name: IconName
  /** Render the path flipped horizontally — the right-handed variant. */
  mirrored: boolean
}

/**
 * Paths on a 24x24 grid, stroked (never filled) so one definition serves the
 * 40px banner arrow and the 16px "then" cue, with weight as a CSS knob.
 */
export const ICON_PATHS: Record<IconName, string> = {
  // Travel is upward; the vehicle enters at the bottom centre.
  start: 'M12 21V7 M12 7l-4 4 M12 7l4 4',
  arrive: 'M12 3v10 M8 17.5a4 4 0 1 0 8 0 4 4 0 1 0-8 0 M12 13v.5',
  continue: 'M12 21V4 M12 4L7.5 8.5 M12 4l4.5 4.5',
  'slight-left': 'M12 21v-8.5L7 7.5 M7 7.5h5 M7 7.5v5',
  left: 'M12 21v-9a3 3 0 0 0-3-3H5 M5 9l4.5-4.5 M5 9l4.5 4.5',
  'sharp-left': 'M14 21V13a3 3 0 0 0-3-3H6.5 M14 13l-8-4 M6.5 10l3-5 M6.5 10l5 3',
  // Up, over the top, and back down the other side.
  uturn: 'M8 21V10a4 4 0 0 1 8 0v6 M16 16l-3-3 M16 16l3-3',
  ramp: 'M8 21v-6c0-4 2-7 6-9 M14 6l-4.5.5 M14 6l1 4.5',
  exit: 'M9 21V11c0-3 1.5-5 5-6.5 M6 4v5 M6 4h5 M14 4.5l-4 .5 M14 4.5l.5 4',
  merge: 'M12 21v-7 M12 14c0-3-1.5-5-4.5-6.5 M12 14c0-3 1.5-5 4.5-6.5 M7.5 7.5l4 1 M7.5 7.5l-.5-4',
  // A ring with the entry at the bottom and the exit off to the left.
  roundabout:
    'M12 21v-5 M8.5 12a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0 M8.5 12H4 M4 12l3.5-3 M4 12l3.5 3',
  ferry: 'M4 16.5c1.5 0 1.5 1.5 3 1.5s1.5-1.5 3-1.5 1.5 1.5 3 1.5 1.5-1.5 3-1.5 1.5 1.5 3 1.5 M5.5 13h13l-2 -4h-9zM12 9V5 M9.5 5h5',
}

/**
 * Which arrow to draw for a Valhalla maneuver type.
 *
 * Never throws and never returns undefined. An unrecognised type — or no type
 * at all, which is what an older backend sends — falls through to 'continue'.
 * A missing icon is a plain arrow; a thrown error mid-drive is a blank screen.
 */
export function iconForManeuver(type?: number): ManeuverIconSpec {
  switch (type) {
    case 1: // kStart
    case 2: // kStartRight
    case 3: // kStartLeft
      return { name: 'start', mirrored: false }

    case 4: // kDestination
    case 5: // kDestinationRight
    case 6: // kDestinationLeft
      return { name: 'arrive', mirrored: false }

    case 9: // kSlightRight
      return { name: 'slight-left', mirrored: true }
    case 16: // kSlightLeft
      return { name: 'slight-left', mirrored: false }

    case 10: // kRight
      return { name: 'left', mirrored: true }
    case 15: // kLeft
      return { name: 'left', mirrored: false }

    case 11: // kSharpRight
      return { name: 'sharp-left', mirrored: true }
    case 14: // kSharpLeft
      return { name: 'sharp-left', mirrored: false }

    case 12: // kUturnRight
      return { name: 'uturn', mirrored: true }
    case 13: // kUturnLeft
      return { name: 'uturn', mirrored: false }

    // kStayRight / kStayLeft: a fork, which reads as a slight turn.
    case 23:
      return { name: 'slight-left', mirrored: true }
    case 24:
      return { name: 'slight-left', mirrored: false }

    case 18: // kRampRight
      return { name: 'ramp', mirrored: true }
    case 19: // kRampLeft
      return { name: 'ramp', mirrored: false }

    case 20: // kExitRight
      return { name: 'exit', mirrored: true }
    case 21: // kExitLeft
      return { name: 'exit', mirrored: false }

    case 25: // kMerge — unspecified side
    case 37: // kMergeRight
      return { name: 'merge', mirrored: true }
    case 38: // kMergeLeft
      return { name: 'merge', mirrored: false }

    case 26: // kRoundaboutEnter
    case 27: // kRoundaboutExit
      return { name: 'roundabout', mirrored: false }

    case 28: // kFerryEnter
    case 29: // kFerryExit
      return { name: 'ferry', mirrored: false }

    // 0 kNone, 7 kBecomes, 8 kContinue, 17 kRampStraight, 22 kStayStraight,
    // 30-36 transit (unreachable for these costings, but must not fall
    // through to undefined), 39-43 elevator/steps/escalator/building.
    default:
      return { name: 'continue', mirrored: false }
  }
}
