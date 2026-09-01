// Docs numbers, enforced against the repository.
//
// Both READMEs state the version and, in three places each, the test count.
// Nothing made those numbers move when the code moved, and numbers like these
// drift exactly one release at a time, silently. These tests read every stated
// number and compare it against package.json, the CHANGELOG, and what vitest
// itself says the suite contains, so a stale claim is a red run instead of a
// wrong page.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (name: string) => readFileSync(join(root, name), 'utf8')

const pkgVersion = (JSON.parse(read('package.json')) as { version: string }).version

// Anchored on the CHANGELOG link so version mentions elsewhere in the READMEs
// can never be mistaken for the Status one.
const STATUS_RE = /v(\d+\.\d+\.\d+)\s*[（(]\[CHANGELOG\]/
const COUNT_RES: Record<string, RegExp> = {
  'README.md': /(\d+) offline (?:unit\/integration )?tests/g,
  'README.zh-TW.md': /(\d+) 個離線(?:單元\/整合)?測試/g,
}

describe('docs consistency', () => {
  it('newest CHANGELOG entry matches package.json', () => {
    const newest = read('CHANGELOG.md').match(/^## \[(\d+\.\d+\.\d+)\]/m)
    expect(newest, 'CHANGELOG.md has no "## [x.y.z]" entry').not.toBeNull()
    expect(newest![1]).toBe(pkgVersion)
  })

  it.each(['README.md', 'README.zh-TW.md'])('%s Status version matches package.json', (name) => {
    const stated = read(name).match(STATUS_RE)
    expect(stated, `${name} has no "vX.Y.Z ([CHANGELOG]...)" Status line`).not.toBeNull()
    expect(stated![1]).toBe(pkgVersion)
  })

  it.each(['README.md', 'README.zh-TW.md'])(
    '%s test counts match what vitest lists',
    (name) => {
      const stated = [...read(name).matchAll(COUNT_RES[name])].map((m) => Number(m[1]))
      expect(stated.length, `${name} states no test count`).toBeGreaterThan(0)
      // `vitest list` collects without executing, so this cannot recurse; it
      // prints one "file > suite > test" line per test.
      const listed = execFileSync('npx', ['vitest', 'list'], { cwd: root, encoding: 'utf8' })
        .split('\n')
        .filter((line) => line.includes(' > ')).length
      const wrong = [...new Set(stated.filter((n) => n !== listed))]
      expect(
        wrong,
        `${name} states ${wrong.join(', ')} test(s) but vitest lists ${listed}; update every count in the file`,
      ).toEqual([])
    },
    60_000,
  )
})
