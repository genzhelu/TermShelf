# TermShelf — QA acceptance checklist

Manual acceptance tests for release candidates. Run the full checklist on **Windows 11**
and **macOS**; Linux is worth a smoke pass. Each item has a **PASS/FAIL** box and the
expected observable result. Record the build (`git sha`, version from **TermShelf → About**),
the host OS + version, and attach screenshots/logs for failures.

- Product: TermShelf — a terminal with a MobaXterm-style file sidebar for local and SSH
  sessions (Electron + xterm.js + ssh2 + node-pty).
- Test build: unsigned. See [Unsigned app warnings](#13-unsigned-app-warnings) first.
- Backend under test: `tools/dev-sshd` demo SSH server (ships in the repo, loopback demo).

---

## 0. Test environment

| Tool                    | Version / notes                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Node.js                 | 22.x (only needed to run the demo SSH server and dev build)                                                                    |
| pnpm                    | 11.x (`pnpm --version`)                                                                                                        |
| Demo SSH server         | `pnpm dev:sshd` — defaults to `127.0.0.1:2222`, user `demo`, password `demo`                                                   |
| SSH test fixtures       | a folder with a few files, a nested folder, a symlink if the host OS supports it, and one large file (≥ 1 GB) for cancel tests |
| Remote OS for pty tests | Linux/macOS/WSL host; the demo server needs a real POSIX shell                                                                 |

Commands used by this checklist (run from the repository root):

```bash
pnpm install --frozen-lockfile   # build machine only; never needed for a packaged app
pnpm build                       # or use an installer built by CI / `pnpm dist:*`
pnpm dev:sshd                    # demo SSH server on 127.0.0.1:2222
pnpm dev:sshd --root ./demo-remote --port 2222 --user demo --password demo
```

Create demo content once (POSIX):

```bash
mkdir -p demo-remote/photos demo-remote/empty
printf 'hello termshelf\n' > demo-remote/hello.txt
head -c 2097152 /dev/urandom > demo-remote/photos/sample.bin
printf 'nested\n' > demo-remote/photos/notes.txt
fallocate -l 1G demo-remote/large.bin 2>/dev/null || dd if=/dev/zero of=demo-remote/large.bin bs=1M count=1024
```

**Windows 11 note:** the demo SSH server must run where a POSIX shell exists. Run it in
WSL (`wsl` then `cd` to the repo clone) and make it reachable from Windows:

```powershell
# in WSL: bind all interfaces (demo credentials — trusted networks only!)
pnpm dev:sshd --host 0.0.0.0 --root demo-remote
# in WSL, get the address Windows should use:
hostname -I        # e.g. 172.24.x.y
# in the app: host = that IP, port 2222, user demo, password demo
```

Alternatively use a real SSH host (another machine, WSL OpenSSH, or a VM). The
`127.0.0.1` default works when the app and server run on the same machine.

For **remote folder sync** (OSC 7 / follow-cwd) tests use
`pnpm dev:sshd --sftp-path-mode absolute`: the default `virtual` mode exposes the
sandbox to SFTP as `/`, while the pty shell's cwd is the real host directory, so the two
namespaces intentionally differ (real SSH hosts have a single namespace — `absolute` mode
reproduces that).

---

## 1. Install and launch — Windows 11

From the built installer (`dist/TermShelf-<version>-win-x64.exe`) or a dev run (`pnpm dev`).

- [ ] **1.1** Run the installer. It is per-user by default; no admin prompt is required and
      the install directory can be changed. PASS = wizard completes without errors.
- [ ] **1.2** Launch **TermShelf** from the Start menu. A dark window opens with a terminal
      area and a file sidebar; the title says **TermShelf**. PASS = window renders, no blank
      white screen, no uncaught-exception dialog.
- [ ] **1.3** Close and relaunch. Window size/position and sidebar width are restored.
- [ ] **1.4** Check the log folder has no crash entries (see [Appendix A](#appendix-a--file-locations)).

## 2. Install and launch — macOS

From `dist/TermShelf-<version>-mac-<arch>.dmg` (or `pnpm dev`).

- [ ] **2.1** Open the `.dmg`, drag **TermShelf** into **Applications**, eject the DMG.
- [ ] **2.2** First launch: macOS blocks the unsigned app (see §13). Open it anyway, then
      verify it starts and shows the terminal + sidebar.
- [ ] **2.3** On Apple Silicon (`arm64`) and Intel (`x64`) builds: the app launches and
      `uname -m` in the terminal reports the matching architecture.
- [ ] **2.4** Quit and relaunch (⌘Q then open). Window geometry and sidebar width restore.
- [ ] **2.5** Rotate/normalize: windows on a second display restore onto that display; a window
      moved off-screen is clamped back on screen.

## 3. Local session — PowerShell (Windows) / zsh (macOS)

Create a local terminal session (new tab / **New local session**), then exercise the sidebar.

- [ ] **3.1 (Windows)** The default shell opens (PowerShell or configured `shellPath`). Type
      `pwd`, `dir` — output renders and the terminal accepts input.
- [ ] **3.2 (macOS)** The default shell opens (zsh unless configured otherwise). Type
      `pwd`, `ls`; output renders.
- [ ] **3.3** The sidebar shows the home folder and its contents; folders come first, then files,
      sorted by name. Breadcrumbs/path field match the location.
- [ ] **3.4** Click a folder → navigate into it; ← back button returns; ↑ parent works; typing an
      absolute path in the path bar + Enter navigates there; invalid path shows an inline error,
      not a crash.
- [ ] **3.5** **Folder ↔ terminal sync (follow cwd):** with follow mode enabled (pin/locate
      toggle in the sidebar toolbar), `cd` in the terminal into a folder — the sidebar follows
      after the prompt returns. Toggle follow mode off, `cd` again — sidebar stays put.
- [ ] **3.6** **New folder…** (toolbar) creates a folder; the name prompt rejects empty/duplicate
      names with a clear message.
- [ ] **3.7** Rename a file/folder (context menu) and confirm the new name is shown and the pane
      refreshes. Renaming to an existing name is refused with a readable error.
- [ ] **3.8** Delete a file/folder (context menu). With `confirmDelete` on, a confirmation dialog
      appears; cancel leaves the item, confirm removes it. Deleting a non-empty folder asks for
      recursive confirmation and succeeds.
- [ ] **3.9** **Show hidden files** toggle reveals/hides dotfiles (macOS) / hidden-attribute files
      (Windows) and the choice survives a restart.
- [ ] **3.10** Sort by name/size/mtime and toggle asc/desc; sorting persists across restarts.

## 4. Upload — drag and drop from Explorer / Finder

- [ ] **4.1** In a **local** session, drag a file from Explorer/Finder onto the sidebar. A
      "Drop to upload" overlay appears while dragging; dropping copies the file into the
      currently displayed folder. PASS = file appears after refresh and content matches.
- [ ] **4.2** Drag a folder. The folder and all nested files are copied recursively.
- [ ] **4.3** Drag multiple files at once. All are copied; the transfer drawer shows one job
      with correct progress and file counts.
- [ ] **4.4** Drag from Explorer/Finder into an **SSH** session (dev:sshd) — files upload over
      SFTP into the current remote folder; progress, byte totals, and completion toast appear.
- [ ] **4.5** Drag into a disconnected/error tab: an informative toast appears and nothing is
      half-written.
- [ ] **4.6** Cancelling a drag (drop outside the window) leaves no partial files and no job.

## 5. Download and conflict handling

- [ ] **5.1** In a local session or SSH session, select one or more files → **Download
      selected…** → choose a destination folder. Files appear there with identical bytes
      (`fc /b` / `sha256sum` compare).
- [ ] **5.2** Download a folder recursively; nested structure is preserved (empty folders too).
- [ ] **5.3** Check file modification times are preserved (within filesystem granularity).
- [ ] **5.4** Download the same file twice. A **conflict** dialog appears listing the colliding
      item(s) with actions: **Overwrite**, **Keep both**, **Skip**, **Cancel**. Verify each: - Overwrite → destination replaced with the new content. - Keep both → new file named `name (1).ext` (or next free number). - Skip → existing file untouched, job completes. - Cancel → nothing written, existing file untouched.
- [ ] **5.5** Illegal/awkward names: create remote files named `CON`, `a:b.txt`, `trailing. `,
      `name?*` (POSIX side) and download them on Windows — files are sanitized to legal names
      (`_CON`, `a_b.txt`, `trailing`, `name__`) and still download successfully.
- [ ] **5.6** Download with the destination folder on a different drive/network share; error is
      surfaced as a toast/job error, not a crash.
- [ ] **5.7** Remembered download folder: after changing it in the picker, the next
      **Download selected…** starts in that folder; restart preserves it.

## 6. SSH session to the demo server (password auth)

1. Terminal menu → **New SSH session** (or the SSH button, depending on the build).
2. Fill in: host `127.0.0.1` (or WSL IP), port `2222`, username `demo`, auth method
   **Password**, password `demo`. Leave "save password" off for the first pass.

- [ ] **6.1** Connect. The host-key dialog appears the first time, showing the `ssh-ed25519`
      algorithm and `SHA256:…` fingerprint; it matches the server console output from
      `pnpm dev:sshd`. Choose **Trust**.
- [ ] **6.2** The terminal opens a remote shell; `pwd` reports a POSIX path and the server
      console logs the shell start. Type `ls` — output works, typing latency is acceptable.
- [ ] **6.3** The sidebar shows the remote root `/` of the demo server (the server's virtual root
      maps to the `--root` directory). `demo-remote` fixture files are listed; navigate folders,
      breadcrumbs show POSIX paths.
- [ ] **6.4** Run an interactive program (`top`, `vim`, `nano`) in the SSH terminal: resizing the
      window propagates (no garbled wrap); Ctrl+C works; exit restores the prompt.
- [ ] **6.5** Create a folder, upload, download, rename, and delete on the SSH session
      (repeat §3.6–§3.8 / §4 / §5 against the remote backend).
- [ ] **6.6** Wrong port/host or wrong password: a clear, typed error is shown ("authentication
      failed" / "connect failed"), the app stays usable and the tab ends in an error state.
- [ ] **6.7** Close the SSH tab: session ends; reopen and reconnect works.
- [ ] **6.8** Verify the shell environment reports the pty (`tty` prints a `/dev/pts/...` path on a
      Linux target; `echo $TERM` is `xterm-256color`-like).

## 7. Host key trust, mismatch and recovery

- [ ] **7.1** With the connection still trusted, stop the server and delete the persisted host key:
      `rm .dev-sshd/host.key`, then restart `pnpm dev:sshd`. The fingerprint changes.
- [ ] **7.2** Reconnect the profile from §6. The app must **refuse** the connection with a
      host-key-mismatch error (not silently trust). PASS = explicit warning naming the host and
      the changed fingerprint; session does not open.
- [ ] **7.3** Only after an explicit **Replace/Forget known host** action can the profile be
      connected again; the new trusted fingerprint is stored.
- [ ] **7.4** Trust the host key, restart the app, reconnect: no dialog is shown (known host
      persisted). Check the known-host entry in the config file (no secrets there).
- [ ] **7.5** Cancel the host-key dialog: connection aborts cleanly and nothing is stored.
- [ ] **7.6** First-connection dialog for a host whose key is unknown: **Reject** ends the
      connection; **Trust** stores the fingerprint and connects.

## 8. Disconnect and reconnect

- [ ] **8.1** In an SSH session, kill the server process (Ctrl+C the `pnpm dev:sshd` process). The
      terminal shows a disconnected/ended state; the sidebar shows a clear "not connected"
      placeholder rather than stale actions.
- [ ] **8.2** Start the server again, restart it, or click **Reconnect** on the tab. With the
      server running again, reconnect succeeds and a fresh shell opens; file browsing resumes.
- [ ] **8.3** Reconnect while the server is still down: a typed error is shown, the tab stays
      reconnectable, no crash or unhandled rejection in the log.
- [ ] **8.4** Reconnect after changing window size: the new pty dimensions match the window.
- [ ] **8.5** Closing the app during a disconnect state exits cleanly within a second or two.

## 9. Public key authentication

On the server host:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/termshelf_qa -N ''          # QA key, no passphrase
pnpm dev:sshd --authorized-keys ~/.ssh/termshelf_qa.pub     # accept that key
# For passphrase coverage, repeat with: ssh-keygen -t ed25519 -f ~/.ssh/termshelf_qa_p -N 'test-pass'
```

- [ ] **9.1** App SSH dialog: auth method **Private key**, choose `termshelf_qa`. Connect with
      user `demo`. PASS = session opens without entering a password.
- [ ] **9.2** Wrong key (a key that was not authorized): connection is refused with an
      authentication error; the app does not fall back to an insecure mode.
- [ ] **9.3** Passphrase-protected key: the app prompts for the passphrase; correct passphrase
      connects, wrong passphrase shows a clear error.
- [ ] **9.4** **Save passphrase** enabled with OS encryption available: after restart the profile
      reconnects without prompting. Disable it: prompt returns after restart.
- [ ] **9.5** Agent auth (optional, if available on the QA host): auth method **Agent**, with an
      ssh-agent holding the authorized key, connects.
- [ ] **9.6** Key file permission/format errors (e.g. point at a text file) produce a readable
      error, not a crash.

## 10. Cancel a large transfer

- [ ] **10.1** Download the 1 GB `large.bin` (or the whole fixture folder) from the SSH session.
      The transfer drawer shows running progress (bytes and files).
- [ ] **10.2** Cancel mid-transfer (drag a large folder to raise the duration if needed). PASS =
      job state becomes **cancelled** within ~1 s, progress stops, an informational toast appears.
- [ ] **10.3** After cancelling a download, the destination contains **no** `*.part` temp file and
      no partial `large.bin` (only pre-existing files remain).
- [ ] **10.4** After cancelling an upload, the remote demo folder contains no
      `termshelf-*.part` leftovers (check the server side on disk).
- [ ] **10.5** Cancel while a small file in a multi-file transfer is completing: already completed
      files remain valid; the rest are skipped.
- [ ] **10.6** A cancelled transfer never reports **completed**; the drawer/list shows the
      cancelled state after switching tabs and restarting the app (no phantom running job).
- [ ] **10.7** Quit the app during a transfer: the app shuts down cleanly; on next launch no
      transfer is reported as running (and no `.part` files remain).

## 11. Secrets at rest (no plaintext)

Save an SSH profile **with** the password (and a passphrase-protected key profile with
**save passphrase**), then fully quit the app and inspect the config file
([Appendix A](#appendix-a--file-locations) for the exact path).

- [ ] **11.1** The profile is listed after restart with `hasSavedPassword: true` when
      `encryptionAvailable` is true (Config → visible via saved-profile badge/behavior).
- [ ] **11.2** **No plaintext secret strings** appear anywhere in `config.json` or the logs:
      search for the actual password/passphrase text (`grep -i "demo"` is fine — the demo
      password legitimately appears in the profile name, but not as a stored secret value next to
      `"password"`/`"passphrase"` keys). Stored secrets must be opaque base64 ciphertext blobs.
- [ ] **11.3** When the OS encryption backend is unavailable (common on bare WSL/Linux without a
      keyring; app reports `encryptionAvailable: false`), enabling "save password" must **not**
      write the secret at all: `hasSavedPassword` is false and the app prompts on the next
      connect. No plaintext fallback is acceptable.
- [ ] **11.4** **Do not save secret** path: profile persists, secrets are absent from the config
      file, next connection prompts for the password.
- [ ] **11.5** `config.json` permissions are owner-only (`600` on POSIX; per-user file on Windows).
- [ ] **11.6** Host keys, profiles, and settings are the only sensitive-ish data in the config;
      no SSH private key contents are copied into it (only the key **path**).

## 12. Settings, logs and stability

- [ ] **12.1** Change font size, download folder, default shell path and confirm-delete; all
      persist across restart.
- [ ] **12.2** Window size/position/sidebar width/transfer drawer height restore after restart;
      values are clamped to sane minimums when the config is edited by hand.
- [ ] **12.3** Corrupt the config file (write invalid JSON), start the app: it recovers with
      defaults, writes a `.corrupt-*.bak` backup, and stays usable.
- [ ] **12.4** Logs are written under the userData `logs/` folder, contain no secrets, and are
      readable after a crash.
- [ ] **12.5** 30-minute soak: several SSH sessions + local session, many file operations,
      a few transfers, no memory growth beyond a few hundred MB, no leaked pty processes after
      closing tabs (compare process lists before/after).

## 13. Unsigned app warnings

- [ ] **13.1 Windows SmartScreen:** double-click the installer → "Windows protected your PC" →
      **More info → Run anyway** → installs. (Release builds are unsigned until a code-signing
      certificate is configured; this is expected.)
- [ ] **13.2 Windows Defender/AV** may scan the NSIS installer; no malicious detection expected.
      `node-pty` and Electron binaries may raise a heuristic warning — note it in the QA report.
- [ ] **13.3 macOS Gatekeeper:** first launch shows "TermShelf cannot be opened because the
      developer cannot be verified" → open **System Settings → Privacy & Security → Open
      Anyway**, or right-click the app → **Open** → **Open**. Do **not** claim the app is broken.
- [ ] **13.4 macOS quarantine:** `xattr -dr com.apple.quarantine /Applications/TermShelf.app`
      clears the quarantine flag if the dialog keeps reappearing.
- [ ] **13.5** After the first "Open Anyway", subsequent launches work normally.

---

## Appendix A — File locations

| Item                      | Windows 11                                        | macOS                                                 | Linux                             |
| ------------------------- | ------------------------------------------------- | ----------------------------------------------------- | --------------------------------- |
| Config + secrets          | `%APPDATA%\TermShelf\config.json`                 | `~/Library/Application Support/TermShelf/config.json` | `~/.config/TermShelf/config.json` |
| Logs                      | `%APPDATA%\TermShelf\logs\`                       | `~/Library/Application Support/TermShelf/logs/`       | `~/.config/TermShelf/logs/`       |
| Runtime shell integration | `%APPDATA%\TermShelf\runtime\`                    | `~/Library/Application Support/TermShelf/runtime/`    | `~/.config/TermShelf/runtime/`    |
| Demo host key             | `.dev-sshd/host.key` (repo root, gitignored)      | same                                                  | same                              |
| Demo SFTP root            | `demo-remote/` (repo root, gitignored by default) | same                                                  | same                              |

(The Electron userData folder name follows `app.getPath('userData')`; on Windows it can be
`%APPDATA%\termshelf` if the app was ever launched by a build with a lowercase name — check
both.)

## Appendix B — Demo SSH server quick reference

```bash
pnpm dev:sshd --help
# defaults: root demo-remote, host 127.0.0.1, port 2222, user demo, password demo
# useful flags:
#   --root <dir>              backing dir for the virtual SFTP root /
#   --port <port>             default 2222; 0 = ephemeral (prints the bound port)
#   --host <addr>             default 127.0.0.1 (use 0.0.0.0 only on trusted networks)
#   --user/--password <x>     demo credentials
#   --authorized-keys <file>  OpenSSH authorized_keys file for public-key auth (repeatable)
#   --shell <path>            shell used for pty sessions
#   --sftp-path-mode <mode>   'virtual' (root exposed as /, default) or 'absolute'
#                             (real host paths under --root; matches the pty cwd)
#   --quiet                   only print the connection banner
```

The server prints its SHA256 host-key fingerprint and connection details on startup — use
them to validate the app's host-key dialog. Delete `.dev-sshd/host.key` to simulate a changed
host key (§7).

## Appendix C — Bug report template

```text
Build: <version> (<git sha>, <artifact name>)
Host OS: <Windows 11 23H2 / macOS 14.5 / Ubuntu 24.04>  Arch: x64 / arm64
Remote target: <dev-sshd local / WSL / other host, server OS>
Checklist item: <e.g. 5.4 Keep both>
Steps to reproduce:
  1. ...
Expected:
Actual:
Attachments: screenshot(s), config.json (redacted), logs/ entries, terminal output
```

## Exit criteria

- All **PASS** boxes on Windows 11 and macOS; Linux smoke pass (items 1, 3, 6, 10, 11).
- No crashes, no unhandled-rejection dialogs, no plaintext secrets in config/logs.
- Any deviation is documented in the QA report with severity and a linked issue.

## Downloaded-file timestamps and refresh

- Download a file from a remote folder, then sort the destination folder by **Modified**:
  the downloaded copy must show the **download completion time**, not the remote file's mtime.
- After an upload/download finishes, the sidebar must refresh automatically (new files appear
  without pressing F5).
