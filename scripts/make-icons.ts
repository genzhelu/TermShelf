/**
 * Generates TermShelf's packaging icons from an embedded SVG design.
 *
 *   pnpm icons
 *
 * Outputs:
 *   build/icon.png          1024x1024 PNG (Linux target)
 *   build/icon.ico          multi-size Windows ICO (16, 24, 32, 48, 64, 128, 256)
 *   build/icon.icns         macOS ICNS (16/32/64/128/256/512/1024 + retina variants)
 *   build/icons/<size>.png  individual PNG sizes (optional extras / docs)
 *
 * The script is idempotent: every run overwrites the same files with identical
 * bytes. It only uses dev dependencies that ship prebuilt binaries (sharp) and
 * pure JS libraries (png-to-ico, @fiahfy/icns), so it also works in CI without
 * a C compiler or a display.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Icns, IcnsImage } from '@fiahfy/icns'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

/** Sizes written to build/icons and used by the ICO. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256] as const
/** Sizes written to build/icons (superset of the ICO sizes). */
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024] as const
/** ICNS entries: PNG pixel size -> Apple icon type (1x and 2x variants). */
const ICNS_ENTRIES: Array<{ size: number; type: string }> = [
  { size: 16, type: 'icp4' },
  { size: 32, type: 'icp5' },
  { size: 64, type: 'icp6' },
  { size: 32, type: 'ic11' },
  { size: 64, type: 'ic12' },
  { size: 128, type: 'ic07' },
  { size: 256, type: 'ic13' },
  { size: 256, type: 'ic08' },
  { size: 512, type: 'ic14' },
  { size: 512, type: 'ic09' },
  { size: 1024, type: 'ic10' }
]

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_DIR = path.join(ROOT_DIR, 'build')
const ICONS_DIR = path.join(BUILD_DIR, 'icons')

/**
 * The design stays deliberately geometric (no text/fonts, no filters) so it
 * renders identically on every OS and through sharp's SVG renderer:
 * a rounded dark terminal window with a green `>_` prompt and a blue shelf
 * (the MobaXterm-style file sidebar) on the right.
 */
const ICON_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1e293b"/>
      <stop offset="0.55" stop-color="#111c30"/>
      <stop offset="1" stop-color="#070d19"/>
    </linearGradient>
    <linearGradient id="window" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#101b2f"/>
      <stop offset="1" stop-color="#0a1120"/>
    </linearGradient>
    <linearGradient id="shelf" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3b82f6"/>
      <stop offset="1" stop-color="#1d4ed8"/>
    </linearGradient>
    <linearGradient id="prompt" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4ade80"/>
      <stop offset="1" stop-color="#16a34a"/>
    </linearGradient>
  </defs>

  <!-- rounded app tile -->
  <rect x="56" y="56" width="912" height="912" rx="204" fill="url(#background)"/>
  <rect x="56" y="56" width="912" height="912" rx="204" fill="none" stroke="#334155" stroke-width="10"/>

  <!-- terminal window -->
  <rect x="168" y="216" width="688" height="592" rx="56" fill="url(#window)" stroke="#334155" stroke-width="10"/>
  <!-- title bar with traffic lights -->
  <path d="M168 272 A 56 56 0 0 1 224 216 H 800 A 56 56 0 0 1 856 272 V 328 H 168 Z" fill="#1e293b"/>
  <circle cx="252" cy="284" r="18" fill="#ef4444"/>
  <circle cx="312" cy="284" r="18" fill="#f59e0b"/>
  <circle cx="372" cy="284" r="18" fill="#22c55e"/>

  <!-- green prompt: >_ -->
  <path d="M 248 430 L 344 498 L 248 566" fill="none" stroke="url(#prompt)" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="392" y="532" width="172" height="34" rx="17" fill="#22c55e"/>

  <!-- blue file shelf -->
  <rect x="700" y="372" width="96" height="392" rx="20" fill="url(#shelf)"/>
  <rect x="724" y="412" width="48" height="16" rx="8" fill="#dbeafe"/>
  <rect x="724" y="464" width="48" height="16" rx="8" fill="#dbeafe" opacity="0.88"/>
  <rect x="724" y="516" width="48" height="16" rx="8" fill="#dbeafe" opacity="0.74"/>
  <rect x="724" y="568" width="48" height="16" rx="8" fill="#dbeafe" opacity="0.6"/>
</svg>
`

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

async function fileSize(filePath: string): Promise<number> {
  const stats = await fs.stat(filePath)
  if (!stats.isFile() || stats.size === 0)
    throw new Error(`Expected a non-empty file at ${filePath}`)
  return stats.size
}

function assertPng(buffer: Buffer, label: string): void {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (buffer.length < 64 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error(`${label} is not a valid PNG`)
  }
}

function assertIco(buffer: Buffer, expectedCount: number): void {
  if (buffer.length < 6) throw new Error('ICO file is too small')
  const reserved = buffer.readUInt16LE(0)
  const type = buffer.readUInt16LE(2)
  const count = buffer.readUInt16LE(4)
  if (reserved !== 0 || type !== 1) throw new Error('ICO header is invalid')
  if (count !== expectedCount) {
    throw new Error(`ICO contains ${count} images, expected ${expectedCount}`)
  }
}

function assertIcns(buffer: Buffer): void {
  if (buffer.length < 8) throw new Error('ICNS file is too small')
  if (buffer.toString('ascii', 0, 4) !== 'icns') throw new Error('ICNS magic header is missing')
  const declaredLength = buffer.readUInt32BE(4)
  if (declaredLength !== buffer.length) {
    throw new Error(`ICNS length mismatch: header says ${declaredLength}, file is ${buffer.length}`)
  }
}

async function main(): Promise<void> {
  await fs.mkdir(BUILD_DIR, { recursive: true })
  await fs.mkdir(ICONS_DIR, { recursive: true })

  // Render the SVG once at full resolution; resize from the master PNG for
  // deterministic, high-quality downscaling at every small icon size.
  const masterPng = await sharp(Buffer.from(ICON_SVG, 'utf8'))
    .resize(1024, 1024, { fit: 'contain' })
    .png({ compressionLevel: 9 })
    .toBuffer()
  assertPng(masterPng, 'build/icon.png')
  await fs.writeFile(path.join(BUILD_DIR, 'icon.png'), masterPng)

  const iconPngPaths = new Map<number, string>()
  for (const size of PNG_SIZES) {
    const resized = await sharp(masterPng)
      .resize(size, size, { fit: 'contain', kernel: 'lanczos3' })
      .png({ compressionLevel: 9 })
      .toBuffer()
    assertPng(resized, `build/icons/${size}x${size}.png`)
    const target = path.join(ICONS_DIR, `${size}x${size}.png`)
    await fs.writeFile(target, resized)
    iconPngPaths.set(size, target)
  }

  // Windows ICO (multi-size)
  const icoInputs = ICO_SIZES.map((size) => {
    const iconPath = iconPngPaths.get(size)
    if (!iconPath) throw new Error(`Missing ${size}px PNG for the ICO`)
    return iconPath
  })
  const icoBuffer = await pngToIco(icoInputs)
  assertIco(icoBuffer, icoInputs.length)
  await fs.writeFile(path.join(BUILD_DIR, 'icon.ico'), icoBuffer)

  // macOS ICNS
  const icns = new Icns()
  for (const entry of ICNS_ENTRIES) {
    const iconPath = iconPngPaths.get(entry.size)
    if (!iconPath) throw new Error(`Missing ${entry.size}px PNG for the ICNS`)
    const png = await fs.readFile(iconPath)
    // `type` is validated by the library against its supported icon types.
    icns.append(IcnsImage.fromPNG(png, entry.type as Parameters<typeof IcnsImage.fromPNG>[1]))
  }
  const icnsBuffer = icns.data
  assertIcns(icnsBuffer)
  await fs.writeFile(path.join(BUILD_DIR, 'icon.icns'), icnsBuffer)

  const rows: Array<[string, number, string]> = [
    ['build/icon.png', await fileSize(path.join(BUILD_DIR, 'icon.png')), '1024x1024 PNG'],
    [
      'build/icon.ico',
      await fileSize(path.join(BUILD_DIR, 'icon.ico')),
      `${ICO_SIZES.length} sizes: ${ICO_SIZES.join(', ')}`
    ],
    [
      'build/icon.icns',
      await fileSize(path.join(BUILD_DIR, 'icon.icns')),
      `${ICNS_ENTRIES.length} entries: ${ICNS_ENTRIES.map((entry) => `${entry.type}@${entry.size}`).join(', ')}`
    ]
  ]

  const sha256 = createHash('sha256')
  sha256.update(masterPng)
  sha256.update(Buffer.from(ICO_SIZES.join(',')))
  sha256.update(Buffer.from(ICNS_ENTRIES.map((entry) => `${entry.type}@${entry.size}`).join(',')))

  console.log('TermShelf icons generated')
  console.log('─'.repeat(72))
  for (const [name, bytes, detail] of rows) {
    console.log(`  ${name.padEnd(18)} ${formatBytes(bytes).padStart(11)}  ${detail}`)
  }
  console.log(
    `  build/icons/       ${PNG_SIZES.length} PNGs (16, 24, 32, 48, 64, 128, 256, 512, 1024)`
  )
  console.log('─'.repeat(72))
  console.log(`  design hash:  ${sha256.digest('hex').slice(0, 16)}`)
}

void main().catch((error) => {
  console.error('Icon generation failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
