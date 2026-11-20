# Building, packaging and releasing TermShelf

TermShelf is an Electron app (electron-vite + React for the renderer, Node main process
with ssh2 and node-pty). This document covers the exact dev/build commands, the
electron-builder targets, which host builds which artifact, CI, and code signing.

---

## 1. Prerequisites

| Tool                 | Version                                     | Notes                                                                                                                                        |
| -------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js              | **22.x**                                    | CI pins Node 22 (`actions/setup-node@v4`). Node 22.12+ is recommended.                                                                       |
| pnpm                 | **11.x**                                    | CI pins `pnpm/action-setup@v4` with version `11`.                                                                                            |
| Python + build tools | only if a native dependency has no prebuild | Not needed for the supported platforms: `@homebridge/node-pty-prebuilt-multiarch`, `sharp` and `ssh2`/`cpu-features` ship prebuilt binaries. |
| Xvfb / X server      | only for real GUI e2e runs on Linux         | Not needed for `pnpm test`.                                                                                                                  |
| OS packaging tools   | see [§4](#4-packaging-targets)              | NSIS on Windows, Xcode CLT on macOS, AppImage tooling on Linux (downloaded by electron-builder).                                             |

Enable pnpm at the pinned major version (either way is fine):

```bash
corepack enable && corepack prepare pnpm@11 --activate
# or
npm install -g pnpm@11
```

Check versions:

```bash
node --version    # v22.x
pnpm --version    # 11.x
```

### Why `pnpm install` works without a compiler

`pnpm-workspace.yaml` contains an `allowBuilds` list for the packages whose install scripts
are allowed to run under pnpm 11:

```yaml
allowBuilds:
  '@homebridge/node-pty-prebuilt-multiarch': true
  electron: true
  electron-winstaller: true
  esbuild: true
  cpu-features: false
  ssh2: false
```

Do **not** remove the `true` entries: pnpm 11 blocks dependency build scripts by default,
and these packages need their postinstall (Electron binary download, pty prebuild
validation, esbuild binary setup). `cpu-features`/`ssh2` are optional native accelerators;
they are intentionally `false` because ssh2 falls back to its pure-JS crypto and neither
package has a prebuilt binary for every platform (blocking them avoids failed node-gyp
runs on machines without a compiler). They do **not** compile native code from source on
the supported x64/arm64 platforms.

A portable Windows build can be cross-packaged from Linux/macOS with
`pnpm exec electron-builder --win zip` (electron-builder edits the PE resources in JS; no
Wine needed). The NSIS installer and all macOS targets are built natively in the release
workflow, because NSIS needs Wine on non-Windows hosts and DMG/signing require macOS.

---

## 2. Install and run

```bash
# from the repository root
pnpm install --frozen-lockfile   # CI/exact installs; use plain `pnpm install` while hacking
pnpm dev                         # electron-vite dev server with renderer HMR
```

`pnpm dev` starts the Vite renderer dev server and an Electron main process.
The app writes config/logs under Electron's `userData` directory (see `docs/QA.md`).

### Useful scripts

| Command                                     | What it does                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm dev`                                  | Run the app in development (electron-vite dev, HMR renderer, main/preload rebuild on change) |
| `pnpm start`                                | Preview a production build without packaging (`electron-vite preview`)                       |
| `pnpm build`                                | Compile main + preload + renderer into `out/`                                                |
| `pnpm typecheck`                            | `tsc` for node and web tsconfigs, no emit                                                    |
| `pnpm lint`                                 | ESLint over the repo                                                                         |
| `pnpm format` / `pnpm format:check`         | Prettier write / verify                                                                      |
| `pnpm test`                                 | Vitest unit + integration tests (no display needed)                                          |
| `pnpm test:watch`                           | Vitest in watch mode                                                                         |
| `pnpm test:e2e`                             | Playwright Electron e2e (needs a built app + a display; Lead owns `tests/e2e`)               |
| `pnpm dev:sshd`                             | Run the demo SSH server (`tools/dev-sshd`) for local SSH testing                             |
| `pnpm icons`                                | Generate `build/icon.png`, `build/icon.ico`, `build/icon.icns` from the embedded SVG         |
| `pnpm dist`                                 | `electron-vite build && electron-builder` for the current host (all default targets)         |
| `pnpm dist:win` / `dist:mac` / `dist:linux` | Build + package for one platform                                                             |

### Demo SSH server (not part of the packaged app)

```bash
pnpm build
pnpm dev:sshd                       # 127.0.0.1:2222, demo/demo, SFTP root demo-remote/
pnpm dev:sshd --port 0 --quiet      # ephemeral port, prints the bound port
pnpm dev:sshd --sftp-path-mode absolute   # SFTP paths = real host paths (folder sync / OSC 7)
```

SFTP path modes: `virtual` (default) exposes the sandbox root as `/`; `absolute` exposes
the real host paths under the root so the SFTP namespace matches the pty shell's cwd (what
the app's remote folder sync needs). Both are sandboxed to `--root`; paths outside it are
rejected.

It is a development/test fixture only: it serves password auth for `demo/demo`, generates and
persists an ed25519 host key at `.dev-sshd/host.key`, exposes a real pty shell, and sandboxes
SFTP to `--root`. See `tools/dev-sshd/server.ts`, `docs/QA.md` and
`tests/integration/dev-sshd.test.ts`. `.dev-sshd/` and `demo-remote/` are gitignored.

---

## 3. Build outputs

```
out/
  main/index.js          # Electron main process bundle
  preload/index.js       # preload bundle (contextBridge API)
  renderer/              # renderer HTML/CSS/JS
build/
  icon.png               # Linux icon (1024x1024)
  icon.ico               # Windows icon (7 sizes)
  icon.icns              # macOS icon (11 entries)
  icons/<size>x<size>.png
dist/                    # electron-builder output (installers, blockmaps) - gitignored
```

`out/` and `dist/` are gitignored. `build/icon.*` are generated by `pnpm icons`; the release
workflow runs that step before packaging, and it is safe to commit the generated files if you
prefer having them in the repo (the script is deterministic/idempotent).

The renderer is loaded from `out/renderer/index.html` in production and from the Vite dev
server (`ELECTRON_RENDERER_URL`) in development.

---

## 4. Packaging targets

Packaging is configured in `electron-builder.yml` (owned by the Lead — do not edit it from
the test/build docs without coordination):

| Platform | Targets          | Arch       | Output                                             |
| -------- | ---------------- | ---------- | -------------------------------------------------- |
| Windows  | `nsis` installer | x64        | `dist/TermShelf-<version>-win-x64.exe`             |
| macOS    | `dmg` + `zip`    | arm64, x64 | `dist/TermShelf-<version>-mac-<arch>.dmg` / `.zip` |
| Linux    | `AppImage`       | x64        | `dist/TermShelf-<version>-linux-x64.AppImage`      |

All builds are **unsigned by default**: `mac.identity: null` in the config, and CI sets
`CSC_IDENTITY_AUTO_DISCOVERY=false` (see [§6](#6-code-signing-optional)).

### What can be built on which host

| Target                                        | Windows host | macOS host                              | Linux host                              |
| --------------------------------------------- | ------------ | --------------------------------------- | --------------------------------------- |
| Windows NSIS (x64)                            | ✅           | ⚠️ possible with wine but not supported | ⚠️ possible with wine but not supported |
| macOS dmg/zip (arm64/x64)                     | ❌           | ✅ (both arches from one macOS host)    | ❌                                      |
| Linux AppImage (x64)                          | ❌           | ❌                                      | ✅                                      |
| `pnpm build` / `pnpm test` / `pnpm typecheck` | ✅           | ✅                                      | ✅                                      |
| Real GUI e2e                                  | ✅           | ✅                                      | ✅ with `xvfb-run`                      |

Practical rule: **package each platform on its own OS runner** (exactly what
`.github/workflows/release.yml` does), because the mac/Windows packaging steps rely on
platform binaries (codesign, hdiutil, NSIS) and on the prebuilt node-pty binary for the
target platform.

---

## 5. Native modules: node-pty, asarUnpack and N-API prebuilds

TermShelf uses `@homebridge/node-pty-prebuilt-multiarch` for local shells and for the SSH
server's pty. Three things matter for packaging:

1. **N-API prebuilds.** The package ships N-API prebuilt binaries for Windows/macOS/Linux on
   x64 and arm64 in its `prebuilds/` directory. N-API is ABI-stable across Node/Electron
   versions, so the binary built for Node also works inside Electron — **no `electron-rebuild`
   and no compiler are required**. `electron-builder.yml` therefore sets `npmRebuild: false`,
   which speeds up packaging and avoids needing build tools on CI runners.
2. **`asarUnpack` is required.** electron-builder packs the app into `app.asar` by default.
   Native modules cannot be loaded from inside that archive, and node-pty additionally
   _executes_ helper binaries as child processes (e.g. the pty helper on macOS, `conpty` /
   `winpty` on Windows). Files inside an asar are not real files on disk, so this fails. The
   config unpacks the whole module:

   ```yaml
   asar: true
   asarUnpack:
     - node_modules/@homebridge/node-pty-prebuilt-multiarch/**/*
   ```

   At runtime the unpacked copy lives in `resources/app.asar.unpacked/node_modules/...`; the
   main-process `require('@homebridge/node-pty-prebuilt-multiarch')` resolves there
   automatically (Electron transparently redirects unpacked paths). Keep `asarUnpack` in sync
   with any other native dependency added later.

3. **Prebuild selection at runtime** is handled by the package itself
   (`prebuilds/<platform>-<arch>/`), so cross-arch macOS builds package the right binary as
   long as the dependency install happened on the runner.

`ssh2` is pure JS for the feature set used here (`cpu-features` is optional and loaded only
when present). `sharp` is only a **devDependency** used by `scripts/make-icons.ts`, so it is
not shipped in the app.

---

## 5b. WSL default terminal (Windows-only behavior)

On Windows, TermShelf can open a **WSL distribution as the local terminal** instead of
PowerShell. This is a runtime feature of the Windows build only; nothing extra is packaged.
Implementation pointers:

- `src/main/wsl/service.ts` — detects `wsl.exe` (`PATH`, then `C:\Windows\System32\wsl.exe`),
  tolerates UTF-16LE output from `wsl.exe`, parses `wsl -l -q` / `wsl -l -v`, and probes the
  selected distro with `wsl.exe [-d <distro>] -e sh -c …` to get its name, `$HOME`, `$SHELL`
  and (`wslpath -w /`) the Windows UNC root. UNC candidates are `\wsl.localhost\<distro>`
  first, then `\wsl$\<distro>`; if none is reachable the tab falls back to a terminal-only
  WSL session (no file sidebar). The service caches detection for 30 s.
- `src/main/wsl/launch.ts` — prepares the interactive launch. Shell-integration scripts are
  written _into the distro's_ `/tmp/termshelf-<session>-<launch>/` directory **through the UNC mount**
  (so the same bash/zsh/fish OSC 7 hooks as native POSIX shells apply), verified with
  `wsl.exe … test -r <linux path>`, then launched as
  `wsl.exe -d <distro> --cd <linux-home> -e <shell> …`. `--cd` matters: it starts the shell in
  the Linux home instead of inheriting the Windows working directory. When the UNC root, shell
  or script write is unusable, the launch degrades to a plain
  `wsl.exe -d <distro> --cd <linux-home>` shell (terminal works, sidebar follow disabled).
  The generated `/tmp/termshelf-*-*` directory is removed when the tab closes.
- `src/main/files/wsl-backend.ts` — the `FileBackend` for WSL tabs: the renderer sees POSIX
  paths (`/home/<user>`), while reads/writes/listing go through the UNC path. A `null` UNC root
  produces a terminal-only session whose file operations fail with `WSL_FS_UNAVAILABLE`.
- `src/main/sessions/manager.ts` — picks WSL vs native from
  `settings.localTerminal` (`auto`/`native`/`wsl`) and `settings.wslDistro`, honours
  per-request overrides, and falls back to the native shell (with a warning toast) when WSL
  cannot start.

### What can and cannot be tested in CI

- `tests/unit/wsl-service.test.ts`, `wsl-backend.test.ts` and `wsl-launch.test.ts` are
  **hermetic**: they inject `WslService({ platform: 'win32', executablePath: 'C:\\fake\\wsl.exe',
runner, pathExists })`, a fake test-readable hook and a temp directory standing in for the
  UNC root. They never spawn `wsl.exe` and run on Linux/macOS/Windows CI.
- **Real WSL behavior cannot be automated on hosted CI runners** (GitHub's `windows-latest`
  does not have WSL distributions enabled). End-to-end WSL validation — default WSL tab,
  `--cd` home, sidebar `/home`, OSC 7 follow, Explorer drag-drop, `ssh -Y` via WSLg, settings
  switching, WSL-unavailable fallback, UNC-invalid filenames — must be done manually on a
  Windows 11 + WSL2 machine using `docs/QA.md` §3b.
- The feature must gracefully degrade: if `wsl.exe` or any distro is missing, `Auto`/`WSL`
  falls back to the native shell (warning toast) and Settings disables the WSL option. Keep
  that fallback path working when changing detection code.

---

## 5c. Remote GUI / X11 forwarding

SSH profiles can opt into **Remote GUI**, which requests X11 forwarding from the remote sshd
and relays the resulting channels to a local X server:

- `src/main/x11/service.ts` — local display detection, X11 auth probing, and the Windows/WSLg
  authenticated TCP bridge. On Windows, a small Python process inside WSL forwards TCP to
  `/mnt/wslg/.X11-unix/X<n>`; on macOS XQuartz is launched on demand; on Linux/macOS the
  current DISPLAY is used. The WSLg bridge requires a per-process preface token and stops when
  the last X11 tab releases it. A per-session MIT cookie is validated by the relay, which
  substitutes the local server credential without modifying the user's xauth database.
- `src/main/x11/forwarder.ts` — authenticates each ssh2 `x11` setup packet and relays it to
  the local display, substituting local credentials when needed (bounded at 64 concurrent
  clients).
- `src/main/sessions/ssh.ts` — prepares the display before opening the shell, passes
  `x11` options to `client.shell`/`client.exec`, and retries the terminal without X11 if the
  remote host rejects forwarding.

Real WSLg/XQuartz/remote-host X11 cannot be exercised on hosted CI runners. The unit tests are
hermetic (`tests/unit/x11-service.test.ts`, `tests/unit/x11-forwarder.test.ts`); remote GUI
acceptance must be done manually per `docs/QA.md` §6b. The fallback test uses the in-process
dev SSH server, which intentionally rejects X11 requests.

---

## 6. Code signing (optional)

Release builds are intentionally unsigned so any contributor/CI can produce artifacts. The
release workflow sets:

```yaml
env:
  CSC_IDENTITY_AUTO_DISCOVERY: 'false'
```

and never references signing secrets (so undefined secrets can never break the workflow).
To enable signing, add repository secrets and wire them into the relevant job:

### Windows (Authenticode)

| Secret                 | Meaning                                          |
| ---------------------- | ------------------------------------------------ |
| `WIN_CSC_LINK`         | Base64/PATH to a `.pfx` code-signing certificate |
| `WIN_CSC_KEY_PASSWORD` | Password for that `.pfx`                         |

Then remove/override `CSC_IDENTITY_AUTO_DISCOVERY=false` for the Windows job (or set it to
`true`). electron-builder signs the NSIS installer and the app executable. EV certificates
may require a hardware token and cannot run on hosted runners without a cloud-signing service.

### macOS (Developer ID + notarization)

| Secret                        | Meaning                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| `CSC_LINK`                    | Base64/PATH to a `.p12` "Developer ID Application" certificate |
| `CSC_KEY_PASSWORD`            | Password for the `.p12`                                        |
| `APPLE_ID`                    | Apple ID for notarization                                      |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID                        |
| `APPLE_TEAM_ID`               | Apple Developer Team ID                                        |

Additionally update `electron-builder.yml` mac settings: replace `identity: null` with the
Developer ID identity (or remove it), set `hardenedRuntime: true`, and add notarization
(`notarize: true` in electron-builder ≥ 26 requires the Apple credentials above). Unsigned
builds run, but macOS Gatekeeper shows the warning described in `docs/QA.md` §13.

### Linux

AppImages are unsigned by convention; GPG signing is optional and not configured here.

---

## 7. Continuous integration and releases

### `.github/workflows/ci.yml`

| Job             | Runner                                    | Steps                                                                                                                                    |
| --------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `check`         | `ubuntu-latest`                           | install → `pnpm typecheck` → `pnpm lint` → `pnpm test`                                                                                   |
| `e2e`           | `ubuntu-latest`                           | install → `pnpm build` → install Electron libs + Xvfb → `xvfb-run -a pnpm test:e2e` (skips with a notice while `tests/e2e` has no specs) |
| `test-other-os` | `windows-latest`, `macos-latest` (matrix) | install → `pnpm typecheck` → `pnpm test`                                                                                                 |

Notes:

- `pnpm install --frozen-lockfile` requires an up-to-date `pnpm-lock.yaml`; commit lockfile
  changes with any dependency change.
- The e2e job installs `xvfb` and the Electron system libraries (`libnss3`, `libgbm1`,
  `libxss1`, `libxtst6`, `libgtk-3-0t64`/`libgtk-3-0`, `libasound2t64`/`libasound2`) because
  the GitHub Ubuntu image does not include them. `pnpm test` itself is headless and needs no
  display or system libraries.
- `pnpm test` covers **unit + integration** (`tests/` configured by `vitest.config.ts`). The
  integration suite starts the in-process dev SSH server on ephemeral ports and spawns a pty
  from the prebuilt binary, so it exercises the native module on every OS in the matrix.
- The WSL feature's unit tests (`tests/unit/wsl-*.test.ts`) are hermetic (fake `wsl.exe` path,
  fake runner, temp dir as UNC root) and run on every OS. Real WSL cannot be exercised on
  hosted CI runners — see §5b and the manual WSL checklist in `docs/QA.md` §3b.

### `.github/workflows/release.yml`

- Triggers: pushing a `v*` tag or manual `workflow_dispatch`.
- Three independent jobs: `windows` (NSIS), `macos` (dmg + zip, arm64 + x64), `linux`
  (AppImage). Each installs with pnpm 11/Node 22, runs `pnpm icons`, `pnpm build`, then
  `npx electron-builder --<target> --publish never`.
- Artifacts are uploaded with `actions/upload-artifact@v4` (installer/zip/dmg/AppImage,
  blockmaps, `latest*.yml`) and kept for 14 days.
- On a **tag push**, a dependent `publish` job downloads all artifacts, creates a source
  archive and `SHA256SUMS.txt`, and publishes a **GitHub Release** with those assets using the
  workflow's `contents: write` permission (no personal token needed). macOS users can then
  download the DMG straight from the repository's Releases page. Manual dispatches do not
  publish a release; download artifacts from the run instead.
- Builds are unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false`). On macOS the release notes tell
  users to right-click → Open (or clear the quarantine attribute) the first time.

### Reproducing CI locally

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test     # == `check` job

pnpm build                                    # == e2e job build step
xvfb-run -a pnpm test:e2e                     # only if tests/e2e exists

pnpm icons && pnpm build && pnpm dist         # == release packaging (current host only)
```

---

## 8. Local Linux/WSL development on this workstation

This WSL box has no system Electron dependencies installed globally and no C compiler. Two
repo-local workarounds exist:

- **Electron runtime libraries** live in `.local-deps/usr/lib/x86_64-linux-gnu`
  (`libnss3`, `libnspr4`, `libasound.so.2`, …) and `.local-deps/` is gitignored. Launch
  Electron with the library path extended:

  ```bash
  export LD_LIBRARY_PATH="$PWD/.local-deps/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  pnpm dev
  ```

  Without it you may see `error while loading shared libraries: libnss3.so` /
  `libasound.so.2` from Electron. If Chromium reports a sandbox error under WSL
  (`SUID sandbox helper binary was found, but is not configured correctly`), launch with
  `--no-sandbox` for local dev only (never ship that flag).

- **No C compiler**: do not run `pnpm install` with build scripts that need `node-gyp` from
  source. The prebuilt binaries cover Node 22 / Electron 45 on x64 Linux; `pnpm test` and
  `pnpm build` work without a compiler. Do not run `pnpm rebuild`, `electron-rebuild`, or
  delete `node_modules/@homebridge/**` (the prebuild would need to be re-fetched).

The **packaged** app must not rely on `.local-deps`: real Linux distributions provide these
libs, and the AppImage is built on a standard Ubuntu CI runner. `.local-deps` and the
`LD_LIBRARY_PATH` trick are development-only.

**WSL GUI note:** `pnpm dev` needs WSLg (Windows 11) or an X server. For headless checks use
`pnpm test`/`pnpm build`; use `xvfb-run` for GUI e2e.

**WSL _feature_ development:** this workstation is itself a WSL guest. The app's WSL-default-
terminal feature can only be exercised from a **Windows host** running the packaged/`pnpm dev`
app against WSL; from inside WSL there is no `wsl.exe`. The hermetic `tests/unit/wsl-*.test.ts`
suite still runs here (and in CI) because it injects the executable path/runner and uses temp
directories instead of a real UNC mount — use it while iterating on the feature, then validate
end-to-end on Windows via `docs/QA.md` §3b.

---

## 9. Troubleshooting

| Symptom                                               | Likely cause / fix                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install` warns "Ignored build scripts"          | `allowBuilds` in `pnpm-workspace.yaml` was modified; restore it and reinstall.                                                                                                                                                                                                        |
| `Error: Electron failed to install correctly`         | Interrupted `pnpm install`; remove `node_modules/electron` and reinstall (needs network).                                                                                                                                                                                             |
| `libnss3.so` / `libasound.so.2` missing on Linux      | Use the `.local-deps` `LD_LIBRARY_PATH` from §8, or install the distro packages (`libnss3 libasound2t64 libgtk-3-0t64`).                                                                                                                                                              |
| node-pty native error after packaging                 | `asarUnpack` entry removed/broken, or the prebuild for the target arch was not installed at pack time. Reinstall dependencies and rebuild on the target OS.                                                                                                                           |
| `pnpm typecheck` fails on a clean checkout            | Make sure you did not edit tsconfigs/config files outside your task; run `pnpm exec tsc -p tsconfig.node.json --noEmit` and read the first error.                                                                                                                                     |
| e2e job fails with "Missing X server or $DISPLAY"     | Wrap the runner in `xvfb-run -a` (CI does this).                                                                                                                                                                                                                                      |
| Release packaging can't find `build/icon.icns`/`.ico` | Run `pnpm icons` first (the release workflow does).                                                                                                                                                                                                                                   |
| `frozen-lockfile` failure in CI                       | Lockfile out of date: `pnpm install`, commit `pnpm-lock.yaml`.                                                                                                                                                                                                                        |
| Host key/permission errors with `pnpm dev:sshd`       | Delete `.dev-sshd/host.key` and restart (regenerates); the directory is gitignored and may be read-only in some sandboxes.                                                                                                                                                            |
| New Windows terminal opens PowerShell, not WSL        | `Auto` only uses WSL when `wsl.exe` was found and WSL reports a distro; check `wsl -l -v`, or set Settings → Local terminal = WSL. A native `shellPath` in Settings makes `Auto` prefer native.                                                                                       |
| WSL tab opens but the sidebar is empty/errors         | The UNC mount (`\\wsl.localhost\<distro>` / `\\wsl$\<distro>`) was not reachable (distro stopped, network-drive policy, old Windows build). Clicking refresh or restarting the distro usually re-probes it; otherwise the tab degrades to terminal-only (`WSL_FS_UNAVAILABLE` toast). |
| WSL files with `:` `*` etc. missing from the sidebar  | Windows-invalid filenames cannot be addressed through the UNC mount — expected limitation; the terminal can still see them. See `docs/QA.md` §3b.11.                                                                                                                                  |
| WSL detection slow on first tab                       | `wsl.exe` cold start can take seconds; detection is cached for 30 s. Subsequent tabs are fast (see `WslService` cache).                                                                                                                                                               |
