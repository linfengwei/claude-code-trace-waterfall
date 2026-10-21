import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, SessionCompactTrigger, TurnStepResult } from 'claude-code'

import type { Run, Span, SpanStatus, Tokens } from '../types'
import {
  addTokens,
  axisRange,
  clip,
  colorOf,
  COLORS,
  costOf,
  errorLine,
  firstLine,
  fmtCost,
  fmtDuration,
  fmtTokens,
  inputOf,
  modelLabel,
  NO_TOKENS,
  pct,
  percents,
  toolDetail,
  toolInput,
  toolName,
  ticks,
  TOKEN_COLORS,
  track,
} from './model'
import { summarySvg, waterfallSvg } from './svg'
import type { Stat } from './svg'

const PANE = 'trace-waterfall'
const runs = atom({ plugin: 'trace-waterfall', key: 'runs' } as const, [])
const now = atom({ plugin: 'trace-waterfall', key: 'now' } as const, 0)
const collapsed = atom({ plugin: 'trace-waterfall', key: 'collapsed' } as const, [])
const openId = atom({ plugin: 'trace-waterfall', key: 'openId' } as const, null)

// The oldest turns drop off past this many.
const MAX_RUNS = 30

const isCall = (s: Span) => s.kind === 'llm' || s.kind === 'tool'
// What a folded row carries as marks on its line: its calls and its compactions.
const isMark = (s: Span) => isCall(s) || s.kind === 'compact'

// How a compaction's row names what started it.
const TRIGGERS: Record<SessionCompactTrigger, string> = {
  manual: '/compact',
  auto: 'auto',
  plugin: 'by a plugin',
  precompute: 'ahead of time',
}
// Tells apart two compactions begun in the same millisecond. Module-local, as `drawn`.
let compactions = 0
// The model each loop last called, by agent id (`main` for the main loop): a
// compaction's usage names none, and it runs on its loop's model.
const models = new Map<string, string>()

// A remote surface counts its width in its code font's advance: about this many px.
const PX_PER_COLUMN = 7.5
// The most an Svg's source may hold (SvgProps.source).
const SVG_LIMIT = 131072
// The tallest an Svg may be drawn, in CSS px (SvgProps.height).
const SVG_HEIGHT_LIMIT = 4096

/**
 * Finished turns' pictures, by run: a card that can no longer change is drawn
 * once per width and fold state, not on every tick. Module-local, so a reload
 * starts it afresh.
 */
const drawn = new Map<string, { key: string; picture: Picture }>()
type Picture = { source: string; height: number }

function withSpan(r: Run, span: Span): Run {
  return r.spans.some(s => s.id === span.id)
    ? { ...r, spans: r.spans.map(s => (s.id === span.id ? { ...s, ...span } : s)) }
    : { ...r, spans: [...r.spans, span] }
}

function editSpan(r: Run, id: string, fn: (s: Span) => Span): Run {
  return { ...r, spans: r.spans.map(s => (s.id === id ? fn(s) : s)) }
}

/** The span a loop's steps and calls hang under: its subagent's, else the root. */
function parentFor(r: Run, agentId: string | undefined): string {
  return (agentId && r.spans.find(s => s.agentId === agentId)?.id) || 'root'
}

/** Which run a loop's work belongs to: the one holding its subagent, else the newest. */
const byAgent = (agentId: string | undefined) => (list: Run[]) => {
  const i = agentId ? list.findIndex(r => r.spans.some(s => s.agentId === agentId)) : -1

  return i >= 0 ? i : 0
}
const bySpan = (id: string) => (list: Run[]) => list.findIndex(r => r.spans.some(s => s.id === id))
const byTurn = (turnId: string) => (list: Run[]) => list.findIndex(r => r.id === turnId)

const patch = ($: EngineInterface, at: (list: Run[]) => number, fn: (r: Run) => Run) =>
  update($, runs, list => {
    const i = at(list)

    return list[i] ? list.map((r, j) => (j === i ? fn(r) : r)) : list
  })

/**
 * Bookkeeping that must never break the call it watches: a failed state write
 * is dropped rather than thrown past the tool, model or agent it records.
 */
async function quietly(work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch {
    // The trace misses this update; the call goes on as if the mod were not there.
  }
}

/**
 * Closes the spans left open under `topId` as it ends, as interrupted: all but
 * a background subagent still running, and what runs under it.
 */
function closeOpen(r: Run, topId: string, end: number): Run {
  const byId = new Map(r.spans.map(s => [s.id, s]))
  const parentOf = (s: Span) => (s.parentId === null ? undefined : byId.get(s.parentId))
  const isUnder = (s: Span): boolean => {
    const parent = parentOf(s)

    return parent !== undefined && (parent.id === topId || isUnder(parent))
  }
  const isLive = (s: Span): boolean => {
    if (s.kind === 'subagent' && s.isBackground && s.status === 'running') return true
    const parent = parentOf(s)

    return parent !== undefined && parent.id !== topId && isLive(parent)
  }

  return {
    ...r,
    spans: r.spans.map(s =>
      s.status === 'running' && isUnder(s) && !isLive(s) ? finish(s, end, 'failed', { error: 'Interrupted' }) : s,
    ),
  }
}

function finish(s: Span, end: number, status: SpanStatus, more: Partial<Span> = {}): Span {
  return s.status === 'running' ? { ...s, ...more, status, end } : s
}

/** A model request's tokens, split by how the cache served its input. */
const tokensFrom = (u: ModelUsage): Tokens => ({
  uncached: u.input_tokens,
  cacheRead: u.cache_read_input_tokens,
  cacheWrite: u.cache_creation_input_tokens,
  output: u.output_tokens,
})

/** A span's own tokens; spans recorded before the split carry none. */
const tokensOf = (s: Span): Tokens => s.tokens ?? NO_TOKENS
const sumTokens = (spans: Span[]) => spans.reduce((a, s) => addTokens(a, tokensOf(s)), NO_TOKENS)

/** How fast a set of LLM calls answered: first byte and first text after the request, output per second of streaming. */
function speedOf(spans: Span[]) {
  const calls = spans.filter(s => s.kind === 'llm' && s.firstByte !== undefined)
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined)
  const streamed = calls.filter(s => s.end !== undefined)
  const seconds = streamed.reduce((a, s) => a + (s.end! - s.firstByte!) / 1000, 0)

  return {
    ttft: avg(calls.map(s => s.firstByte! - s.start)),
    firstText: avg(calls.filter(s => s.firstText !== undefined).map(s => s.firstText! - s.start)),
    tps: seconds > 0 ? streamed.reduce((a, s) => a + tokensOf(s).output, 0) / seconds : undefined,
  }
}

const orDash = (v: number | undefined, f: (v: number) => string) => (v === undefined ? '—' : f(v))

/** The token and speed figures: input by how the cache served it, output with its speed, then time to first byte. */
function tokenStats(t: Tokens, speed: ReturnType<typeof speedOf>): Stat[] {
  const input = inputOf(t)

  return [
    {
      label: 'INPUT',
      value: fmtTokens(input),
      sub: `${pct(t.cacheRead, input)}% cached`,
      subColor: TOKEN_COLORS.cacheRead,
      split: [
        { part: t.cacheRead, color: TOKEN_COLORS.cacheRead },
        { part: t.cacheWrite, color: TOKEN_COLORS.cacheWrite },
        { part: t.uncached, color: TOKEN_COLORS.uncached },
      ],
    },
    { label: 'OUTPUT', value: fmtTokens(t.output), sub: `${orDash(speed.tps, v => String(Math.round(v)))} tok/s` },
    {
      label: 'TTFT',
      value: orDash(speed.ttft, fmtDuration),
      sub: `first text ${orDash(speed.firstText, fmtDuration)}`,
    },
  ]
}

const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter(k => k !== key) : [...list, key])

function clockTime(t: number): string {
  const d = new Date(t)

  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'Trace' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'trace',
      description: 'Show the live trace of the current run in a pane',
    })
    if (e.surface !== 'terminal') void openPane($)

    // The clock that grows running bars: written only while something runs.
    $.clock.every(2000, () => {
      void (async () => {
        const list = await read($, runs)
        if (list.some(r => r.spans.some(s => s.status === 'running'))) {
          const t = await $.clock.now()
          await update($, now, () => t)
        }
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'trace' }, async $ => {
    await openPane($)

    return { text: 'Trace pane opened.' }
  })

  on('turn.start', async ($, e, next) => {
    const t = await $.clock.now()

    if (e.agentId === undefined) {
      const root: Span = {
        id: 'root',
        parentId: null,
        name: 'Claude',
        detail: '',
        kind: 'agent',
        status: 'running',
        start: t,
        tokens: NO_TOKENS,
        cost: 0,
        input: firstLine(e.text),
      }
      // A turn already over folds to one line as a new one goes live, once:
      // one the person opened again stays open.
      const over = (await read($, runs)).filter(r => r.status !== 'running' && !r.wasFolded).map(r => r.id)
      const kept = await update($, runs, list => [
        {
          id: e.turnId,
          n: (list[0]?.n ?? 0) + 1,
          prompt: firstLine(e.text, 120) ?? '(continued)',
          startedAt: t,
          status: 'running' as const,
          spans: [root],
        },
        ...list
          .filter(r => r.id !== e.turnId)
          .slice(0, MAX_RUNS - 1)
          .map(r => (over.includes(r.id) ? { ...r, wasFolded: true } : r)),
      ])
      // Fold state of turns that dropped off goes with them.
      const isKept = (key: string) => kept.some(r => key.startsWith(`${r.id}:`))
      await update($, collapsed, keys => [...new Set([...keys, ...over.map(id => `${id}:root`)])].filter(isKept))
      await update($, openId, key => (key && isKept(key) ? key : null))
      await update($, now, () => t)
    } else {
      const agentId = e.agentId
      await patch($, byAgent(agentId), r => {
        const sub = r.spans.find(s => s.agentId === agentId)

        return sub && sub.status !== 'running'
          ? editSpan(r, sub.id, s => ({ ...s, status: 'running', end: undefined }))
          : r
      })
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if ((await read($, runs)).length === 0) return yield* next(e)

    const id = `${e.agentId ?? 'main'}:${e.turnId}:${e.index}`
    models.set(e.agentId ?? 'main', e.model)
    const t0 = await $.clock.now()
    await patch($, byAgent(e.agentId), r => {
      const parentId = parentFor(r, e.agentId)
      const label = modelLabel(e.model)
      const withStep = withSpan(r, {
        id,
        parentId,
        name: 'LLM call',
        detail: label,
        kind: 'llm',
        status: 'running',
        start: t0,
        tokens: NO_TOKENS,
        cost: 0,
      })

      return editSpan(withStep, parentId, s => (s.detail ? s : { ...s, detail: label }))
    })

    // When the first chunk came back (the bar turns from waiting to streaming),
    // and the first text or tool call the person could see.
    let firstText: number | undefined
    let hasFirstByte = false
    let result: TurnStepResult | undefined
    try {
      const stream = next(e)
      for await (const chunk of stream) {
        const at = hasFirstByte && firstText !== undefined ? undefined : await $.clock.now()
        if (firstText === undefined && (chunk.kind === 'text' || chunk.kind === 'tool')) firstText = at
        yield chunk
        // Recorded after the chunk has gone on, so the trace never holds up the reply.
        if (!hasFirstByte) {
          hasFirstByte = true
          void quietly(() => patch($, bySpan(id), r => editSpan(r, id, s => ({ ...s, firstByte: at }))))
        }
      }
      result = await stream.result

      return result
    } finally {
      const t1 = await $.clock.now()
      const done = result
      await patch($, bySpan(id), r =>
        editSpan(r, id, s => {
          if (!done) return finish(s, t1, 'failed', { error: 'Interrupted' })
          if (done.stopReason === null) return finish(s, t1, 'failed', { error: 'No response' })
          const u = done.usage
          const tools = [...new Set(done.toolUses.map(t => toolName(t.name)))]
          const said = firstLine(done.answer, 48)

          return finish(s, t1, 'done', {
            name: said ?? (tools.length ? `Calls ${tools.join(', ')}` : 'LLM call'),
            detail: modelLabel(u?.model ?? e.model),
            tokens: u ? tokensFrom(u) : NO_TOKENS,
            firstText,
            cost: u ? costOf(u.model, u) : 0,
            output: firstLine(done.answer) ?? (tools.length ? `→ ${tools.join(', ')}` : undefined),
          })
        }),
      )
    }
  })

  // Should a hook here fail, the call goes on: a caught `next` replays, so a call made is never made twice.
  on('tool.call', async ($, e, next) => {
    if ((await read($, runs)).length === 0) return next(e)

    const input = e as unknown as Record<string, unknown>
    const isAgent = e.tool === 'Agent'
    const t0 = await $.clock.now()
    await quietly(() =>
      patch($, byAgent(e.agentId), r =>
        withSpan(r, {
          id: e.tool_use_id,
          parentId: parentFor(r, e.agentId),
          name: isAgent ? String(input.subagent_type ?? 'Subagent') : toolName(e.tool),
          detail: isAgent ? String(input.description ?? '') : toolDetail(input),
          kind: isAgent ? 'subagent' : 'tool',
          status: 'running',
          start: t0,
          tokens: NO_TOKENS,
          cost: 0,
          input: isAgent ? firstLine(String(input.prompt ?? '')) : toolInput(input),
        }),
      ),
    )

    // A failure beneath is the call's own: recorded, then passed on.
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } catch (err) {
      const t1 = await $.clock.now()
      await quietly(() =>
        patch($, bySpan(e.tool_use_id), r =>
          editSpan(r, e.tool_use_id, s => finish(s, t1, 'failed', { error: errorLine(String(err)) ?? 'Failed' })),
        ),
      )
      throw err
    }

    const t1 = await $.clock.now()
    await quietly(() =>
      patch($, bySpan(e.tool_use_id), r =>
        editSpan(r, e.tool_use_id, s => {
          if (ran.deny !== undefined) return finish(s, t1, 'failed', { error: errorLine(ran.deny) ?? 'Denied' })
          if (ran.isError) return finish(s, t1, 'failed', { error: errorLine(ran.text) ?? 'Failed' })
          // A subagent still running as its call returns went to the background
          // (asked for or not): it ends at its own turn.complete.
          if (isAgent && s.agentId !== undefined && s.status === 'running') return { ...s, isBackground: true }

          return finish(s, t1, 'done', { output: firstLine(ran.text) })
        }),
      ),
    )

    return ran
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId === undefined) return spawned

    const agentId = spawned.agentId
    await quietly(async () => {
      if ((await read($, runs)).length === 0) return
      const t = await $.clock.now()
      const at = (list: Run[]) => {
        const i = bySpan(e.tool_use_id)(list)

        return i >= 0 ? i : byAgent(e.parentAgentId)(list)
      }
      await patch($, at, r =>
        withSpan(r, {
          ...(r.spans.find(s => s.id === e.tool_use_id) ?? {
            id: e.tool_use_id,
            parentId: parentFor(r, e.parentAgentId),
            name: e.subagentType,
            kind: 'subagent' as const,
            status: 'running' as const,
            start: t,
            tokens: NO_TOKENS,
            cost: 0,
            input: firstLine(e.prompt),
          }),
          agentId,
          detail: modelLabel(spawned.model),
        }),
      )
    })

    return spawned
  }).catch(($, e, next) => next(e))

  // A compaction is drawn where it happens: in the live turn, under the loop
  // that compacts; between turns (`/compact`), as a card of its own. One made
  // ahead of time with no turn live is left out.
  on('session.compact', async ($, e, next) => {
    const t0 = await $.clock.now()
    const id = `compact:${t0}:${(compactions += 1)}`
    const how = TRIGGERS[e.trigger]
    const span: Span = {
      id,
      parentId: 'root',
      name: 'Compacting context',
      detail: how,
      kind: 'compact',
      status: 'running',
      start: t0,
      tokens: NO_TOKENS,
      cost: 0,
      input: firstLine(e.instructions),
    }
    let isOwnCard = false
    await quietly(async () => {
      const list = await read($, runs)
      const live = e.agentId !== undefined ? byAgent(e.agentId)(list) : list.findIndex(r => r.status === 'running')
      if (list[live]?.status === 'running') {
        await patch($, () => live, r => withSpan(r, { ...span, parentId: parentFor(r, e.agentId) }))
      } else if (e.trigger !== 'precompute') {
        isOwnCard = true
        const root: Span = { id: 'root', parentId: null, name: 'Claude', detail: '', kind: 'agent', status: 'running', start: t0, tokens: NO_TOKENS, cost: 0 }
        await update($, runs, all => [
          {
            id: `compact-${t0}-${compactions}`,
            n: all[0]?.n ?? 0,
            prompt: e.trigger === 'manual' ? ['/compact', firstLine(e.instructions, 100)].filter(Boolean).join(' ') : `Context compacted (${how})`,
            startedAt: t0,
            status: 'running' as const,
            spans: [root, span],
            isCompaction: true,
          },
          ...all.slice(0, MAX_RUNS - 1),
        ])
      }
      await update($, now, () => t0)
    })

    // A failure beneath is the compaction's own: recorded, then passed on.
    let done: Awaited<ReturnType<typeof next>> | undefined
    let error: string | undefined
    try {
      done = await next(e)

      return done
    } catch (err) {
      error = errorLine(String(err)) ?? 'Failed'
      throw err
    } finally {
      const t1 = await $.clock.now()
      await quietly(async () => {
        await patch($, bySpan(id), r => {
          const ended = editSpan(r, id, s => {
            if (!done) return finish(s, t1, 'failed', { error: error ?? 'Interrupted' })
            if (done.skip !== undefined) return finish(s, t1, 'done', { name: 'Compaction skipped', output: done.skip })
            // The conversation's size before and after, in whole thousands of tokens:
            // the row's detail where known, what started it otherwise.
            const k = (n: number) => `${Math.round(n / 1000)}k`
            const sizes =
              done.tokensBefore !== undefined
                ? `${k(done.tokensBefore)}${done.tokensAfter !== undefined ? ` → ${k(done.tokensAfter)}` : ''}`
                : undefined
            const u = done.usage

            return finish(s, t1, 'done', {
              name: 'Compaction',
              detail: sizes ?? how,
              tokens: u ? tokensFrom(u) : NO_TOKENS,
              cost: u ? costOf(models.get(e.agentId ?? 'main') ?? '', u) : 0,
              output: sizes ? `${how} · conversation ${sizes} tokens` : `${how} · conversation compacted`,
            })
          })
          if (!isOwnCard) return ended
          const status = ended.spans.find(s => s.id === id)?.status === 'failed' ? 'failed' : 'done'

          return { ...editSpan(ended, 'root', s => finish(s, t1, status)), status }
        })
        await update($, now, () => t1)
      })
    }
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const t = await $.clock.now()
    const status: SpanStatus = e.reason === 'error' || e.reason === 'refusal' ? 'failed' : 'done'
    const error = e.reason === 'aborted' ? undefined : status === 'failed' ? `Turn ended: ${e.reason}` : undefined

    await quietly(async () => {
      if (e.agentId === undefined) {
        // The turn is over: whatever it left open closes with it, but a background subagent.
        await patch($, byTurn(e.turnId), r => ({
          ...closeOpen(editSpan(r, 'root', s => finish(s, t, status, { error })), 'root', t),
          status,
        }))
      } else {
        const agentId = e.agentId
        await patch($, byAgent(agentId), r => {
          const sub = r.spans.find(s => s.agentId === agentId)
          if (!sub) return r
          // What it left open closes with it.
          return closeOpen(editSpan(r, sub.id, s => finish(s, t, status, { error })), sub.id, t)
        })
      }
      await update($, now, () => t)
    })

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, runs)
    const t = await read($, now)
    const folded = await read($, collapsed)
    const opened = await read($, openId)
    const cols = Math.max(32, e.props.bodyColumns)
    // Desktop and mobile draw each turn's waterfall as one SVG.
    const pictures = e.surface === 'desktop' || e.surface === 'mobile' ? $.ui.resolve(e) : undefined
    const isPicture = pictures !== undefined

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text bold>✦ Trace</Text>
          <Text dimColor>Send a prompt: its LLM calls, tool calls and subagents show up here as they run.</Text>
        </Box>
      )
    }

    const endOf = (s: Span) => s.end ?? Math.max(t, s.start)
    for (const id of drawn.keys()) if (!list.some(r => r.id === id)) drawn.delete(id)

    /** One turn's figures, for its card and for the summary. */
    const totalsOf = (r: Run) => {
      const root = r.spans.find(s => s.id === 'root')!
      const calls = r.spans.filter(isCall)

      return {
        duration: endOf(root) - root.start,
        cost: r.spans.reduce((a, s) => a + s.cost, 0),
        tokens: sumTokens(r.spans),
        speed: speedOf(r.spans),
        llm: calls.filter(s => s.kind === 'llm').length,
        tool: calls.filter(s => s.kind === 'tool').length,
        errors: calls.filter(s => s.status === 'failed' && s.error !== 'Interrupted').length,
      }
    }
    const statsOf = (head: Stat[], x: ReturnType<typeof totalsOf>): Stat[] => [
      ...head,
      { label: 'COST', value: fmtCost(x.cost) },
      ...tokenStats(x.tokens, x.speed),
      x.errors
        ? { label: 'CALLS', value: `${x.llm} · ${x.tool}`, sub: x.errors === 1 ? '1 error' : `${x.errors} errors`, subColor: COLORS.failed }
        : { label: 'CALLS', value: `${x.llm} · ${x.tool}`, sub: 'LLM · tool' },
    ]
    const sayStats = (stats: Stat[]) =>
      stats.map(s => `${s.label.toLowerCase()} ${s.value}${s.sub ? ` (${s.sub})` : ''}`).join(', ')
    const statusOf = (status: SpanStatus) =>
      status === 'running'
        ? { text: '● Live', color: 'suggestion' }
        : status === 'failed'
          ? { text: '✕ Failed', color: 'error' }
          : { text: '✓ Done', color: 'success' }

    // One cell of padding each side; two between the columns.
    const inner = cols - 2
    const isWide = inner >= 64
    const gap = 2
    const labelW = 15
    const nameW = isWide ? Math.min(36, Math.max(22, Math.floor(inner * 0.34))) : inner
    const trackW = isWide ? inner - nameW - labelW - gap * 2 : inner - 2
    const statW = Math.floor(inner / (isWide ? 6 : 3))
    const rule = <Text dimColor>{'─'.repeat(inner)}</Text>

    // A figure as text: label, value, the line under it, and its split as a bar.
    const tileOf = (s: Stat) => {
      const parts = (s.split ?? []).filter(p => p.part > 0)
      const total = parts.reduce((a, p) => a + p.part, 0)

      return (
        <Box width={statW} flexDirection="column">
          <Text dimColor>{s.label}</Text>
          <Text bold color={s.isAlert ? 'error' : undefined}>{s.value}</Text>
          {s.sub ? (
            <Text color={s.subColor} dimColor={!s.subColor} wrap="truncate">
              {s.sub}
            </Text>
          ) : null}
          {total > 0 ? (
            <Box flexDirection="row" width={Math.max(4, statW - 2)} height={1} overflow="hidden">
              {percents(parts.map(p => ({ width: p.part / total, color: p.color }))).map(piece => (
                <Box width={piece.share} height={1} overflow="hidden">
                  <Text color={piece.color}>{'━'.repeat(statW)}</Text>
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      )
    }
    const tilesOf = (stats: Stat[]) => (
      <Box flexDirection="row" flexWrap="wrap" rowGap={1} marginY={1}>
        {stats.map(tileOf)}
      </Box>
    )

    /** One turn's card: its figures, its waterfall, its details. */
    const drawRun = (r: Run) => {
      const keyOf = (s: Span) => `${r.id}:${s.id}`
      const isFolded = (s: Span) => folded.includes(keyOf(s))
      const fold = (s: Span) => update($, collapsed, keys => toggle(keys, keyOf(s)))

      const kids = new Map<string, Span[]>()
      for (const s of r.spans) {
        if (s.parentId === null) continue
        kids.set(s.parentId, [...(kids.get(s.parentId) ?? []), s])
      }
      for (const group of kids.values()) group.sort((a, b) => a.start - b.start)
      const subtrees = new Map<string, Span[]>()
      const below = (s: Span): Span[] => {
        let found = subtrees.get(s.id)
        if (!found) {
          found = (kids.get(s.id) ?? []).flatMap(c => [c, ...below(c)])
          subtrees.set(s.id, found)
        }

        return found
      }
      const rolled = (s: Span, f: (x: Span) => number) => f(s) + below(s).reduce((a, c) => a + f(c), 0)

      const root = r.spans.find(s => s.id === 'root')!
      const rows: { span: Span; depth: number }[] = []
      const walk = (s: Span, depth: number) => {
        rows.push({ span: s, depth })
        if (!isFolded(s)) for (const c of kids.get(s.id) ?? []) walk(c, depth + 1)
      }
      walk(root, 0)

      const elapsed = Math.max(...r.spans.map(endOf)) - r.startedAt
      const [rangeS, stepS] = axisRange(elapsed)
      const calls = r.spans.filter(isCall)
      const finished = calls.filter(s => s.status === 'done')
      const slowest =
        finished.length > 1
          ? finished.reduce((a, s) => (endOf(s) - s.start > endOf(a) - a.start ? s : a))
          : undefined
      const title = `${r.isCompaction ? 'Compaction' : `Turn ${r.n}`} · ${clockTime(r.startedAt)}`
      const status = statusOf(r.status)
      const totals = totalsOf(r)
      const stats = statsOf([{ label: 'DURATION', value: fmtDuration(totals.duration) }], totals)

      const detailLines = (span: Span) => {
        const lines: [string, string, string?][] = [
          ['Kind', span.kind],
          ['Duration', fmtDuration(endOf(span) - span.start) + (span.status === 'running' ? ' (running)' : '')],
        ]
        const tk = sumTokens([span, ...below(span)])
        if (inputOf(tk) || tk.output) {
          lines.push(['Tokens in', `${fmtTokens(inputOf(tk))} · ${pct(tk.cacheRead, inputOf(tk))}% cached`])
          lines.push([
            '',
            `cache read ${fmtTokens(tk.cacheRead)} · cache write ${fmtTokens(tk.cacheWrite)} · uncached ${fmtTokens(tk.uncached)}`,
          ])
          lines.push(['Tokens out', fmtTokens(tk.output)])
        }
        if (span.firstByte !== undefined) {
          const waited = span.firstByte - span.start
          const said = span.firstText === undefined ? '' : ` · first text ${fmtDuration(span.firstText - span.start)}`
          lines.push(['TTFT', `first byte ${fmtDuration(waited)}${said}`])
          if (span.end !== undefined) {
            const streaming = span.end - span.firstByte
            const tps = streaming > 0 ? ` · ${Math.round(tokensOf(span).output / (streaming / 1000))} tok/s` : ''
            lines.push(['Streaming', `${fmtDuration(streaming)}${tps}`])
          }
        }
        const cost = rolled(span, s => s.cost)
        if (cost) lines.push(['Cost', `${fmtCost(cost)} (estimate)`])
        if (span.input) lines.push(['Input', span.input])
        if (span.output) lines.push(['Output', span.output])
        if (span.error) lines.push(['Error', span.error, 'error'])

        return lines
      }
      const detailsOf = (span: Span, depth: number) => {
        const lines = detailLines(span)

        return (
          <Box
            flexDirection="column"
            marginLeft={depth * 2 + 3}
            marginY={1}
            paddingX={1}
            borderStyle="round"
            borderDimColor
          >
            {lines.map(([k, v, color]) => (
              <Text wrap="truncate">
                <Text dimColor>{k.padEnd(11)}</Text>
                <Text color={color}>{clip(v, inner - depth * 2 - 19)}</Text>
              </Text>
            ))}
          </Box>
        )
      }

      // The picture is laid out to the pane's width. A plain image, not a
      // frame, so a redraw swaps it in place without a flash.
      if (pictures) {
        const { Svg } = pictures
        const draw = (shown: typeof rows, hidden: number) =>
          waterfallSvg({
            width: cols * PX_PER_COLUMN,
            title,
            prompt: r.prompt,
            status: r.status,
            origin: r.startedAt,
            now: t,
            rangeS,
            stepS,
            stats,
            hidden,
            rows: shown.map(({ span, depth }) => ({
              span,
              depth,
              end: endOf(span),
              hasKids: (kids.get(span.id)?.length ?? 0) > 0,
              isFolded: isFolded(span),
              isSlowest: span === slowest,
              cost: rolled(span, s => s.cost),
              firstByte: span.firstByte,
              marks: isFolded(span)
                ? below(span)
                    .filter(isMark)
                    .map(c => ({ start: c.start, end: endOf(c), kind: c.kind, status: c.status }))
                : [],
            })),
          })
        // Too many rows for one picture (too long, or too tall): keep the root and the latest rows,
        // where a live turn's work is, and say how many were left out.
        const fit = (): Picture => {
          let picture = draw(rows, 0)
          for (let keep = rows.length; (picture.source.length > SVG_LIMIT || picture.height > SVG_HEIGHT_LIMIT) && keep > 2; ) {
            keep = Math.max(2, Math.floor(keep * 0.85))
            picture = draw([rows[0]!, ...rows.slice(rows.length - (keep - 1))], rows.length - keep)
          }

          return picture
        }
        const isSettled = r.status !== 'running' && r.spans.every(s => s.end !== undefined)
        const cacheKey = [
          cols,
          r.status,
          r.spans.length,
          r.spans.reduce((a, s) => a + (s.end ?? 0), 0),
          folded.filter(k => k.startsWith(`${r.id}:`)).sort().join(','),
        ].join('|')
        const cached = drawn.get(r.id)
        const picture = isSettled && cached?.key === cacheKey ? cached.picture : fit()
        if (isSettled) drawn.set(r.id, { key: cacheKey, picture })
        const branches = r.spans.filter(s => (kids.get(s.id)?.length ?? 0) > 0)
        const failed = r.spans.filter(s => s.status === 'failed' && s.error)
        const summary = `${title}, "${r.prompt}": ${sayStats(stats)}`

        // The fold buttons head the card, where its title is.
        return (
          <Box key={`run:${r.id}`} flexDirection="column" marginBottom={2}>
            {branches.length > 0 && (
              <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginBottom={1}>
                <Text dimColor>Fold</Text>
                {branches.map(b => (
                  <Button key={`fold:${keyOf(b)}`} plain onPress={() => fold(b)}>
                    {isFolded(b) ? '▸ ' : '▾ '}
                    {b.id === 'root' ? (r.isCompaction ? 'Whole card' : 'Whole turn') : b.name}
                  </Button>
                ))}
              </Box>
            )}
            <Svg source={picture.source} height={picture.height} alt={summary} />
            {failed.map(s => (
              <Box flexDirection="row" columnGap={1} marginTop={1}>
                <Text color="error">✕ {s.name}</Text>
                <Text dimColor wrap="truncate">
                  {clip(errorLine(s.error) ?? '', Math.max(10, cols - s.name.length - 4))}
                </Text>
              </Box>
            ))}
          </Box>
        )
      }

      const nameOf = (span: Span, depth: number, room: number) => {
        const hasKids = (kids.get(span.id)?.length ?? 0) > 0
        // The slowest call wears a turtle ahead of its name: two cells and a space.
        const isSlowest = span === slowest
        const left = room - depth * 2 - 4 - (isSlowest ? 3 : 0)
        const name = clip(span.name, left)
        const spare = left - name.length - 1
        const detail = spare >= 6 ? clip(span.detail, spare) : ''

        return (
          <Box flexDirection="row">
            <Text>{' '.repeat(depth * 2)}</Text>
            {hasKids ? (
              <Button key={`fold:${keyOf(span)}`} plain label={isFolded(span) ? '▸' : '▾'} onPress={() => fold(span)} />
            ) : (
              <Text> </Text>
            )}
            <Text> </Text>
            <Button
              key={`open:${keyOf(span)}`}
              plain
              onPress={() => update($, openId, key => (key === keyOf(span) ? null : keyOf(span)))}
            >
              <Text color={colorOf(span)}>■ </Text>
              {isSlowest ? <Text>🐢 </Text> : ''}
              <Text bold={!isMark(span)}>{name}</Text>
              {detail ? <Text dimColor> {detail}</Text> : ''}
            </Button>
          </Box>
        )
      }

      const labelOf = (span: Span) => {
        const cost = rolled(span, s => s.cost)
        const failed = span.status === 'failed' ? ' ✕' : ''

        return `${fmtDuration(endOf(span) - span.start)}${cost ? ` · ${fmtCost(cost)}` : ''}${failed}`
      }

      const trackOf = (span: Span, width: number) => {
        const marks = isFolded(span)
          ? below(span)
              .filter(isMark)
              .map(c => ({ start: c.start, end: endOf(c), color: colorOf(c) }))
          : []

        return (
          <Box flexDirection="row" width={width} height={1} overflow="hidden">
            {percents(track(span, endOf(span), r.startedAt, rangeS * 1000, width, marks)).map(piece =>
              piece.color ? (
                <Box width={piece.share} height={1} overflow="hidden">
                  <Text color={piece.color}>{(piece.isLine ? '─' : '━').repeat(width)}</Text>
                </Box>
              ) : (
                <Box width={piece.share} height={1} />
              ),
            )}
          </Box>
        )
      }

      const axisOf = (width: number) => (
        <Box flexDirection="row" width={width} height={1} overflow="hidden">
          {percents(ticks(rangeS, stepS)).map(tick => (
            <Box width={tick.share} height={1} overflow="hidden">
              <Text dimColor>{tick.label}</Text>
            </Box>
          ))}
        </Box>
      )

      return (
        <Box key={`run:${r.id}`} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold>{title}</Text>
            <Text color={status.color}>{status.text}</Text>
          </Box>
          <Text dimColor wrap="truncate">{r.prompt}</Text>

          <Box marginTop={1}>{rule}</Box>
          {tilesOf(stats)}
          {rule}

          {isWide ? (
            <Box flexDirection="row" columnGap={gap} marginY={1}>
              <Box width={nameW}>
                <Text dimColor>SPAN</Text>
              </Box>
              {axisOf(trackW)}
            </Box>
          ) : (
            <Box flexDirection="row" marginY={1}>
              <Text>{'  '}</Text>
              {axisOf(trackW)}
            </Box>
          )}

          <Box flexDirection="column" rowGap={isWide ? 0 : 1}>
            {rows.map(({ span, depth }) => (
              <Box key={`row:${keyOf(span)}`} flexDirection="column">
                {isWide ? (
                  <Box flexDirection="row" columnGap={gap}>
                    <Box width={nameW} overflow="hidden">
                      {nameOf(span, depth, nameW)}
                    </Box>
                    {trackOf(span, trackW)}
                    <Box width={labelW} justifyContent="flex-end">
                      <Text dimColor={span.status !== 'failed'} color={span.status === 'failed' ? 'error' : undefined}>
                        {labelOf(span)}
                      </Text>
                    </Box>
                  </Box>
                ) : (
                  <>
                    <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
                      <Box flexShrink={1} overflow="hidden">
                        {nameOf(span, depth, inner - labelOf(span).length - 1)}
                      </Box>
                      <Text dimColor={span.status !== 'failed'} color={span.status === 'failed' ? 'error' : undefined}>
                        {labelOf(span)}
                      </Text>
                    </Box>
                    <Box flexDirection="row">
                      <Text>{'  '}</Text>
                      {trackOf(span, trackW)}
                    </Box>
                  </>
                )}
                {opened === keyOf(span) ? detailsOf(span, depth) : null}
              </Box>
            ))}
          </Box>
          <Box marginTop={1}>{rule}</Box>
        </Box>
      )
    }

    // Every turn at a glance, above the turns themselves.
    const each = list.map(r => ({ r, x: totalsOf(r) }))
    const sums = each.reduce(
      (a, { x }) => ({
        duration: a.duration + x.duration,
        cost: a.cost + x.cost,
        tokens: addTokens(a.tokens, x.tokens),
        llm: a.llm + x.llm,
        tool: a.tool + x.tool,
        errors: a.errors + x.errors,
      }),
      { duration: 0, cost: 0, tokens: NO_TOKENS, llm: 0, tool: 0, errors: 0 },
    )
    const grand = { ...sums, speed: speedOf(list.flatMap(r => r.spans)) }
    const live = list.filter(r => r.status === 'running').length
    const summaryStats = statsOf(
      [{ label: 'TURNS', value: String(list.length), sub: live ? `${live} live` : `${fmtDuration(grand.duration)} in all` }],
      grand,
    )
    const summaryAlt = `All turns: ${sayStats(summaryStats)}`
    const summaryPicture =
      pictures &&
      summarySvg({
        width: cols * PX_PER_COLUMN,
        stats: summaryStats,
        rows: each.map(({ r, x }) => ({
          label: r.isCompaction ? '—' : `#${r.n}`,
          time: clockTime(r.startedAt),
          prompt: r.prompt,
          status: r.status,
          duration: fmtDuration(x.duration),
          cost: fmtCost(x.cost),
          input: fmtTokens(inputOf(x.tokens)),
          cached: `${pct(x.tokens.cacheRead, inputOf(x.tokens))}%`,
          output: fmtTokens(x.tokens.output),
          ttft: orDash(x.speed.ttft, fmtDuration),
          tps: orDash(x.speed.tps, v => String(Math.round(v))),
        })),
      })
    // A set height keeps the box while a new picture loads, so the pane keeps its scroll.
    const summary = pictures && summaryPicture ? (
      <Box marginBottom={2}>
        <pictures.Svg source={summaryPicture.source} height={summaryPicture.height} alt={summaryAlt} />
      </Box>
    ) : (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>All turns</Text>
        <Box marginTop={1}>{rule}</Box>
        {tilesOf(summaryStats)}
        {rule}
        {each.map(({ r, x }) => {
          const said = isWide
            ? `${fmtDuration(x.duration)} · ${fmtCost(x.cost)} · in ${fmtTokens(inputOf(x.tokens))} (${pct(x.tokens.cacheRead, inputOf(x.tokens))}% cached) · out ${fmtTokens(x.tokens.output)} · TTFT ${orDash(x.speed.ttft, fmtDuration)} · ${orDash(x.speed.tps, v => String(Math.round(v)))} tok/s`
            : `${fmtDuration(x.duration)} · ${fmtCost(x.cost)}`

          return (
            <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
              <Box flexShrink={1} overflow="hidden">
                <Text wrap="truncate">
                  <Text color={statusOf(r.status).color}>● </Text>
                  <Text bold>{r.isCompaction ? '—' : `#${r.n}`}</Text>
                  <Text dimColor> {clockTime(r.startedAt)} </Text>
                  {r.prompt}
                </Text>
              </Box>
              <Text dimColor>{said}</Text>
            </Box>
          )
        })}
        <Box marginTop={1}>{rule}</Box>
      </Box>
    )

    // Reset clears the turns that are over; one still running stays.
    const reset = async () => {
      const kept = (await update($, runs, all => all.filter(r => r.status === 'running'))).map(r => `${r.id}:`)
      const isKept = (key: string) => kept.some(prefix => key.startsWith(prefix))
      await update($, collapsed, keys => keys.filter(isKept))
      await update($, openId, key => (key && isKept(key) ? key : null))
    }

    return (
      <Box flexDirection="column" paddingX={isPicture ? 0 : 1}>
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text bold color="claude">✦ Trace</Text>
          <Button key="reset" onPress={reset}>
            Reset
          </Button>
        </Box>
        {summary}
        {list.map(drawRun)}
        {isPicture ? null : (
          <Text dimColor wrap="truncate">
            <Text color={COLORS.llm}>━</Text> LLM call  <Text color={COLORS.tool}>━</Text> tool call  <Text color={COLORS.compact}>━</Text> compaction  <Text color={COLORS.agent}>─</Text> agent  🐢 slowest · costs are API list-price estimates
          </Text>
        )}
      </Box>
    )
  })
}
