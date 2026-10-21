import type { ModelUsage } from 'claude-code'

import type { Span, Tokens } from '../types'

// US dollars per million tokens: input, output, cache read, cache write.
// First-party API list prices; Claude Code on a subscription is billed otherwise,
// so treat every cost here as an API-equivalent estimate.
type Price = [number, number, number, number]
const PRICES: [RegExp, Price][] = [
  [/fable-5-1|mythos-5-1/, [10, 50, 0.25, 12.5]],
  [/fable|mythos/, [10, 50, 1, 12.5]],
  [/opus-5-5/, [4, 20, 0.2, 5]],
  [/opus-(5|4-[5-9])/, [5, 25, 0.5, 6.25]],
  [/opus/, [15, 75, 1.5, 18.75]],
  [/sonnet-5/, [2, 10, 0.2, 2.5]],
  [/sonnet/, [3, 15, 0.3, 3.75]],
  [/haiku-5/, [0.1, 0.5, 0.01, 0.125]],
  [/haiku/, [1, 5, 0.1, 1.25]],
]

export function costOf(model: string, u: ModelUsage): number {
  const [i, o, r, w] = PRICES.find(([re]) => re.test(model))?.[1] ?? [3, 15, 0.3, 3.75]

  return (
    (u.input_tokens * i +
      u.output_tokens * o +
      u.cache_read_input_tokens * r +
      u.cache_creation_input_tokens * w) /
    1e6
  )
}

/** `claude-opus-5-5` → `Opus 5.5`, `claude-sonnet-4-5-20250929` → `Sonnet 4.5`. */
export function modelLabel(model: string): string {
  const m = /(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?=-|\[|$)/.exec(model)
  if (!m) return model.replace(/^claude-/, '')
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1)

  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`
}

export function firstLine(text: string | undefined, max = 200): string | undefined {
  const line = text?.split('\n').find(l => l.trim() !== '')?.trim()
  if (!line) return undefined

  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

/** A tool's error as one plain line: the engine's `<tool_use_error>` wrapper and other tags dropped. */
export function errorLine(text: string | undefined, max = 200): string | undefined {
  const plain = text
    ?.replace(/<\/?[a-z_][\w-]*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return firstLine(plain, max)
}

/** `mcp__github__create_issue` → `github · create_issue`. */
export function toolName(tool: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)

  return m ? `${m[1]} · ${m[2]}` : tool
}

const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p

/** The few muted words after a tool's name: its file, command or query. */
export function toolDetail(input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  const path = s('file_path') ?? s('notebook_path') ?? s('path')
  const text =
    s('description') ??
    s('command') ??
    s('query') ??
    s('pattern') ??
    s('url') ??
    (path ? basename(path) : undefined) ??
    s('prompt') ??
    Object.values(input).find((v): v is string => typeof v === 'string')

  return firstLine(text, 60) ?? ''
}

/** The tool's input as one short line, for the details. */
export function toolInput(input: Record<string, unknown>): string | undefined {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)

  return firstLine(
    s('command') ?? s('file_path') ?? s('query') ?? s('pattern') ?? s('url') ?? s('prompt') ?? JSON.stringify(input),
  )
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 120_000) return `${Math.round(ms / 1000)}s`

  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

export const NO_TOKENS: Tokens = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return {
    uncached: a.uncached + b.uncached,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
  }
}

export const inputOf = (t: Tokens) => t.uncached + t.cacheRead + t.cacheWrite

/** Whole-number percent of `part` in `whole`; 0 of nothing. */
export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

/** The colours of the input split, by how the cache served it. */
export const TOKEN_COLORS = {
  cacheRead: '#4FB286',
  cacheWrite: '#E0A43B',
  uncached: '#8A8A93',
} as const

export function fmtCost(c: number): string {
  return c < 0.01 ? `$${c.toFixed(3)}` : `$${c.toFixed(2)}`
}

export function fmtTokens(t: number): string {
  if (t >= 1e6) return `${(t / 1e6).toFixed(1)}M`
  if (t >= 1000) return `${(t / 1000).toFixed(1)}k`

  return String(Math.round(t))
}

/** The axis: the run's length rounded up to a round range, and its tick step, in seconds. */
const RANGES: [number, number][] = [
  [10, 2], [15, 5], [20, 5], [30, 10], [40, 10], [60, 15], [90, 30], [120, 30],
  [180, 60], [300, 60], [600, 120], [900, 300], [1800, 300], [3600, 900],
]

export function axisRange(elapsedMs: number): [number, number] {
  const need = (elapsedMs / 1000) * 1.04

  return RANGES.find(([r]) => r >= need) ?? [Math.ceil(need / 3600) * 3600, 1800]
}

export function tickLabel(s: number): string {
  return s >= 60 && s % 60 === 0 ? `${s / 60}m` : `${s}s`
}

export const COLORS = {
  agent: '#888780',
  subagent: '#888780',
  llm: '#7F77DD',
  tool: '#3E9FC8',
  compact: '#D9A23B',
  failed: '#E24B4A',
} as const

export function colorOf(span: Span): string {
  return span.status === 'failed' ? COLORS.failed : COLORS[span.kind]
}

/** One stretch of a track, as a fraction of its width: a gap, a call's bar, or an agent's line. */
export type Piece = { width: number; color?: string; isLine?: boolean }

/**
 * One row's track, left to right. Calls and compactions are a solid bar;
 * agents a thin line; a folded parent carries its descendants' calls as bars
 * on its line.
 * Widths are fractions, so the surface lays them out to the exact pixel.
 */
export function track(
  span: Span,
  end: number,
  origin: number,
  rangeMs: number,
  cells: number,
  marks: { start: number; end: number; color: string }[] = [],
): Piece[] {
  const at = (t: number) => Math.min(1, Math.max(0, (t - origin) / rangeMs))
  const minWidth = 1 / Math.max(1, cells)
  const from = Math.min(1 - minWidth, at(span.start))
  const to = Math.min(1, Math.max(from + minWidth, at(end)))
  const pieces: Piece[] = from > 0 ? [{ width: from }] : []

  if (span.kind === 'llm' || span.kind === 'tool' || span.kind === 'compact') {
    return [...pieces, { width: to - from, color: colorOf(span) }]
  }

  let x = from
  for (const m of [...marks].sort((a, b) => a.start - b.start)) {
    const a = Math.max(x, at(m.start))
    const b = Math.min(to, Math.max(a + minWidth, at(m.end)))
    if (b <= x) continue
    if (a > x) pieces.push({ width: a - x, color: colorOf(span), isLine: true })
    pieces.push({ width: b - a, color: m.color })
    x = b
  }
  if (to > x) pieces.push({ width: to - x, color: colorOf(span), isLine: true })

  return pieces
}

/** The axis: each tick's label at the start of its share of the width. */
export function ticks(rangeS: number, stepS: number): { label: string; width: number }[] {
  const out: { label: string; width: number }[] = []
  for (let s = 0; s < rangeS; s += stepS) out.push({ label: tickLabel(s), width: Math.min(stepS, rangeS - s) / rangeS })

  return out
}

export function clip(text: string, max: number): string {
  if (max <= 0) return ''

  return text.length > max ? text.slice(0, Math.max(0, max - 1)) + '…' : text
}

/**
 * Whole-number percentages for a row of widths (a surface takes no fraction
 * of a percent), rounded on the running total so they still add up; anything
 * colored keeps at least 1%.
 */
export function percents<T extends { width: number; color?: string }>(pieces: T[]): (T & { share: string })[] {
  let total = 0
  let laid = 0

  return pieces.map(p => {
    total += p.width * 100
    const share = Math.max(p.color ? 1 : 0, Math.round(total) - laid)
    laid += share

    return { ...p, share: `${share}%` }
  })
}
