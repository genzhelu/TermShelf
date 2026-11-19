import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/main/errors'
import {
  linuxToNative,
  nativeToLinux,
  normalizeLinuxPath,
  validateLinuxEntryName
} from '../../src/main/wsl/paths'

const UNC_ROOT = '\\\\wsl.localhost\\Ubuntu'
const UNC_ROOT_TRAILING = '\\\\wsl.localhost\\Ubuntu\\'
const UNC_EXTENDED = '\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\test\\file.txt'

describe('WSL UNC path mapping', () => {
  it('maps Linux paths into a UNC root without doubling separators', () => {
    expect(linuxToNative(UNC_ROOT, '/home/test/file.txt')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\test\\file.txt'
    )
    expect(linuxToNative(UNC_ROOT_TRAILING, '/')).toBe(UNC_ROOT_TRAILING)
  })

  it('maps UNC descendants back to Linux paths including a trailing root separator', () => {
    expect(nativeToLinux(UNC_ROOT, '\\\\wsl.localhost\\Ubuntu\\home\\test\\file.txt')).toBe(
      '/home/test/file.txt'
    )
    expect(
      nativeToLinux(UNC_ROOT_TRAILING, '\\\\wsl.localhost\\Ubuntu\\home\\test\\file.txt')
    ).toBe('/home/test/file.txt')
    // Node's Win32 resolver canonicalises a UNC share root with a trailing
    // separator; the mapping must still work with that form and with \\?\UNC\.
    expect(nativeToLinux(UNC_ROOT, '\\\\wsl.localhost\\Ubuntu\\')).toBe('/')
    expect(nativeToLinux(UNC_ROOT, UNC_EXTENDED)).toBe('/home/test/file.txt')
  })

  it('is case-insensitive for UNC roots and rejects paths outside the root', () => {
    expect(nativeToLinux(UNC_ROOT, '\\\\WSL.LOCALHOST\\ubuntu\\home\\test')).toBe('/home/test')
    expect(nativeToLinux(UNC_ROOT, '\\\\wsl.localhost\\Debian\\home\\test')).toBeNull()
    expect(nativeToLinux(UNC_ROOT, '\\\\wsl.localhost\\Ubuntu-extra\\home')).toBeNull()
  })

  it('rejects Linux paths containing a Win32 separator', () => {
    expect(() => normalizeLinuxPath('/home/test/back\\slash')).toThrow(AppError)
    expect(() => normalizeLinuxPath('/home/test/back\\slash')).toThrow(/backslash/)
    expect(() => validateLinuxEntryName('back\\slash')).toThrow(/Invalid WSL entry name/)
    expect(() => validateLinuxEntryName('a/b')).toThrow(/Invalid WSL entry name/)
    expect(validateLinuxEntryName('normal.txt')).toBe('normal.txt')
  })

  it('rejects names Win32 would reinterpret (reserved, colon, trailing dot/space)', () => {
    for (const name of ['CON', 'con.txt', 'com1', 'a:b', 'a?b', 'trailing.', 'trailing ', 'a|b']) {
      expect(() => validateLinuxEntryName(name)).toThrow(/Invalid WSL entry name/)
      expect(() => normalizeLinuxPath(`/home/test/${name}`)).toThrow(/cannot be represented/)
    }
    expect(validateLinuxEntryName('.hidden')).toBe('.hidden')
    expect(validateLinuxEntryName('normal file.txt')).toBe('normal file.txt')
  })
})
