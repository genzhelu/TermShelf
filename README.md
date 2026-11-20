# TermShelf

**A terminal with a MobaXterm-style file sidebar — local and over SSH, for Windows and macOS.**

TermShelf pairs an xterm.js terminal with a file browser that follows the shell's working
directory. Drag files from Explorer/Finder onto the sidebar to transfer them into the folder
shown by the terminal; select files in the sidebar and download them to any folder you pick.
Connect over SSH and the same sidebar becomes an SFTP browser for the remote machine, with
uploads, downloads, progress, cancellation and conflict handling.

Built with Electron, React, xterm.js, node-pty and ssh2. One codebase produces native
Windows and macOS builds.

![Local session with file sidebar and transfer drawer](docs/screenshots/local-session.png)

## Features

- **Terminal first** — real PTY (ConPTY on Windows, forkpty on macOS), ANSI-256/truecolor,
  10k scrollback, resizable, tabs that keep their scrollback when hidden, configurable font
  size, clickable links, copy/paste and right-click menu. On Windows, **WSL is the default
  local terminal** when installed (switchable in Settings → Terminal), including full Linux
  folder sync and drag-and-drop transfers.
- **File sidebar synced to the shell** — the folder view follows `cd` through OSC 7 shell
  integration. Supported shells: bash, zsh, fish, PowerShell, and WSL's login shells. A per-tab toggle switches
  between "follow terminal" and manual browsing; the editable path bar covers unsupported
  shells (`cmd.exe`, `sh`).
- **Drag-and-drop transfer** — drop OS files _or folders_ onto the sidebar to copy them into
  the terminal's folder (upload over SFTP for SSH sessions). Drop on a folder row to target
  that folder. The same pipeline powers the **Upload files…** / **Upload folder…** buttons.
- **Download anywhere** — multi-select files/folders, pick a destination folder, and receive
  a recursive transfer with live progress; the last destination is remembered and a quick
  action reuses it. Remote sessions stream through SFTP.
- **Real SSH sessions** — profile manager (password, private key + passphrase, or SSH agent),
  explicit host-key trust with SHA-256 fingerprints and mismatch blocking, keepalives,
  reconnect, saved profiles, and per-session SFTP on the same connection. Opt-in **Remote GUI
  (X11 forwarding)** opens Linux GUI applications such as RELION locally while the terminal
  and SFTP sidebar keep working.
- **Fast SFTP transfers** — remote uploads/downloads use a 32-way pipelined SFTP path
  (signed-off chunks with progress and cancellation) instead of a single ordered stream,
  which is several times faster over real SSH links.
- **Transfers you can control** — aggregate and per-file progress, cancel with partial-file
  cleanup (`.part` files are removed), overwrite/skip/keep-both/conflict prompts, filename
  sanitization for Windows-invalid names, and auto-refreshing sidebars. Downloaded files are
  stamped with their **completion time** (not the remote mtime), so they appear as the newest
  items when sorting the destination by modified time.
- **Security defaults** — sandboxed renderer with context isolation, typed/zod-validated IPC,
  CSP, no Node integration in the renderer, secrets encrypted with the OS keychain/DPAPI via
  `safeStorage` (never stored in plaintext), and no secrets ever sent to the renderer.

![SSH session with remote SFTP sidebar and remote-folder sync](docs/screenshots/ssh-session.png)

## Download

Prebuilt unsigned builds (macOS DMG/ZIP, Windows NSIS, Linux AppImage) are published at
**<https://github.com/genzhelu/TermShelf/releases/latest>**. macOS needs Ventura 13 or newer;
see the [macOS instructions](#run-on-macos) for Gatekeeper notes.

## Quick start

Requirements: **Node.js 22.12+** and **pnpm 11**.

```bash
pnpm install
pnpm dev            # Electron + Vite dev server
```

Build the production bundles and run them:

```bash
pnpm build
pnpm start          # electron-vite preview
```

### Run on macOS

Electron 45 requires **macOS 13 Ventura or newer** (Apple Silicon or Intel). Node 22 and
pnpm 11 are the only build prerequisites; the native PTY ships as a prebuilt N-API binary, so
no compiler is needed.

```bash
# On the Mac (source archive is in dist/termshelf-0.2.0-source.tar.gz,
# or use the repo checkout)
tar -xzf termshelf-0.2.0-source.tar.gz
cd termshelf-0.2.0
brew install node@22                      # or nvm install 22
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npm install -g pnpm@11

pnpm install --frozen-lockfile
pnpm dev                                  # run the app from source
```

Build the distributables (unsigned by default):

```bash
pnpm build
pnpm exec electron-builder --mac --arm64   # or --x64, or omit for both arches
```

Outputs land in `dist/` as `TermShelf-0.2.0-mac-arm64.dmg` / `.zip` and
`TermShelf-0.2.0-mac-x64.dmg` / `.zip`; the unpacked app is under `dist/mac-arm64/` or
`dist/mac/`. Launch a locally built app with `open dist/mac-arm64/TermShelf.app`.

Because builds are **unsigned**, an app downloaded from CI is quarantined by Gatekeeper:
right-click the app → **Open**, or run
`xattr -dr com.apple.quarantine /Applications/TermShelf.app`. The first time you browse
Desktop/Documents/Downloads, macOS may ask you to grant file access; allow it for the sidebar.
Saved SSH secrets go to the macOS Keychain. Alternatively push the repository to GitHub and
push a tag (`git tag v0.2.0 && git push origin v0.2.0`): the release workflow builds both Mac
architectures and publishes a GitHub **Release** with the DMGs, ZIPs and checksums attached,
so other macOS users can install without a GitHub account.

### Try SSH locally with the bundled demo server

`tools/dev-sshd` is a small ssh2-based SSH server with a sandboxed SFTP subsystem and a real
PTY shell. It is a development/demo fixture (not hardened) and binds to loopback only.

```bash
# Terminal A — serves demo-remote/ as the SSH root
pnpm dev:sshd --root demo-remote --port 2222 --user demo --password demo --sftp-path-mode absolute

# Terminal B — in the app: New SSH Session → 127.0.0.1:2222, demo / demo
```

`--sftp-path-mode absolute` exposes real paths under the root, which matches the pty shell's
`$PWD` so remote-folder following (OSC 7) works end-to-end. The default `virtual` mode maps
the root to `/` and is what the integration tests use for sandbox-path coverage.

### Checks

```bash
pnpm typecheck      # main + preload + renderer, no emit
pnpm lint           # ESLint 10 + typescript-eslint
pnpm test           # unit + integration (Vitest), incl. in-process SSH/SFTP server
pnpm test:e2e       # Playwright + Electron, headless, real local and SSH flows
pnpm format:check   # Prettier
```

The end-to-end suite launches the real built app with an isolated profile, verifies terminal
input, CWD-following, new-folder, upload and download on local sessions, then connects to the
in-process demo SSH server, trusts its host key, browses/transfers over SFTP and verifies
remote `cd` folder sync.

## Builds

| Platform    | Artifact                                    | How                                                                                        |
| ----------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Windows     | Portable `.zip` (unsigned)                  | `pnpm build && pnpm exec electron-builder --win zip` — cross-buildable from Linux/macOS    |
| Windows     | NSIS `.exe` installer (unsigned by default) | GitHub Actions **release** workflow on `windows-latest`, or run `pnpm dist:win` on Windows |
| macOS       | `.dmg` + `.zip`, arm64 and x64              | GitHub Actions **release** workflow on `macos-latest`, or `pnpm dist:mac` on a Mac         |
| Linux (dev) | `.AppImage`                                 | `pnpm dist:linux`                                                                          |

The repository's `.github/workflows/release.yml` builds all three on a `v*` tag (or manual
dispatch). Tag pushes also publish a **GitHub Release** with the `.dmg`/`.zip`/`.exe`/
`.AppImage` assets, a source archive and `SHA256SUMS.txt`, so end users can install directly
from the Releases page. Builds are unsigned unless signing secrets are configured —
see [docs/BUILDING.md](docs/BUILDING.md) for signing, notarization and CI details.

Artifacts produced and verified in this checkout:

- `dist/TermShelf-0.2.0-linux-x86_64.AppImage` — built and smoke-tested headlessly.
- `dist/TermShelf-0.2.0-win-x64.zip` — Windows x64 portable build (PE32+ verified; cannot be
  executed on this Linux host).
- The macOS `.dmg`/`.zip` must be built on macOS (or the provided CI workflow); macOS
  packaging is not possible on Linux.

## Architecture

```
src/renderer        React 19 + zustand + xterm.js 6; tabbed terminals, file sidebar,
                    dialogs, transfer drawer. Sandboxed, talks to main through a typed preload.
src/preload         contextBridge API (window.termshelf) + webUtils.getPathForFile for DnD.
src/main            Electron main process:
  sessions/         LocalSession (node-pty) and SshSession (ssh2 pty + SFTP), session manager
  files/            FileBackend contract: LocalBackend, WslBackend and SftpBackend
  wsl/              WSL detection/context, UNC path mapping, shell launch/integration
  x11/              local display detection, WSLg bridge, X11 channel forwarding
  transfers/        scan → plan → conflict policy → streams → progress/cancel/cleanup
  shell/            per-shell init scripts for clean OSC 7 CWD reporting
  store/            atomic JSON config: settings, profiles, encrypted secrets, known hosts
  security/         SHA-256 host-key fingerprinting
src/shared          IPC contract, zod schemas, shared types/constants
tests/              unit, integration (dev-sshd fixture), Playwright e2e
tools/dev-sshd      demo/test SSH + SFTP server
```

Path handling is centralized in the main process: local sessions use the host path rules
(including Windows drive and UNC roots), SSH sessions use POSIX/SFTP paths, and the renderer
never constructs filesystem paths itself.

## Platform notes and limitations

- **Windows**: when WSL is installed, new local tabs start the default/selected WSL
  distribution (or Auto picks it), and the sidebar browses Linux files through the
  `\\wsl.localhost\<distro>` mount. `cd` sync, drag-and-drop uploads from Explorer,
  downloads and the normal transfer rules all work. Choose `Native` in Settings → Terminal to
  get PowerShell 7 / Windows PowerShell instead; `cmd.exe` works in manual-folder mode.
  WSL files with names Windows cannot address (e.g. containing `:`) may be hidden or fail to
  open through the UNC bridge; very large WSL directory trees can also be slower than native
  browsing. Downloads sanitize Windows-illegal characters and reserved device names. Unsigned
  builds show SmartScreen warnings.
- **macOS**: zsh/bash/fish login shells get folder sync (a generated `ZDOTDIR` preserves
  user startup files). Unsigned apps must be opened with right-click → Open (or after
  clearing quarantine). Browsing protected folders (Desktop/Documents/Downloads) may trigger
  the standard macOS privacy prompts.
- **SSH**: Linux/macOS remotes support remote-folder sync over bash/zsh/fish. Windows OpenSSH
  remotes work for the terminal and SFTP; remote-folder sync falls back to manual browsing.
  Shell integration is best-effort: if SFTP, shell detection or init-file verification fails,
  the session falls back to a plain shell and the sidebar remains fully usable manually.
- **Remote GUI (X11 forwarding)** — SSH profiles can enable **Remote GUI** to display remote
  Linux applications locally. On Windows 11 the app bridges to **WSLg** automatically (WSL
  needs `python3` or `socat`; no separate X server is required). On macOS, install
  **[XQuartz](https://www.xquartz.org/)**; TermShelf launches it on demand. On Linux the app
  uses the current X11 display. The remote host must permit X11 forwarding (`X11Forwarding
yes` and `xauth`); if it rejects the request, the terminal opens normally with a warning.
  Enable it per saved profile in the SSH dialog. Example: connect to a RELION host, enable
  Remote GUI, then run `relion` (or the full path to the RELION executable). X11 is only safe with
  trusted hosts — a remote application can access your local display while forwarding is
  enabled. GUI rendering may be slower than local; OpenGL/GLX apps can require software
  rendering. The remote sidebar remains SFTP, so file browsing is unaffected.
- **Running `ssh` inside a native local tab does not repoint the sidebar.** Use the app's
  **New SSH Session** flow (server icon, `Ctrl/Cmd+Shift+T`) so it can open SFTP with the
  same credentials and follow the remote shell's folder.
- **Scope for v1**: no jump hosts/port forwarding, no built-in editor, no upload
  resume/retry, no drag-out to the desktop, no session restore on launch, no light theme, and
  no bundled X server on Windows/macOS. Remote GUI uses WSLg/XQuartz/the local display as
  described above. WSL file browsing uses the Windows UNC mount, so Linux filenames Windows
  cannot address are unsupported; choosing a specific shell inside the distro is not exposed
  (the distro's login shell is used). Keyboard-interactive auth is limited to a single
  non-echo password prompt.
- Electron bundle size is ~100 MB; terminal rendering uses xterm's DOM renderer for stability
  (WebGL can be added later).

## Security

- Renderer: `sandbox: true`, `contextIsolation: true`, no `nodeIntegration`, strict CSP in
  packaged builds, navigation/window-open denied, external links restricted to http(s).
- IPC: sender validation, channel whitelist, zod validation on every payload.
- Credentials: main process only; saved passwords/passphrases are encrypted with
  `safeStorage` (Keychain/DPAPI). If encryption is unavailable (e.g. a Linux box without a
  keyring) TermShelf never persists the secret and asks on each connection.
- Host keys: trust-on-first-use with a visible SHA-256 fingerprint; unknown keys are blocked
  until explicitly trusted and a changed key is a hard error that requires forgetting the old
  key. Known hosts and profiles live in the app's `userData` directory.
- The demo SSH server is a development fixture: loopback only, demo credentials, not hardened.

## Documentation

- [docs/BUILDING.md](docs/BUILDING.md) — prerequisites, native modules, packaging matrix,
  signing/notarization, CI, troubleshooting.
- [docs/QA.md](docs/QA.md) — Windows 11 and macOS acceptance checklist, including host-key
  flows, drag-and-drop, transfers, secrets-at-rest checks and the demo server.

## License

UNLICENSED / proprietary by default. Add a license before distributing. The application
bundles Electron, Chromium, xterm.js, ssh2 and node-pty; their licenses are included in the
packaged app's license files.
