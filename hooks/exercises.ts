// A break is two plain steps: stand up, then walk. The point is to leave the
// chair for two minutes, not to follow a workout.

export type Exercise = {
  id: string
  name: string
  how: string
  seconds: number
}

const STEPS: readonly Exercise[] = [
  { id: 'stand-up', name: 'Stand up', how: 'Stand up, stretch, and look away from the screen.', seconds: 30 },
  { id: 'walk', name: 'Walk around', how: 'Walk around the room, get some water, take the stairs.', seconds: 90 },
]

const BY_ID = new Map(STEPS.map(x => [x.id, x]))

export function exercise(id: string): Exercise {
  return BY_ID.get(id) ?? STEPS[0]!
}

export function routineSteps(): string[] {
  return STEPS.map(x => x.id)
}

/** `30 s`, `1:30 min`. */
export function span(seconds: number): string {
  if (seconds < 60) return `${seconds} s`

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} min`
}
