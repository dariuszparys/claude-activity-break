export type BreakSettings = {
  /** The master switch: off, the mod shows nothing and holds nothing, in every session. */
  isEnabled: boolean
  /** Minutes of sitting before a break is due. */
  minutes: number
  /** Strict mode: new prompts are held while a break is due. */
  isStrict: boolean
  isSoundOn: boolean
}

export type BreakClock = {
  /** Epoch ms the current stretch at the keyboard began. */
  startedAt: number
  /** Epoch ms the break is due; a snooze moves it. */
  dueAt: number
  /** Epoch ms a session last raised the alert for this stretch; null before the first. */
  alertedAt: number | null
  /** Epoch ms breaks stay off until; null while on. */
  offUntil: number | null
  /** Epoch ms any session last checked in. */
  heartbeatAt: number
  /** Breaks finished in all. */
  round: number
}

export type BreakLog = {
  /** Local day the counts belong to, YYYY-MM-DD. */
  day: string
  breaks: number
  /** Skips and snoozes used today in strict mode. */
  skips: number
  /** Days in a row with at least one break. */
  streak: number
  streakDay: string | null
}

/** What every session shares through the state file. */
export type BreakShared = {
  settings: BreakSettings
  clock: BreakClock
  log: BreakLog
}

/** The routine this session is running; other sessions only see its end. */
export type BreakRoutine = {
  status: 'running' | 'paused'
  /** Exercise ids, in order. */
  exercises: string[]
  step: number
  leftMs: number
  /** Strict mode on macOS: the step waits while keyboard or mouse are in use. */
  isHeld: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'activity-break': {
      shared: BreakShared
      now: number
      routine: BreakRoutine | null
      isSettingsOpen: boolean
      /** A prompt strict mode held back, put back once the break is done. */
      held: string | null
    }
  }
}
