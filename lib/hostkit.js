/**
 * Host-platform helpers, borrowed from DSH when it is reachable.
 *
 * File replacement and cross-process locking are already solved inside DSH, by
 * `@deepseek-ai/dsh-atomic-write`, and that is the authority: `writeFileAtomic`
 * opens its temp sibling with exclusive create, so it refuses to follow a
 * symlink planted at the scratch path and carries explicit permission bits
 * through the rename.
 *
 * It cannot be imported statically. It is not a dependency of this package —
 * it belongs to the harness the plugin is mounted into — and a bare `import`
 * of a package that is only present in the host profile makes the whole module
 * fail to load in any other layout (a `link:`ed checkout resolves from the
 * checkout, not from the profile, and finds nothing). So it is probed once,
 * asynchronously, and every helper here works before and without it: the
 * fallbacks are the same behaviour written locally.
 *
 * The seam is drawn around the ASYNC I/O primitives only. Borrowing is worth a
 * probe when it buys real behaviour that is awkward to restate — O_EXCL temp
 * files, mode bits, locking — and those are already async, so the probe rides
 * along for free. It is not worth it for a synchronous three-line env read
 * (see `dshHomePath`), where the probe would instead impose an ordering rule
 * on every caller.
 *
 * `withFileLock` is the reason this file exists rather than two inline
 * helpers. A temp-and-rename write is atomic against a READER, but two dsh
 * processes sharing one `$DSH_HOME` still interleave: the rollup is a
 * read-modify-write cycle, and without a lock the second writer's rename
 * silently discards what the first one just committed.
 *
 * @module dsh-bill/hostkit
 */

import { promises as fsPromises } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Permission bits for the files this plugin writes: spend history is private. */
const FILE_MODE = 0o600
/** Permission bits for the directory holding them. */
const DIR_MODE = 0o700

/** Resolved `@deepseek-ai/dsh-atomic-write` module, or null until/unless probed. */
let atomicWrite = null

/**
 * One-shot probe for the optional host package.
 *
 * Awaited by the plugin's startup chain so the borrowed implementation is in
 * place before the first write, but never required: a rejected import leaves
 * the local fallback in charge for the process lifetime.
 */
export const hostkitReady = import('@deepseek-ai/dsh-atomic-write')
  .then((mod) => { if (typeof mod?.writeFileAtomic === 'function') atomicWrite = mod })
  .catch(() => { /* not mounted here; the local fallback stands */ })

/**
 * Import a package that exists only inside the harness's own module graph.
 *
 * Two attempts, because there are two ways this plugin gets mounted:
 *
 *   1. Installed normally, it sits in the profile's `node_modules` and a bare
 *      specifier resolves its `@deepseek-ai/*` siblings the ordinary way.
 *   2. Mounted from a `link:`ed checkout — the layout anyone developing it
 *      uses — Node resolves the symlink to its real path first, so the lookup
 *      walks up from the CHECKOUT and never sees the profile at all. Every
 *      borrowed module silently went missing in that layout, which is why the
 *      agent tool had never once registered on a dev machine.
 *
 * The fallback resolves from `process.argv[1]`, the harness's own entry
 * script. That is not a guess about the filesystem: "borrow from the host"
 * means exactly "resolve from where the host resolves", and the entry point is
 * the one path into its graph that a plugin can always name.
 *
 * Resolves to `null` rather than throwing, on either path.
 */
export function optionalHostImport(specifier) {
  return import(specifier).catch(() => importFromHostEntry(specifier))
}

/** Second attempt: resolve `specifier` the way the harness entry script would. */
async function importFromHostEntry(specifier) {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry === '') return null
  try {
    const { createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    const resolved = createRequire(entry).resolve(specifier)
    return await import(pathToFileURL(resolved).href)
  } catch {
    return null // not reachable from here either; the caller degrades
  }
}

/**
 * Join segments onto the harness home (`$DSH_HOME`, else `~/.dsh`).
 *
 * Deliberately NOT borrowed from `@deepseek-ai/dsh-home-paths`, though that
 * package exports exactly this. Borrowing it would make the answer depend on
 * whether the async probe had landed yet — an "await the probe before
 * computing any path" rule that the startup chain can honour but the persist
 * queue and the backfill pass cannot, and which would let the file location
 * change under an in-flight write. Three lines of env reading are not worth a
 * startup-ordering discipline, and the rule they encode ("a blank override is
 * not an override") is stable enough to restate.
 *
 * The async seam below is kept for `writeFileAtomic` / `withFileLock`, which
 * borrow real behaviour — O_EXCL temp files, mode bits, cross-process locking
 * — and are already async, so the probe rides along for free.
 */
export function dshHomePath(...segments) {
  const configured = process.env.DSH_HOME
  const home = configured && configured.trim() ? configured.trim() : join(homedir(), '.dsh')
  return join(home, ...segments)
}

/**
 * Directories already created this process.
 *
 * Every write goes through `ensureParent`, and in the steady state that is one
 * `mkdir` per recorded model call (plus one per lock retry, which used to mean
 * up to 200 of them while waiting out a peer). The tree is created once and
 * then never disappears, so remembering it turns all but the first into
 * nothing. A failed `mkdir` is not remembered, so a transient error retries.
 */
const ensuredDirs = new Set()

/** Create a file's parent directory, private to the user. Idempotent. */
async function ensureParent(file) {
  const dir = join(file, '..')
  if (ensuredDirs.has(dir)) return
  await fsPromises.mkdir(dir, { recursive: true, mode: DIR_MODE })
  ensuredDirs.add(dir)
}

/**
 * Replace a file's contents in one atomic step.
 *
 * `writeFile` truncates before it writes, so a process killed mid-write — or a
 * reader arriving mid-write — sees a half-written file. Rename is atomic on
 * one filesystem, so a reader sees either the old contents or the new ones.
 */
export async function writeFileAtomic(file, text) {
  // The borrowed implementation creates the tree itself, so only the fallback
  // path needs the directory prepared here.
  if (atomicWrite) {
    await atomicWrite.writeFileAtomic(file, text, { mode: FILE_MODE, dirMode: DIR_MODE })
    return
  }
  await ensureParent(file)
  // `wx` refuses to follow a symlink planted at the temp path, and the fresh
  // inode carries the mode through the rename. The pid keeps two processes
  // from colliding on the scratch name itself.
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  let handle
  try {
    handle = await fsPromises.open(temp, 'wx', FILE_MODE)
    await handle.writeFile(text, 'utf8')
  } catch (error) {
    await handle?.close().catch(() => {})
    await fsPromises.rm(temp, { force: true }).catch(() => {})
    throw error
  }
  await handle.close()
  try {
    await fsPromises.rename(temp, file)
  } catch (error) {
    await fsPromises.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/** Append to a file, creating it (and its directory) with private bits. */
export async function appendFilePrivate(file, text) {
  await ensureParent(file)
  await fsPromises.appendFile(file, text, { encoding: 'utf8', mode: FILE_MODE })
}

/** How long to keep retrying a lock another process is holding. */
const LOCK_TIMEOUT_MS = 5000
/** Age past which a lock file is assumed to be a crashed writer's leftover. */
const LOCK_STALE_MS = 30000

/**
 * Run `operation` while holding an exclusive lock on `file`.
 *
 * The lock is a `<file>.lock` sibling created with `wx`, so exactly one holder
 * wins. Readers never take it — the rename commit is already atomic for them;
 * it exists for the read-modify-write cycles, where two writers that each read
 * the old state would otherwise both write a state missing the other's change.
 *
 * Fail-soft: this plugin records spend, so a lock that cannot be taken (a
 * read-only home, an exotic filesystem, a peer that died holding it) must
 * degrade to the unlocked write rather than lose the data. A lock older than
 * {@link LOCK_STALE_MS} is broken on that basis.
 */
export async function withFileLock(file, operation) {
  if (atomicWrite) return atomicWrite.withFileLock(file, operation)
  const lock = `${file}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let held = false
  // Outside the retry loop: the tree cannot vanish between attempts, and
  // rebuilding it on every 25ms poll was pure syscall churn.
  await ensureParent(file).catch(() => {})
  for (;;) {
    try {
      const handle = await fsPromises.open(lock, 'wx', FILE_MODE)
      await handle.close()
      held = true
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') break // cannot lock at all — proceed unlocked
      const age = await fsPromises.stat(lock).then(
        (stat) => Date.now() - stat.mtimeMs,
        () => 0, // vanished between the open and the stat: retry immediately
      )
      if (age > LOCK_STALE_MS) {
        await fsPromises.rm(lock, { force: true }).catch(() => {})
        continue
      }
      if (Date.now() >= deadline) break // holder is alive but slow — proceed unlocked
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  try {
    return await operation()
  } finally {
    if (held) await fsPromises.rm(lock, { force: true }).catch(() => {})
  }
}

/** Read a file as utf8, or `null` when it does not exist. */
export async function readFileOrNull(file) {
  try {
    return await fsPromises.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}
