# trace-waterfall

**English** · [中文](README_CN.md)

A Claude Code mod that opens a live **Trace** pane beside the conversation. Every LLM call, tool call and subagent of a turn, subagents of subagents included, is drawn as a bar on a timeline, with tokens, TTFT, tokens per second and an estimated cost.

![Trace pane](media/preview.png)

🎬 Intro video: [media/intro.mp4](media/intro.mp4). It is drawn with the mod's own SVG code; the numbers are sample data.

## Features

- **Live waterfall**: one row per span, laid out on a timeline. Running bars keep growing, and subagents are indented under the call that started them.
- **Waiting vs. streaming**: the pale part of an LLM bar is the wait for the first byte; the solid part is streaming.
- **Token split**
  - Input: uncached, cache read and cache write, with the cached share and a split bar.
  - Output: output tokens and streaming speed (tok/s).
- **TTFT**: average time to the first byte, and to the first visible text or tool call.
- **Calls and errors**: LLM and tool call counts. Failed calls are listed with their error message, with tags such as `<tool_use_error>` stripped.
- **Slowest call**: a 🐢 sits in front of the name of the turn's slowest call.
- **Context compaction**: a compaction is drawn as an amber bar where it happened, in the live turn under the loop that compacted, with the conversation's size before and after (`182k → 24k`). A `/compact` between turns gets a card of its own. Its summarizer's tokens and cost count toward the turn.
- **One card per turn**: turns stack up as cards, newest on top. When a new turn goes live, finished turns fold themselves once; a turn you unfold stays open.
- **Summary**: the top of the pane shows totals for all turns and a table of time, cost, input, cached, output, TTFT and TPS.
- **Reset**: clears finished turns and keeps the one still running.
- **Fold branches**: the **Fold** buttons at the top of each card fold a whole turn or any subagent; its calls are drawn as marks on the folded row.
- **Details**: in the terminal and VS Code, press a row to see its input, output, tokens, TTFT, streaming time and error.
- **Background subagents**: a subagent still running after its Agent call returns stays live until its own turn ends. Calls left unfinished when a turn is interrupted are marked Interrupted.
- **Every surface**: a scalable SVG on desktop and mobile; text rows in the terminal and VS Code.

Costs are API list-price estimates. On a subscription plan you are billed differently.

## Install

At the Claude Code prompt in a terminal:

```
/plugin install trace-waterfall --marketplace linfengwei/trace-waterfall
```

Press `y` to add the marketplace, then pick a scope (user scope is the default; press Enter).

From a shell:

```bash
claude plugin install trace-waterfall --marketplace linfengwei/trace-waterfall
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box → **Plugins** → **Add marketplace**, enter `linfengwei/trace-waterfall`, then **Add plugin**.

## Use

- On desktop, mobile and VS Code the pane opens when a session starts. In the terminal, type `/trace` to open it; `/trace` reopens it anywhere.
- In the pane:
  - **Reset** clears finished turns.
  - The **Fold** buttons at the top of each card fold or unfold a branch.

## Develop

```bash
claude --plugin-dir /path/to/trace-waterfall
```

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

## Files

| File | What it holds |
| --- | --- |
| `hooks/register.tsx` | Every hook: records turns, LLM streams, tools and subagents, and draws the pane |
| `hooks/svg.ts` | The SVG drawing for desktop and mobile (summary, waterfall, stat tiles) |
| `hooks/model.ts` | Prices, formatting, colors, the time axis |
| `types/index.d.ts` | The `$.state` type contract |
| `tests/trace.test.tsx` | Tests for every surface, history, background subagents, compaction and huge turns |

## Limits

- The usage Claude Code passes to mods has input, output, cache read and cache write only, with no thinking token count, so thinking is not shown.
- One card's SVG holds at most 131072 characters and 4096 px of height. A bigger turn draws its root and its latest rows and says how many it left out; fold a branch to see the rest.
- The pane keeps at most 30 turns.
