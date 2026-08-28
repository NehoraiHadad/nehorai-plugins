/**
 * What actually ships, read out of the tarball.
 *
 * `dependencies: { "@nehorai/credits": "workspace:^" }` is correct in the repo
 * and meaningless on a registry: `workspace:` is a pnpm-only protocol that no
 * installer outside this monorepo can resolve. pnpm rewrites it at pack time to
 * the concrete range — but only if the workspace link is intact, and only for
 * the fields it knows about. A published package carrying the literal string
 * installs for nobody, so the check has to be on the packed manifest rather
 * than on the source one.
 *
 * This packs; it never publishes.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url))

function has(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'ignore', shell: process.platform === 'win32' })
    return true
  } catch {
    return false
  }
}

// pnpm is present anywhere this repo is built. Skipping is honest about the
// tool being missing rather than reporting a pass that verified nothing. The
// tarball itself is read in-process — shelling out to `tar` reads a Windows
// `C:\...` path as a remote host and fails for a reason that has nothing to do
// with what is being tested.
const CAN_PACK = has('pnpm', ['--version'])

interface TarEntry {
  name: string
  content: Buffer
}

/**
 * Read a gzipped tar into its entries.
 *
 * Enough of the format for a package tarball: 512-byte headers, a NUL-padded
 * name, a base-8 size, and file bodies rounded up to the block size. Long-name
 * (`L`) and metadata (`x`, `g`) entries are skipped rather than misread.
 */
function readTarball(path: string): TarEntry[] {
  const buffer = gunzipSync(readFileSync(path))
  const entries: TarEntry[] = []
  for (let offset = 0; offset + 512 <= buffer.length; ) {
    const header = buffer.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    if (name === '') break // two zero blocks end the archive
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8)
    const type = String.fromCharCode(header[156])
    const body = buffer.subarray(offset + 512, offset + 512 + size)
    if (type === '0' || type === '\0') entries.push({ name, content: Buffer.from(body) })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

describe.skipIf(!CAN_PACK)('the packed manifest', () => {
  function packAndRead(): { manifest: Record<string, any>; entries: string[] } {
    const destination = mkdtempSync(join(tmpdir(), 'credits-pack-'))
    try {
      execFileSync('pnpm', ['pack', '--pack-destination', destination], {
        cwd: PACKAGE_ROOT,
        stdio: 'ignore',
        shell: process.platform === 'win32',
      })
      const tarball = readdirSync(destination).find((name) => name.endsWith('.tgz'))
      expect(tarball, 'pnpm pack produced no tarball').toBeDefined()
      const files = readTarball(join(destination, tarball!))
      const packageJson = files.find((entry) => entry.name === 'package/package.json')
      expect(packageJson, 'the tarball has no package.json').toBeDefined()
      return {
        manifest: JSON.parse(packageJson!.content.toString('utf8')),
        entries: files.map((entry) => entry.name),
      }
    } finally {
      rmSync(destination, { recursive: true, force: true })
    }
  }

  it('depends on a concrete version of the core package, not on workspace:^', () => {
    const { manifest } = packAndRead()

    expect(manifest.dependencies['@nehorai/credits']).toMatch(/^\^\d+\.\d+\.\d+$/)
    expect(JSON.stringify(manifest)).not.toContain('workspace:')
    // Publish order follows from this: the core version named here has to exist
    // on the registry before this package is installable.
    expect(manifest.dependencies['@nehorai/credits']).toBe('^2.0.0')
  })

  it('keeps drizzle a peer dependency, so the app owns the ORM version', () => {
    const { manifest } = packAndRead()
    expect(manifest.peerDependencies['drizzle-orm']).toBeDefined()
    expect(manifest.dependencies['drizzle-orm']).toBeUndefined()
  })

  it('ships the built output and nothing else', () => {
    const { entries } = packAndRead()

    const unexpected = entries.filter(
      (entry) => !/^package\/(dist\/|package\.json$|README\.md$|LICENSE$|CHANGELOG)/.test(entry)
    )
    expect(unexpected, 'source or test files leaked into the tarball').toEqual([])
    // Every documented entry point resolves to a file that is actually in here.
    for (const subpath of ['index', 'schema/index', 'repository/index', 'migrations/index']) {
      expect(entries).toContain(`package/dist/${subpath}.js`)
      expect(entries).toContain(`package/dist/${subpath}.d.ts`)
    }
  })
})
