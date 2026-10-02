import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Exhibit, Tile } from '../types'
import { applyOutcome, bandCells, isAnimating, isInterruption, isUnfinished, opOf, statsLine, statsOf, wallCells, wallLayout } from './lacquer'
import type { Stats, WallLayout } from './lacquer'

const tiles = atom({ plugin: 'fault-lacquer', key: 'tiles' } as const, [])
const band = atom({ plugin: 'fault-lacquer', key: 'band' } as const, true)
const totals = atom({ plugin: 'fault-lacquer', key: 'totals' } as const, { cracks: 0, repaired: 0 })

const PANE = 'fault-lacquer'
const BAND_KEY = 'strip'
const WALL_KEY = 'wall'
const FRAME_MS = 33
const GALLERY = 'gallery'
const GALLERY_MAX = 200
const TILE_MIN_ROWS = 7

// The animation's own bookkeeping lives in the module: it is cosmetic, and a reload starts it afresh.
let wall: Tile[] = []
let frame = 0
let settled = true
// The frame clock runs only while something animates.
let timer: { cancel: () => void } | null = null
// The newest frame painted, so a slow frame never paints over a newer one.
let painted = 0
let bandSite: { requestId: string; columns: number } | null = null
let paneSite: { requestId: string; layout: WallLayout; maxRows: number } | null = null

/** One animation frame: repaint whatever is mounted while a crack grows or gold sweeps, then go quiet. */
async function tick($: EngineInterface): Promise<void> {
  const now = Date.now()
  const animating = isAnimating(wall, now)
  if (!animating && settled) {
    // Nothing moves: stop the clock until the next outcome starts it again.
    if (timer !== null) timer.cancel()
    timer = null
    return
  }
  // One more frame after the animation ends, so the resting state is what stays on screen.
  settled = !animating
  frame += 1
  const mine = frame
  const opts = { now, frame }
  if (mine < painted) return
  painted = mine
  if (bandSite !== null) {
    const cells = bandCells(wall, bandSite.columns, opts).encode()
    const res = await $.ui.blit({ requestId: bandSite.requestId, key: BAND_KEY, cells, columns: bandSite.columns, rows: 1 })
    if (res.deny !== undefined) bandSite = null
  }
  if (paneSite !== null) {
    const layout = paneSite.layout
    if (wallLayout(wall.length, layout.columns, paneSite.maxRows).rows !== layout.rows) {
      // More tiles than the mounted Raster holds: a resize is a redraw, not a blit.
      $.ui.invalidate('ui.render')
      return
    }
    const cells = wallCells(wall, layout, opts).encode()
    const res = await $.ui.blit({ requestId: paneSite.requestId, key: WALL_KEY, cells, columns: layout.columns, rows: layout.rows })
    if (res.deny !== undefined) paneSite = null
  }
}

/** Starts the frame clock if it is not running; the callback returns its frame, so frames never overlap. */
function startClock($: EngineInterface): void {
  if (timer !== null) return
  timer = $.clock.every(FRAME_MS, () => tick($))
}

/** The session's stats: every crack and repair counted, and what is broken on the wall now. */
function sessionStats(list: readonly Tile[], t: { cracks: number; repaired: number }): Stats {
  return { cracks: t.cracks, repaired: t.repaired, broken: list.filter(x => x.state === 'cracked').length }
}

/** Adds this session to the lifetime gallery, newest last. */
async function exhibit($: EngineInterface, list: readonly Tile[]): Promise<void> {
  const t = await read($, totals)
  if (t.cracks === 0 && list.length === 0) return
  const s = sessionStats(list, t)
  const worst = list.slice().sort((p, q) => q.fails - p.fails)[0]
  const entry: Exhibit = { at: Date.now(), cracks: s.cracks, repaired: s.repaired, broken: s.broken, worst: worst === undefined ? '' : worst.label }
  const prior = await $.store.get(GALLERY)
  const past = Array.isArray(prior) ? (prior as Exhibit[]) : []
  await $.store.set(GALLERY, [...past, entry].slice(-GALLERY_MAX))
}

/** The lifetime gallery as one line. */
async function galleryLine($: EngineInterface): Promise<string> {
  const prior = await $.store.get(GALLERY)
  const past = Array.isArray(prior) ? (prior as Exhibit[]) : []
  if (past.length === 0) return 'Fault Lacquer gallery: no finished sessions yet.'
  let cracks = 0
  let repaired = 0
  for (const x of past) {
    cracks += x.cracks
    repaired += x.repaired
  }
  const kept = past.length >= GALLERY_MAX ? ` (the last ${GALLERY_MAX})` : ''
  return `Fault Lacquer gallery: ${past.length} session${past.length === 1 ? '' : 's'}${kept} · ${cracks} crack${cracks === 1 ? '' : 's'} · ${repaired} repaired in gold.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'kintsugi',
      description: 'Fault Lacquer: open the kintsugi wall of failed and mended operations',
      argumentHint: '[band on|off | gallery | clear]',
      immediate: true,
    })
    wall = await read($, tiles)
    timer = null
    settled = false
    startClock($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await exhibit($, await read($, tiles))
    // A /clear or a resume starts a new session without a session.start: drop the ended wall from screen.
    wall = []
    bandSite = null
    paneSite = null
    await update($, tiles, () => [])
    await update($, totals, () => ({ cracks: 0, repaired: 0 }))
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('command.run', { command: 'kintsugi' }, async ($, e) => {
    const args = e.args.trim().toLowerCase()
    if (args === 'band on' || args === 'band off') {
      await update($, band, () => args === 'band on')
      return { text: `Fault Lacquer: band ${args === 'band on' ? 'on' : 'off'}.` }
    }
    if (args === 'gallery') return { text: await galleryLine($) }
    if (args === 'clear') {
      // A clean slate: the wall and this session's crack and repair counts (the gallery keeps past sessions).
      wall = await update($, tiles, () => [])
      await update($, totals, () => ({ cracks: 0, repaired: 0 }))
      return { text: 'Fault Lacquer: the wall is clear.' }
    }
    await $.ui.open({ id: PANE, title: 'Kintsugi', rows: 16 })
    const list = await read($, tiles)
    const t = await read($, totals)
    return { text: list.length === 0 && t.cracks === 0 ? 'Fault Lacquer: nothing has broken yet.' : `Fault Lacquer: ${statsLine(sessionStats(list, t))}.` }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const op = opOf(e as { tool: string })
    if (op === null) return ran
    const result = ran.result as Record<string, unknown> | undefined
    // A run that never finished in the foreground, or an edit held for review, proves nothing either way.
    if (e.tool === 'Bash' && isUnfinished(result)) return ran
    if (result !== undefined && result !== null && typeof result === 'object' && result.staged === true) return ran
    // A fetch that came back with an HTTP error is a failure even though the tool itself succeeded.
    const httpFailed = e.tool === 'WebFetch' && typeof result?.code === 'number' && (result.code as number) >= 400
    const failed = ran.isError === true || httpFailed
    if (ran.isError === true && isInterruption(String(ran.text ?? (typeof ran.result === 'string' ? ran.result : '')))) return ran
    const now = Date.now()
    // Decided against the current wall (update's compare-and-swap), never a snapshot taken before the call ran.
    let changed = false
    const next_ = await update($, tiles, cur => {
      const out = applyOutcome(cur, op, failed, now)
      changed = out !== cur
      return out
    })
    if (!changed) return ran
    wall = next_
    await update($, totals, t => (failed ? { ...t, cracks: t.cracks + 1 } : { ...t, repaired: t.repaired + 1 }))
    settled = false
    startClock($)
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, tiles)
    const isOn = await read($, band)
    if (!isOn || list.length === 0) {
      if (bandSite !== null && bandSite.requestId === e.requestId) bandSite = null
      return next(e)
    }
    const t = await read($, totals)
    // One row here: the mods beneath get the rest of the band.
    const below = await next({ ...e, props: { ...e.props, maxRows: Math.max(0, e.props.maxRows - 1) } })
    const { Box, Text } = $.ui.resolve(e)
    if (e.surface !== 'terminal') {
      return (
        <Box flexDirection="column">
          <Text>◈ kintsugi: {statsLine(sessionStats(list, t))}</Text>
          {below}
        </Box>
      )
    }
    const { Raster } = $.ui.resolve(e)
    const columns = Math.max(20, Math.min(512, e.props.bodyColumns))
    bandSite = { requestId: e.requestId, columns }
    const cells = bandCells(list, columns, { now: Date.now(), frame }, sessionStats(list, t)).encode()
    return (
      <Box flexDirection="column">
        <Raster key={BAND_KEY} columns={columns} rows={1} cells={cells} />
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, tiles)
    const s = sessionStats(list, await read($, totals))
    const { Box, Text } = $.ui.resolve(e)
    if (list.length === 0) {
      paneSite = null
      return (
        <Box flexDirection="column">
          <Text bold>Kintsugi</Text>
          <Text dimColor>Nothing has broken yet. When an operation fails its tile cracks; the run that fixes it mends the crack in gold.</Text>
        </Box>
      )
    }
    const broken = list.filter(t => t.state === 'cracked').map(t => t.label)
    if (e.surface !== 'terminal') {
      paneSite = null
      return (
        <Box flexDirection="column">
          <Text bold>Kintsugi</Text>
          <Text>{statsLine(s)}</Text>
          {list.map(t => (
            <Text key={t.key}>
              {t.state === 'gold' ? '◆ mended' : '× broken'} · {t.label} · failed {t.fails}×
            </Text>
          ))}
        </Box>
      )
    }
    const { Raster } = $.ui.resolve(e)
    // The pane's own body, less the header and the legend lines: never the whole terminal.
    const bodyRows = e.props.scroll?.bodyRows ?? Math.floor((e.viewport?.rows ?? 40) / 3)
    const maxRows = Math.max(TILE_MIN_ROWS, bodyRows - 4)
    const layout = wallLayout(list.length, e.props.bodyColumns, maxRows)
    paneSite = { requestId: e.requestId, layout, maxRows }
    const cells = wallCells(list, layout, { now: Date.now(), frame }).encode()
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">
          ◈ KINTSUGI · {statsLine(s)}
        </Text>
        <Raster key={WALL_KEY} columns={layout.columns} rows={layout.rows} cells={cells} />
        {layout.shown < list.length && <Text dimColor>{list.length - layout.shown} older tiles not shown.</Text>}
        <Text dimColor>
          Lacquer tile = an operation that failed. White cracks: still broken. Gold seams: a later run fixed it. × failures ◆ repairs.
        </Text>
        {broken.length > 0 && <Text color="red">still broken: {broken.slice(0, 8).join(' · ')}</Text>}
      </Box>
    )
  })
}

