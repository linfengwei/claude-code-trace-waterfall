import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const pane = (bodyColumns: number) =>
  ({
    plugin: 'trace-waterfall',
    component: 'Pane',
    requestId: 'trace-waterfall',
    props: {
      title: 'Trace',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

const usage = (model: string) => ({
  model,
  input_tokens: 1200,
  output_tokens: 800,
  cache_read_input_tokens: 10_000,
  cache_creation_input_tokens: 0,
})

// Nothing sits beneath the plugin: these hooks stand for the engine. It counts the tool calls it runs.
function engine(on: Parameters<TestBody>[1]) {
  const ran = { tools: 0 }
  const clock = mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'trace' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('turn.step', async function* (_, e) {
    // 1.5s to the first byte, 0.5s more to the first text, 5.4s of streaming in all.
    await clock.advance(1500)
    yield { kind: 'thinking' as const, index: 0, text: '' }
    await clock.advance(500)
    yield { kind: 'text' as const, index: 1, text: 'a'.repeat(100) }
    await clock.advance(4900)

    return {
      turnId: e.turnId,
      index: e.index,
      answer: e.agentId ? 'Competitors anchor at $8 per seat' : 'Planning the launch',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: usage(e.model),
    }
  })
  on('tool.call', async (_, e) => {
    ran.tools += 1
    await clock.advance(3000)

    return e.tool === 'Read' ? { result: {}, isError: true as const, text: '<tool_use_error>ENOENT: no such file</tool_use_error>' } : { result: {}, text: '4 rows' }
  })

  return ran
}

test('a run draws as a waterfall, on every surface and width', async ($, on) => {
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Launch the new pricing page by Friday', turnId: 't1' })
  const plan = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of plan);
  await $.tool.call({ tool: 'Bash', command: 'psql -c "select plan"', description: 'Query plan usage' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/missing.md' })
  await $.agent.spawn({
    tool_use_id: 'agent-1',
    prompt: 'Research competitor pricing',
    description: 'Research pricing',
    subagentType: 'Researcher',
    provider: { plugin: 'engine', tier: 'builtin' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  const research = $.turn.step({ turnId: 't2', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'a1' })
  for await (const _ of research);
  await $.turn.complete({ turnId: 't2', reason: 'answer', agentId: 'a1', answer: '', durationMs: 6900, isAborted: false })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Done', durationMs: 30000, isAborted: false })

  // Terminal and VS Code draw text rows.
  for (const surface of ['terminal', 'vscode'] as const) {
    for (const width of [110, 50]) {
      const ui = await $.ui.mount({ ...pane(width), surface })

      expect((await ui.find({ type: 'Text', text: /Done/ }))?.text).toContain('Done')
      expect(await ui.find({ type: 'Text', text: 'Planning the launch' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Researcher' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /ENOENT/ })).toBeUndefined()

      // The Read failed: one error, and its details open on a press.
      expect((await ui.findAll({ type: 'Text', text: '1' })).length).toBeGreaterThan(0)
      const read = (await ui.findAll({ type: 'Button' })).find(b => /^open:/.test(b.key ?? '') && /missing/.test(b.text))
      expect(read).toBeDefined()
      await ui.press({ key: read!.key! })
      expect(await ui.find({ type: 'Text', text: /ENOENT/ })).toBeDefined()
      await ui.press({ key: read!.key! })

      // Folding the subagent hides its call.
      await ui.press({ key: 'fold:t1:agent-1' })
      expect(await ui.find({ type: 'Text', text: /Competitors anchor/ })).toBeUndefined()
      await ui.press({ key: 'fold:t1:agent-1' })
      expect(await ui.find({ type: 'Text', text: /Competitors anchor/ })).toBeDefined()

      await ui.unmount()
    }
  }

  // Desktop and mobile draw one SVG; the failed Read's error rides its tooltip.
  for (const surface of ['desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...pane(110), surface })
    const [summary, svg] = await ui.findAll({ type: 'Svg' })
    const source = String(svg?.props.source)

    // The summary: every turn's figures; input 1.2k uncached + 10k cache read.
    expect(String(summary?.props.source)).toContain('All turns')
    expect(String(summary?.props.alt)).toContain('input 22.4k')
    expect(String(summary?.props.source)).toContain('89%')
    // 800 output tokens over 5.4s of streaming, after 1.5s to the first byte.
    expect(source).toContain('148 tok/s')
    expect(source).toContain('1.5s')
    expect(source).toContain('first text 2.0s')
    expect(source).toContain('1 error')
    expect(String(summary?.props.source)).toContain('148')

    expect(String(svg?.props.alt)).toContain('1 error')
    // Each picture holds its height across redraws, so the pane keeps its scroll.
    expect(summary?.props.height).toBeGreaterThan(0)
    expect(svg?.props.height).toBeGreaterThan(0)
    // A plain image, so a redraw swaps it without a flash; no dropdown either.
    expect(svg?.props.isInteractive).toBeUndefined()
    expect(await ui.find({ type: 'Select' })).toBeUndefined()
    expect(source).toContain('Planning the launch')
    expect(source).toContain('Researcher')
    expect(await ui.find({ type: 'Text', text: /ENOENT/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /tool_use_error/ })).toBeUndefined()
    expect(source).toContain('✓ Done')

    // Folding the subagent takes its call out of the picture.
    const card = async () => String((await ui.findAll({ type: 'Svg' }))[1]?.props.source)
    await ui.press({ key: 'fold:t1:agent-1' })
    expect(await card()).not.toContain('Competitors anchor')
    await ui.press({ key: 'fold:t1:agent-1' })
    expect(await card()).toContain('Competitors anchor')

    await ui.unmount()
  }
})

test('the pane says what it is for before the first run', async ($, on) => {
  const ui = await $.ui.mount({ ...pane(80), surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /show up here/ })).toBeDefined()
  await ui.unmount()
})

test('turns stack newest first until a reset clears them', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const [turnId, text] of [['t1', 'First question'], ['t2', 'Second question']] as const) {
    await $.turn.start({ text, turnId })
    for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 }));
    await $.tool.call({ tool: 'Bash', command: 'ls', description: `List for ${text}` })
    await $.turn.complete({ turnId, reason: 'answer', answer: 'Done', durationMs: 10000, isAborted: false })
  }

  const ui = await $.ui.mount({ ...pane(110), surface: 'desktop' })
  const sources = async () => (await ui.findAll({ type: 'Svg' })).map(p => String(p.props.source))
  const [summary, second, first] = await sources()
  expect(summary).toContain('Second question')
  expect(summary).toContain('First question')
  expect(second).toContain('Turn 2')
  expect(second).toContain('List for Second')
  // The first turn folded itself away as the second went live.
  expect(first).toContain('First question')
  expect(first).not.toContain('List for First')
  await ui.press({ key: 'fold:t1:root' })
  expect((await sources())[2]).toContain('List for First')

  // Folding in one turn leaves the other alone.
  await ui.press({ key: 'fold:t2:root' })
  expect((await sources())[1]).not.toContain('List for Second')
  expect((await sources())[2]).toContain('List for First')

  // Reset clears the finished turns and keeps the live one.
  await $.turn.start({ text: 'Third question', turnId: 't3' })
  await ui.press({ key: 'reset' })
  const kept = await sources()
  expect(kept.length).toBe(2)
  expect(kept[1]).toContain('Third question')
  expect(kept[1]).toContain('● Live')
  expect(kept[0]).not.toContain('First question')

  await $.turn.complete({ turnId: 't3', reason: 'answer', answer: 'Done', durationMs: 1000, isAborted: false })
  await ui.press({ key: 'reset' })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /show up here/ })).toBeDefined()
  await ui.unmount()

  // The terminal stacks turns as text, the summary above them.
  await $.turn.start({ text: 'Fourth question', turnId: 't4' })
  const term = await $.ui.mount({ ...pane(110), surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: 'All turns' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /Turn 1/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /First question/ })).toBeUndefined()
  await term.unmount()
})

test('a background subagent outlives its turn; what the turn left open is closed', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Kick off research', turnId: 't1' })

  // Spawned, and its call returns while it still runs.
  const spawn = {
    tool_use_id: 'bg-1',
    prompt: 'Research in the background',
    description: 'Research',
    subagentType: 'Researcher',
    provider: { plugin: 'engine', tier: 'builtin' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  } as const
  await $.agent.spawn(spawn)
  await $.tool.call({ tool: 'Agent', tool_use_id: 'bg-1', subagent_type: 'Researcher', description: 'Research', prompt: 'Research in the background' } as never)

  // A call the turn never saw finish.
  const step = $.turn.step({ turnId: 't1', index: 1, model: 'claude-opus-5-5', messageCount: 2 })
  await step[Symbol.asyncIterator]().next()

  // Another turn's end leaves this one alone.
  await $.turn.complete({ turnId: 'elsewhere', reason: 'answer', answer: '', durationMs: 1, isAborted: false })
  const ui = await $.ui.mount({ ...pane(110), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Live/ })).toBeDefined()

  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Done', durationMs: 9000, isAborted: false })
  const details = async (id: string) => {
    await ui.press({ key: `open:t1:${id}` })
    const text = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    await ui.press({ key: `open:t1:${id}` })

    return text
  }
  expect(await details('bg-1')).toContain('(running)')
  expect(await details('main:t1:1')).toContain('Interrupted')

  // It ends at its own turn.complete.
  await $.turn.complete({ turnId: 'sub', reason: 'answer', agentId: 'a1', answer: '', durationMs: 4000, isAborted: false })
  expect(await details('bg-1')).not.toContain('(running)')
  await ui.unmount()
})

test('a huge turn stays inside the picture limit, and each call runs once', { timeoutMs: 30_000 }, async ($, on) => {
  const ran = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Touch every file', turnId: 't1' })
  for (let i = 0; i < 400; i++) {
    await $.tool.call({ tool: 'Bash', command: `cat file-${i}`, description: `Read file number ${i} of the very long list ${'x'.repeat(40)}` })
  }
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Done', durationMs: 60000, isAborted: false })
  expect(ran.tools).toBe(400)

  const ui = await $.ui.mount({ ...pane(110), surface: 'desktop' })
  const source = String((await ui.findAll({ type: 'Svg' }))[1]?.props.source)
  expect(source.length).toBeLessThanOrEqual(131072)
  expect((await ui.findAll({ type: 'Svg' }))[1]?.props.height).toBeLessThanOrEqual(4096)
  expect(source).toContain('not drawn')
  expect(source).toContain('file number 399')
  await ui.unmount()
})

test('a compaction shows on the waterfall, in the live turn or as a card of its own', async ($, on) => {
  engine(on)
  const messages = [{ role: 'user' as const, text: 'Summary of the conversation so far', toolUses: [] }]
  on('session.compact', async () => ({
    messages,
    tokensBefore: 182_000,
    tokensAfter: 24_000,
    usage: { input_tokens: 2000, output_tokens: 3000, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 0 },
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // At the threshold, mid-turn: a row of the live turn, between its calls.
  await $.turn.start({ text: 'Refactor the billing module', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }));
  await $.session.compact({ trigger: 'auto', messages })
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List the billing files' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 1, model: 'claude-opus-5-5', messageCount: 2 }));
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Done', durationMs: 20000, isAborted: false })

  // `/compact` between turns: a card of its own, which numbers no turn.
  await $.session.compact({ trigger: 'manual', instructions: 'keep the plan', messages })
  // Ahead of time with nothing live: left out.
  await $.session.compact({ trigger: 'precompute', messages })

  const ui = await $.ui.mount({ ...pane(110), surface: 'desktop' })
  const [summary, own, turn] = (await ui.findAll({ type: 'Svg' })).map(p => String(p.props.source))
  expect(turn).toContain('Turn 1')
  // Its row, and its key in the legend.
  expect(turn).toContain('class="t">Compaction<')
  expect(turn).toContain('182k → 24k')
  expect(turn).toContain('class="s">Compaction<')
  expect(own).toContain('Compaction ·')
  expect(own).toContain('/compact keep the plan')
  expect(own).not.toContain('ahead of time')
  expect(summary).toContain('—')
  expect((await ui.findAll({ type: 'Svg' })).length).toBe(3)

  // Folded, the turn carries the compaction as a mark on its line.
  await ui.press({ key: 'fold:t1:root' })
  const folded = String((await ui.findAll({ type: 'Svg' }))[2]?.props.source)
  expect(folded).not.toContain('182k → 24k')
  expect(folded).toContain('#D9A23B')
  await ui.unmount()

  // The next turn is Turn 2, and the terminal draws the compaction as a row.
  await $.turn.start({ text: 'Next question', turnId: 't2' })
  const term = await $.ui.mount({ ...pane(110), surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /Turn 2/ })).toBeDefined()
  await term.press({ key: 'fold:t1:root' })
  expect(await term.find({ type: 'Text', text: 'Compaction' })).toBeDefined()
  const compaction = (await term.findAll({ type: 'Button' })).find(b => /^open:t1:compact:/.test(b.key ?? ''))
  await term.press({ key: compaction!.key! })
  expect(await term.find({ type: 'Text', text: /auto · conversation 182k → 24k tokens/ })).toBeDefined()
  await term.unmount()
})

test('the slowest call wears a turtle before its name; the fold buttons head the card', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Find the slow part', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }));
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'Quick list' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Done', durationMs: 10000, isAborted: false })

  const ui = await $.ui.mount({ ...pane(110), surface: 'desktop' })
  const source = String((await ui.findAll({ type: 'Svg' }))[1]?.props.source)
  // The LLM call took 6.9s, the Bash 3s: the turtle comes before "Planning the launch".
  expect(source).not.toContain('SLOWEST')
  expect(source.indexOf('🐢')).toBeGreaterThan(-1)
  expect(source.indexOf('🐢')).toBeLessThan(source.indexOf('>Planning the launch<'))
  expect(source).toContain('Slowest call')
  const card = JSON.stringify((await ui.find({ type: 'Box', key: 'run:t1' }))?.children)
  expect(card.indexOf('fold:t1:root')).toBeGreaterThan(-1)
  expect(card.indexOf('fold:t1:root')).toBeLessThan(card.indexOf('<svg'))
  await ui.unmount()

  const term = await $.ui.mount({ ...pane(110), surface: 'terminal' })
  const open = (await term.findAll({ type: 'Button' })).find(b => b.key === 'open:t1:main:t1:0')
  expect(open?.text.indexOf('🐢')).toBeLessThan(open!.text.indexOf('Planning'))
  await term.unmount()
})
