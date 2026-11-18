import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/main/errors'
import {
  assertAbsolutePath,
  basenamePath,
  breadcrumbsFor,
  dirnamePath,
  isAbsolutePath,
  joinPath,
  nextAvailableName,
  normalizePath,
  parentPathFor,
  pathStyleForPlatform,
  sanitizeLocalFilename,
  shellQuote,
  splitNameExtension
} from '../../src/main/util/paths'

describe('pathStyleForPlatform', () => {
  it('maps win32 to the win32 path style and everything else to posix', () => {
    expect(pathStyleForPlatform('win32')).toBe('win32')
    expect(pathStyleForPlatform('darwin')).toBe('posix')
    expect(pathStyleForPlatform('linux')).toBe('posix')
  })
})

describe('path helpers', () => {
  it('joins, dirnames, basenames and normalizes in the requested style', () => {
    expect(joinPath('posix', '/a', 'b', 'c')).toBe('/a/b/c')
    expect(joinPath('win32', 'C:\\a', 'b')).toBe('C:\\a\\b')
    expect(dirnamePath('posix', '/a/b/c.txt')).toBe('/a/b')
    expect(dirnamePath('win32', 'C:\\a\\b\\c.txt')).toBe('C:\\a\\b')
    expect(basenamePath('posix', '/a/b/c.txt')).toBe('c.txt')
    expect(basenamePath('win32', 'C:\\a\\b\\c.txt')).toBe('c.txt')
    expect(normalizePath('posix', '/a//b/../c')).toBe('/a/c')
    expect(normalizePath('win32', 'C:\\a\\..\\b')).toBe('C:\\b')
  })

  it('detects absolute paths per style', () => {
    expect(isAbsolutePath('posix', '/home/user')).toBe(true)
    expect(isAbsolutePath('posix', 'home/user')).toBe(false)
    expect(isAbsolutePath('win32', 'C:\\Users\\demo')).toBe(true)
    expect(isAbsolutePath('win32', '\\\\server\\share\\file')).toBe(true)
    expect(isAbsolutePath('win32', 'Users\\demo')).toBe(false)
  })

  it('assertAbsolutePath accepts absolute paths and rejects bad input', () => {
    expect(() => assertAbsolutePath('posix', '/home/user')).not.toThrow()
    expect(() => assertAbsolutePath('win32', 'C:\\Users\\demo')).not.toThrow()
    for (const invalid of ['', 'relative/path', '.', '..']) {
      expect(() => assertAbsolutePath('posix', invalid)).toThrow(AppError)
      try {
        assertAbsolutePath('posix', invalid)
      } catch (error) {
        expect((error as AppError).code).toBe('FS_INVALID_PATH')
      }
    }
    const tooLong = `/${'a'.repeat(5000)}`
    expect(() => assertAbsolutePath('posix', tooLong)).toThrow(/Invalid path/)
  })
})

describe('breadcrumbsFor / parentPathFor', () => {
  it('builds POSIX breadcrumbs from the filesystem root', () => {
    expect(breadcrumbsFor('posix', '/home/user/project')).toEqual([
      { name: '/', path: '/' },
      { name: 'home', path: '/home' },
      { name: 'user', path: '/home/user' },
      { name: 'project', path: '/home/user/project' }
    ])
    expect(parentPathFor('posix', '/home/user/project')).toBe('/home/user')
  })

  it('handles the POSIX root and trailing separators', () => {
    expect(breadcrumbsFor('posix', '/')).toEqual([{ name: '/', path: '/' }])
    expect(parentPathFor('posix', '/')).toBeNull()
    expect(breadcrumbsFor('posix', '/home/user/')).toEqual([
      { name: '/', path: '/' },
      { name: 'home', path: '/home' },
      { name: 'user', path: '/home/user' }
    ])
    expect(parentPathFor('posix', '/home/user/')).toBe('/home')
  })

  it('builds Windows drive breadcrumbs with a trailing backslash root', () => {
    expect(breadcrumbsFor('win32', 'C:\\Users\\demo\\project')).toEqual([
      { name: 'C:', path: 'C:\\' },
      { name: 'Users', path: 'C:\\Users' },
      { name: 'demo', path: 'C:\\Users\\demo' },
      { name: 'project', path: 'C:\\Users\\demo\\project' }
    ])
    expect(parentPathFor('win32', 'C:\\Users\\demo\\project')).toBe('C:\\Users\\demo')
    expect(breadcrumbsFor('win32', 'C:\\')).toEqual([{ name: 'C:', path: 'C:\\' }])
    expect(parentPathFor('win32', 'C:\\')).toBeNull()
  })

  it('handles UNC roots (\\\\server\\share)', () => {
    expect(breadcrumbsFor('win32', '\\\\server\\share\\folder\\file.txt')).toEqual([
      { name: '\\\\server\\share', path: '\\\\server\\share\\' },
      { name: 'folder', path: '\\\\server\\share\\folder' },
      { name: 'file.txt', path: '\\\\server\\share\\folder\\file.txt' }
    ])
    expect(parentPathFor('win32', '\\\\server\\share\\folder\\file.txt')).toBe(
      '\\\\server\\share\\folder'
    )
    expect(breadcrumbsFor('win32', '\\\\server\\share')).toEqual([
      { name: '\\\\server\\share', path: '\\\\server\\share\\' }
    ])
    expect(parentPathFor('win32', '\\\\server\\share')).toBeNull()
  })

  it('normalizes redundant separators before building breadcrumbs', () => {
    expect(breadcrumbsFor('posix', '/home//user/./project')).toEqual([
      { name: '/', path: '/' },
      { name: 'home', path: '/home' },
      { name: 'user', path: '/home/user' },
      { name: 'project', path: '/home/user/project' }
    ])
  })
})

describe('splitNameExtension', () => {
  it('splits the last extension case-preserving', () => {
    expect(splitNameExtension('archive.tar.gz')).toEqual({ base: 'archive.tar', extension: '.gz' })
    expect(splitNameExtension('photo.JPG')).toEqual({ base: 'photo', extension: '.JPG' })
  })

  it('keeps dotfiles and extension-less names intact', () => {
    expect(splitNameExtension('README')).toEqual({ base: 'README', extension: '' })
    expect(splitNameExtension('.gitignore')).toEqual({ base: '.gitignore', extension: '' })
  })
})

describe('nextAvailableName', () => {
  it('returns the original name when it does not exist', () => {
    expect(nextAvailableName('name.ext', () => false)).toBe('name.ext')
  })

  it('appends (n) before the extension and increments until free', () => {
    expect(nextAvailableName('name.ext', (candidate) => candidate === 'name.ext')).toBe(
      'name (1).ext'
    )
    expect(
      nextAvailableName(
        'name.ext',
        (candidate) => candidate === 'name.ext' || candidate === 'name (1).ext'
      )
    ).toBe('name (2).ext')
    expect(nextAvailableName('notes', (candidate) => candidate === 'notes')).toBe('notes (1)')
    expect(nextAvailableName('archive.tar.gz', (candidate) => candidate === 'archive.tar.gz')).toBe(
      'archive.tar (1).gz'
    )
  })

  it('queries the exists callback with each candidate in order', () => {
    const seen: string[] = []
    nextAvailableName('file.txt', (candidate) => {
      seen.push(candidate)
      return seen.length < 3
    })
    expect(seen).toEqual(['file.txt', 'file (1).txt', 'file (2).txt'])
  })
})

describe('sanitizeLocalFilename', () => {
  it('replaces illegal characters on Windows', () => {
    expect(sanitizeLocalFilename('a<b>c:d"e/f\\g|h?i*j', 'win32')).toBe('a_b_c_d_e_f_g_h_i_j')
    expect(sanitizeLocalFilename('report.pdf', 'win32')).toBe('report.pdf')
  })

  it('strips trailing dots and spaces on Windows', () => {
    expect(sanitizeLocalFilename('name.  ', 'win32')).toBe('name')
    expect(sanitizeLocalFilename('name...', 'win32')).toBe('name')
  })

  it('prefixes Windows reserved device names', () => {
    expect(sanitizeLocalFilename('CON', 'win32')).toBe('_CON')
    expect(sanitizeLocalFilename('con.txt', 'win32')).toBe('_con.txt')
    expect(sanitizeLocalFilename('LPT9.log', 'win32')).toBe('_LPT9.log')
    expect(sanitizeLocalFilename('console.txt', 'win32')).toBe('console.txt')
  })

  it('replaces path separators and NUL on macOS and Linux', () => {
    expect(sanitizeLocalFilename('a/b:c', 'darwin')).toBe('a_b:c')
    expect(sanitizeLocalFilename('a/b:c', 'linux')).toBe('a_b:c')
    expect(sanitizeLocalFilename('nul\u0000byte', 'linux')).toBe('nul_byte')
    expect(sanitizeLocalFilename('back\\slash', 'darwin')).toBe('back\\slash')
  })

  it('truncates very long names while preserving the extension', () => {
    const long = `${'a'.repeat(300)}.pdf`
    const sanitized = sanitizeLocalFilename(long, 'win32')
    expect(sanitized.length).toBeLessThanOrEqual(200)
    expect(sanitized.endsWith('.pdf')).toBe(true)
  })
})

describe('shellQuote', () => {
  it('single-quotes simple and spaced values', () => {
    expect(shellQuote('abc')).toBe("'abc'")
    expect(shellQuote('a b')).toBe("'a b'")
    expect(shellQuote('')).toBe("''")
  })

  it('escapes embedded single quotes for POSIX shells', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote('a $HOME `id` "x"')).toBe('\'a $HOME `id` "x"\'')
  })
})
