# Head Terminal

Desktop terminal for working with several AI coding agents in parallel. The application uses Electron with a React UI, one independent native PTY per pane and a narrow API between the renderer and the operating system.

## Features

- persisted sessions, pinning, renaming, reordering and quick switching;
- resizable horizontal and vertical splits, each with its own PTY;
- lazy spawn, per-pane restart and scrollback preservation;
- the agent conversation a pane is on is shown in its header, renamable by hand, and the name also applies in the resume list;
- Antigravity, Cursor Agent, Claude Code, Codex and shell profiles;
- multiple Claude accounts, each in its own `~/.head-terminal/claude-profiles/<id>` (the user's own `~/.claude` is never used by a pane, so logging in inside the app never changes the account of a terminal opened outside it);
- automatic `agent-N` Git worktrees, so several agents can work on one repository without fighting over the same working tree (see below);
- search, zoom, links, clipboard and WebGL rendering with fallback;
- activity detection, remaining context, crashes and shell fallback;
- Git context, watcher and diff, including untracked files;
- MCP status for Claude and Cursor;
- voice with local recording and OpenAI transcription;
- notifications, logs, checkpoints and diagnostic export;
- single instance and confirmation before closing working agents.

## Architecture

```text
React 19 + xterm.js + Zustand
              │
              ▼
window.headTerminal (typed preload)
              │ named, validated IPC
              ▼
Electron main ── node-pty / Git / filesystem / safeStorage / voice
```

The renderer has no access to Node or to `ipcRenderer`. The window uses `contextIsolation`, sandbox, CSP and `nodeIntegration: false`. Main and preload are bundled by Vite; Electron Forge rebuilds and unpacks `node-pty` inside the package.

| Area | Technology |
|---|---|
| Desktop | Electron 41 + Electron Forge |
| UI | React 19 + TypeScript + Vite |
| Terminal | xterm.js + node-pty |
| State | Zustand + versioned JSON workspace |
| Tests | Vitest + Electron/X11 smoke |

## Requirements

### All systems

- Node.js 20 (the current baseline is Node `20.18.3`);
- npm;
- a native toolchain to build Node modules (`node-pty`);
- at least one supported shell installed.

Install the JavaScript dependencies with:

```bash
npm install
```

### Linux (Ubuntu/Debian)

```bash
sudo apt install build-essential python3 make g++ libsecret-1-0
```

For voice recording:

```bash
sudo apt install pulseaudio-utils
command -v parecord
```

The smoke test and the visual harness use `xdotool` and, preferably, an isolated display:

```bash
sudo apt install xvfb xdotool imagemagick
```

On Wayland the application runs through Electron/Ozone, but the current visual automation uses X11/XWayland. Recording as implemented today depends on `parecord`; without it, only voice is unavailable.

### Windows

On Windows the application runs natively: each pane is a ConPTY (`node-pty`)
hosting PowerShell — PowerShell 7 when installed, Windows PowerShell 5.1
otherwise — and the agents are their Windows builds on `PATH`. Repositories are
ordinary `C:\...` folders; `git`, the watcher (`fs.watch`) and the transcript
lookup under `%USERPROFILE%\.head-terminal\claude-profiles\<id>` all run on the
Windows side. WSL is not involved, except for a plain shell session the user
opens on a WSL distribution (see below).

Requirements:

- Windows 10 1809 or later (ConPTY);
- Node.js 20 and npm;
- Git for Windows (for the Git context);
- the agent CLIs: `winget install Anthropic.ClaudeCode`, `winget install
  OpenAI.Codex`, the Cursor Agent Windows installer. Missing ones are offered
  for installation on first start.

No C++ toolchain is needed: `node-pty` publishes N-API prebuilds for
`win32-x64` and `win32-arm64`, and the module loads them straight from
`prebuilds/<platform>-<arch>`, so `rebuildConfig` skips the native rebuild on
Windows. Linux has no published prebuild and still compiles normally.

Panes carry their own working directory (the folder button in the pane header);
the session's folder is the default for new panes. A workspace saved by the
older WSL-based build is migrated on first start: `/mnt/c/...` folders become
`C:\...`, folders that only existed inside the distribution fall back to the
default folder.

Known differences on Windows:

| Area | Behaviour |
|---|---|
| Voice | Recording happens in the renderer through Chromium (`MediaRecorder`), since there is no `parecord` to spawn. |
| Shell | The pane shell is PowerShell; agent profiles are PowerShell scripts (`-EncodedCommand`), the `zsh` profiles are Linux/macOS only. A *Shell* session can instead open a WSL distribution (`wsl.exe -d <distro>`, picked in the new-session dialog), starting in the session folder under `/mnt/<drive>`. |
| Installer | `npm run make` produces a Squirrel installer. Code signing is still pending, as is macOS notarization. |

### macOS

The application runs natively on macOS, Apple Silicon and Intel alike, with the
same window, sidebar, panes, Git context, worktrees, voice and brainstorm as on
Windows. Each pane is a login `zsh` (`/bin/zsh`), the agents are the same
`zsh` profiles Linux uses, and data lives in `~/.head-terminal`.

Requirements:

- macOS 12 or later (what Electron 41 supports);
- Node.js 20 and npm;
- `git` (the Command Line Tools install it: `xcode-select --install`);
- the agent CLIs: `curl -fsSL https://claude.ai/install.sh | bash`, `curl
  https://cursor.com/install -fsS | bash`, `npm i -g @openai/codex` or
  `brew install codex`. Missing ones are offered for installation on first start.

No C++ toolchain is needed for `node-pty`: it publishes N-API prebuilds for
`darwin-arm64` and `darwin-x64`, and `rebuildConfig` skips the native rebuild
the same way it does on Windows.

What is macOS-specific, and how the app handles it:

| Area | Behaviour |
|---|---|
| Shortcuts | Every `Ctrl+…` shortcut in this README is `⌘…` on macOS (`⌘⇧P`, `⌘F`, `⌘\`, `⌘1..9`); labels in the app follow. `Ctrl+Tab` stays on Control, since `⌘Tab` is the system's. `⌘C` / `⌘V` copy and paste in the terminal natively; `⌥` acts as Meta (`⌥B`, `⌥F`, `⌥Enter`). |
| Function keys | `F2`, `F9`, `F10` and `F11` work as everywhere; on a Mac keyboard hold `Fn` unless *Use F1, F2, etc. keys as standard function keys* is on. Mission Control claims `F10` (Application Windows) and `F11` (Show Desktop) by default and the app never sees them while those are on: turn them off in System Settings › Keyboard › Keyboard Shortcuts › Mission Control. |
| Microphone denied | If the microphone was refused once, macOS never asks again; the next voice attempt opens System Settings › Privacy & Security › Microphone so it can be switched on for Head Terminal. |
| PATH | An app started from the Finder, the Dock or Spotlight gets launchd's PATH, not the shell's. At startup the app asks the login shell (`$SHELL -ilc`) for its PATH and adopts it, so Homebrew, nvm and `~/.local/bin` installs are found by panes, by the Git context and by the brainstorm agents. |
| Voice | Recording happens in the renderer through Chromium, as on Windows; the first use shows the system microphone prompt (the `.app` declares `NSMicrophoneUsageDescription`). |
| Menu | The app installs its own menu bar so `⌘W` does not close the window, `⌘R` does not reload the renderer (and every PTY with it) and `⌘=` / `⌘-` zoom the terminal font instead of the page. |
| Window | Closing the window keeps the app in the Dock, as macOS expects; clicking the Dock icon opens a new window and the workspace comes back. `⌘Q` quits. |
| Packaging | `spawn-helper`, the binary `node-pty` uses to start each pane, is kept outside the ASAR archive so it can be executed. |

`npm run package` produces `out/Head Terminal-darwin-<arch>/Head Terminal.app`
and `npm run make` a ZIP of it. The bundle is not signed or notarized, so a
copy downloaded from elsewhere is quarantined by Gatekeeper: run it from the
machine that built it, or clear the flag with `xattr -dr com.apple.quarantine
"Head Terminal.app"`. Public distribution still requires signing, hardened
runtime, entitlements and notarization.

#### Install with Homebrew

Once the tap exists, a tagged release installs with:

```bash
brew install --cask matheussl22/tap/head-terminal
```

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds the ZIP on
arm64 and x64 runners and attaches both to the GitHub release along with their
checksums. The tag has to match the `package.json` version, because the cask
builds its download URL from both; the workflow fails early when they diverge. The cask itself lives in `packaging/homebrew/head-terminal.rb`; it has
to be copied into a `homebrew-tap` repository, because Homebrew only loads casks
from a tap. Since the app is not signed, the cask strips the quarantine
attribute after install; that workaround goes away once notarization is in
place.

## Commands

```bash
npm run dev                         # Electron + Vite with hot reload
npm run typecheck                   # renderer, main, preload and configs
npm test                            # renderer/core tests
npm run test:electron               # services and IPC contract
npm run package                     # unpacked app in out/
npm run make                        # platform distribution artifacts
npm run build                       # typecheck + package
npm run smoke:electron              # package + real boot and window check
npm run smoke:electron:existing     # smoke against the existing package
npm run smoke:electron:win          # package + boot check on Windows
```

On Linux, `npm run make` produces the `.deb` in `out/make/deb/`. On macOS it produces a ZIP, and on Windows a Squirrel installer in `out/make/squirrel.windows/`. Builds must be made on the target platform; native modules are not portable across systems or Electron versions.

Runtime and packaging are Electron only; the Tauri/Rust backend was removed. The WebKit reader in the main process exists solely to import, once, data from old installations.

The launchers below and the X11 smoke test are Linux only. On Windows the app
is started by the installed shortcut, or by `npm run dev` during development.
On macOS use `npm run dev`, or the `.app` from `npm run package`;
`npm run start:prod` also finds that bundle.

## Linux launchers

The local installer creates two entries without needing `sudo`:

```bash
npm run install:desktop             # installs Head Terminal (Dev)
npm run package
npm run install:desktop:release     # also installs Head Terminal
```

| Entry | Target |
|---|---|
| Head Terminal | Electron package in `out/Head Terminal-linux-x64/` |
| Head Terminal (Dev) | `npm run dev`, with Vite and hot reload |

Dev mode uses its own launcher, logs, window class and data directory; do not use it for sessions that cannot be interrupted by a reload.

To install the generated Debian package:

```bash
npm run make
sudo apt install ./out/make/deb/x64/head-terminal_*.deb
```

## Main shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+P` | open the command palette |
| `Ctrl+F` | search in the active terminal |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | copy / paste |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | zoom |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | next / previous session |
| `Ctrl+1..9` | select session |
| `Ctrl+Shift+L` | `/clear` in the active terminal or in all of them |

On macOS `Ctrl` reads as `⌘` in every row except `Ctrl+Tab`, and the app shows
the shortcuts that way (`⌘⇧P`). The `Split ↓` and `Split →` buttons split the active pane. “Run everything” sends toolbar commands to every pane in the session.

## Several agents on one repository

Two agents in the same folder share one working tree: one `git status`, one
index, one `index.lock`, and commits from one landing in the other's work. Head
Terminal keeps them apart with Git worktrees — a sibling folder on its own
branch, sharing the repository's `.git`, so each agent commits and pushes
independently.

Isolation is offered exactly when it is needed: **the first session opens the
repository itself, and only a session arriving at a tree somebody is already in
gets a worktree of its own.** The new-session dialog says which case it is and
leaves the checkbox open either way; `Duplicar` on a session always isolates the
copy, since the original is by definition already there.

| Where | What it does |
|---|---|
| New session dialog | Pre-checks *Worktree isolado* when the chosen tree already has a terminal in it |
| Pane header ⎇ button | Moves that one terminal to a fresh worktree, restarts it there, and the folder in the header follows |
| Session menu → *Isolar em worktree…* | The same for every terminal of the session |
| Session menu → *Duplicar* | The copy never lands in the tree the original occupies |

Each tree is `<repo>-agent-N` next to the repository, on branch `agent-N`. Files
the repository ignores but the project needs — `.env`, `.claude/settings.local.json`
and the like — are copied over, since `git worktree add` only writes tracked
files and the agent would otherwise land in a checkout that does not run.
Ignored *directories* (`node_modules/`, `dist/`) are not copied: install them in
the worktree as usual.

Closing a session or a terminal that owns a worktree asks what to do with it —
from the pane's ✕, the session menu, `Ctrl+Shift+W` or the command palette
alike. A tree with nothing to lose — no uncommitted change and no commit that
exists only there — is offered for removal, folder and branch together; the
branch goes only while the worktree is still on it, so a branch you switched to
yourself is never touched. A tree that still holds work is never removed: the
choice is to close and keep the folder, or to cancel and go publish first.
Moving a session or terminal to another folder by hand drops the app's claim on
that worktree; it stays on disk for `git worktree remove` whenever you want it
gone.

## Agents

Profiles live in `src/config/agents.ts`:

| Profile | Expected executable |
|---|---|
| Antigravity | `agy` |
| Cursor Agent | `cursor` |
| Claude Code | `claude` |
| Codex CLI | `codex` |
| Shell | configured shell / `zsh` |

Head Terminal inherits the environment from the graphical launcher and fills in `PATH`, locale and terminal variables before starting the PTY. Markers left behind by an agent session that started the app are dropped, so a pane always runs a top-level agent session.

## Layout

```text
electron/
├── main.ts              # lifecycle and BrowserWindow
├── preload.ts           # window.headTerminal
├── ipc/                 # channels, validation and handlers
├── services/            # PTY, Git, system, secrets, voice and persistence
└── types/               # shared contract
src/
├── actions/
├── components/
├── config/
├── core/
├── hooks/
└── types/
tests/electron/          # services, IPC contract and Electron infrastructure
scripts/                 # launchers, E2E and smoke
```

## Validation and diagnostics

The smoke test tears down the process group even on failure and uses Xvfb when there is no usable `DISPLAY`. To require a display/xdotool in CI:

```bash
HEAD_TERMINAL_SMOKE_REQUIRE_DISPLAY=1 npm run smoke:electron
```

The interactive harness offers screenshots, keyboard and clicks on an isolated display:

```bash
npm run e2e -- start
npm run e2e -- shot /tmp/head-terminal.png
npm run e2e -- key ctrl+shift+p
npm run e2e -- stop
```

Local launcher failures land in `~/.local/share/head-terminal/logs/`.
