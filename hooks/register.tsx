import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { BreakRoutine, BreakShared } from '../types'
import { exercise, routineSteps, span } from './exercises'
import {
  MINUTE,
  LIMITS,
  SNOOZE_MINUTES,
  checkIn,
  clock,
  escapesLeft,
  finish,
  fresh,
  markAlerted,
  parseDuration,
  parseShared,
  pauseUntil,
  phaseOf,
  progress,
  setEnabled,
  setMinutes,
  shouldAlert,
  skip,
  snooze,
  timeOfDay,
} from './model'

const PANE = 'activity-break'
const TITLE = 'Activity break'
const CHIME = 'sounds/chime.wav'
const SYNC_MS = 15_000
const DEFAULT_OFF_MS = 2 * 60 * MINUTE
// While a routine waits for the hands to leave the keyboard (strict, macOS),
// input this recent holds the step clock.
const HANDS_OFF_MS = 1500
const ACCENT = { due: '#C2410C', calm: '#1D4ED8' }

const shared = atom({ plugin: 'activity-break', key: 'shared' } as const, fresh(0))
const now = atom({ plugin: 'activity-break', key: 'now' } as const, 0)
const routine = atom({ plugin: 'activity-break', key: 'routine' } as const, null)
const isSettingsOpen = atom({ plugin: 'activity-break', key: 'isSettingsOpen' } as const, false)
const held = atom({ plugin: 'activity-break', key: 'held' } as const, null)

// Module variables start over on a hot reload; session.start sets them again.
let ticker: Timer | undefined
let syncer: Timer | undefined
let statePath: string | undefined
let lastTickAt: number | undefined
let lastStatus: string | undefined
let wasEnabled: boolean | undefined
let hasIdleProbe: boolean | undefined
let isAlerting = false
let isInteractive = true

// The shared clock lives in a file of its own, not `$.store`: every session
// and every installed copy of the mod reads the same deadline from disk.
async function pathOf($: EngineInterface): Promise<string> {
  if (statePath !== undefined) return statePath
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await $.env.get('HOME')
  statePath = `${configDir ?? `${home ?? '.'}/.claude`}/activity-break.json`

  return statePath
}

async function load($: EngineInterface, t: number): Promise<BreakShared> {
  const text = await $.fs.read(await pathOf($)).catch(() => undefined)

  return parseShared(typeof text === 'string' ? text : undefined, t)
}

// Read, change, write back, then publish to this session's drawings. Two
// sessions writing in the same instant is the one race: the later one wins.
async function change($: EngineInterface, fn: (s: BreakShared, t: number) => BreakShared): Promise<BreakShared> {
  const t = await $.clock.now()
  const next = fn(await load($, t), t)
  await $.fs.write(await pathOf($), `${JSON.stringify(next, null, 2)}\n`)
  await publish($, next, t)

  return next
}

async function publish($: EngineInterface, s: BreakShared, t: number): Promise<void> {
  await update($, shared, () => s)
  await update($, now, () => t)
  await applySwitch($, s)
  showStatus(s, await read($, routine), t, $)
}

// macOS keeps the time since the last key or pointer event; elsewhere there is
// no ioreg and the mod goes without.
async function idleMs($: EngineInterface): Promise<number | undefined> {
  if (hasIdleProbe === false) return undefined
  try {
    const { exitCode, stdout } = await $.process.run(['ioreg', '-c', 'IOHIDSystem', '-d', '4'], { timeoutMs: 3000 })
    const match = /"HIDIdleTime" = (\d+)/.exec(stdout)
    hasIdleProbe = exitCode === 0 && match !== null
    if (!hasIdleProbe || match === null) return undefined

    return Number(match[1]) / 1e6
  } catch {
    hasIdleProbe = false

    return undefined
  }
}

function bar(p: number, width: number): string {
  const filled = Math.min(width, Math.floor(p * width))

  return '▰'.repeat(filled) + '▱'.repeat(width - filled)
}

function statusText(s: BreakShared, r: BreakRoutine | null, t: number): string | undefined {
  const phase = phaseOf(s, t)
  if (phase === 'disabled') return undefined
  if (r !== null) {
    const note = r.status === 'paused' ? ' (paused)' : r.isHeld ? ' · hands off the keyboard' : ''

    return `break ${r.step + 1}/${r.exercises.length} · ${clock(r.leftMs)}${note}`
  }
  if (phase === 'off') return `move · off until ${timeOfDay(s.clock.offUntil ?? t)}`
  if (phase === 'due') return `MOVE ${bar(1, 10)} break due${s.settings.isStrict ? ' · prompts held' : ''}`

  return `move ${bar(progress(s, t), 10)} ${Math.ceil((s.clock.dueAt - t) / MINUTE)}m`
}

function showStatus(s: BreakShared, r: BreakRoutine | null, t: number, $: EngineInterface): void {
  const text = statusText(s, r, t)
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

// `Stand up 30 s → Walk around 1:30 min`
function plan(ids: readonly string[]): string {
  return ids.map(id => `${exercise(id).name} ${span(exercise(id).seconds)}`).join(' → ')
}

function chime($: EngineInterface, s: BreakShared): void {
  if (s.settings.isSoundOn) void $.audio.play({ asset: CHIME }).catch(() => undefined)
}

function stopTicker(): void {
  ticker?.cancel()
  ticker = undefined
}

function startTicker($: EngineInterface): void {
  stopTicker()
  ticker = $.clock.every(1000, () => {
    void tick($).catch(err => $.ui.log(`activity-break: tick failed: ${String(err)}`, { to: 'debug' }))
  })
}

// The master switch, seen from any session: off stops the clock, the status
// line, the pane and the gate here too.
async function applySwitch($: EngineInterface, s: BreakShared): Promise<void> {
  const isEnabled = s.settings.isEnabled
  if (isEnabled === wasEnabled) return
  const isFirst = wasEnabled === undefined
  wasEnabled = isEnabled
  if (isEnabled) {
    startTicker($)
    if (!isFirst) void $.ui.open({ id: PANE, title: TITLE })

    return
  }
  stopTicker()
  lastStatus = undefined
  $.ui.status(undefined)
  await update($, routine, () => null)
  if (!isFirst) await $.ui.close({ id: PANE }).catch(() => undefined)
}

async function sync($: EngineInterface): Promise<void> {
  const before = await read($, shared)
  const r = await read($, routine)
  const idle = before.settings.isEnabled ? await idleMs($) : undefined
  const after = await change($, (s, t) => checkIn(s, t, idle, r !== null))
  const t = await $.clock.now()
  // A break finished in another session lifts the gate here as well.
  if (phaseOf(after, t) !== 'due') await giveBack($)
}

async function tick($: EngineInterface): Promise<void> {
  const t = await $.clock.now()
  await update($, now, () => t)
  const s = await read($, shared)
  let r = await read($, routine)
  if (r !== null && r.status === 'running') r = await advance($, r, s, t)
  else lastTickAt = t
  if (r === null && shouldAlert(s, t)) await alert($)
  showStatus(await read($, shared), r, t, $)
}

// Raised by whichever session gets there first: it writes `alertedAt`, and
// the others see it on their next check and stay quiet. A `claude -p` run or
// an SDK job with nothing attached never claims it, so it never chimes.
async function alert($: EngineInterface): Promise<void> {
  if (isAlerting) return
  if (!isInteractive && (await $.session.surfaces()).length === 0) return
  isAlerting = true
  try {
    let isMine = false
    const s = await change($, (s, t) => {
      isMine = shouldAlert(s, t)

      return isMine ? markAlerted(s, t) : s
    })
    if (!isMine) return

    const text = `Time to move: ${s.settings.minutes} min at the keyboard. ${plan(routineSteps())}.`
    chime($, s)
    $.ui.toast(text, { timeoutMs: 15_000 })
    void $.ui.notify(text, { title: TITLE }).catch(() => undefined)
    void $.ui.open({ id: PANE, title: TITLE })
  } finally {
    isAlerting = false
  }
}

async function advance($: EngineInterface, r: BreakRoutine, s: BreakShared, t: number): Promise<BreakRoutine | null> {
  // Capped, so a laptop waking from sleep does not skip through the routine.
  const dt = Math.min(2000, Math.max(0, t - (lastTickAt ?? t - 1000)))
  lastTickAt = t
  const idle = s.settings.isStrict ? await idleMs($) : undefined
  const isHeld = idle !== undefined && idle < HANDS_OFF_MS
  const leftMs = isHeld ? r.leftMs : r.leftMs - dt

  if (leftMs > 0) return update($, routine, c => (c === null ? c : { ...c, leftMs, isHeld }))
  if (r.step + 1 >= r.exercises.length) {
    await finishBreak($, 'routine')

    return null
  }
  const x = exercise(r.exercises[r.step + 1]!)
  chime($, s)

  return update($, routine, c => (c === null ? c : { ...c, step: c.step + 1, leftMs: x.seconds * 1000, isHeld: false }))
}

async function startBreak($: EngineInterface): Promise<string> {
  const t = await $.clock.now()
  const s = await read($, shared)
  if (phaseOf(s, t) === 'disabled') return 'Activity break is turned off. Turn it on with /activity on.'
  const exercises = routineSteps()
  const first = exercise(exercises[0]!)
  await update($, routine, () => ({ status: 'running', exercises, step: 0, leftMs: first.seconds * 1000, isHeld: false }))
  lastTickAt = t
  // Marked as alerted, so another session does not nag in the middle of it.
  await change($, (c, at) => (phaseOf(c, at) === 'due' ? markAlerted(c, at) : c))
  startTicker($)
  void $.ui.open({ id: PANE, title: TITLE })

  return `Break started: ${plan(exercises)}.`
}

async function finishBreak($: EngineInterface, how: 'routine' | 'away'): Promise<string> {
  await update($, routine, () => null)
  const s = await change($, finish)
  const text = `Break done${how === 'away' ? ' (counted as away)' : ''}. ${s.log.breaks} today. Next one in ${s.settings.minutes} min.`
  if (how === 'routine') chime($, s)
  $.ui.toast(text, { timeoutMs: 8000 })
  await giveBack($)

  return text
}

// The prompt strict mode held goes back into the prompt box, or, where the
// box cannot take it, into a toast.
async function giveBack($: EngineInterface): Promise<void> {
  const text = await read($, held)
  if (text === null) return
  await update($, held, () => null)
  const box = await $.prompt.read().catch(() => undefined)
  const filled = await $.prompt.fill({ text, mode: box?.text ? 'append' : 'replace' }).catch(() => undefined)
  if (filled?.isFilled !== true) $.ui.toast(`Your held prompt: ${text.slice(0, 300)}`, { timeoutMs: 20_000 })
}

async function useEscape($: EngineInterface, apply: (s: BreakShared, t: number) => BreakShared, said: string): Promise<string> {
  const t = await $.clock.now()
  const s = await read($, shared)
  if (s.settings.isStrict && escapesLeft(s, t) === 0) {
    return 'No skips left today in strict mode. Take the break (/activity start), or turn breaks off for a while (/activity off 2h).'
  }
  await update($, routine, () => null)
  const after = await change($, apply)
  await giveBack($)
  const left = after.settings.isStrict ? ` ${escapesLeft(after, t)} skips left today.` : ''

  return `${said}${left}`
}

async function setSwitch($: EngineInterface, isEnabled: boolean): Promise<string> {
  await change($, (s, t) => setEnabled(s, isEnabled, t))
  if (!isEnabled) await giveBack($)

  return isEnabled
    ? 'Activity break is on. The hour starts now.'
    : 'Activity break is off in every session, until /activity on.'
}

function describe(s: BreakShared, r: BreakRoutine | null, t: number): string {
  const phase = phaseOf(s, t)
  const mode = `${s.settings.minutes} min${s.settings.isStrict ? ', strict' : ''}`
  if (phase === 'disabled') return 'Activity break is off. /activity on turns it back on.'
  if (r !== null) return `Break ${r.step + 1} of ${r.exercises.length}: ${exercise(r.exercises[r.step]!).name}, ${clock(r.leftMs)} left.`
  if (phase === 'off') return `Activity break is paused until ${timeOfDay(s.clock.offUntil ?? t)} (${mode}).`
  if (phase === 'due') return `Break due (${mode}). /activity start begins it. ${s.log.breaks} breaks today.`

  return `Next break in ${clock(s.clock.dueAt - t)} (${mode}). ${s.log.breaks} breaks today, streak ${s.log.streak} days.`
}

const USAGE = [
  'Usage: /activity [start|done|away|snooze [min]|skip|off [2h]|on|strict on|off|sound on|off|<minutes>]',
  '  /activity           status, and opens the pane',
  '  /activity start     start the break routine now',
  '  /activity 45        a break every 45 minutes',
  '  /activity off       turn the mod off in every session, until /activity on',
  '  /activity off 2h    pause breaks for two hours',
].join('\n')

async function boot($: EngineInterface): Promise<void> {
  if (syncer !== undefined) return
  syncer = $.clock.every(SYNC_MS, () => {
    void sync($).catch(err => $.ui.log(`activity-break: sync failed: ${String(err)}`, { to: 'debug' }))
  })
  const s = await change($, (c, t) => checkIn(c, t, undefined, false))
  if (s.settings.isEnabled) void $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'activity',
      description: 'Activity break: status, start or skip a break, set the minutes, or turn the mod off and on',
      argumentHint: '[start|snooze|skip|off|on|strict on|off|<minutes>]',
      immediate: true,
    })
    isInteractive = e.isInteractive
    await boot($)

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    await boot($)

    return next(e)
  })

  on('command.run', { command: 'activity' }, async ($, e) => {
    const args = e.args.trim().toLowerCase()
    const [word = '', value = ''] = args.split(/\s+/)
    const isOn = value === 'on' || value === 'true'
    const isToggle = value === 'on' || value === 'off' || value === 'true' || value === 'false'

    if (word === '' || word === 'open' || word === 'status') {
      const opened = await $.ui.open({ id: PANE, title: TITLE })
      const t = await $.clock.now()
      const text = describe(await read($, shared), await read($, routine), t)

      return { text: opened.isPlaced ? text : `${text} The pane is waiting for room: ${opened.reason}` }
    }
    if (word === 'on' || word === 'enable') return { text: await setSwitch($, true) }
    if ((word === 'off' || word === 'disable') && value === '') return { text: await setSwitch($, false) }
    if (word === 'off' || word === 'pause') {
      const ms = parseDuration(value) ?? DEFAULT_OFF_MS
      const s = await change($, (c, t) => pauseUntil(c, t + ms))
      await update($, routine, () => null)
      await giveBack($)

      return { text: `Breaks paused until ${timeOfDay(s.clock.offUntil ?? 0)}. /activity on resumes them.` }
    }

    const s = await read($, shared)
    if (!s.settings.isEnabled) return { text: 'Activity break is off. /activity on turns it back on.' }

    if (word === 'start' || word === 'now') return { text: await startBreak($) }
    if (word === 'done' || word === 'away') {
      if (s.settings.isStrict) return { text: 'Strict mode counts a break only when the routine finishes: /activity start.' }

      return { text: await finishBreak($, 'away') }
    }
    if (word === 'snooze') {
      const minutes = Number(value || SNOOZE_MINUTES)
      if (!Number.isFinite(minutes) || minutes <= 0) return { text: USAGE }

      return { text: await useEscape($, (c, t) => snooze(c, t, minutes), `Snoozed for ${minutes} min.`) }
    }
    if (word === 'skip') return { text: await useEscape($, skip, 'Skipped. The hour starts over.') }
    if ((word === 'strict' || word === 'sound') && isToggle) {
      const key = word === 'strict' ? 'isStrict' : 'isSoundOn'
      await change($, c => ({ ...c, settings: { ...c.settings, [key]: isOn } }))
      if (word === 'strict' && !isOn) await giveBack($)

      return { text: `${word[0]!.toUpperCase()}${word.slice(1)} ${isOn ? 'on' : 'off'}.` }
    }
    const minutes = Number(word)
    if (value === '' && Number.isFinite(minutes) && minutes > 0) {
      const after = await change($, (c, t) => setMinutes(c, minutes, t))

      return { text: describe(after, await read($, routine), await $.clock.now()) }
    }

    return { text: USAGE }
  })

  // Strict mode: while a break is due, the person's own prompts wait. Slash
  // commands, notifications and other sessions' messages go through, and so
  // does everything if this hook fails: a broken gate never blocks work.
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || e.isMeta === true) return next(e)
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)
    const t = await $.clock.now()
    // Read fresh: another session may have finished the break a moment ago.
    const s = await load($, t)
    await update($, shared, () => s)
    if (!s.settings.isStrict || phaseOf(s, t) !== 'due') return next(e)

    await update($, held, () => e.text)

    return {
      drop: `Activity break due after ${s.settings.minutes} min at the keyboard. Your prompt is held and comes back when the break is done. Start it above the prompt or with /activity start (/activity skip: ${escapesLeft(s, t)} left today).`,
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const s = await read($, shared)
    const r = await read($, routine)
    const t = await $.clock.now()
    const phase = phaseOf(s, t)
    if (phase === 'disabled' || phase === 'off') return next(e)
    if (r === null && phase !== 'due') return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)

    if (r !== null) {
      const x = exercise(r.exercises[r.step]!)

      return (
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          <Text color="suggestion" bold>
            Break {r.step + 1}/{r.exercises.length}
          </Text>
          <Text>
            {x.name} · {clock(r.leftMs)}
            {r.isHeld ? ' · hands off the keyboard' : ''}
          </Text>
          <Button
            key="band-pause"
            label={r.status === 'paused' ? 'Resume' : 'Pause'}
            hotkey="1"
            onPress={() => void togglePause($)}
          />
          <Button key="band-next" label="Next" hotkey="2" onPress={() => void nextExercise($)} />
        </Box>
      )
    }

    const left = escapesLeft(s, t)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text color="warning" bold>
            MOVE
          </Text>
          <Text>
            {s.settings.minutes} min at the keyboard · {plan(routineSteps())}
          </Text>
        </Box>
        {s.settings.isStrict && <Text dimColor>Prompts are held until the break is done.</Text>}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="band-start" label="Start" hotkey="1" variant="primary" onPress={() => void startBreak($)} />
          <Button
            key="band-snooze"
            label={`Snooze ${SNOOZE_MINUTES}`}
            hotkey="2"
            onPress={() => void useEscape($, (c, at) => snooze(c, at, SNOOZE_MINUTES), '')}
          />
          {s.settings.isStrict ? (
            <Button key="band-skip" label={`Skip · ${left} left`} hotkey="3" onPress={() => void useEscape($, skip, '')} />
          ) : (
            <Button key="band-away" label="I was away" hotkey="3" onPress={() => void finishBreak($, 'away')} />
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, shared)
    const r = await read($, routine)
    const t = await read($, now)
    const isOpen = await read($, isSettingsOpen)
    const phase = phaseOf(s, t)
    const isTerminal = e.surface === 'terminal'
    const width = Math.max(12, Math.min(30, e.props.bodyColumns - 4))

    if (phase === 'disabled') {
      return (
        <Box flexDirection="column" gap={1} paddingY={1} alignItems="center">
          <Text dimColor>Activity break is off in every session.</Text>
          <Button key="enable" label="Turn on" variant="primary" onPress={() => void setSwitch($, true)} />
        </Box>
      )
    }

    let body
    if (r !== null) {
      const x = exercise(r.exercises[r.step]!)
      const total = x.seconds * 1000
      const done = 1 - r.leftMs / total
      const after = r.exercises[r.step + 1]
      let dial
      if (e.surface === 'terminal') {
        dial = (
          <Box flexDirection="column" alignItems="center">
            <Text bold>{x.name}</Text>
            <Text bold>{clock(r.leftMs)}</Text>
            <Text color="suggestion">{bar(done, width)}</Text>
          </Box>
        )
      } else {
        const { Svg } = $.ui.resolve(e)
        dial = <Svg source={ring(done, x.name, clock(r.leftMs))} alt={`${x.name}, ${clock(r.leftMs)} left`} width={200} height={200} />
      }
      body = (
        <Box flexDirection="column" gap={1} alignItems="center">
          <Text dimColor>
            Break {r.step + 1} of {r.exercises.length}
          </Text>
          {dial}
          <Text wrap="wrap">{x.how}</Text>
          {r.status === 'paused' && <Text dimColor>Paused</Text>}
          {r.isHeld && r.status === 'running' && <Text color="warning">Hands off the keyboard: the clock waits.</Text>}
          {after !== undefined && (
            <Text dimColor>
              Next: {exercise(after).name} · {span(exercise(after).seconds)}
            </Text>
          )}
          <Box flexDirection="row" gap={1} justifyContent="center">
            <Button
              key="pause"
              label={r.status === 'paused' ? 'Resume' : 'Pause'}
              hotkey="s"
              variant="primary"
              onPress={() => void togglePause($)}
            />
            <Button key="next" label="Next" hotkey="n" onPress={() => void nextExercise($)} />
            <Button key="end" label="End" hotkey="x" onPress={() => void endRoutine($)} />
          </Box>
        </Box>
      )
    } else if (phase === 'off') {
      body = (
        <Box flexDirection="column" gap={1} alignItems="center">
          <Text dimColor>Breaks paused until {timeOfDay(s.clock.offUntil ?? t)}.</Text>
          <Button key="resume" label="Resume breaks" variant="primary" onPress={() => void setSwitch($, true)} />
        </Box>
      )
    } else if (phase === 'due') {
      body = (
        <Box flexDirection="column" gap={1} alignItems="center">
          <Text color="warning" bold size="heading">
            Time to move
          </Text>
          <Text>{s.settings.minutes} min at the keyboard. Two minutes away from it:</Text>
          <Box flexDirection="column" alignItems="center">
            {routineSteps().map((id, i) => (
              <Text>
                {i + 1}. {exercise(id).name} · {span(exercise(id).seconds)}
              </Text>
            ))}
          </Box>
          {s.settings.isStrict && <Text dimColor>Prompts are held until the break is done.</Text>}
          <Box flexDirection="row" gap={1} justifyContent="center">
            <Button key="start" label="Start" hotkey="s" variant="primary" onPress={() => void startBreak($)} />
            <Button
              key="snooze"
              label={`Snooze ${SNOOZE_MINUTES}`}
              hotkey="z"
              onPress={() => void useEscape($, (c, at) => snooze(c, at, SNOOZE_MINUTES), '')}
            />
            {s.settings.isStrict ? (
              <Button key="skip" label={`Skip · ${escapesLeft(s, t)} left`} onPress={() => void useEscape($, skip, '')} />
            ) : (
              <Button key="away" label="I was away" onPress={() => void finishBreak($, 'away')} />
            )}
          </Box>
        </Box>
      )
    } else {
      const left = s.clock.dueAt - t
      const p = progress(s, t)
      let dial
      if (e.surface === 'terminal') {
        dial = (
          <Box flexDirection="column" alignItems="center">
            <Text dimColor>Next break in</Text>
            <Text bold>{clock(left)}</Text>
            <Text color="suggestion">{bar(p, width)}</Text>
          </Box>
        )
      } else {
        const { Svg } = $.ui.resolve(e)
        dial = <Svg source={ring(p, 'Next break in', clock(left))} alt={`Next break in ${clock(left)}`} width={200} height={200} />
      }
      body = (
        <Box flexDirection="column" gap={1} alignItems="center">
          {dial}
          <Button key="start-now" label="Break now" hotkey="b" onPress={() => void startBreak($)} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1} paddingY={1} alignItems="center">
        {body}
        <Box flexDirection="row" gap={1} alignItems="center" justifyContent="center" flexWrap="wrap">
          <Text dimColor>
            {s.settings.minutes} min{s.settings.isStrict ? ' · strict' : ''} · {s.log.breaks} today · streak {s.log.streak}
          </Text>
          <Button
            key="settings"
            label={isOpen ? 'Done' : 'Adjust'}
            plain
            dimColor
            onPress={() => void update($, isSettingsOpen, o => !o)}
          />
        </Box>
        {isOpen && (
          <Box flexDirection="column" gap={1} alignItems="center">
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text>Every</Text>
              <Button key="less" label="−" onPress={() => void nudge($, -1)} />
              <Box width={8} justifyContent="center">
                <Text tabular>{s.settings.minutes} min</Text>
              </Box>
              <Button key="more" label="+" onPress={() => void nudge($, 1)} />
            </Box>
            <Box flexDirection="row" gap={1} justifyContent="center" flexWrap="wrap">
              <Button
                key="strict"
                label={s.settings.isStrict ? 'Strict on' : 'Strict off'}
                plain
                dimColor={!s.settings.isStrict}
                onPress={() => void toggle($, 'isStrict')}
              />
              <Button
                key="sound"
                label={s.settings.isSoundOn ? 'Sound on' : 'Sound off'}
                plain
                dimColor={!s.settings.isSoundOn}
                onPress={() => void toggle($, 'isSoundOn')}
              />
            </Box>
            <Button key="disable" label="Turn off everywhere" onPress={() => void setSwitch($, false)} />
            {isTerminal && <Text dimColor>/activity off 2h pauses, /activity off turns it off</Text>}
          </Box>
        )}
      </Box>
    )
  })
}

// The countdown ring for surfaces that draw SVG, to the next break or through
// a step of one; text colours follow the system theme, since an SVG image
// cannot read the app's theme keys.
function ring(p: number, caption: string, time: string): string {
  const size = 200
  const mid = size / 2
  const radius = 84
  const length = 2 * Math.PI * radius
  const arc =
    p === 0
      ? ''
      : `<circle cx="${mid}" cy="${mid}" r="${radius}" fill="none" stroke="${ACCENT.calm}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${length.toFixed(2)}" stroke-dashoffset="${(length * (1 - p)).toFixed(2)}" transform="rotate(-90 ${mid} ${mid})"/>`

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    '<style>',
    '.time{fill:#1d1d1f;font:600 42px -apple-system,BlinkMacSystemFont,"SF Pro Display",system-ui,sans-serif;font-variant-numeric:tabular-nums}',
    '.cap{fill:#6e6e73;font:500 13px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;letter-spacing:0.4px}',
    '@media (prefers-color-scheme:dark){.time{fill:#f5f5f7}.cap{fill:#a1a1a6}}',
    '</style>',
    `<circle cx="${mid}" cy="${mid}" r="${radius}" fill="none" stroke="rgba(128,128,128,0.18)" stroke-width="10"/>`,
    arc,
    `<text x="${mid}" y="${mid - 26}" text-anchor="middle" class="cap">${caption}</text>`,
    `<text x="${mid}" y="${mid + 16}" text-anchor="middle" class="time">${time}</text>`,
    '</svg>',
  ].join('')
}

async function togglePause($: EngineInterface): Promise<void> {
  lastTickAt = await $.clock.now()
  const r = await update($, routine, (c): BreakRoutine | null =>
    c === null ? c : { ...c, status: c.status === 'paused' ? 'running' : 'paused' },
  )
  showStatus(await read($, shared), r, await $.clock.now(), $)
}

async function nextExercise($: EngineInterface): Promise<void> {
  const r = await read($, routine)
  if (r === null) return
  if (r.step + 1 >= r.exercises.length) {
    await finishBreak($, 'routine')

    return
  }
  const x = exercise(r.exercises[r.step + 1]!)
  lastTickAt = await $.clock.now()
  await update($, routine, (c): BreakRoutine | null =>
    c === null ? c : { ...c, step: c.step + 1, leftMs: x.seconds * 1000, isHeld: false, status: 'running' },
  )
}

// Ending early counts nothing: the break stays due.
async function endRoutine($: EngineInterface): Promise<void> {
  await update($, routine, () => null)
  showStatus(await read($, shared), null, await $.clock.now(), $)
}

async function nudge($: EngineInterface, direction: 1 | -1): Promise<void> {
  await change($, (s, t) => {
    const step = LIMITS.step
    // Snap to the step grid, so 22 goes to 25 or 20.
    const next = direction > 0 ? Math.floor(s.settings.minutes / step) * step + step : Math.ceil(s.settings.minutes / step) * step - step

    return setMinutes(s, next, t)
  })
}

async function toggle($: EngineInterface, key: 'isStrict' | 'isSoundOn'): Promise<void> {
  const s = await change($, c => ({ ...c, settings: { ...c.settings, [key]: !c.settings[key] } }))
  if (key === 'isStrict' && !s.settings.isStrict) await giveBack($)
}
