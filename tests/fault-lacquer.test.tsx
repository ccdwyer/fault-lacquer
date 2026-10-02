import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Tile } from '../types'
import {
  GOLD_MS,
  MAX_TILES,
  SHIMMER_MS,
  TILE_COLUMNS,
  TILE_ROWS,
  applyOutcome,
  bandCells,
  base64,
  crackPaths,
  isAnimating,
  isInterruption,
  normalizeCommand,
  opOf,
  rasterize,
  statsLine,
  statsOf,
  wallCells,
  wallLayout,
} from '../hooks/lacquer'

const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} }
const PANE = { title: 'Kintsugi', isFocused: true, bodyColumns: 120, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

type Run = Parameters<Engine['command']['run']>[0]
const kintsugi = (args: string) => ({ command: 'kintsugi', args }) as Run

/** A shell where `npm test` fails until `fixed` is set, and anything named `interrupt` is cut short. */
function shell(on: On, state: { fixed: boolean }) {
  on('tool.call', (_$, e) => {
    const call = e as { tool: string; command?: string }
    if (call.tool === 'Bash' && call.command?.includes('interrupt')) return { isError: true as const, result: 'x', text: '[Request interrupted by user]' }
    if (call.tool === 'Bash' && call.command?.includes('npm test') && !state.fixed) return { isError: true as const, result: '1 failing', text: '1 failing' }
    return { result: { stdout: 'ok', stderr: '' } }
  })
}

function surfaces(on: On) {
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>OTHER MOD</Text>
  })
}

const op = (key: string) => ({ key, label: key, tool: 'Bash' })

function codesOf(cells: string): number[] {
  const bytes = Uint8Array.from(atob(cells), c => c.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  const out: number[] = []
  for (let i = 0; i < bytes.length; i += 4) out.push(view.getUint32(i, true))
  return out
}

describe('operations', () => {
  test('commands are keyed without cd prefixes, env assignments or extra spaces', async () => {
    expect(normalizeCommand('cd app &&  CI=1 FOO="a b"   npm   test')).toBe('npm test')
    expect(normalizeCommand("cd 'my dir'; cd x && pytest -q")).toBe('pytest -q')
  })

  test('tool calls map to tiles by command, file, URL or MCP server', async () => {
    expect(opOf({ tool: 'Bash', command: 'npm test' })?.key).toBe('Bash:npm test')
    expect(opOf({ tool: 'Edit', file_path: '/repo/src/cart.ts' })).toEqual({ key: 'Edit:/repo/src/cart.ts', label: 'Edit cart.ts', tool: 'Edit' })
    expect(opOf({ tool: 'WebFetch', url: 'https://x.dev/a', prompt: 'summarize' })?.key).toBe('WebFetch:[["url","https://x.dev/a"]]')
    // A retried fetch with a different prompt is the same fetch; another URL is not.
    expect(opOf({ tool: 'WebFetch', url: 'https://x.dev/a', prompt: 'other' })?.key).toBe(opOf({ tool: 'WebFetch', url: 'https://x.dev/a' })?.key)
    // MCP calls are told apart by their arguments: issue 1 and issue 2 are different tiles.
    expect(opOf({ tool: 'mcp__github__get_issue', issue_number: 1 })?.key).not.toBe(opOf({ tool: 'mcp__github__get_issue', issue_number: 2 })?.key)
    // Different directories are different operations.
    expect(opOf({ tool: 'Bash', command: 'cd web && npm test' })?.key).not.toBe(opOf({ tool: 'Bash', command: 'cd api && npm test' })?.key)
    expect(opOf({ tool: 'mcp__github__get_issue' })?.label).toMatch(/^github\/get_is/)
    expect(opOf({ tool: 'TodoWrite' })).toBeNull()
    expect(opOf({ tool: 'Bash', command: '   ' })).toBeNull()
  })

  test('interruptions are not failures', async () => {
    expect(isInterruption('[Request interrupted by user]')).toBe(true)
    expect(isInterruption('The user doesn\'t want to proceed with this tool use')).toBe(true)
    expect(isInterruption('Error: 2 tests failed')).toBe(false)
    // A real failure whose log merely mentions an interruption still cracks.
    expect(isInterruption('AssertionError: expected interrupted to be false\n  at test (a.test.ts:3)\n' + 'x'.repeat(400))).toBe(false)
  })
})

describe('the wall', () => {
  test('a failure cracks a tile, a later success mends it in gold, and a new failure cracks it again', async () => {
    const empty: Tile[] = []
    expect(applyOutcome(empty, op('npm test'), false, 1)).toBe(empty)
    const one = applyOutcome(empty, op('npm test'), true, 10)
    expect(one).toHaveLength(1)
    expect(one[0]).toMatchObject({ state: 'cracked', fails: 1, repairs: 0, crackedAt: 10 })
    const two = applyOutcome(one, op('npm test'), true, 20)
    expect(two[0]).toMatchObject({ state: 'cracked', fails: 2 })
    const mended = applyOutcome(two, op('npm test'), false, 30)
    expect(mended[0]).toMatchObject({ state: 'gold', repairs: 1, repairedAt: 30 })
    expect(applyOutcome(mended, op('npm test'), false, 40)).toBe(mended)
    const again = applyOutcome(mended, op('npm test'), true, 50)
    expect(again[0]).toMatchObject({ state: 'cracked', fails: 3, repairs: 1 })
    expect(statsLine(statsOf(again))).toBe('3 cracks · 0 repaired in gold · 1 still broken')
  })

  test('the wall stays bounded, letting mended tiles go before broken ones', async () => {
    let wall: Tile[] = applyOutcome([], op('first-gold'), true, 1)
    wall = applyOutcome(wall, op('first-gold'), false, 2)
    for (let i = 0; i < MAX_TILES; i += 1) wall = applyOutcome(wall, op(`broken-${i}`), true, 10 + i)
    expect(wall).toHaveLength(MAX_TILES)
    expect(wall.some(t => t.key === 'first-gold')).toBe(false)
    expect(wall.every(t => t.state === 'cracked')).toBe(true)
  })

  test('animation runs only while a crack grows or gold sweeps and shimmers', async () => {
    const wall = applyOutcome(applyOutcome([], op('t'), true, 0), op('t'), false, 5000)
    expect(isAnimating(wall, 5000 + 100)).toBe(true)
    expect(isAnimating(wall, 5000 + GOLD_MS + SHIMMER_MS + 1)).toBe(false)
  })
})

describe('drawing', () => {
  test('base64 matches the standard encoding', async () => {
    for (const n of [0, 1, 2, 3, 4, 5]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) & 255)
      expect(base64(bytes)).toBe(btoa(String.fromCharCode(...bytes)))
    }
  })

  test('cracks are deterministic, stay inside the tile, and rasterize without gaps', async () => {
    const w = TILE_COLUMNS * 2
    const hgt = (TILE_ROWS - 1) * 4
    const a = crackPaths(1234, 2, w, hgt)
    expect(crackPaths(1234, 2, w, hgt)).toEqual(a)
    expect(a.length).toBeGreaterThanOrEqual(6)
    for (const path of a) {
      const dots = rasterize(path)
      for (let i = 0; i < dots.length; i += 1) {
        const d = dots[i]!
        expect(d.x >= 0 && d.y >= 0 && d.x < w && d.y < hgt).toBe(true)
        if (i > 0) {
          const p = dots[i - 1]!
          expect(Math.abs(d.x - p.x) <= 1 && Math.abs(d.y - p.y) <= 1).toBe(true)
        }
      }
    }
  })

  test('a broken tile shows white braille cracks; a mended one shows gold seams at rest', async () => {
    const broken = applyOutcome([], op('npm test'), true, 0)
    const layout = wallLayout(1, 40, 40)
    const at = { now: 100_000, frame: 0 }
    const crackCells = codesOf(wallCells(broken, layout, at).encode())
    const braille = (codes: number[]) => codes.filter((_, i) => i % 3 === 0 && codes[i]! >= 0x2801 && codes[i]! <= 0x28ff).length
    expect(braille(crackCells)).toBeGreaterThan(3)
    const crackFg = crackCells.filter((v, i) => i % 3 === 1 && v === 0xb9b4a6).length
    expect(crackFg).toBeGreaterThan(0)
    const mended = applyOutcome(broken, op('npm test'), false, 1)
    const goldCells = codesOf(wallCells(mended, layout, at).encode())
    expect(goldCells.filter((v, i) => i % 3 === 1 && v === 0xffcc4d).length).toBeGreaterThan(0)
  })

  test('the band shows a mini-tile per tile and the tally', async () => {
    const wall = applyOutcome(applyOutcome([], op('a'), true, 0), op('b'), true, 0)
    const codes = codesOf(bandCells(wall, 80, { now: 100_000, frame: 0 }).encode())
    const text = codes.filter((_, i) => i % 3 === 0).map(c => String.fromCharCode(c)).join('')
    expect(text).toMatch(/2 cracks · 0 repaired in gold · 2 still broken/)
  })
})

describe('hooks', () => {
  test('a failing command cracks a tile; the run that passes mends it; the band stacks above other mods', async ($, on) => {
    const state = { fixed: false }
    shell(on, state)
    surfaces(on)
    const quiet = await $.ui.mount({ plugin: 'fault-lacquer', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await quiet.find({ type: 'Raster' })).toBeUndefined()
    await quiet.unmount()
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await $.tool.call({ tool: 'Bash', command: 'cd app && npm test' })
    const band = await $.ui.mount({ plugin: 'fault-lacquer', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Raster', key: 'strip' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'OTHER MOD' })).toBeDefined()
    await band.unmount()
    state.fixed = true
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    const desk = await $.ui.mount({ plugin: 'fault-lacquer', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    // `npm test` and `cd app && npm test` are different operations: only the first was mended.
    expect(await desk.find({ type: 'Text', text: /2 cracks · 1 repaired in gold · 1 still broken/ })).toBeDefined()
    await desk.unmount()
  })

  test('a backgrounded or timed-out run does not mend a crack, and a fetch with an HTTP error cracks', async ($, on) => {
    let n = 0
    on('tool.call', (_$, e) => {
      const call = e as { tool: string; command?: string }
      if (call.tool === 'WebFetch') return { result: { code: 404, codeText: 'Not Found', result: '', bytes: 0, durationMs: 1, url: 'https://x.dev' } }
      n += 1
      // Fails first; then comes back moved to the background, not finished.
      return n === 1 ? { isError: true as const, result: '1 failing', text: '1 failing' } : { result: { stdout: '', stderr: '', backgroundTaskId: 'b1' } }
    })
    surfaces(on)
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await $.tool.call({ tool: 'WebFetch', url: 'https://x.dev', prompt: 'p' } as never)
    const ran = await $.command.run(kintsugi(''))
    expect(String(ran.text)).toMatch(/2 cracks · 0 repaired in gold · 2 still broken/)
  })

  test('successes alone, interruptions and refusals leave the wall empty', async ($, on) => {
    on('tool.call', { tool: 'Bash' }, (_$, e) => {
      const call = e as { command?: string }
      if (call.command === 'refuse') return { deny: 'no' }
      if (call.command === 'interrupt') return { isError: true as const, result: 'x', text: '[Request interrupted by user]' }
      return { result: { stdout: 'ok', stderr: '' } }
    })
    surfaces(on)
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await $.tool.call({ tool: 'Bash', command: 'interrupt' })
    await $.tool.call({ tool: 'Bash', command: 'refuse' })
    const ran = await $.command.run(kintsugi(''))
    expect(String(ran.text)).toMatch(/nothing has broken yet/)
  })

  test('/kintsugi opens the wall pane; band off hides the band; clear empties the wall', async ($, on) => {
    const state = { fixed: false }
    shell(on, state)
    surfaces(on)
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/cart.ts', old_string: 'a', new_string: 'b' })
    const ran = await $.command.run(kintsugi(''))
    expect(String(ran.text)).toMatch(/1 crack · 0 repaired in gold · 1 still broken/)
    const pane = await $.ui.mount({ plugin: 'fault-lacquer', surface: 'terminal', component: 'Pane', requestId: 'fault-lacquer', props: PANE })
    expect(await pane.find({ type: 'Raster', key: 'wall' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /still broken: npm test/ })).toBeDefined()
    await pane.unmount()
    const desk = await $.ui.mount({ plugin: 'fault-lacquer', surface: 'desktop', component: 'Pane', requestId: 'fault-lacquer', props: PANE })
    expect(await desk.find({ type: 'Text', text: /× broken · npm test · failed 1×/ })).toBeDefined()
    await desk.unmount()
    await $.command.run(kintsugi('band off'))
    const band = await $.ui.mount({ plugin: 'fault-lacquer', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Raster' })).toBeUndefined()
    await band.unmount()
    await $.command.run(kintsugi('clear'))
    expect(String((await $.command.run(kintsugi(''))).text)).toMatch(/nothing has broken yet/)
  })
})
