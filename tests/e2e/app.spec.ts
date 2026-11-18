import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { startDevSshd } from '../../tools/dev-sshd/server'
import {
  closeApp,
  fillSshForm,
  launchApp,
  openSshDialog,
  refreshSidebar,
  shellQuote,
  stubOpenDialogQueue,
  typeInTerminal,
  waitForConnectedTab,
  waitForFile,
  waitForSidebarPath,
  waitForTerminalText
} from './helpers'

test('local session: folder sync, drag-equivalent upload, download, new folder', async ({}, testInfo) => {
  const launched = await launchApp()
  try {
    const { page, baseDir, app } = launched
    await waitForConnectedTab(page, 1)

    const fixture = path.join(baseDir, 'local-fixture')
    fs.mkdirSync(fixture, { recursive: true })
    fs.mkdirSync(path.join(fixture, 'subfolder'))
    fs.writeFileSync(path.join(fixture, 'sample.txt'), 'hello-local')

    await typeInTerminal(page, `cd ${await shellQuote(fixture)} && printf 'LOCAL_READY\\n'`)
    await waitForTerminalText(page, 'LOCAL_READY')
    await waitForSidebarPath(page, fixture)
    await page
      .locator('[data-testid="file-row"][data-name="sample.txt"]')
      .waitFor({ state: 'visible' })

    // New folder through the UI.
    await page.getByTestId('new-folder-button').click()
    await page.getByTestId('prompt-input').fill('created-by-ui')
    await page.getByTestId('prompt-confirm-button').click()
    await waitForFile(path.join(fixture, 'created-by-ui'))

    // Upload files through the native dialog path (the same transfer pipeline
    // used by drag and drop once the OS path is resolved).
    const uploadSource = path.join(baseDir, 'upload-source.txt')
    fs.writeFileSync(uploadSource, 'uploaded-from-e2e')
    await stubOpenDialogQueue(app, [uploadSource])
    await page.getByTestId('upload-files-button').click()
    await waitForFile(path.join(fixture, 'upload-source.txt'))
    expect(fs.readFileSync(path.join(fixture, 'upload-source.txt'), 'utf8')).toBe(
      'uploaded-from-e2e'
    )
    await refreshSidebar(page)
    await page
      .locator('[data-testid="file-row"][data-name="upload-source.txt"]')
      .waitFor({ state: 'visible' })

    // Download the selected file to a folder picked with the native dialog.
    const downloadDir = path.join(baseDir, 'downloads')
    await page.locator('[data-testid="file-row"][data-name="sample.txt"]').click()
    await stubOpenDialogQueue(app, [downloadDir])
    await page.getByTestId('download-button').click()
    await waitForFile(path.join(downloadDir, 'sample.txt'))
    expect(fs.readFileSync(path.join(downloadDir, 'sample.txt'), 'utf8')).toBe('hello-local')

    const shot = testInfo.outputPath('local-session.png')
    await page.screenshot({ path: shot })
    await testInfo.attach('local-session', { path: shot, contentType: 'image/png' })
    expect(launched.pageErrors).toEqual([])
  } finally {
    await closeApp(launched)
  }
})

test('ssh session: host-key trust, remote sidebar, remote folder sync, upload and download', async ({}, testInfo) => {
  const baseDir = path.join(
    process.cwd(),
    '.e2e-tmp',
    `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  )
  const remoteRoot = path.join(baseDir, 'remote')
  fs.mkdirSync(path.join(remoteRoot, 'photos'), { recursive: true })
  fs.mkdirSync(path.join(remoteRoot, 'docs'), { recursive: true })
  fs.mkdirSync(path.join(baseDir, 'downloads'), { recursive: true })
  fs.writeFileSync(path.join(remoteRoot, 'remote.txt'), 'hello-remote')
  fs.writeFileSync(
    path.join(remoteRoot, 'photos', 'sunset.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47])
  )
  const sshd = await startDevSshd({
    root: remoteRoot,
    port: 0,
    hostKeyPath: path.join(baseDir, 'host.key'),
    sftpPathMode: 'absolute'
  })
  const launched = await launchApp()
  try {
    const { page, app } = launched
    await waitForConnectedTab(page, 1)

    await openSshDialog(page)
    await fillSshForm(page, {
      name: 'E2E Remote',
      host: '127.0.0.1',
      port: sshd.port,
      username: sshd.username,
      password: sshd.password
    })
    await page.getByTestId('ssh-connect-button').click()

    // First use of the host key must require explicit trust.
    await page.getByTestId('hostkey-trust-button').waitFor({ state: 'visible', timeout: 30_000 })
    await page.getByTestId('hostkey-trust-button').click()
    await waitForConnectedTab(page, 2)
    await page.getByTestId('ssh-dialog').waitFor({ state: 'hidden', timeout: 20_000 })

    const realRoot = fs.realpathSync(remoteRoot)
    await waitForSidebarPath(page, realRoot, 45_000)
    await page.locator('[data-testid="file-row"][data-name="remote.txt"]').waitFor({
      state: 'visible',
      timeout: 20_000
    })

    // Upload into the remote root.
    const uploadSource = path.join(baseDir, 'ssh-upload.txt')
    fs.writeFileSync(uploadSource, 'uploaded-over-sftp')
    await stubOpenDialogQueue(app, [uploadSource])
    await page.getByTestId('upload-files-button').click()
    await waitForFile(path.join(realRoot, 'ssh-upload.txt'), 30_000)
    expect(fs.readFileSync(path.join(realRoot, 'ssh-upload.txt'), 'utf8')).toBe(
      'uploaded-over-sftp'
    )

    // Download a remote file to a local folder.
    const downloadDir = path.join(baseDir, 'downloads')
    await page.locator('[data-testid="file-row"][data-name="remote.txt"]').click()
    await stubOpenDialogQueue(app, [downloadDir])
    await page.getByTestId('download-button').click()
    await waitForFile(path.join(downloadDir, 'remote.txt'), 30_000)
    expect(fs.readFileSync(path.join(downloadDir, 'remote.txt'), 'utf8')).toBe('hello-remote')

    // Remote CWD following via OSC 7 over the SSH pty.
    await typeInTerminal(page, 'cd photos && printf "REMOTE_CD_OK\\n"')
    await waitForTerminalText(page, 'REMOTE_CD_OK', 30_000)
    await waitForSidebarPath(page, path.join(realRoot, 'photos'), 30_000)
    await page.locator('[data-testid="file-row"][data-name="sunset.png"]').waitFor({
      state: 'visible',
      timeout: 20_000
    })

    const shot = testInfo.outputPath('ssh-session.png')
    await page.screenshot({ path: shot })
    await testInfo.attach('ssh-session', { path: shot, contentType: 'image/png' })
    expect(launched.pageErrors).toEqual([])
  } finally {
    await closeApp(launched)
    fs.rmSync(baseDir, { recursive: true, force: true })
    await sshd.close()
  }
})
