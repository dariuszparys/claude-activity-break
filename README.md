# activity-break

A Claude Code mod that gets you off the chair. After an hour at the keyboard
(adjustable), it interrupts with a two-minute break: stand up for 30 seconds,
then walk around for 1:30. Each step has a countdown, and a chime marks the
start of the next step.

- **Move bar.** The status line fills like a Garmin move bar:
  `move ▰▰▰▰▰▰▱▱▱▱ 24m`, then `MOVE ▰▰▰▰▰▰▰▰▰▰ break due`.
- **Coach pane.** A pane beside the chat counts down to the next break, then
  through the two steps of the break. In the terminal the mod can only open the pane on its own
  in a fullscreen terminal at least 144 columns wide. When it is narrower, the
  band above the prompt offers **Start**, and your press opens the pane at any
  width.
- **Strict mode** (off by default). While a break is due, prompts you type are
  held back with a reason and put back in the prompt box once the break is
  done. A running turn is never cut, and slash commands, notifications and
  other sessions' messages still go through. On macOS the break's clock only
  runs while keyboard and mouse are idle. You get 2 skips or snoozes a day.

## Install

At the prompt of a terminal session:

```
/plugin install activity-break --marketplace dariuszparys/claude-activity-break
```

Answer `y` to add the marketplace, then press Enter for the user scope.

From a shell:

```
claude plugin install activity-break --marketplace dariuszparys/claude-activity-break
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `dariuszparys/claude-activity-break`,
then Add plugin.

## One clock across sessions

The deadline lives in `~/.claude/activity-break.json` (under
`$CLAUDE_CONFIG_DIR` when that is set), so every session reads the same hour.
Each session checks the file every 15 seconds. The first one past the deadline
raises the alert, and a break finished in any session clears it everywhere.

Natural breaks count: when no session ran for 15 minutes, or (macOS) keyboard
and mouse were untouched for 5 minutes, the hour starts over. A `claude -p`
run or SDK job with nothing attached does not take part.

## Commands

| Command | Does |
| --- | --- |
| `/move` | Status, and opens the pane |
| `/move start` | Start the break now |
| `/move 45` | A break every 45 minutes (15 to 180) |
| `/move snooze [min]` | Snooze, 10 minutes by default |
| `/move skip` | Restart the hour without a break |
| `/move away` | Count the break: you were away (not in strict mode) |
| `/move strict on` / `off` | Strict mode |
| `/move sound on` / `off` | The chime |
| `/move off 2h` | Pause breaks for a while (`90m`, `30`) |
| `/move off` | Turn the mod off, in every session, until `/move on` |
| `/move on` | Turn it back on; the hour starts fresh |

## Turning it off

- **For now, everywhere:** `/move off`, or **Adjust → Turn off everywhere** in
  the pane. Off, the mod shows nothing, holds no prompts and plays no chime in
  any session until `/move on`. The switch is stored in the state file, so it
  holds across restarts.
- **For a while:** `/move off 2h`.
- **The mod itself:** disable the plugin in Claude Code with
  `claude plugin disable activity-break`, or with `/plugin` in a terminal
  session. Delete `~/.claude/activity-break.json` to forget its history.

## Platforms

The chime uses `afplay` and idle detection uses `ioreg`, so both work on macOS
only. Everything else works on Linux and Windows.
