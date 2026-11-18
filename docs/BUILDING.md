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

### `.github/workflows/release.yml`

- Triggers: pushing a `v*` tag or manual `workflow_dispatch`.
- Three independent jobs: `windows` (NSIS), `macos` (dmg + zip, arm64 + x64), `linux`
  (AppImage). Each installs with pnpm 11/Node 22, runs `pnpm icons`, `pnpm build`, then
  `npx electron-builder --<target> --publish never`.
- Artifacts are uploaded with `actions/upload-artifact@v4` (installer/zip/dmg/AppImage,
  blockmaps, `latest*.yml`) and kept for 14 days. There is no automatic GitHub Release
  upload; download the artifacts from the workflow run (or add a release step once signing is
  configured).
- Builds are unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false`).

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

---

## 9. Troubleshooting

| Symptom                                               | Likely cause / fix                                                                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install` warns "Ignored build scripts"          | `allowBuilds` in `pnpm-workspace.yaml` was modified; restore it and reinstall.                                                                              |
| `Error: Electron failed to install correctly`         | Interrupted `pnpm install`; remove `node_modules/electron` and reinstall (needs network).                                                                   |
| `libnss3.so` / `libasound.so.2` missing on Linux      | Use the `.local-deps` `LD_LIBRARY_PATH` from §8, or install the distro packages (`libnss3 libasound2t64 libgtk-3-0t64`).                                    |
| node-pty native error after packaging                 | `asarUnpack` entry removed/broken, or the prebuild for the target arch was not installed at pack time. Reinstall dependencies and rebuild on the target OS. |
| `pnpm typecheck` fails on a clean checkout            | Make sure you did not edit tsconfigs/config files outside your task; run `pnpm exec tsc -p tsconfig.node.json --noEmit` and read the first error.           |
| e2e job fails with "Missing X server or $DISPLAY"     | Wrap the runner in `xvfb-run -a` (CI does this).                                                                                                            |
| Release packaging can't find `build/icon.icns`/`.ico` | Run `pnpm icons` first (the release workflow does).                                                                                                         |
| `frozen-lockfile` failure in CI                       | Lockfile out of date: `pnpm install`, commit `pnpm-lock.yaml`.                                                                                              |
| Host key/permission errors with `pnpm dev:sshd`       | Delete `.dev-sshd/host.key` and restart (regenerates); the directory is gitignored and may be read-only in some sandboxes.                                  |
