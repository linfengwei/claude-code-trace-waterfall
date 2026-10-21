import type { Span, SpanStatus } from '../types'
import { COLORS, fmtCost, fmtDuration, tickLabel } from './model'

/** One visible row of the waterfall, already folded and ordered. */
export type SvgRow = {
  span: Span
  depth: number
  end: number
  hasKids: boolean
  isFolded: boolean
  isSlowest: boolean
  cost: number
  marks: { start: number; end: number; kind: Span['kind']; status: SpanStatus }[]
  /** An LLM call's first byte back: before it the bar is drawn pale, as waiting. */
  firstByte?: number
  /** The row's details, shown over the card while the pointer is on the row. */
  tip?: { title: string; lines: [label: string, value: string, isError?: boolean][] }
}

/** One figure: its value, an optional line under it, and an optional split bar. */
export type Stat = {
  label: string
  value: string
  sub?: string
  subColor?: string
  split?: { part: number; color: string }[]
  isAlert?: boolean
}

export type SvgModel = {
  /** The pane's width in CSS px, as near as the surface lets us know it. */
  width: number
  /** The card's name, as `Turn 3 · 14:02`. */
  title: string
  prompt: string
  status: SpanStatus
  origin: number
  now: number
  rangeS: number
  stepS: number
  stats: Stat[]
  rows: SvgRow[]
  /** Spans left out to keep the picture under the surface's size limit. */
  hidden?: number
  /**
   * The pane's row height in CSS px, where a button is laid over the root
   * row: the table drops to put that row's middle on a row's middle.
   */
  rowPx?: number
}

const PAD = 20
const HEADER_H = 52
const STAT_H = 86
const AXIS_H = 32
const ROW_H = 32
const LABEL_ROOM = 96
// Each card is laid out this much wider than the pane and drawn back down to
// fit, so every size below shows at this fraction: compact on a 1x screen.
const ZOOM = 0.82
// The narrowest a stat may be before the stats wrap to a second row.
const STAT_MIN_W = 96
// The least room a summary row's prompt keeps before the extra columns are dropped.
const PROMPT_MIN_W = 220
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`
// How long a running bar keeps growing on its own between two redraws.
const GROW_S = 30
// The hover card: its width, its line height, the cells a row's name is cut into
// across and down (the cell under the pointer places the card's corner there),
// the card's gap from the pointer, and the most lines a value wraps to.
const TIP_W = 340
const TIP_LINE = 17
const CELLS_ACROSS = 24
const CELLS_DOWN = 2
const TIP_GAP = 6
const TIP_VALUE_LINES = 3
// The most an Svg's source may hold (SvgProps.source), and the room the hover layer's style takes.
const SVG_LIMIT = 131072
const STYLE_ROOM = 16384

const STYLE = `
  .card{fill:#1e1e21;stroke:#2f2f34}
  .rule{stroke:#2f2f34}
  .grid{stroke:#2a2a2f}
  .t{fill:#ececee}
  .s{fill:#a0a0a6}
  .m{fill:#6e6e75}
  .tile{fill:#26262a;stroke:#38383e}
  .chev{stroke:#7a7a80}
  .agentbar{fill:#ffffff;fill-opacity:.05;stroke:#3c3c43}
  .live{fill:#1c2a4a}.livet{fill:#86aaff}
  .done{fill:#16301f}.donet{fill:#6fcf8f}
  .fail{fill:#3a1d1d}.failt{fill:#f08a89}
  .slowt{fill:#f0b55a}
  .pulse{animation:pulse 1.2s ease-in-out infinite}
  @keyframes pulse{50%{opacity:.55}}
  @media (prefers-color-scheme: light){
    .card{fill:#ffffff;stroke:#e4e4e7}
    .rule{stroke:#e4e4e7}
    .grid{stroke:#efeff1}
    .t{fill:#18181b}.s{fill:#63636b}.m{fill:#9a9aa1}
    .tile{fill:#f6f6f7;stroke:#e1e1e4}
    .chev{stroke:#9a9aa1}
    .agentbar{fill:#000000;fill-opacity:.035;stroke:#d6d6da}
    .live{fill:#e8efff}.livet{fill:#2f62d6}
    .done{fill:#e6f6ea}.donet{fill:#1f7a3d}
    .fail{fill:#fdeaea}.failt{fill:#b42323}
    .slowt{fill:#94600c}
  }
`

const KIND = { llm: COLORS.llm, tool: COLORS.tool, compact: COLORS.compact, failed: COLORS.failed, now: '#5B8CFF', claude: '#D97757' }
// The slowest call's mark, before its name.
const TURTLE = '🐢'

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The text in lines of at most `maxPx`, `maxLines` at most, the last cut with an
 * ellipsis. A line breaks at its last space where one is near the end, else mid-word.
 */
function wrapTo(s: string, maxPx: number, size: number, maxLines: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const ch of s.replace(/\s+/g, ' ')) {
    if (textWidth(line + ch, size) > maxPx) {
      const cut = line.lastIndexOf(' ')
      const atSpace = cut > line.length * 0.6
      lines.push(atSpace ? line.slice(0, cut) : line)
      line = atSpace ? line.slice(cut + 1) : ''
      if (lines.length === maxLines) break
    }
    line += ch
  }
  if (lines.length < maxLines) {
    if (line) lines.push(line)
  } else {
    lines[maxLines - 1] = clipTo(lines[maxLines - 1]! + '……', maxPx, size)
  }

  return lines
}

/** A rough width in px: wide (CJK) glyphs are a full em, the rest a little over half. */
function textWidth(s: string, size: number): number {
  let w = 0
  for (const ch of s) w += ch.codePointAt(0)! >= 0x2e80 ? size : size * 0.58

  return w
}

function clipTo(s: string, maxPx: number, size: number): string {
  if (textWidth(s, size) <= maxPx) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxPx) break
    out += ch
  }

  return out + '…'
}

const callColor = (kind: Span['kind'], status: SpanStatus) =>
  status === 'failed' ? KIND.failed : kind === 'llm' ? KIND.llm : kind === 'compact' ? KIND.compact : KIND.tool

const r1 = (v: number) => Math.round(v * 10) / 10

/**
 * The figures, in equal columns between hairlines: label, value, the line
 * under it, and a thin bar of how the value splits.
 */
function tiles(stats: Stat[], W: number, y0: number, cols: number): string[] {
  const out: string[] = []
  const colW = (W - PAD * 2) / cols
  stats.forEach((s, i) => {
    const cx = r1(PAD + (i % cols) * colW)
    const top = y0 + Math.floor(i / cols) * STAT_H
    if (i % cols > 0) {
      out.push(`<line class="rule" x1="${cx - 12}" y1="${top + 12}" x2="${cx - 12}" y2="${top + STAT_H - 12}"/>`)
    }
    out.push(
      `<text x="${cx}" y="${top + 24}" font-size="11" letter-spacing="1" class="s">${esc(s.label)}</text>`,
      `<text x="${cx}" y="${top + 50}" font-size="22" style="font-variant-numeric:tabular-nums" ${s.isAlert ? `fill="${KIND.failed}"` : 'class="t"'}>${esc(s.value)}</text>`,
    )
    if (s.sub) {
      out.push(
        `<text x="${cx}" y="${top + 67}" font-size="11.5" ${s.subColor ? `fill="${s.subColor}"` : 'class="s"'}>${esc(clipTo(s.sub, colW - 16, 11.5))}</text>`,
      )
    }
    const total = s.split?.reduce((a, p) => a + p.part, 0) ?? 0
    if (s.split && total > 0) {
      const barW = Math.max(24, colW - 30)
      let at = cx
      out.push(`<rect class="tile" x="${cx}" y="${top + 74}" width="${r1(barW)}" height="4" rx="2" stroke="none"/>`)
      for (const p of s.split) {
        const w = (p.part / total) * barW
        if (w >= 0.5) out.push(`<rect x="${r1(at)}" y="${top + 74}" width="${r1(w)}" height="4" fill="${p.color}"/>`)
        at += w
      }
    }
  })

  return out
}

/** One turn in the summary's table. */
export type SummaryRow = {
  /** `#3` for a turn, `—` for a compaction between turns. */
  label: string
  time: string
  prompt: string
  status: SpanStatus
  duration: string
  cost: string
  input: string
  cached: string
  output: string
  ttft: string
  tps: string
}

/** Every turn at a glance: the totals, then one line per turn, newest first. */
export function summarySvg(m: { width: number; stats: Stat[]; rows: SummaryRow[] }): { source: string; height: number } {
  const W = Math.max(320, Math.round(m.width / ZOOM))
  const cols = statColumns(W, m.stats.length)
  const statsH = Math.ceil(m.stats.length / cols) * STAT_H + 12
  const headY = HEADER_H + statsH
  const rowsY = headY + 30
  const height = rowsY + m.rows.length * 28 + 14
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 ${W} ${height}" font-family="${FONT}">`,
    `<style>${STYLE}</style>`,
    `<rect class="card" x="0.5" y="0.5" width="${W - 1}" height="${height - 1}" rx="14"/>`,
    `<text x="${PAD}" y="32" font-size="16" fill="${KIND.now}">✦</text>`,
    `<text x="${PAD + 22}" y="32" font-size="15" font-weight="600" class="t">All turns</text>`,
    `<text x="${W - PAD}" y="32" font-size="13" text-anchor="end" class="m">${m.rows.length === 1 ? '1 turn' : `${m.rows.length} turns`} · newest first</text>`,
    `<line class="rule" x1="0" y1="${HEADER_H}" x2="${W}" y2="${HEADER_H}"/>`,
    ...tiles(m.stats, W, HEADER_H + 6, cols),
    `<line class="rule" x1="0" y1="${headY}" x2="${W}" y2="${headY}"/>`,
  ]

  // The columns, right to left from the edge; the prompt takes what is left,
  // and keeps the room for a readable line before the extra columns get any.
  type Column = { label: string; w: number; of: (r: SummaryRow) => string }
  const short: Column[] = [
    { label: 'COST', w: 60, of: r => r.cost },
    { label: 'TIME', w: 56, of: r => r.duration },
  ]
  const full: Column[] = [
    { label: 'TPS', w: 54, of: r => r.tps },
    { label: 'TTFT', w: 58, of: r => r.ttft },
    { label: 'OUTPUT', w: 66, of: r => r.output },
    { label: 'CACHED', w: 66, of: r => r.cached },
    { label: 'INPUT', w: 62, of: r => r.input },
    { label: 'COST', w: 62, of: r => r.cost },
    { label: 'TIME', w: 58, of: r => r.duration },
  ]
  const promptX = PAD + 96
  const roomFor = (cs: Column[]) => W - PAD - cs.reduce((a, c) => a + c.w, 0) - promptX - 12
  const columns = roomFor(full) >= PROMPT_MIN_W ? full : short
  const right: number[] = []
  let edge = W - PAD
  for (const c of columns) {
    right.push(edge)
    edge -= c.w
  }
  const promptW = edge - promptX - 12
  out.push(
    `<text x="${PAD}" y="${headY + 20}" font-size="11" letter-spacing="1" class="s">TURN</text>`,
    `<text x="${promptX}" y="${headY + 20}" font-size="11" letter-spacing="1" class="s">PROMPT</text>`,
    ...columns.map((c, i) => `<text x="${right[i]}" y="${headY + 20}" font-size="11" letter-spacing="1" text-anchor="end" class="s">${c.label}</text>`),
  )
  m.rows.forEach((r, i) => {
    const y = rowsY + i * 28 + 18
    const dot = r.status === 'running' ? KIND.now : r.status === 'failed' ? KIND.failed : '#6fcf8f'
    out.push(
      `<line class="grid" x1="${PAD}" y1="${y - 18}" x2="${W - PAD}" y2="${y - 18}"/>`,
      `<circle cx="${PAD + 4}" cy="${y - 4.5}" r="3.5" fill="${dot}"${r.status === 'running' ? ' class="pulse"' : ''}/>`,
      `<text x="${PAD + 14}" y="${y}" font-size="13" class="t" style="font-variant-numeric:tabular-nums">${esc(r.label)}</text>`,
      `<text x="${PAD + 42}" y="${y}" font-size="11.5" class="m">${esc(r.time)}</text>`,
      `<text x="${promptX}" y="${y}" font-size="13" class="s">${esc(clipTo(r.prompt, promptW, 13))}</text>`,
      ...columns.map(
        (c, j) =>
          `<text x="${right[j]}" y="${y}" font-size="13" text-anchor="end" class="t" style="font-variant-numeric:tabular-nums">${esc(c.of(r))}</text>`,
      ),
    )
  })
  out.push('</svg>')

  return { source: out.join(''), height: Math.round(height * ZOOM) }
}

/** The stats in one row where each keeps its room, else in rows of three. */
function statColumns(W: number, n: number): number {
  return (W - PAD * 2) / n >= STAT_MIN_W ? n : Math.min(n, 3)
}

/**
 * The hover layer: each row's name cut into cells, and its card, hidden until
 * the pointer is on the name. The cell under the pointer puts the card's top left
 * corner there; by the right edge the card turns to the pointer's left, and
 * near the bottom it opens upward. Plain CSS (each cell is placed by its class),
 * since an interactive surface draws it and nothing runs.
 */
function hoverLayer(rows: SvgRow[], W: number, nameW: number, height: number, rowsY: number, budget: number): string[] {
  if (!rows.some(r => r.tip)) return []
  const cellW = nameW / CELLS_ACROSS
  const cellH = ROW_H / CELLS_DOWN
  const valueX = 96
  const valueW = TIP_W - valueX - 12
  const cells = Array.from({ length: CELLS_ACROSS * CELLS_DOWN }, (_, c) => {
    const x = (c % CELLS_ACROSS) * cellW
    const y = Math.floor(c / CELLS_ACROSS) * cellH
    // Where the pointer is, about: the cell's middle.
    const px = x + cellW / 2
    const tx = px + TIP_GAP + TIP_W <= W - PAD ? px + TIP_GAP : Math.max(PAD, px - TIP_GAP - TIP_W)
    return { x, y, tx, ty: y + cellH / 2 }
  })
  const out = [
    '<style>.tip{display:none;pointer-events:none}.hr:hover .tip{display:inline}',
    `.hr>[class^=c]{width:${r1(cellW + 0.5)}px;height:${r1(cellH + 0.5)}px;fill:transparent}`,
    // The band lights the whole row, but only the name's cells take the pointer.
    '.hl{pointer-events:none}.hr:hover .hl{fill-opacity:.05}.tipbox{fill:#2a2a2f;stroke:#45454d}',
    // A frame whose color scheme is not the page's is drawn opaque: follow the system's, as the page does by default.
    ':root{color-scheme:light dark}',
    ...cells.map((c, k) => `.c${k}{x:${r1(c.x)}px;y:${r1(c.y)}px}.c${k}:hover~.tip{transform:translate(${r1(c.tx)}px,${r1(c.ty)}px)}`),
    '</style>',
  ]
  const cellMarks = cells.map((_, k) => `<rect class="c${k}"/>`).join('')
  // The latest rows first, as far as the budget goes: a huge turn's last rows keep their cards.
  const parts: string[] = []
  let used = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (!row.tip) continue
    const y = rowsY + i * ROW_H
    const lines = row.tip.lines.flatMap(([label, value, isError]) =>
      wrapTo(value, valueW, 12, TIP_VALUE_LINES).map((text, j) => ({ label: j === 0 ? label : '', text, isError })),
    )
    const tipH = 40 + lines.length * TIP_LINE
    // The card's top against the pointer's height: below it, else above it, else as low as it fits.
    const top =
      y + ROW_H + TIP_GAP + tipH <= height - 4
        ? TIP_GAP
        : y - TIP_GAP - tipH >= 4
          ? -TIP_GAP - tipH
          : Math.max(4, height - 4 - tipH) - y - ROW_H / 2
    const part = [
      `<g class="hr" transform="translate(0 ${y})">`,
      `<rect class="hl" x="0" y="0" width="${W}" height="${ROW_H}" fill="#fff" fill-opacity="0"/>`,
      cellMarks,
      '<g class="tip">',
      `<rect class="tipbox" x="0" y="${r1(top)}" width="${TIP_W}" height="${tipH}" rx="8"/>`,
      `<text x="12" y="${r1(top + 22)}" font-size="13" font-weight="600" class="t">${esc(clipTo(row.tip.title, TIP_W - 24, 13))}</text>`,
      ...lines.map(
        (l, j) =>
          (l.label ? `<text x="12" y="${r1(top + 42 + j * TIP_LINE)}" font-size="12" class="s">${esc(l.label)}</text>` : '') +
          `<text x="${valueX}" y="${r1(top + 42 + j * TIP_LINE)}" font-size="12" ${l.isError ? `fill="${KIND.failed}"` : 'class="t"'}>${esc(l.text)}</text>`,
      ),
      '</g></g>',
    ].join('')
    if (used + part.length > budget) break
    used += part.length
    parts.unshift(part)
  }

  return [...out, ...parts]
}

/**
 * The waterfall at the pane's own width: the name column and the label room
 * keep their size, the track takes the rest. The markup is `width="100%"`
 * over a viewBox of that width over ZOOM, so it fills the slot even where the
 * width we were told is a little off.
 */
/**
 * A turn's card: the picture; the hover layer alone, to lay over the picture
 * as it is redrawn as a plain image; and the two in one (`withHover`), for a
 * card that no longer changes. `root` is the root row's band and its name
 * column, in CSS px from the picture's top left.
 */
export type WaterfallPicture = {
  source: string
  width: number
  height: number
  overlay?: string
  withHover?: string
  root: { top: number; height: number; width: number }
}

export function waterfallSvg(m: SvgModel): WaterfallPicture {
  const W = Math.max(320, Math.round(m.width / ZOOM))
  const isNarrow = W < 600
  const nameW = Math.round(Math.min(300, Math.max(160, W * (isNarrow ? 0.38 : 0.34))))
  const trackX = PAD + nameW + 12
  const trackR = W - PAD - LABEL_ROOM
  const trackW = Math.max(40, trackR - trackX)
  const rangeMs = m.rangeS * 1000
  const x = (t: number) => r1(trackX + Math.min(1, Math.max(0, (t - m.origin) / rangeMs)) * trackW)
  const growPx = (trackW / rangeMs) * GROW_S * 1000

  const statCols = statColumns(W, m.stats.length)
  const statRows = Math.ceil(m.stats.length / statCols)
  const statsH = statRows * STAT_H + 12
  const rootMid = (HEADER_H + statsH + AXIS_H + ROW_H / 2) * ZOOM
  const drop = m.rowPx ? ((Math.ceil(rootMid / m.rowPx - 0.5) + 0.5) * m.rowPx - rootMid) / ZOOM : 0
  const axisY = HEADER_H + statsH + drop
  const rowsY = axisY + AXIS_H
  const footY = rowsY + m.rows.length * ROW_H + 12
  const height = footY + 36
  const out: string[] = []

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 ${W} ${height}" font-family="${FONT}">`,
    `<style>${STYLE}</style>`,
    `<rect class="card" x="0.5" y="0.5" width="${W - 1}" height="${height - 1}" rx="14"/>`,
  )

  // The bar: sparkle, title, the run's prompt, and its state.
  const pill =
    m.status === 'running'
      ? { cls: 'live', text: '● Live' }
      : m.status === 'failed'
        ? { cls: 'fail', text: '✕ Failed' }
        : { cls: 'done', text: '✓ Done' }
  const pillW = textWidth(pill.text, 13) + 22
  const promptX = r1(PAD + 22 + textWidth(m.title, 15) + 14)
  out.push(
    `<text x="${PAD}" y="32" font-size="16" fill="${KIND.now}">✦</text>`,
    `<text x="${PAD + 22}" y="32" font-size="15" font-weight="600" class="t">${esc(m.title)}</text>`,
    `<text x="${promptX}" y="32" font-size="14" class="s">${esc(clipTo(m.prompt, W - PAD - promptX - pillW - 16, 14))}</text>`,
    `<rect class="${pill.cls}" x="${W - PAD - pillW}" y="14" width="${pillW}" height="26" rx="7"/>`,
    `<text x="${W - PAD - pillW / 2}" y="31.5" font-size="13" text-anchor="middle" class="${pill.cls}t">${pill.text}</text>`,
    `<line class="rule" x1="0" y1="${HEADER_H}" x2="${W}" y2="${HEADER_H}"/>`,
  )

  out.push(...tiles(m.stats, W, HEADER_H + 6, statCols))
  out.push(`<line class="rule" x1="0" y1="${axisY}" x2="${W}" y2="${axisY}"/>`)

  // The axis: ticks across the track, grid lines down through the rows.
  out.push(
    `<text x="${PAD + 12}" y="${axisY + 21}" font-size="11" letter-spacing="1" class="s">SPAN</text>`,
    `<line class="rule" x1="${trackX}" y1="${axisY}" x2="${trackX}" y2="${footY}"/>`,
    `<line class="rule" x1="0" y1="${rowsY}" x2="${W}" y2="${rowsY}"/>`,
  )
  const everyTick = trackW / (m.rangeS / m.stepS) < 44 ? 2 : 1
  for (let s = 0, k = 0; s <= m.rangeS; s += m.stepS, k++) {
    const gx = r1(trackX + (s / m.rangeS) * trackW)
    if (s > 0) out.push(`<line class="grid" x1="${gx}" y1="${axisY}" x2="${gx}" y2="${footY}"/>`)
    if (k % everyTick === 0 && s < m.rangeS) {
      out.push(`<text x="${gx + 6}" y="${axisY + 21}" font-size="12" class="m">${tickLabel(s)}</text>`)
    }
  }

  // The rows. The first one's name column is where a press folds it.
  m.rows.forEach((row, i) => {
    const { span } = row
    const y = rowsY + i * ROW_H
    const mid = y + ROW_H / 2
    const isAgent = span.kind === 'agent' || span.kind === 'subagent'
    const isRunning = span.status === 'running'
    const indent = PAD + 8 + row.depth * (isNarrow ? 12 : 18)

    if (row.hasKids) {
      const turn = row.isFolded ? ` transform="rotate(-90 ${indent + 4} ${mid})"` : ''
      out.push(
        `<path class="chev" d="M${indent} ${mid - 2} l4 4 l4 -4" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"${turn}/>`,
      )
    }
    const iconX = indent + 14
    if (isAgent) {
      out.push(
        `<rect class="tile" x="${iconX}" y="${mid - 11}" width="22" height="22" rx="6"/>`,
        `<text x="${iconX + 11}" y="${mid + 5}" font-size="14" text-anchor="middle" fill="${KIND.claude}">✳</text>`,
      )
    } else {
      out.push(`<rect x="${iconX + 6}" y="${mid - 5}" width="10" height="10" rx="3" fill="${callColor(span.kind, span.status)}"/>`)
    }

    // The slowest call wears a turtle ahead of its name.
    if (row.isSlowest) out.push(`<text x="${iconX + 30}" y="${mid + 5}" font-size="14">${TURTLE}</text>`)
    const nameX = iconX + 30 + (row.isSlowest ? 22 : 0)
    const room = trackX - 14 - nameX
    const name = clipTo(span.name, room, 14)
    const nameLen = textWidth(name, 14)
    const detailRoom = room - nameLen - 8
    const detail = detailRoom > 30 && span.detail ? clipTo(span.detail, detailRoom, 13) : ''
    out.push(`<text x="${nameX}" y="${mid + 5}" font-size="14" class="t"${isAgent ? ' font-weight="500"' : ''}>${esc(name)}</text>`)
    if (detail) out.push(`<text x="${r1(nameX + nameLen + 8)}" y="${mid + 5}" font-size="13" class="s">${esc(detail)}</text>`)

    // The bar; a running one keeps growing until the next redraw replaces it.
    const bx = x(span.start)
    const bw = r1(Math.max(3, x(row.end) - bx))
    const grownW = r1(Math.min(trackR - bx, bw + growPx))
    const grow = isRunning
      ? `<animate attributeName="width" from="${bw}" to="${Math.max(bw, grownW)}" dur="${GROW_S}s" fill="freeze"/>`
      : ''
    if (isAgent) {
      out.push(`<rect class="agentbar" x="${bx}" y="${mid - 8}" width="${bw}" height="16" rx="5">${grow}</rect>`)
      for (const mk of row.marks) {
        const mx = x(mk.start)
        out.push(`<rect x="${mx}" y="${mid - 2}" width="${r1(Math.max(2, x(mk.end) - mx))}" height="4" rx="2" fill="${callColor(mk.kind, mk.status)}"/>`)
      }
    } else {
      const c = callColor(span.kind, span.status)
      const isWaitable = span.kind === 'llm' && (row.firstByte !== undefined || isRunning)
      if (!isWaitable) {
        out.push(
          `<rect x="${bx}" y="${mid - 6}" width="${bw}" height="12" rx="3" fill="${c}" fill-opacity="${isRunning ? 1 : 0.85}"${isRunning ? ' class="pulse"' : ''}>${grow}</rect>`,
        )
      } else {
        // Pale while it waits for the first byte, solid from then on as it streams.
        out.push(`<rect x="${bx}" y="${mid - 6}" width="${bw}" height="12" rx="3" fill="${c}" fill-opacity=".3">${grow}</rect>`)
        if (row.firstByte !== undefined) {
          const sx = Math.min(bx + bw - 2, x(row.firstByte))
          const sw = r1(Math.max(2, bx + bw - sx))
          const streamGrow = isRunning
            ? `<animate attributeName="width" from="${sw}" to="${r1(Math.max(sw, sw + grownW - bw))}" dur="${GROW_S}s" fill="freeze"/>`
            : ''
          out.push(
            `<rect x="${r1(sx)}" y="${mid - 6}" width="${sw}" height="12" rx="3" fill="${c}" fill-opacity="${isRunning ? 1 : 0.9}"${isRunning ? ' class="pulse"' : ''}>${streamGrow}</rect>`,
          )
        }
      }
    }
    const label = `${fmtDuration(row.end - span.start)}${row.cost && !isNarrow ? ` · ${fmtCost(row.cost)}` : ''}`
    const lw = textWidth(label, 12) + (span.status === 'failed' ? 14 : 0)
    const after = bx + bw + 8
    const lx = after + lw <= W - PAD ? after : Math.max(trackX + 4, bx - 8 - lw)
    out.push(
      `<text x="${r1(lx)}" y="${mid + 4.5}" font-size="12" style="font-variant-numeric:tabular-nums" ${span.status === 'failed' ? `fill="${KIND.failed}"` : 'class="s"'}>${esc(label)}${span.status === 'failed' ? ' ✕' : ''}</text>`,
    )
  })

  // The "now" line while the run goes on, moving on with the bars.
  if (m.status === 'running') {
    const nx = x(m.now)
    const to = r1(Math.min(trackR, nx + growPx) - nx)
    const move = `<animateTransform attributeName="transform" type="translate" from="0 0" to="${to} 0" dur="${GROW_S}s" fill="freeze"/>`
    out.push(
      `<g>${move}`,
      `<line x1="${nx}" y1="${axisY + 4}" x2="${nx}" y2="${footY}" stroke="${KIND.now}" stroke-width="1.25"/>`,
      `<circle cx="${nx}" cy="${rowsY}" r="3.5" fill="${KIND.now}"/>`,
      '</g>',
    )
  }

  // The legend, left to right while it fits: compaction and the turtle only where the card has them.
  const ly = height - 14
  const hasCompaction = m.rows.some(r => r.span.kind === 'compact' || r.marks.some(mk => mk.kind === 'compact'))
  const keys: { label: string; swatch: (x: number) => string }[] = [
    { label: 'LLM call', swatch: x => `<rect x="${x}" y="${ly - 8}" width="14" height="8" rx="2" fill="${KIND.llm}"/>` },
    { label: 'Tool call', swatch: x => `<rect x="${x}" y="${ly - 8}" width="14" height="8" rx="2" fill="${KIND.tool}"/>` },
    { label: 'Agent', swatch: x => `<rect class="agentbar" x="${x}" y="${ly - 9}" width="14" height="10" rx="3"/>` },
    ...(hasCompaction
      ? [{ label: 'Compaction', swatch: (x: number) => `<rect x="${x}" y="${ly - 8}" width="14" height="8" rx="2" fill="${KIND.compact}"/>` }]
      : []),
    ...(m.rows.some(r => r.isSlowest)
      ? [{ label: 'Slowest call', swatch: (x: number) => `<text x="${x}" y="${ly + 1}" font-size="12">${TURTLE}</text>` }]
      : []),
    { label: 'Waiting for first byte', swatch: x => `<rect x="${x}" y="${ly - 8}" width="14" height="8" rx="2" fill="${KIND.llm}" fill-opacity=".3"/>` },
  ]
  const keyW = (k: (typeof keys)[number]) => 20 + textWidth(k.label, 12)
  const keysW = keys.reduce((a, k) => a + keyW(k) + 18, 0)
  // The cost note gives way to the legend; the note on spans left out does not.
  const costs = 'Costs are API list-price estimates'
  const note = m.hidden
    ? { text: `${m.hidden} earlier spans not drawn · fold a branch to see them`, cls: 'slowt' }
    : PAD + keysW + textWidth(costs, 12) + 16 <= W - PAD
      ? { text: costs, cls: 'm' }
      : undefined
  const noteW = note ? textWidth(note.text, 12) + 16 : 0
  out.push(`<line class="rule" x1="0" y1="${footY}" x2="${W}" y2="${footY}"/>`)
  let lx = PAD
  for (const k of keys) {
    const w = keyW(k)
    if (lx + w > W - PAD - noteW) break
    out.push(k.swatch(lx), `<text x="${r1(lx + 20)}" y="${ly}" font-size="12" class="s">${k.label}</text>`)
    lx += w + 18
  }
  if (note) out.push(`<text x="${W - PAD}" y="${ly}" font-size="12" text-anchor="end" class="${note.cls}">${note.text}</text>`)
  const picture = out.join('')
  // The name column, the waterfall's first, up to the track's edge.
  const nameEnd = trackX - 14
  const hover = hoverLayer(m.rows, W, nameEnd, height, rowsY, SVG_LIMIT - STYLE_ROOM)
  const inPicture = hoverLayer(m.rows, W, nameEnd, height, rowsY, SVG_LIMIT - STYLE_ROOM - picture.length)

  return {
    source: `${picture}</svg>`,
    width: Math.round(W * ZOOM),
    height: Math.round(height * ZOOM),
    overlay: hover.length
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 ${W} ${height}" font-family="${FONT}"><style>${STYLE}</style>${hover.join('')}</svg>`
      : undefined,
    withHover: inPicture.length ? `${picture}${inPicture.join('')}</svg>` : undefined,
    root: { top: rowsY * ZOOM, height: ROW_H * ZOOM, width: Math.round(nameEnd * ZOOM) },
  }
}
