/** One operation's tile on the wall. It exists from the operation's first failure on. */
export type Tile = {
  key: string
  label: string
  tool: string
  fails: number
  repairs: number
  state: 'cracked' | 'gold'
  seed: number
  crackedAt: number
  repairedAt: number
  lastAt: number
}

/** One finished session, as the lifetime gallery keeps it. */
export type Exhibit = { at: number; cracks: number; repaired: number; broken: number; worst: string }

declare module 'claude-code' {
  interface PluginState {
    'fault-lacquer': {
      tiles: Tile[]
      band: boolean
      // Every crack and repair this session, kept apart from the bounded wall (which drops old tiles).
      totals: { cracks: number; repaired: number }
    }
  }
}
