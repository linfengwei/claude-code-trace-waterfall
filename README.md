# trace-waterfall

**English** · [中文](README_CN.md)

A Claude Code mod that opens a live **Trace** pane beside the conversation. Every LLM call, tool call and subagent of a turn, subagents of subagents included, is drawn as a bar on a timeline, with tokens, TTFT, tokens per second and an estimated cost.

https://github.com/user-attachments/assets/af4ad973-55d6-48d7-8f8a-be67e6a6b67e

## Features

- **Live waterfall**: every LLM call, tool call and subagent as a bar on a timeline, nested under what started it.
- **Spot problems fast**: failed calls in red, 🐢 on the slowest call, compactions in amber (`182k → 24k`).
- **Per turn and in total**: one card per turn, newest first, under a summary of all turns.
- **Fold anything**: collapse a turn or a subagent to a single row.
- **Hover for details** (desktop): tokens in and out, cache hits, TTFT, tok/s, cost, input, output and errors.
- **Everywhere**: SVG on desktop and mobile, text in the terminal and VS Code.

Costs are estimates at API list prices.

## Install

From a shell:

```bash
claude plugin marketplace add linfengwei/claude-code-trace-waterfall
claude plugin install trace-waterfall@trace-waterfall
```

Or at the Claude Code prompt in a terminal:

```
/plugin marketplace add linfengwei/claude-code-trace-waterfall
/plugin install trace-waterfall@trace-waterfall
```

The desktop app uses the same plugins as the CLI, so run the shell commands above in any terminal. Then start a new session (or restart Claude Code) to load the pane.

## Update

```bash
claude plugin update trace-waterfall@trace-waterfall
```

It fetches the latest version from GitHub. Then start a new session (or restart Claude Code) to load it.

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
