/** `compact` is a compaction of the conversation: the engine's summarizing call. */
export type SpanKind = 'agent' | 'subagent' | 'llm' | 'tool' | 'compact'
export type SpanStatus = 'running' | 'done' | 'failed'

/** A call's tokens: input by how the prompt cache served it, output as the API counts it. */
export type Tokens = {
  uncached: number
  cacheRead: number
  cacheWrite: number
  output: number
}

/** One step of a run. Times are epoch ms; cost and tokens are the span's own. */
export type Span = {
  id: string
  parentId: string | null
  name: string
  detail: string
  kind: SpanKind
  status: SpanStatus
  start: number
  end?: number
  /** The subagent's loop id, on a subagent span once it has spawned. */
  agentId?: string
  /** A subagent whose tool call returned while it still ran: it ends at its own turn.complete. */
  isBackground?: boolean
  /** Absent on spans recorded before tokens were split. */
  tokens?: Tokens
  /** An LLM call's first streamed chunk, and its first visible text or tool call. */
  firstByte?: number
  firstText?: number
  cost: number
  input?: string
  output?: string
  error?: string
}

/** One main-loop turn and everything it started. */
export type Run = {
  id: string
  /** Its place in the history: 1 for the first turn since the last reset. */
  n: number
  prompt: string
  startedAt: number
  status: SpanStatus
  spans: Span[]
  /** Folded once already, as the turn after it went live: never folded again by itself. */
  wasFolded?: boolean
  /** A compaction between turns (`/compact`), drawn as a card of its own. */
  isCompaction?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'trace-waterfall': {
      /** Every turn since the last reset, newest first. */
      runs: Run[]
      now: number
      /** Folded spans, as `<run id>:<span id>`. */
      collapsed: string[]
      /** The span whose details are open, as `<run id>:<span id>`. */
      openId: string | null
    }
  }
}
