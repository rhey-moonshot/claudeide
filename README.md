# ClaudeIDE

*by Rhey Minoza*

A terminal-grid editor purpose-built for running **many Claude Code CLI sessions at once**.

Open 4–12 live terminals in a tiling grid, each running its own `claude` session,
each with a live status indicator so you can see at a glance which agents are
**working**, **waiting** for your input, **ready**, or **exited** — without
hunting through stacked VS Code terminal tabs.

## Stack

- **Electron** — desktop shell (runs natively in WSL2 via WSLg)
- **xterm.js** — the same terminal renderer VS Code uses
- **node-pty** — real pseudo-terminals (native bash in WSL, with `claude` on PATH)

## Run

```bash
npm install      # also rebuilds node-pty against Electron's ABI (postinstall)
npm start
```

If node-pty fails to load at startup, rebuild it for Electron:

```bash
npm run rebuild
```

## Features (MVP)

- Grid layout that auto-arranges for 1–12 panes (`Layout` buttons: 4 / 6 / 8 / 12)
- Per-pane **status**: working (orange, pulsing) · waiting (yellow) · ready (green) · exited (gray)
- Per-pane **activity line** — the last line of output, so you can skim what each agent is doing
- **Desktop notification** the moment a pane needs your input (see below)
- Editable pane **labels** (click the title, type, Enter)
- **Auto-run** a command in every new pane (default `claude`), optionally in a chosen working dir
- **Named workspaces** — switch between per-project layouts from the toolbar (see below)
- **Workspace persistence** — your panes, labels, and settings come back on relaunch
- **Jump to the next pane that needs you** — `Ctrl+Shift+J` (or the `⚠ next` button)
- **Switch tabs** with `Ctrl+1…9` (jump to the Nth workspace) or `Ctrl+Tab` / `Ctrl+Shift+Tab` (cycle)
- **Drag** a pane by its title bar to rearrange the grid
- **Focus (zen) mode** — `F11` or double-click a pane's title bar to expand it full-window
- `↻` restart the command in a pane · `✕` close a pane · `Ctrl+T` new pane

## Focus (zen) mode

Drop into a single agent without distraction: **double-click a pane's title bar**
(the maximize-window gesture) or press **`F11`**. The toolbar and tab bar melt
away and that terminal fills the window. **`F11` / double-click again**, or the
floating **⤢ Exit focus** button, returns you to the grid.

The other agents keep running in the background while you're focused — and if one
needs you, **jumping to it (`Ctrl+Shift+J`) or clicking its notification
automatically leaves focus mode**, so you're never trapped.

## How status is derived (Claude Code-aware)

Status comes from parsing Claude Code's actual TUI, not raw output timing. Each
tick (`src/detector.js`) reads the **composited xterm screen buffer** — so the
in-place redraws of Claude's REPL are already resolved into a clean snapshot —
and classifies by the **bottom-most live signal** on screen:

| state | signal | meaning |
|---|---|---|
| **working** 🟠 | spinner line with `esc to interrupt` | actively thinking / running a tool |
| **needs you** 🔴 | a permission/confirmation box (`Do you want to proceed?`, `1. Yes / 2. No`, `don't ask again`) | paused for your decision — pane glows |
| **ready** 🟢 | idle input box (`? for shortcuts`) | waiting for your next instruction |
| **error** 🔴 | `✗` / `Error:` / traceback, with no live prompt | last action failed |
| **exited** ⚪ | the PTY process ended | shell/agent closed |

It also extracts live **metadata** shown in each pane's status line:
- current **tool + args** (`Bash npm test`, `Update src/main.js`) — "what is it doing right now"
- **elapsed** time and **token** count from the spinner
- **context left** percentage

Reading the *bottom-most* signal is what makes it robust: a permission prompt
that has scrolled up into history won't be mistaken for a live one, because the
real current state (idle box / spinner) is always painted lower on the screen.

Panes that **need you** glow pink and the toolbar/window title shows a count
(`(2!) ClaudeIDE`) so you can spot which of 12 agents is blocked at a glance.

## Desktop notifications

When a pane transitions **into** the "needs you" state (a Claude permission
prompt), ClaudeIDE pushes a desktop notification titled `<pane name> needs you`
with the prompt text as the body. It's **edge-triggered** — one ping per
prompt, not a repeat every tick — and toggleable from the `🔔 notify` checkbox
in the toolbar.

Delivery is layered so it works regardless of environment:

1. **Native** Electron notification where the OS supports it (click it to focus
   the exact pane).
2. **WSL fallback** → a real **Windows toast** via `powershell.exe` interop,
   shown in the Windows Action Center. This matters because WSLg has **no Linux
   notification daemon**, so the native path is unsupported inside WSL and would
   otherwise show nothing.
3. **Taskbar flash** always fires as a backstop when the window isn't focused.

(If you later run a Linux notification daemon, e.g. `dunst`/`mako`, the native
path lights up automatically — no code change.)

### Detector tests

`src/detector.js` is plain and `require()`-able under Node, so the classifier
is unit-tested independently of Electron (see the test in scratchpad, or adapt
it into the repo).

## Workspace persistence

ClaudeIDE remembers your layout between launches. On every change (add/close a pane,
rename a pane, edit the toolbar) it saves — debounced — and on launch it restores:

- the **panes** (count + order), each with its **label**, **working dir**, and **command**
- toolbar settings: auto-run, notify, the command + working-dir template

State lives in a single JSON file in Electron's userData dir:

```
~/.config/ClaudeIDE/workspace.json      # Linux / WSL
%APPDATA%\ClaudeIDE\workspace.json      # Windows
```

Delete that file to reset to a fresh 4-pane workspace. A legacy single-workspace
file (`version: 1`) is migrated automatically on first launch.

### Named workspaces (tabs — all stay running)

Workspaces are **tabs** along the top — one per project, say `default`, `backend`,
`infra`. Each has its own panes, labels, and toolbar settings.

**Switching tabs does not stop anything.** Every workspace's terminals keep running
in the background; switching only changes what's shown. xterm keeps parsing each
hidden session's output, so background status detection and notifications keep
working. So you can have `backend` running a long agent task, hop to `infra` to do
something else, and come back to find it finished — nothing was killed.

Switch tabs by **clicking**, by **`Ctrl+1…9`** (jump to the Nth tab — its number
is shown on the left of the tab), or **`Ctrl+Tab` / `Ctrl+Shift+Tab`** to cycle
forward/back.

Each tab shows a **live status at a glance**:

- a status **dot** (pink = a pane needs you, orange = working, green = ready)
- **counts**: `⚙` working · `⚠` need-you · `✗` error (or the pane total when idle)

Controls:

- Workspaces are created/opened from the **File** menu in the title bar
  (**New Workspace…**, **Open Workspace…**, **Exit**) · **double-click a tab name** to
  rename · the tab's `✕` closes it (stopping only that tab's terminals; the last open
  tab can't be closed)
- **Workspaces persist as a registry — closing a tab doesn't delete it.** Open any
  saved workspace from **File → Open Workspace…**, which lists every workspace you've
  created with its directory. `✕` forgets one. This is VSCode's "Open Recent" model;
  closed workspaces stay dormant (no terminals) until reopened.
- **Multiple tabs for one workspace.** Tabs are independent *instances* — picking the
  same workspace from **Open Workspace…** again spawns **another tab** in that same
  directory, so you can run several separate grids of agents on one project. Duplicate
  tabs are labelled `name #2`, `name #3`. Each tab keeps its own panes and is restored
  on relaunch.
- **Creating a workspace asks for its working directory** (native folder picker, or
  type a path). That directory becomes the workspace's cwd, so every pane — and the
  `claude` session in it — starts there. Change it any time via the toolbar cwd field.
  - Paths are normalized for WSL: a Windows path the picker may return
    (`C:\Users\me\proj`, `\\wsl.localhost\Ubuntu\home\me\proj`), a `~/...` path, or a
    `file://` URI are all converted to real Linux paths. If a directory genuinely
    doesn't exist, the pane prints a yellow `[ClaudeIDE] directory not found …` warning
    and starts in your home dir (instead of silently using the wrong place).

The window title and the `⚠ next` button count attention across **all** workspaces,
and `Ctrl+Shift+J` jumps to the next pane that needs you — **switching tabs
automatically** if that pane lives in another workspace.

All workspaces live in the one `workspace.json`:

```jsonc
{ "version": 2, "active": "backend",
  "workspaces": { "default": { "toolbar": {…}, "panes": [...] },
                  "backend": { "toolbar": {…}, "panes": [...] } } }
```

### Jump to what needs you

With many agents running, `Ctrl+Shift+J` (or the `⚠ next` button) cycles focus to
the next pane in an **approval** or **error** state, scrolling it into view. The
button shows a live count (`⚠ next (2)`) and pulses when any pane is waiting. The
shortcut works even while a terminal is focused — it's intercepted before the
keystroke reaches the shell.

**What is and isn't restored:** a live PTY can't be serialized — the running
`bash`/`claude` process and its in-memory state are gone when the app closes. So
ClaudeIDE restores the *workspace shape* and **re-spawns** each pane's shell,
re-running its command when auto-run is on. Scrollback from the previous session
is not carried over.

## Roadmap ideas

- ~~Smarter status by parsing Claude Code output~~ ✅ done (`src/detector.js`)
- ~~Desktop notifications when an agent needs input~~ ✅ done (native + WSL toast)
- ~~Persist/restore workspace layout~~ ✅ done (`workspace.json`)
- ~~Named workspaces / projects you can switch between~~ ✅ done
- ~~"Jump to next pane that needs you" hotkey~~ ✅ done (`Ctrl+Shift+J`)
- Editable per-pane working-dir + command (not just at creation)
- Broadcast input to all panes; pane groups
- Per-pane git-branch badge
