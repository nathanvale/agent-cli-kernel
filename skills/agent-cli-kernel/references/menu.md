# Showing a menu

The menu add-on lets a command show rows on a terminal in an interactive run
and hand back the picked row, or `"cancelled"`.

A CLI command routed as `menu` (for example, a doorway-style default command
named `menu`) and the menu add-on are different things. A command named `menu`
is an ordinary command your CLI declares; the menu add-on is the optional
kernel capability that draws rows on a terminal and reads keys. Any command
with any route can use the menu add-on, and a command named `menu` does not
automatically select the add-on.

## Setup

1. Select `"menu"` in `installedAddons` on `contractFor`.
2. In the command declaration (`command` or `changing`), set
   `capabilities: { menu: true }` and declare `notInteractiveCause`, naming a
   command-owned station of that command whose row is `refused` and
   `unchanged` (not a common cause, and with no run bindings).
3. Import `menuAddon` from `agent-cli-kernel/addons/menu` and pass
   `addons: { menu: menuAddon() }` to `runProcess` or `runInProcess`.

## Showing rows

Call `await context.menu.show({ lines, rows })` inside the handler:

- `lines` (optional): at most 3 strings shown above the list.
- `rows`: 1 to 1,000 `MenuRow<Value>` objects (`{ label, value }`). Each
  `label` is at most 200 characters. Control characters and bidirectional
  overrides are stripped from lines and labels before drawing, and each line is
  cut to the terminal width. `value` never reaches the screen.
- The return value is `MenuResult<Value>`:
  - `{ kind: "picked", value, index }` when the person presses Enter (`index`
    is the row's index in the original `rows` array, even when filtered).
  - `{ kind: "cancelled" }` when the person presses Esc.

Keys while the menu is open: Up and Down (and Ctrl-P, Ctrl-N) move the
selection; typing filters rows by case-insensitive substring; Backspace edits
the filter; Enter picks; Esc cancels; Ctrl-C restores the terminal and stops
the run through SIGINT (exit 130, no envelope); Ctrl-Z is ignored. The list
redraws on resize.

## Multiple picks, timing and transactions

- A command may call `context.menu.show` more than once in one run, with other
  work between calls. The terminal returns to normal mode between calls, and
  each call starts with an empty filter.
- `show` has no time limit while a person thinks. It still stops cleanly and
  restores the terminal on Ctrl-C (exit 130), SIGTERM (exit 143) and
  `--deadline-ms` (`DOMAIN_DEADLINE_UNCHANGED` when no transaction started).
- Never open a menu inside a state transaction. A transaction holds a
  coordination lock for its scope, so waiting for a person inside it would
  block other runs. Look and ask first; open the transaction after the pick.

## Not in an interactive run

An interactive run has a terminal adapter (in a process: both stdin and stdout
are terminals) and no `--json`. Whenever a run is not interactive, the kernel
answers with the command's declared `notInteractiveCause` station before the
handler starts. Agents and `--json` runs never see a menu, and the handler
never has to branch on missing terminals.

## Cancelled at a menu

When `context.menu.show` returns `{ kind: "cancelled" }` (the person pressed
Esc), return a station of the command's own that is `refused` and `unchanged`,
such as `DOMAIN_DOORWAY_NOTHING_CHOSEN`, with a plain message (for example,
`"Nothing was opened."`), `data: null` and unchanged effects. That exits with
code 3. Never open a transaction just to report that nothing happened: an empty
transaction cannot earn an unchanged success today. For a run without a
terminal or with `--json`, rely on `notInteractiveCause`, which the kernel
returns before the handler runs.

## Testing

Pass `addons: { menu: menuAddon() }` and `terminal: scriptedTerminal(keys)`
(imported from `agent-cli-kernel`) to `runInProcess` to drive picks, filtering
and Esc cancels without a live terminal. Omit `terminal` or pass `"--json"` to
verify the command's `notInteractiveCause` refusal. See
[testing](testing.md).
