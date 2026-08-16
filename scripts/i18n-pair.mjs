/**
 * Keep the bilingual README pair honest.
 *
 * A translated pair rots one side at a time: someone edits the language they
 * think in, ships, and the other half quietly describes an older plugin. The
 * failure is invisible to every other check — both files parse, both files
 * read fine, and only a reader of the *other* language ever finds out.
 *
 * So the pair carries a consistency record: the hash of each side as of the
 * last time a human confirmed the two say the same thing. Editing either side
 * changes its hash and fails `--check`; the fix is to bring the other side
 * along and re-record. This is the same device DSH's own packages use
 * (`README.i18n.yaml`), restated here so this repo needs no monorepo tooling.
 *
 * Hashes are git blob hashes computed directly — `sha1("blob <len>\0" + bytes)`
 * — so they match `git hash-object` and can be checked against a diff by hand,
 * without this script needing git to exist.
 *
 *   node scripts/i18n-pair.mjs           # verify (exit 1 on drift)
 *   node scripts/i18n-pair.mjs --write   # re-record after translating
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RECORD = join(root, 'README.i18n.yaml')
/** The pair, in the order the record lists them. */
const PAIR = ['README.md', 'README.zh.md']

const HEADER = `# Bilingual-pair consistency record: the git blob hash of each side as of the
# last confirmed-consistent state. Both languages carry equal authority; after
# editing either side, bring the other along and re-record with:
#   npm run docs:pair -- --write
`

/** git's blob hash of a file, without needing git. */
function blobHash(file) {
  const bytes = readFileSync(join(root, file))
  return createHash('sha1')
    .update('blob ' + bytes.length + '\0')
    .update(bytes)
    .digest('hex')
}

const current = Object.fromEntries(PAIR.map((file) => [file, blobHash(file)]))

if (process.argv.includes('--write')) {
  writeFileSync(RECORD, HEADER + PAIR.map((f) => f + ': ' + current[f] + '\n').join(''))
  console.log('recorded ' + PAIR.join(' + '))
  process.exit(0)
}

const recorded = {}
try {
  for (const line of readFileSync(RECORD, 'utf8').split('\n')) {
    const m = /^([^#:\s]+):\s*([0-9a-f]{40})\s*$/.exec(line)
    if (m) recorded[m[1]] = m[2]
  }
} catch {
  console.error('README.i18n.yaml is missing — run: npm run docs:pair -- --write')
  process.exit(1)
}

const drifted = PAIR.filter((file) => recorded[file] !== current[file])
if (drifted.length === 0) {
  console.log('README pair is in step')
  process.exit(0)
}
// Naming which side moved is the whole point: it says which language is now
// ahead, and therefore which one has to be brought forward.
console.error('README pair has drifted: ' + drifted.join(', ') + ' changed since the last recorded state.')
console.error('Translate the change across, then: npm run docs:pair -- --write')
process.exit(1)
