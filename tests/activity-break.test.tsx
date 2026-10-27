import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const MINUTE = 60_000
const START = 1_800_000_000_000
const FILE = '/home/me/.claude/activity-break.json'
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

const PANE = {
  plugin: 'activity-break',
  component: 'Pane',
  requestId: 'activity-break',
  props: {
    title: 'Activity break',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'activity-break',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 11 }, view: {} },
} as const

type Shared = {
  settings: { isEnabled: boolean; minutes: number; isStrict: boolean; isSoundOn: boolean }
  clock: { startedAt: number; dueAt: number; alertedAt: number | null; offUntil: number | null; heartbeatAt: number; round: number }
  log: { day: string; breaks: number; skips: number; streak: number; streakDay: string | null }
}

// A state file another session left behind: the stretch began `minutesAgo`.
function file(minutesAgo: number, settings: Partial<Shared['settings']> = {}): string {
  const s = { isEnabled: true, minutes: 60, isStrict: false, isSoundOn: true, ...settings }
  const startedAt = START - minutesAgo * MINUTE

  return JSON.stringify({
    settings: s,
    clock: { startedAt, dueAt: startedAt + s.minutes * MINUTE, alertedAt: null, offUntil: null, heartbeatAt: START - 10_000, round: 0 },
    log: { day: '2027-01-15', breaks: 0, skips: 0, streak: 0, streakDay: null },
  })
}

// Nothing sits beneath the plugin: these hooks stand for the engine.
function engine(on: On, files: Record<string, string> = {}, idle: { ms: number } | undefined = undefined) {
  const toasts: string[] = []
  const sounds: unknown[] = []
  const speech: string[] = []
  const status: (string | undefined)[] = []
  const fills: string[] = []
  const closed: string[] = []

  on('command.register', () => ({ value: { command: 'move' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', (_, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', (_, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-surface' } }))
  on('audio.play', (_, e) => {
    sounds.push(e.clip)
    return { value: undefined }
  })
  on('audio.speak', (_, e) => {
    speech.push(e.text)
    return { value: { via: 'system' as const } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.read', (_, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  // ioreg as macOS prints it, idle time in nanoseconds; without `idle`, no ioreg.
  on('process.run', () => ({
    value:
      idle === undefined
        ? { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
        : {
            exitCode: 0,
            stdout: `  | |   "HIDIdleTime" = ${idle.ms * 1_000_000}\n`,
            stderr: '',
            isStdoutTruncated: false,
            isStderrTruncated: false,
          },
  }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_, e) => {
    fills.push(e.text)
    return { isFilled: true }
  })
  // What the engine draws where the mod leaves a site alone.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const clock = mock.clock(on, { now: START })
  const saved = (): Shared => JSON.parse(files[FILE] ?? '{}') as Shared

  return { clock, toasts, sounds, speech, status, fills, closed, files, saved }
}

test('a fresh install counts down an hour, on every surface', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect(world.saved().settings).toEqual({ isEnabled: true, minutes: 60, isStrict: false, isSoundOn: true })
  expect(world.status.at(-1)).toBe('move ▱▱▱▱▱▱▱▱▱▱ 60m')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: /^60:00$/ })).toBeDefined()
    } else {
      expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('Next break in 60:00')
    }
    expect(await ui.find({ key: 'start-now' })).toBeDefined()
    await ui.unmount()
  }
})

test('the hour runs on from the state file another session left', async ($, on) => {
  const world = engine(on, { [FILE]: file(36) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(world.status.at(-1)).toBe('move ▰▰▰▰▰▰▱▱▱▱ 24m')
})

test('a gap with no session alive counts as a break and restarts the hour', async ($, on) => {
  const stale = JSON.parse(file(50)) as Shared
  stale.clock.heartbeatAt = START - 20 * MINUTE
  const world = engine(on, { [FILE]: JSON.stringify(stale) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(world.saved().clock.startedAt).toBe(START)
  expect(world.status.at(-1)).toBe('move ▱▱▱▱▱▱▱▱▱▱ 60m')
})

test('at the hour it alerts once, offers the routine above the prompt, and nags after 15 minutes', async ($, on) => {
  const world = engine(on, { [FILE]: file(59) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await world.clock.advance(MINUTE + 1000)
  expect(world.toasts.filter(t => t.startsWith('Time to move'))).toHaveLength(1)
  expect(world.toasts.at(-1)).toBe('Time to move: 60 min at the keyboard. Stand up 30 s → Walk around 1:30 min.')
  expect(world.sounds).toHaveLength(1)
  expect(world.status.at(-1)).toBe('MOVE ▰▰▰▰▰▰▰▰▰▰ break due')
  expect(world.saved().clock.alertedAt).not.toBeNull()

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ key: 'band-start' })).toBeDefined()
    expect(await band.find({ key: 'band-away' })).toBeDefined()
    await band.unmount()
  }

  await world.clock.advance(5 * MINUTE)
  expect(world.toasts.filter(t => t.startsWith('Time to move'))).toHaveLength(1)
  await world.clock.advance(10 * MINUTE)
  expect(world.toasts.filter(t => t.startsWith('Time to move'))).toHaveLength(2)
})

test('the break is 30 s standing and 1:30 walking, then it counts and the hour starts over', async ($, on) => {
  const world = engine(on, { [FILE]: file(61) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'band-start' })
  await band.unmount()

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await terminal.find({ type: 'Text', text: /^Stand up$/ })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: /^00:30$/ })).toBeDefined()
  await terminal.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /^Break 1 of 2$/ })).toBeDefined()
  expect((await pane.find({ type: 'Svg' }))?.props.alt).toBe('Stand up, 00:30 left')
  expect(await pane.find({ type: 'Text', text: /^Next: Walk around · 1:30 min$/ })).toBeDefined()

  await world.clock.advance(30_000)
  expect((await pane.find({ type: 'Svg' }))?.props.alt).toBe('Walk around, 01:30 left')
  expect(world.status.at(-1)).toBe('break 2/2 · 01:30')
  expect(world.sounds).toHaveLength(1)

  await pane.press({ key: 'pause' })
  await world.clock.advance(5 * MINUTE)
  expect(world.status.at(-1)).toBe('break 2/2 · 01:30 (paused)')
  await pane.press({ key: 'pause' })

  await world.clock.advance(90_000)
  expect(world.toasts.at(-1)).toBe('Break done. 1 today. Next one in 60 min.')
  expect(world.saved().log.breaks).toBe(1)
  expect(world.saved().log.streak).toBe(1)
  expect(world.saved().clock.round).toBe(1)
  expect(world.status.at(-1)).toBe('move ▱▱▱▱▱▱▱▱▱▱ 60m')
  expect(world.sounds).toHaveLength(2)
  expect(world.speech).toHaveLength(0)
  await pane.unmount()
})

test('a break finished in another session clears the alert here within 15 seconds', async ($, on) => {
  const world = engine(on, { [FILE]: file(61) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await world.clock.advance(1000)
  expect(world.status.at(-1)).toBe('MOVE ▰▰▰▰▰▰▰▰▰▰ break due')

  const elsewhere = world.saved()
  elsewhere.clock = { ...elsewhere.clock, startedAt: START + 1000, dueAt: START + 1000 + 60 * MINUTE, alertedAt: null, heartbeatAt: START + 1000 }
  world.files[FILE] = JSON.stringify(elsewhere)

  await world.clock.advance(15_000)
  expect(world.status.at(-1)).toMatch(/^move ▱▱▱▱▱▱▱▱▱▱ (59|60)m$/)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'band-start' })).toBeUndefined()
  await band.unmount()
})

test('strict mode holds a typed prompt while the break is due and gives it back after', async ($, on) => {
  const world = engine(on, { [FILE]: file(61, { isStrict: true }) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const typed = await $.prompt.submit({ text: 'add a test for the symlink case', origin: { kind: 'composer' }, wait: false })
  expect(typed.drop).toMatch(/^Activity break due after 60 min at the keyboard/)

  const fromTask = await $.prompt.submit({ text: 'task done', origin: { kind: 'task-notification' }, wait: false })
  expect(fromTask.drop).toBeUndefined()

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'band-away' })).toBeUndefined()
  expect((await band.find({ key: 'band-skip' }))?.text).toMatch(/Skip · 2 left/)
  await band.press({ key: 'band-start' })
  await band.unmount()

  const done = await $.command.run({ ...TYPED, command: 'move', args: 'done' })
  expect(done.text).toMatch(/^Strict mode counts a break only when the routine finishes/)

  await world.clock.advance(30_000 + 90_000)
  expect(world.toasts.at(-1)).toBe('Break done. 1 today. Next one in 60 min.')
  expect(world.fills).toEqual(['add a test for the symlink case'])

  const after = await $.prompt.submit({ text: 'go on', origin: { kind: 'composer' }, wait: false })
  expect(after.drop).toBeUndefined()
})

test('strict mode allows two skips a day', async ($, on) => {
  engine(on, { [FILE]: file(61, { isStrict: true }) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await $.command.run({ ...TYPED, command: 'move', args: 'skip' })).text).toBe('Skipped. The hour starts over. 1 skips left today.')
  expect((await $.command.run({ ...TYPED, command: 'move', args: 'snooze' })).text).toBe('Snoozed for 10 min. 0 skips left today.')
  expect((await $.command.run({ ...TYPED, command: 'move', args: 'skip' })).text).toMatch(/^No skips left today/)
})

test('/move off turns the mod off in every session until /move on', async ($, on) => {
  const world = engine(on, { [FILE]: file(61, { isStrict: true }) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const off = await $.command.run({ ...TYPED, command: 'move', args: 'off' })
  expect(off.text).toBe('Activity break is off in every session, until /move on.')
  expect(world.saved().settings.isEnabled).toBe(false)
  expect(world.status.at(-1)).toBeUndefined()
  expect(world.closed).toEqual(['activity-break'])

  const typed = await $.prompt.submit({ text: 'keep working', origin: { kind: 'composer' }, wait: false })
  expect(typed.drop).toBeUndefined()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /^engine$/ })).toBeDefined()
  await band.unmount()

  await world.clock.advance(3 * 60 * MINUTE)
  expect(world.toasts.filter(t => t.startsWith('Time to move'))).toHaveLength(0)
  expect((await $.command.run({ ...TYPED, command: 'move', args: 'start' })).text).toMatch(/is off/)

  const back = await $.command.run({ ...TYPED, command: 'move', args: 'on' })
  expect(back.text).toBe('Activity break is on. The hour starts now.')
  expect(world.status.at(-1)).toBe('move ▱▱▱▱▱▱▱▱▱▱ 60m')
})

test('a state file switched off by another session takes effect here', async ($, on) => {
  const world = engine(on, { [FILE]: file(10) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(world.status.at(-1)).toBe('move ▰▱▱▱▱▱▱▱▱▱ 50m')

  const elsewhere = world.saved()
  elsewhere.settings.isEnabled = false
  world.files[FILE] = JSON.stringify(elsewhere)
  await world.clock.advance(15_000)
  expect(world.status.at(-1)).toBeUndefined()
})

test('on macOS, strict mode holds the routine clock while hands are on the keyboard', async ($, on) => {
  const idle = { ms: 500 }
  const world = engine(on, { [FILE]: file(61, { isStrict: true }) }, idle)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ ...TYPED, command: 'move', args: 'start' })).text).toMatch(/^Break started/)

  await world.clock.advance(3000)
  expect(world.status.at(-1)).toBe('break 1/2 · 00:30 · hands off the keyboard')
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /^Hands off the keyboard/ })).toBeDefined()
  await pane.unmount()

  idle.ms = 10_000
  await world.clock.advance(3000)
  expect(world.status.at(-1)).toBe('break 1/2 · 00:27')
})

test('on macOS, five minutes without keyboard or mouse restarts the hour', async ($, on) => {
  const idle = { ms: 1000 }
  const world = engine(on, { [FILE]: file(30) }, idle)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await world.clock.advance(15_000)
  expect(world.status.at(-1)).toBe('move ▰▰▰▰▰▱▱▱▱▱ 30m')

  idle.ms = 5 * MINUTE
  await world.clock.advance(15_000)
  expect(world.saved().clock.startedAt).toBe(START + 30_000)
  expect(world.status.at(-1)).toBe('move ▱▱▱▱▱▱▱▱▱▱ 60m')
})

test('a headless run with nobody attached keeps the clock but never alerts until a surface attaches', async ($, on) => {
  const surfaces: ('desktop' | 'terminal')[] = []
  const world = engine(on, { [FILE]: file(61) })
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })

  await world.clock.advance(2 * MINUTE)
  expect(world.saved().clock.alertedAt).toBeNull()
  expect(world.toasts).toHaveLength(0)
  expect(world.speech).toHaveLength(0)
  expect(world.sounds).toHaveLength(0)

  surfaces.push('desktop')
  await $.session.attach({ surface: 'desktop', clientId: 'app' })
  await world.clock.advance(1000)
  expect(world.toasts.at(-1)).toMatch(/^Time to move/)
})

test('/move off 2h pauses, and the minutes can be set', async ($, on) => {
  engine(on, { [FILE]: file(10) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await $.command.run({ ...TYPED, command: 'move', args: '45' })).text).toMatch(/^Next break in 35:00 \(45 min\)/)
  expect((await $.command.run({ ...TYPED, command: 'move', args: 'off 2h' })).text).toMatch(/^Breaks paused until \d\d:\d\d/)
  expect((await $.command.run({ ...TYPED, command: 'move', args: 'later' })).text).toMatch(/^Usage:/)
})
