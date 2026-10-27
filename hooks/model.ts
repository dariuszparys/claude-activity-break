// The shared clock as plain data and pure functions of it, so `update` may run
// any of them again on a version miss and the tests can reason about them.

import type { BreakClock, BreakLog, BreakSettings, BreakShared } from '../types'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE

export const DEFAULTS: BreakSettings = { isEnabled: true, minutes: 60, isStrict: false, isSoundOn: true }
export const LIMITS = { min: 15, max: 180, step: 5 }

/** A session that last checked in longer ago than this means nobody was at Claude Code. */
export const AWAY_GAP_MS = 15 * MINUTE
/** Keyboard and mouse untouched this long (macOS) counts as having stepped away. */
export const IDLE_RESET_MS = 5 * MINUTE
/** An ignored alert is raised again after this long. */
export const NAG_MS = 15 * MINUTE
/** Skips and snoozes strict mode allows per day. */
export const STRICT_ESCAPES = 2
export const SNOOZE_MINUTES = 10

export type Phase = 'disabled' | 'off' | 'sitting' | 'due'

export function clampMinutes(value: number): number {
  return Math.min(LIMITS.max, Math.max(LIMITS.min, Math.round(value)))
}

export function dayOf(ms: number): string {
  const d = new Date(ms)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')

  return `${d.getFullYear()}-${mm}-${dd}`
}

export function timeOfDay(ms: number): string {
  const d = new Date(ms)

  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function fresh(now: number, settings: BreakSettings = DEFAULTS): BreakShared {
  return {
    settings,
    clock: { startedAt: now, dueAt: now + settings.minutes * MINUTE, alertedAt: null, offUntil: null, heartbeatAt: now, round: 0 },
    log: { day: dayOf(now), breaks: 0, skips: 0, streak: 0, streakDay: null },
  }
}

/** A new stretch at the keyboard, starting now. */
export function restart(s: BreakShared, now: number): BreakShared {
  return { ...s, clock: { ...s.clock, startedAt: now, dueAt: now + s.settings.minutes * MINUTE, alertedAt: null } }
}

export function phaseOf(s: BreakShared, now: number): Phase {
  if (!s.settings.isEnabled) return 'disabled'
  if (s.clock.offUntil !== null && now < s.clock.offUntil) return 'off'

  return now < s.clock.dueAt ? 'sitting' : 'due'
}

/** How much of the stretch has passed, 0 to 1. */
export function progress(s: BreakShared, now: number): number {
  const total = s.clock.dueAt - s.clock.startedAt
  if (total <= 0) return 1

  return Math.min(1, Math.max(0, (now - s.clock.startedAt) / total))
}

// The day's counts start over on a new day.
function today(log: BreakLog, now: number): BreakLog {
  const day = dayOf(now)

  return log.day === day ? log : { ...log, day, breaks: 0, skips: 0 }
}

export function withToday(s: BreakShared, now: number): BreakShared {
  return { ...s, log: today(s.log, now) }
}

export function escapesLeft(s: BreakShared, now: number): number {
  return Math.max(0, STRICT_ESCAPES - today(s.log, now).skips)
}

/** A finished break: counted for today and the streak, and the hour starts over. */
export function finish(s: BreakShared, now: number): BreakShared {
  const log = today(s.log, now)
  const day = log.day
  const yesterday = dayOf(now - 24 * HOUR)
  const streak = log.streakDay === day ? log.streak : log.streakDay === yesterday ? log.streak + 1 : 1
  const next = restart(s, now)

  return {
    ...next,
    clock: { ...next.clock, round: s.clock.round + 1 },
    log: { ...log, breaks: log.breaks + 1, streak, streakDay: day },
  }
}

/** Skipping restarts the hour without counting a break; strict mode spends an escape. */
export function skip(s: BreakShared, now: number): BreakShared {
  const log = today(s.log, now)
  const next = restart(s, now)

  return { ...next, log: s.settings.isStrict ? { ...log, skips: log.skips + 1 } : log }
}

export function snooze(s: BreakShared, now: number, minutes: number): BreakShared {
  const log = today(s.log, now)

  return {
    ...s,
    clock: { ...s.clock, dueAt: now + minutes * MINUTE, alertedAt: null },
    log: s.settings.isStrict ? { ...log, skips: log.skips + 1 } : log,
  }
}

export function setMinutes(s: BreakShared, minutes: number, now: number): BreakShared {
  const settings = { ...s.settings, minutes: clampMinutes(minutes) }
  // A stretch under way takes the new length; one already due stays due.
  const dueAt = now >= s.clock.dueAt ? s.clock.dueAt : Math.max(now, s.clock.startedAt + settings.minutes * MINUTE)

  return { ...s, settings, clock: { ...s.clock, dueAt } }
}

export function setEnabled(s: BreakShared, isEnabled: boolean, now: number): BreakShared {
  const switched = { ...s, settings: { ...s.settings, isEnabled }, clock: { ...s.clock, offUntil: null } }

  // Turning back on starts a fresh hour rather than one already overdue.
  return isEnabled ? restart(switched, now) : switched
}

export function pauseUntil(s: BreakShared, until: number): BreakShared {
  return { ...s, clock: { ...s.clock, offUntil: until, alertedAt: null } }
}

/**
 * What a session finds when it checks in: a gap with no session alive, or a
 * pause that ran out, starts the hour over; then the heartbeat is stamped.
 */
export function checkIn(s: BreakShared, now: number, idleMs: number | undefined, isRoutineHere: boolean): BreakShared {
  let next = withToday(s, now)
  const wasAway = now - next.clock.heartbeatAt > AWAY_GAP_MS
  const isIdle = idleMs !== undefined && idleMs >= IDLE_RESET_MS && !isRoutineHere
  const pauseEnded = next.clock.offUntil !== null && now >= next.clock.offUntil

  if (pauseEnded) next = restart({ ...next, clock: { ...next.clock, offUntil: null } }, now)
  else if (next.settings.isEnabled && (wasAway || isIdle)) next = restart(next, now)

  return { ...next, clock: { ...next.clock, heartbeatAt: now } }
}

/** Whether this moment should raise the alert: due, and not raised lately. */
export function shouldAlert(s: BreakShared, now: number): boolean {
  if (phaseOf(s, now) !== 'due') return false

  return s.clock.alertedAt === null || now - s.clock.alertedAt >= NAG_MS
}

export function markAlerted(s: BreakShared, now: number): BreakShared {
  return { ...s, clock: { ...s.clock, alertedAt: now } }
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Reads the state file's JSON, filling in anything missing or malformed. */
export function parseShared(text: string | undefined, now: number): BreakShared {
  let raw: unknown
  try {
    raw = text === undefined ? undefined : JSON.parse(text)
  } catch {
    raw = undefined
  }
  if (typeof raw !== 'object' || raw === null) return fresh(now)
  const r = raw as { settings?: Record<string, unknown>; clock?: Record<string, unknown>; log?: Record<string, unknown> }
  const st = r.settings ?? {}
  const settings: BreakSettings = {
    isEnabled: bool(st.isEnabled, DEFAULTS.isEnabled),
    minutes: clampMinutes(num(st.minutes, DEFAULTS.minutes)),
    isStrict: bool(st.isStrict, DEFAULTS.isStrict),
    isSoundOn: bool(st.isSoundOn, DEFAULTS.isSoundOn),
  }
  const base = fresh(now, settings)
  const c = r.clock ?? {}
  const startedAt = num(c.startedAt, base.clock.startedAt)
  const clock: BreakClock = {
    startedAt,
    dueAt: num(c.dueAt, startedAt + settings.minutes * MINUTE),
    alertedAt: typeof c.alertedAt === 'number' ? c.alertedAt : null,
    offUntil: typeof c.offUntil === 'number' ? c.offUntil : null,
    heartbeatAt: num(c.heartbeatAt, now),
    round: Math.max(0, Math.floor(num(c.round, 0))),
  }
  const l = r.log ?? {}
  const log: BreakLog = {
    day: typeof l.day === 'string' ? l.day : base.log.day,
    breaks: Math.max(0, num(l.breaks, 0)),
    skips: Math.max(0, num(l.skips, 0)),
    streak: Math.max(0, num(l.streak, 0)),
    streakDay: typeof l.streakDay === 'string' ? l.streakDay : null,
  }

  return { settings, clock, log }
}

/** Parses `2h`, `90m`, `30` (minutes) into milliseconds. */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*(h|hr|hours?|m|min|minutes?)?$/.exec(text.trim())
  if (match === null) return undefined
  const value = Number(match[1])
  const unit = match[2] ?? 'm'

  return Math.round(value * (unit.startsWith('h') ? HOUR : MINUTE))
}

export function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
  const ss = String(seconds % 60).padStart(2, '0')

  return `${mm}:${ss}`
}
