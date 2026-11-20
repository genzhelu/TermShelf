import { z } from 'zod'

const path = z.string().min(1).max(4096)
const sessionId = z.string().min(1).max(128)
const entryName = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.includes('/') && !value.includes('\\'), 'Name must not contain slashes')
  .refine((value) => value !== '.' && value !== '..', 'Invalid name')

export const sessionIdSchema = sessionId

export const localSessionRequestSchema = z.object({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
  shellPath: z.string().min(1).max(4096).optional(),
  cwd: z.string().min(1).max(4096).optional(),
  terminal: z.enum(['auto', 'native', 'wsl']).optional(),
  wslDistro: z.string().min(1).max(128).nullable().optional()
})

export const sshProfileSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(80),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(255),
  authMethod: z.enum(['password', 'privateKey', 'agent']),
  privateKeyPath: z.string().min(1).max(4096).optional(),
  saveProfile: z.boolean(),
  saveSecret: z.boolean(),
  x11: z.boolean().optional()
})

export const sshConnectRequestSchema = z.object({
  profile: sshProfileSchema,
  password: z.string().max(4096).optional(),
  passphrase: z.string().max(4096).optional(),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000)
})

export const filesListSchema = z.object({ sessionId, path })

export const filesMkdirSchema = z.object({ sessionId, parentPath: path, name: entryName })

export const filesRenameSchema = z.object({ sessionId, path, newName: entryName })

export const filesDeleteSchema = z.object({
  sessionId,
  paths: z.array(path).min(1).max(1000)
})

export const transferRequestSchema = z.object({
  sessionId,
  direction: z.enum(['upload', 'download']),
  sources: z.array(path).min(1).max(1000),
  destDir: path,
  conflictPolicy: z.enum(['ask', 'overwrite', 'skip', 'keepBoth', 'cancel'])
})

export const transferCancelSchema = z.object({ jobId: z.string().min(1).max(128) })

export const hostKeyInfoSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  algorithm: z.string().min(1).max(64),
  fingerprint: z.string().min(1).max(256)
})

export const hostKeyForgetSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535)
})

export const profileDeleteSchema = z.object({ profileId: z.string().min(1).max(128) })

export const settingsSchema = z.object({
  defaultDownloadDir: z.string().max(4096),
  lastDownloadDir: z.string().max(4096),
  followCwd: z.boolean(),
  showHiddenFiles: z.boolean(),
  fontSize: z.number().int().min(8).max(32),
  shellPath: z.string().max(4096).nullable(),
  localTerminal: z.enum(['auto', 'native', 'wsl']),
  wslDistro: z.string().min(1).max(128).nullable(),
  confirmDelete: z.boolean()
})

export const uiPatchSchema = z.object({
  sidebarWidth: z.number().int().min(180).max(1200).optional(),
  transferDrawerHeight: z.number().int().min(80).max(800).optional(),
  sortKey: z.enum(['name', 'size', 'mtime']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional()
})

export const configPatchSchema = z.object({
  settings: settingsSchema.partial().optional(),
  ui: uiPatchSchema.optional()
})

export const pickFolderSchema = z.object({ startPath: z.string().max(4096).optional() }).optional()

export const openExternalSchema = z.object({ url: z.string().url().max(4096) })

export const showItemSchema = z.object({ path: z.string().min(1).max(4096) })

export const clipboardWriteSchema = z.object({ text: z.string().max(10_000_000) })
