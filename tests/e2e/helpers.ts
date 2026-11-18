import fs from 'node:fs'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const repoRoot = path.resolve(__dirname, '../..')

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  baseDir: string
  userDataDir: string
  pageErrors: string[]
}

function makeRunDirectory(): string {
  const base = path.join(
    repoRoot,
    '.e2e-tmp',
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  )
  for (const child of ['userdata', 'config', 'cache', 'downloads']) {
    fs.mkdirSync(path.join(base, child), { recursive: true })
  }
  return base
}

export function electronEnvironment(baseDir: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.TERMSHELF_USER_DATA_DIR = path.join(baseDir, 'userdata')
  env.XDG_CONFIG_HOME = path.join(baseDir, 'config')
  env.XDG_CACHE_HOME = path.join(baseDir, 'cache')
  const localDeps = path.join(repoRoot, '.local-deps/usr/lib/x86_64-linux-gnu')
  if (fs.existsSync(localDeps)) {
    env.LD_LIBRARY_PATH = `${localDeps}${path.delimiter}${env.LD_LIBRARY_PATH ?? ''}`
  }
  return env
}

/**
 * Launches the real packaged-main app via Playwright's Electron driver. The
 * browser runs with the headless Ozone platform (and workspace-local XDG dirs,
 * which Chromium requires to be writable) so it also works on a headless WSL
 * session and on CI.
 */
export async function launchApp(): Promise<LaunchedApp> {
  const baseDir = makeRunDirectory()
  const pageErrors: string[] = []
  const app = await electron.launch({
    cwd: repoRoot,
    args: ['--no-sandbox', '--disable-gpu', '--ozone-platform=headless', '.'],
    env: electronEnvironment(baseDir),
    timeout: 60_000
  })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => {
    pageErrors.push(error.message)
  })
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 30_000 })
  return { app, page, baseDir, userDataDir: path.join(baseDir, 'userdata'), pageErrors }
}

export async function closeApp(launched: LaunchedApp): Promise<void> {
  try {
    await launched.app.close()
  } finally {
    fs.rmSync(launched.baseDir, { recursive: true, force: true })
  }
}

export async function waitForConnectedTab(page: Page, count = 1): Promise<void> {
  await page
    .locator('[data-testid="tab"][data-status="connected"]')
    .nth(count - 1)
    .waitFor({ state: 'attached', timeout: 45_000 })
}

export async function waitForTerminalText(
  page: Page,
  text: string,
  timeout = 30_000
): Promise<void> {
  await page.waitForFunction(
    ([selector, needle]) => {
      return [...document.querySelectorAll(selector as string)].some((node) =>
        (node.textContent ?? '').includes(needle as string)
      )
    },
    ['[data-testid="terminal"] .xterm-rows', text] as const,
    { timeout }
  )
}

export async function typeInTerminal(page: Page, text: string): Promise<void> {
  const area = page.locator('[data-testid="terminal-area"]')
  await area.click({ position: { x: 200, y: 120 } })
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

export async function shellQuote(value: string): Promise<string> {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export async function currentSidebarPath(page: Page): Promise<string | null> {
  const crumbs = page.locator('[data-testid="sidebar"] .pathbar__crumbs').first()
  if ((await crumbs.count()) === 0) return null
  return crumbs.getAttribute('title')
}

export async function waitForSidebarPath(
  page: Page,
  expected: string,
  timeout = 20_000
): Promise<void> {
  await page
    .locator('[data-testid="sidebar"] .pathbar__crumbs')
    .first()
    .waitFor({ state: 'visible', timeout })
  await page.waitForFunction(
    ([selector, wanted]) => {
      const node = document.querySelector(selector)
      return node?.getAttribute('title') === wanted
    },
    ['[data-testid="sidebar"] .pathbar__crumbs', expected] as const,
    { timeout }
  )
}

export async function refreshSidebar(page: Page): Promise<void> {
  await page.getByTestId('refresh-button').click()
}

export async function openSshDialog(page: Page): Promise<void> {
  await page.getByTestId('new-ssh-button').click()
  await page.getByTestId('ssh-dialog').waitFor({ state: 'visible' })
}

export async function fillSshForm(
  page: Page,
  fields: { name: string; host: string; port: number; username: string; password: string }
): Promise<void> {
  await page.getByTestId('ssh-name-input').fill(fields.name)
  await page.getByTestId('ssh-host-input').fill(fields.host)
  await page.getByTestId('ssh-port-input').fill(String(fields.port))
  await page.getByTestId('ssh-username-input').fill(fields.username)
  await page.getByTestId('ssh-password-input').fill(fields.password)
}

/**
 * Replaces Electron's native open dialogs with a deterministic queue. Each
 * subsequent openDialog call shifts one path off the queue.
 */
export async function stubOpenDialogQueue(
  app: ElectronApplication,
  paths: string[]
): Promise<void> {
  await app.evaluate(({ dialog }, queued) => {
    const queue = [...queued]
    ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => {
      const next = queue.shift()
      return next ? { canceled: false, filePaths: [next] } : { canceled: true, filePaths: [] }
    }
  }, paths)
}

export function waitForFile(target: string, timeout = 20_000): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (fs.existsSync(target)) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > timeout) {
        clearInterval(timer)
        reject(new Error(`Timed out waiting for ${target}`))
      }
    }, 100)
  })
}
