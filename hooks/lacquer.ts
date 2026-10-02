import type { Tile } from '../types'

/** The terminal's own colour, as a Raster cell spells it. */
export const DEFAULT = 0x01000000

export const TILE_COLUMNS = 16
export const TILE_ROWS = 5 // four art rows and a label row
export const MAX_TILES = 48
export const CRACK_MS = 650
export const SHAKE_MS = 260
export const GOLD_MS = 1300
export const SHIMMER_MS = 3200
export const FLASH_MS = 900

const PORCELAIN = 0xf3efe4
const PORCELAIN_DIM = 0xb9b4a6
const GOLD = 0xffcc4d
const GOLD_DEEP = 0xc9921c
const GLINT = 0xfff6cf
const BROKEN_RED = 0xff5d6c
const LABEL_BG = 0x0b0c26
const GAP_BG = 0x06061a

// ── Raster plumbing ──────────────────────────────────────────────────────────

/** Standard padded base64, without relying on the environment's encoders. */
export function base64(bytes: Uint8Array): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number)
    out += abc[(n >> 18) & 63]! + abc[(n >> 12) & 63]! + abc[(n >> 6) & 63]! + abc[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = (bytes[i] as number) << 16
    out += abc[(n >> 18) & 63]! + abc[(n >> 12) & 63]! + '=='
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8)
    out += abc[(n >> 18) & 63]! + abc[(n >> 12) & 63]! + abc[(n >> 6) & 63]! + '='
  }
  return out
}

export class Grid {
  readonly cells: Uint32Array
  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    this.cells = new Uint32Array(columns * rows * 3)
    for (let i = 0; i < columns * rows; i += 1) {
      this.cells[i * 3] = 0x20
      this.cells[i * 3 + 1] = DEFAULT
      this.cells[i * 3 + 2] = DEFAULT
    }
  }

  set(x: number, y: number, code: number, fg: number, bg: number): void {
    if (x < 0 || y < 0 || x >= this.columns || y >= this.rows) return
    const i = (y * this.columns + x) * 3
    this.cells[i] = code
    this.cells[i + 1] = fg
    this.cells[i + 2] = bg
  }

  /** Writes text, one printable width-1 character per cell; anything else becomes '?'. */
  text(x: number, y: number, text: string, fg: number, bg: number): number {
    let col = x
    for (const ch of text) {
      if (col >= this.columns) break
      this.set(col, y, safeCode(ch), fg, bg)
      col += 1
    }
    return col
  }

  encode(): string {
    const bytes = new Uint8Array(this.cells.length * 4)
    for (let i = 0; i < this.cells.length; i += 1) {
      const v = this.cells[i] as number
      bytes[i * 4] = v & 0xff
      bytes[i * 4 + 1] = (v >>> 8) & 0xff
      bytes[i * 4 + 2] = (v >>> 16) & 0xff
      bytes[i * 4 + 3] = (v >>> 24) & 0xff
    }
    return base64(bytes)
  }
}

/** A code point the Raster accepts: printable, width 1, in the BMP. Everything else is '?'. */
export function safeCode(ch: string): number {
  const c = ch.codePointAt(0) ?? 0x3f
  // A conservative allowlist of characters every terminal draws in exactly one cell: ASCII,
  // Latin, Greek and Cyrillic letters (no combining marks), common punctuation, arrows, math,
  // box drawing, blocks, geometric shapes and braille. Joiners, variation selectors and
  // everything else draw as "?".
  const ranges: Array<[number, number]> = [
    [0x20, 0x7e], [0xa0, 0xac], [0xae, 0x2ff], [0x370, 0x482], [0x48a, 0x52f],
    [0x2010, 0x2027], [0x2030, 0x205e], [0x20a0, 0x20bf], [0x2100, 0x214f], [0x2190, 0x21ff],
    [0x2200, 0x22ff], [0x2500, 0x25ff], [0x2800, 0x28ff],
  ]
  for (const [lo, hi] of ranges) if (c >= lo && c <= hi) return c
  return 0x3f
}

export function rgb(r: number, g: number, b: number): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return (c(r) << 16) | (c(g) << 8) | c(b)
}

function mix(a: number, b: number, t: number): number {
  const k = Math.max(0, Math.min(1, t))
  return rgb(
    ((a >> 16) & 255) * (1 - k) + ((b >> 16) & 255) * k,
    ((a >> 8) & 255) * (1 - k) + ((b >> 8) & 255) * k,
    (a & 255) * (1 - k) + (b & 255) * k,
  )
}

// ── Operations → tiles ───────────────────────────────────────────────────────

export type Op = { key: string; label: string; tool: string }

function baseName(path: string): string {
  const parts = path.split('/').filter(p => p.length > 0)
  return parts[parts.length - 1] ?? path
}

/** A shell command as a short display label: no leading `cd x &&`, no env assignments, single spaces. Display only: never identity. */
export function normalizeCommand(command: string): string {
  let text = command.replace(/\s+/g, ' ').trim()
  for (let guard = 0; guard < 4; guard += 1) {
    const cd = /^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/.exec(text)
    if (cd === null) break
    text = text.slice(cd[0].length)
  }
  text = text.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '')
  return text
}

function shorten(text: string, room: number): string {
  return text.length > room ? `${text.slice(0, room - 1)}…` : text
}

/** Which tile a tool call belongs to, or null for calls that are not operations worth a tile. */
export function opOf(e: { tool: string; [k: string]: unknown }): Op | null {
  const tool = String(e.tool)
  const file = typeof e.file_path === 'string' ? e.file_path : typeof e.notebook_path === 'string' ? e.notebook_path : undefined
  if (tool === 'Bash') {
    // Identity is the exact command: `cd web && npm test` and `cd api && npm test` are different operations,
    // and whitespace inside quotes matters. The label is the short, normalized form.
    const exact = String(e.command ?? '').trim()
    if (exact.length === 0) return null
    return { key: `Bash:${exact}`, label: shorten(normalizeCommand(exact), TILE_COLUMNS - 2), tool }
  }
  if (file !== undefined && file.length > 0) {
    const verb = tool === 'NotebookEdit' ? 'Nb' : tool
    return { key: `${tool}:${file}`, label: shorten(`${verb} ${baseName(file)}`, TILE_COLUMNS - 2), tool }
  }
  const short = tool.startsWith('mcp__') ? tool.split('__').slice(1).join('/') : tool
  // The arguments that define the operation: for the built-in lookups their target and scope (a retried
  // WebFetch with a different prompt is the same fetch); for an MCP tool every plain argument (the issue number).
  const fields = IDENTITY[tool] ?? (tool.startsWith('mcp__') ? Object.keys(e).filter(k => !IGNORED_ARGS.has(k)) : null)
  if (fields === null) return null
  const args = fields
    .slice()
    .sort()
    .map(k => [k, e[k]] as const)
    .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object')
  if (args.length === 0 && !tool.startsWith('mcp__')) return null
  const target = [e.url, e.pattern, e.query].find(v => typeof v === 'string' && v.length > 0)
  const shown = typeof target === 'string' ? `${short} ${target}` : short
  return { key: `${tool}:${JSON.stringify(args)}`, label: shorten(shown, TILE_COLUMNS - 2), tool }
}

const IDENTITY: Record<string, string[]> = {
  WebFetch: ['url'],
  WebSearch: ['query', 'allowed_domains', 'blocked_domains'],
  Grep: ['pattern', 'path', 'glob', 'type'],
  Glob: ['pattern', 'path'],
}

const IGNORED_ARGS = new Set(['tool', 'tool_use_id', 'agentId', 'consent', 'description'])

/**
 * A result the person or the engine cut short is not a failure of the operation. Only the engine's own
 * short messages count: a test log that merely contains "interrupted" is a real failure.
 */
export function isInterruption(text: string): boolean {
  const t = text.trim()
  if (t.length > 300) return false
  return /^\[?request interrupted by user[^\]]*\]?$|^the user (?:doesn't want|rejected|declined)|request was aborted|aborted before completion|^interrupted\b/i.test(t)
}

/** A Bash run that never finished in the foreground (backgrounded, timed out, interrupted) proved nothing. */
export function isUnfinished(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false
  const r = result as Record<string, unknown>
  return r.interrupted === true || r.backgroundTaskId !== undefined || r.backgroundedByUser === true || r.timedOutAfterMs !== undefined || r.backgroundedByTurnAbort === true
}

function hashSeed(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** The wall after one finished operation: a failure cracks (or re-cracks) its tile; a success repairs a cracked one. */
export function applyOutcome(tiles: readonly Tile[], op: Op, failed: boolean, now: number): Tile[] {
  const index = tiles.findIndex(t => t.key === op.key)
  if (index < 0) {
    if (!failed) return tiles as Tile[]
    const tile: Tile = { key: op.key, label: op.label, tool: op.tool, fails: 1, repairs: 0, state: 'cracked', seed: hashSeed(op.key), crackedAt: now, repairedAt: 0, lastAt: now }
    return trim([...tiles, tile])
  }
  const was = tiles[index] as Tile
  let tile: Tile
  if (failed) tile = { ...was, fails: was.fails + 1, state: 'cracked', crackedAt: now, lastAt: now }
  else if (was.state === 'cracked') tile = { ...was, repairs: was.repairs + 1, state: 'gold', repairedAt: now, lastAt: now }
  else return tiles as Tile[]
  const out = tiles.slice()
  out[index] = tile
  return out
}

/** Keep the wall bounded: drop the oldest repaired tiles first, then the oldest broken ones. */
function trim(tiles: Tile[]): Tile[] {
  if (tiles.length <= MAX_TILES) return tiles
  const out = tiles.slice()
  while (out.length > MAX_TILES) {
    let victim = -1
    for (let i = 0; i < out.length; i += 1) if ((out[i] as Tile).state === 'gold') { victim = i; break }
    out.splice(victim < 0 ? 0 : victim, 1)
  }
  return out
}

export type Stats = { cracks: number; repaired: number; broken: number }

export function statsOf(tiles: readonly Tile[]): Stats {
  let cracks = 0
  let repaired = 0
  let broken = 0
  for (const t of tiles) {
    cracks += t.fails
    if (t.state === 'gold') repaired += 1
    else broken += 1
  }
  return { cracks, repaired, broken }
}

export function statsLine(s: Stats): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  return `${plural(s.cracks, 'crack')} · ${s.repaired} repaired in gold · ${s.broken} still broken`
}

/** True while any tile is mid-animation at `now`. */
export function isAnimating(tiles: readonly Tile[], now: number): boolean {
  return tiles.some(t => now - t.crackedAt < Math.max(CRACK_MS, FLASH_MS) || (t.state === 'gold' && now - t.repairedAt < GOLD_MS + SHIMMER_MS))
}

// ── Crack geometry ───────────────────────────────────────────────────────────

function prng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
}

export type Point = { x: number; y: number }

/**
 * The tile's cracks in sub-pixels (2 across and 4 down per cell): from each impact point, a few jagged
 * branches running out to the edges. One impact per failure, up to three, all from the tile's seed.
 */
export function crackPaths(seed: number, fails: number, width: number, height: number): Point[][] {
  const paths: Point[][] = []
  const impacts = Math.max(1, Math.min(3, fails))
  for (let k = 0; k < impacts; k += 1) {
    const rand = prng(seed + k * 7919)
    const ox = width * (0.3 + rand() * 0.4)
    const oy = height * (0.25 + rand() * 0.5)
    const branches = 3 + Math.floor(rand() * 2)
    const turn = rand() * Math.PI * 2
    for (let b = 0; b < branches; b += 1) {
      let angle = turn + (b / branches) * Math.PI * 2 + (rand() - 0.5) * 0.9
      let x = ox
      let y = oy
      const path: Point[] = [{ x: Math.round(x), y: Math.round(y) }]
      for (let step = 0; step < 60; step += 1) {
        angle += (rand() - 0.5) * 0.9
        x += Math.cos(angle) * 1.6
        y += Math.sin(angle) * 1.1
        if (x < 0 || y < 0 || x > width - 1 || y > height - 1) break
        path.push({ x: Math.round(x), y: Math.round(y) })
      }
      paths.push(path)
    }
  }
  return paths
}

/** Every sub-pixel along a path, in order, with a gap-free line between its points. */
export function rasterize(path: readonly Point[]): Point[] {
  const out: Point[] = []
  for (let i = 0; i < path.length; i += 1) {
    const a = path[i] as Point
    if (i === 0) {
      out.push(a)
      continue
    }
    const p = path[i - 1] as Point
    let x0 = p.x
    let y0 = p.y
    const dx = Math.abs(a.x - x0)
    const dy = -Math.abs(a.y - y0)
    const sx = x0 < a.x ? 1 : -1
    const sy = y0 < a.y ? 1 : -1
    let err = dx + dy
    for (let guard = 0; guard < 64; guard += 1) {
      if (x0 === a.x && y0 === a.y) break
      const e2 = 2 * err
      if (e2 >= dy) {
        err += dy
        x0 += sx
      }
      if (e2 <= dx) {
        err += dx
        y0 += sy
      }
      out.push({ x: x0, y: y0 })
    }
  }
  return out
}

const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

// ── Drawing ──────────────────────────────────────────────────────────────────

/** Glossy lacquer: deep indigo with a soft diagonal highlight; a broken tile shows two shard tones. */
function lacquerBg(cx: number, cy: number, cols: number, rows: number, shard: boolean, warm: boolean): number {
  const t = (cx / Math.max(1, cols - 1)) * 0.6 + (cy / Math.max(1, rows - 1)) * 0.4
  let base = mix(0x34389a, 0x0f1036, t)
  const gloss = Math.abs(cx - cy * 2 - cols * 0.25)
  if (gloss < 2.2) base = mix(base, 0x7d83e0, 0.35 * (1 - gloss / 2.2))
  if (shard) base = mix(base, 0x0a0b25, 0.32)
  if (warm) base = mix(base, 0x3a2a12, 0.12)
  return base
}

export type DrawOptions = { now: number; frame: number }

/** One tile at (x0, y0) in grid cells: lacquer, shards, cracks growing or filled with gold, label and counts. */
export function drawTile(grid: Grid, tile: Tile, x0: number, y0: number, opts: DrawOptions): void {
  const { now, frame } = opts
  const artRows = TILE_ROWS - 1
  const width = TILE_COLUMNS * 2
  const height = artRows * 4
  const sinceCrack = now - tile.crackedAt
  const shake = sinceCrack < SHAKE_MS ? (frame % 2 === 0 ? 1 : -1) : 0
  const growth = Math.min(1, sinceCrack / CRACK_MS)
  const gold = tile.state === 'gold'
  const sinceGold = now - tile.repairedAt
  const sweep = gold ? Math.min(1, sinceGold / GOLD_MS) : 0
  const shimmering = gold && sinceGold >= GOLD_MS && sinceGold < GOLD_MS + SHIMMER_MS
  const paths = crackPaths(tile.seed, tile.fails, width, height)

  // Per sub-pixel: 1 = porcelain crack, 2 = gold seam, 3 = gold glint.
  const marks = new Uint8Array(width * height)
  const first = paths[0] ?? []
  for (const path of paths) {
    const dots = rasterize(path)
    const shown = Math.ceil(dots.length * growth)
    for (let i = 0; i < shown; i += 1) {
      const d = dots[i] as Point
      if (d.x < 0 || d.y < 0 || d.x >= width || d.y >= height) continue
      const along = i / Math.max(1, dots.length - 1)
      let mark = 1
      if (gold && along <= sweep) mark = 2
      if (shimmering) {
        const phase = ((sinceGold - GOLD_MS) / 900) % 1.6
        if (Math.abs(along - phase) < 0.08) mark = 3
      }
      if (gold && sweep < 1 && Math.abs(along - sweep) < 0.05) mark = 3
      marks[d.y * width + d.x] = Math.max(marks[d.y * width + d.x] as number, mark)
    }
  }

  // Which side of the first crack a cell falls on decides its shard tone.
  const a = first[0] ?? { x: width / 2, y: height / 2 }
  const b = first[first.length - 1] ?? { x: width, y: height }
  for (let cy = 0; cy < artRows; cy += 1) {
    for (let cx = 0; cx < TILE_COLUMNS; cx += 1) {
      const px = cx * 2 + 1
      const py = cy * 4 + 2
      const side = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x) > 0
      const bg = lacquerBg(cx, cy, TILE_COLUMNS, artRows, side, gold)
      let bits = 0
      let best = 0
      for (let dy = 0; dy < 4; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const m = marks[(cy * 4 + dy) * width + cx * 2 + dx] as number
          if (m > 0) {
            bits |= (BRAILLE_BITS[dy] as number[])[dx] as number
            best = Math.max(best, m)
          }
        }
      }
      const fg = best === 3 ? GLINT : best === 2 ? (frame % 20 < 10 || !shimmering ? GOLD : GOLD_DEEP) : growth < 1 ? PORCELAIN : PORCELAIN_DIM
      grid.set(x0 + cx + shake, y0 + cy, bits === 0 ? 0x20 : 0x2800 + bits, bits === 0 ? DEFAULT : fg, bg)
    }
  }

  // Label row: what broke, and how often it broke and was mended.
  const flash = tile.state === 'cracked' && now - tile.crackedAt < FLASH_MS && frame % 6 < 3
  const labelBg = flash ? 0x4a0f1c : LABEL_BG
  for (let cx = 0; cx < TILE_COLUMNS; cx += 1) grid.set(x0 + cx, y0 + artRows, 0x20, DEFAULT, labelBg)
  const fails = `×${tile.fails}`
  const mends = tile.repairs > 0 ? ` ◆${tile.repairs}` : ''
  const start = x0 + TILE_COLUMNS - fails.length - mends.length - 1
  grid.text(x0 + 1, y0 + artRows, shorten(tile.label, Math.max(1, start - x0 - 2)), gold ? GOLD : PORCELAIN, labelBg)
  grid.text(start, y0 + artRows, fails, BROKEN_RED, labelBg)
  if (mends.length > 0) grid.text(start + fails.length, y0 + artRows, mends, GOLD, labelBg)
}

export type WallLayout = { columns: number; rows: number; perRow: number; shown: number }

/** How a wall of `count` tiles fits `columns` cells across and at most `maxRows` down. */
export function wallLayout(count: number, columns: number, maxRows: number): WallLayout {
  const cols = Math.max(TILE_COLUMNS + 2, Math.min(512, columns))
  const perRow = Math.max(1, Math.floor((cols - 1) / (TILE_COLUMNS + 1)))
  const fitRows = Math.max(1, Math.floor((Math.min(256, maxRows) - 1) / (TILE_ROWS + 1)))
  const shown = Math.min(count, perRow * fitRows)
  const tileRows = Math.max(1, Math.ceil(shown / perRow))
  return { columns: cols, rows: Math.min(256, tileRows * (TILE_ROWS + 1) + 1), perRow, shown }
}

/** The full wall: newest tiles first, on a near-black grout. */
export function wallCells(tiles: readonly Tile[], layout: WallLayout, opts: DrawOptions): Grid {
  const grid = new Grid(layout.columns, layout.rows)
  for (let y = 0; y < layout.rows; y += 1) for (let x = 0; x < layout.columns; x += 1) grid.set(x, y, 0x20, DEFAULT, GAP_BG)
  const order = tiles.slice().sort((p, q) => q.lastAt - p.lastAt).slice(0, layout.shown)
  order.forEach((tile, i) => {
    const x = 1 + (i % layout.perRow) * (TILE_COLUMNS + 1)
    const y = 1 + Math.floor(i / layout.perRow) * (TILE_ROWS + 1)
    drawTile(grid, tile, x, y, opts)
  })
  return grid
}

/** The band: one row of mini-tiles (broken ones crack-white, mended ones gold), then the tally. */
export function bandCells(tiles: readonly Tile[], columns: number, opts: DrawOptions, stats?: Stats): Grid {
  const cols = Math.max(20, Math.min(512, columns))
  const grid = new Grid(cols, 1)
  const order = tiles.slice().sort((p, q) => q.lastAt - p.lastAt)
  const s = stats ?? statsOf(tiles)
  const tally = ` ◈ ${statsLine(s)}`
  const room = Math.max(0, Math.floor((cols - tally.length - 1) / 3))
  let x = 0
  for (const tile of order.slice(0, room)) {
    const gold = tile.state === 'gold'
    const fresh = !gold && opts.now - tile.crackedAt < FLASH_MS && opts.frame % 6 < 3
    const glint = gold && opts.now - tile.repairedAt < GOLD_MS && opts.frame % 4 < 2
    const bg = fresh ? 0x5a1222 : gold ? 0x2a2050 : 0x1d1f5c
    const fg = gold ? (glint ? GLINT : GOLD) : PORCELAIN
    grid.set(x, 0, gold ? 0x2871 : 0x2847, fg, bg) // ⡱ ⡇
    grid.set(x + 1, 0, gold ? 0x288e : 0x28b8, fg, bg) // ⢎ ⢸
    x += 3
  }
  if (order.length > room && room > 0) grid.text(Math.max(0, x - 1), 0, '…', PORCELAIN_DIM, DEFAULT)
  grid.text(x, 0, tally, s.broken > 0 ? PORCELAIN : GOLD, DEFAULT)
  return grid
}
