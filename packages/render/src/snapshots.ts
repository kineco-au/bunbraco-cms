/**
 * Content-addressed snapshots of the views tree.
 *
 * A view is a module, and `import()` caches modules in the runtime keyed on the
 * resolved path. There is no eviction, a query string does not bust it on Bun,
 * and the graph beneath a re-imported file stays pinned on every runtime. So a
 * template edited under a running node keeps rendering as it did at first
 * import, and no cache this codebase owns can change that.
 *
 * Only a new path is read fresh. A structure-preserving copy of the whole tree
 * at a new path therefore re-resolves the whole graph — which is why the unit of
 * versioning is the tree and not the file: `homePage.tsx` can be byte-identical
 * while the layout it imports has changed.
 *
 *   alias  →  <cacheDir>/<hash>/<alias>.tsx
 *
 * `sourceDir` stays the truth, for the template editor, `listComponents` and
 * `views check`. A snapshot is only ever an import target.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, sep } from 'node:path'

export interface SnapshotLimits {
  /** How long a stat gate's answer is trusted before another render re-checks. */
  gateTtlMs: number
  /** How long after an announced write a node keeps checking eagerly. */
  eagerWindowMs: number
  /** The floor between eager checks, so eagerness is frequent rather than per render. */
  eagerGateMs: number
  /** The floor between swaps; a burst of writes collapses to the latest tree. */
  minSwapIntervalMs: number
  /** Distinct generations this process will load before it freezes. */
  maxGenerations: number
  /** Previous generations left on disk, for an instant return to one. */
  keep: number
  maxFiles: number
  maxBytes: number
}

export const SNAPSHOT_LIMITS: SnapshotLimits = {
  gateTtlMs: 5_000,
  eagerWindowMs: 20_000,
  eagerGateMs: 500,
  minSwapIntervalMs: 10_000,
  // At ~88 KB of registry per generation on a small tree, a budget of 250 is
  // about 22 MB — enough that nobody reaches it by working, low enough that a
  // runaway writer is bounded. A bigger tree leaks proportionally more.
  maxGenerations: 250,
  keep: 3,
  maxFiles: 2_000,
  maxBytes: 20 * 1024 * 1024,
}

/**
 * Development wants to see an edit at once and does not need the burst floor.
 *
 * It evicts nothing at runtime: deleting a file `bun --watch` has imported
 * restarts the process, which is the very thing a snapshot exists to avoid.
 * `prepare` clears the lot at boot instead.
 */
export const DEVELOPMENT_LIMITS: Partial<SnapshotLimits> = {
  gateTtlMs: 500,
  eagerGateMs: 0,
  minSwapIntervalMs: 0,
  keep: Number.POSITIVE_INFINITY,
}

export interface SnapshotStatus {
  /** The generation being rendered, or undefined before the first is taken. */
  hash: string | undefined
  /** Distinct generations loaded by this process. */
  generations: number
  /** The budget is spent: the current generation keeps serving, new ones are refused. */
  frozen: boolean
  /** Why the last snapshot was refused, if one was. */
  refused: string | undefined
}

export interface SnapshotOptions {
  /** Where the views really live; read, never imported. */
  sourceDir: string
  /** Where snapshots are written. Must be outside `sourceDir`. */
  cacheDir: string
  limits?: Partial<SnapshotLimits>
  /** Reported once per distinct problem, not per render. */
  onProblem?: (message: string) => void
  /**
   * A generation came into use, with the one it replaced. Undefined on the first,
   * which is every boot and not an event worth reporting.
   */
  onSwap?: (hash: string, previous: string | undefined) => void
  now?: () => number
}

interface FileEntry {
  /** Path relative to the source root, `/`-separated so a hash is portable. */
  key: string
  absolute: string
  size: number
  mtimeMs: number
}

const PARTIAL = '.partial-'

/** `/`-separated, whatever the host platform writes. */
const toKey = (path: string) => path.split(sep).join('/')

function walk(dir: string, root = dir, out: FileEntry[] = []): FileEntry[] {
  // Sorted, so two nodes reading the same tree hash it the same way.
  for (const name of readdirSync(dir).sort()) {
    const absolute = join(dir, name)
    const stats = statSync(absolute)
    if (stats.isDirectory()) walk(absolute, root, out)
    else
      out.push({
        key: toKey(relative(root, absolute)),
        absolute,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      })
  }
  return out
}

export class ViewSnapshots {
  #sourceDir: string
  #cacheDir: string
  #limits: SnapshotLimits
  #onProblem: (message: string) => void
  #onSwap: (hash: string, previous: string | undefined) => void
  #now: () => number

  #current: { hash: string; dir: string } | undefined
  /** Every hash this process has imported from: returning to one costs nothing. */
  #loaded = new Set<string>()
  #gateHash: string | undefined
  #gateAt = 0
  #swappedAt = 0
  #eagerUntil = 0
  #announced: string | undefined
  #checking: Promise<void> | undefined
  #forceNext = false
  #frozen = false
  #refused: string | undefined
  #reported = new Set<string>()

  constructor(options: SnapshotOptions) {
    this.#sourceDir = options.sourceDir
    this.#cacheDir = options.cacheDir
    this.#limits = { ...SNAPSHOT_LIMITS, ...options.limits }
    this.#onProblem = options.onProblem ?? (() => {})
    this.#onSwap = options.onSwap ?? (() => {})
    this.#now = options.now ?? Date.now
    if (!relative(this.#sourceDir, this.#cacheDir).startsWith('..')) {
      throw new Error(
        `The views cache directory must sit outside the views directory; ${this.#cacheDir} is inside ${this.#sourceDir}.`,
      )
    }
  }

  /** Each distinct problem once: a render path must not fill the log. */
  #problem(message: string): void {
    this.#refused = message
    if (this.#reported.has(message)) return
    this.#reported.add(message)
    this.#onProblem(message)
  }

  /** Where generations are written; the renderer maps paths out of it for people. */
  get cacheDir(): string {
    return this.#cacheDir
  }

  status(): SnapshotStatus {
    return {
      hash: this.#current?.hash,
      generations: this.#loaded.size,
      frozen: this.#frozen,
      refused: this.#refused,
    }
  }

  /**
   * Clears what a previous process left and takes the first generation, so no
   * request pays for it and a crashed partial copy is never imported.
   */
  async prepare(): Promise<void> {
    mkdirSync(this.#cacheDir, { recursive: true })
    // Everything, not just the partials: a generation a previous process
    // imported is not in this one's registry, so keeping it buys nothing and a
    // fresh boot is the only safe moment to delete what `--watch` is watching.
    for (const name of readdirSync(this.#cacheDir))
      rmSync(join(this.#cacheDir, name), { recursive: true, force: true })
    await this.#check()
    await this.settle()
  }

  /**
   * The directory to import from.
   *
   * Synchronous and cheap: it answers from the current generation and, when the
   * gate has gone stale, starts a check in the background. A render never waits
   * for one, and concurrent renders share the single check in flight.
   */
  directory(): string | undefined {
    const now = this.#now()
    // Eager means often, not every render: a stat walk is a ListObjects call on
    // a mounted bucket, and a render must not pay for one.
    const eager = now < this.#eagerUntil && now - this.#gateAt >= this.#limits.eagerGateMs
    const due = eager || now - this.#gateAt >= this.#limits.gateTtlMs
    if (due && !this.#checking) {
      this.#checking = this.#check()
        .catch((error: unknown) => {
          this.#problem(`Could not refresh the views snapshot: ${String(error)}`)
        })
        .finally(() => {
          this.#checking = undefined
        })
    }
    return this.#current?.dir
  }

  /**
   * Another node says a template was written.
   *
   * The hash is a hint for when to stop looking, never what to render: this node
   * always snapshots the bytes it reads, so it converges on whatever the tree
   * actually is even when the hash it was handed is already superseded. If it is
   * never reached, the window closing ends the eagerness.
   */
  announce(hash?: string): void {
    this.#announced = hash
    this.#eagerUntil = this.#now() + this.#limits.eagerWindowMs
    this.#gateAt = 0
    // A deliberate write, relayed from the node that made it. The floor exists
    // to absorb a flapping sync, which is by definition unannounced; applying it
    // here would make an editor's save take the floor's length to reach the
    // renderers even though somebody asked for it.
    this.#forceNext = true
  }

  /**
   * A template was written *here*: take the snapshot now and report its hash.
   *
   * The coalescing floor is skipped, for two reasons. An editor must see their
   * own save rather than the previous template for the next ten seconds; and the
   * floor exists to absorb a flapping sync, which is by definition something no
   * node announced. A runaway announced writer is bounded by the generation
   * budget instead, which is what the budget is for.
   */
  async refresh(): Promise<string | undefined> {
    await this.settle()
    this.#checking = this.#check(true).finally(() => {
      this.#checking = undefined
    })
    await this.#checking
    return this.#current?.hash
  }

  /** Waits for any check in flight; tests and `prepare` want the settled state. */
  async settle(): Promise<void> {
    while (this.#checking) await this.#checking
  }

  async #check(force = false): Promise<void> {
    const now = this.#now()
    this.#gateAt = now
    if (!existsSync(this.#sourceDir)) return

    const files = walk(this.#sourceDir)
    const gate = createHash('sha256')
    for (const file of files) gate.update(`${file.key}\0${file.size}\0${file.mtimeMs}\n`)
    const gateHash = gate.digest('hex')

    // Nothing the filesystem can see has moved.
    if (gateHash === this.#gateHash && this.#current) {
      if (this.#announced !== undefined && this.#announced === this.#current.hash)
        this.#eagerUntil = 0
      return
    }

    // A burst of unannounced changes collapses into one generation. The first
    // snapshot is never delayed, or a boot would serve nothing, and an announced
    // write is not a burst — see `refresh`.
    const forced = force || this.#forceNext
    this.#forceNext = false
    if (!forced && this.#current && now - this.#swappedAt < this.#limits.minSwapIntervalMs) return

    if (files.length > this.#limits.maxFiles) {
      this.#problem(
        `The views tree has ${files.length} files, over the ${this.#limits.maxFiles} a snapshot allows; the current views keep serving.`,
      )
      return
    }
    const bytes = files.reduce((total, file) => total + file.size, 0)
    if (bytes > this.#limits.maxBytes) {
      this.#problem(
        `The views tree is ${Math.round(bytes / 1024)} KB, over the ${Math.round(this.#limits.maxBytes / 1024)} KB a snapshot allows; the current views keep serving.`,
      )
      return
    }

    this.#gateHash = gateHash
    await this.#materialise(files)
  }

  /**
   * Copies the tree once, hashing the bytes it writes.
   *
   * One pass, so the name always describes the content: hashing first and
   * copying second could name a directory after bytes it does not hold. The
   * copy lands in a partial directory and is renamed into place, so no render
   * can import a half-written tree.
   */
  async #materialise(files: FileEntry[]): Promise<void> {
    const partial = join(this.#cacheDir, `${PARTIAL}${crypto.randomUUID().slice(0, 8)}`)
    const hasher = createHash('sha256')
    try {
      mkdirSync(partial, { recursive: true })
      for (const file of files) {
        const bytes = await Bun.file(file.absolute).bytes()
        hasher.update(`${file.key}\0`)
        hasher.update(bytes)
        hasher.update('\n')
        const target = join(partial, ...file.key.split('/'))
        mkdirSync(join(target, '..'), { recursive: true })
        writeFileSync(target, bytes)
      }
      const hash = hasher.digest('hex').slice(0, 16)

      // Already rendering this exact tree: the copy was wasted but harmless.
      if (hash === this.#current?.hash) return

      // A deploy writing twenty files is not atomic, so a snapshot can catch a
      // half-synced tree. If anything moved while copying, leave it for the next
      // check rather than publish a generation nobody asked for.
      const after = walk(this.#sourceDir)
      if (!sameTree(files, after)) return

      if (!this.#loaded.has(hash) && this.#loaded.size >= this.#limits.maxGenerations) {
        this.#frozen = true
        this.#problem(
          `This node has loaded ${this.#loaded.size} view generations, its limit. The views it is serving keep serving and newer ones are refused; restart the node to pick them up.`,
        )
        return
      }

      const dir = join(this.#cacheDir, hash)
      if (existsSync(dir)) rmSync(partial, { recursive: true, force: true })
      else renameSync(partial, dir)

      const previous = this.#current?.hash
      this.#current = { hash, dir }
      this.#loaded.add(hash)
      this.#swappedAt = this.#now()
      this.#refused = undefined
      if (this.#announced === hash) this.#eagerUntil = 0
      this.#onSwap(hash, previous)
      this.#evict(hash)
    } finally {
      rmSync(partial, { recursive: true, force: true })
    }
  }

  /**
   * Drops the oldest generations on disk, newest kept.
   *
   * Deleting one is safe even while its modules are loaded — a module lives in
   * the registry, not on disk — and a return to that hash re-creates the path,
   * which `import()` answers from the registry without reading anything.
   */
  #evict(current: string): void {
    if (!Number.isFinite(this.#limits.keep)) return
    const generations = readdirSync(this.#cacheDir)
      .filter((name) => name !== current && !name.startsWith(PARTIAL))
      .map((name) => ({ name, at: statSync(join(this.#cacheDir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    for (const stale of generations.slice(this.#limits.keep))
      rmSync(join(this.#cacheDir, stale.name), { recursive: true, force: true })
  }
}

function sameTree(before: FileEntry[], after: FileEntry[]): boolean {
  if (before.length !== after.length) return false
  return before.every((file, index) => {
    const other = after[index] as FileEntry
    return file.key === other.key && file.size === other.size && file.mtimeMs === other.mtimeMs
  })
}
