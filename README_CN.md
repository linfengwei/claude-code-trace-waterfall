# trace-waterfall

[English](README.md) · **中文**

一個 Claude Code 的 mod：在對話旁邊開一個 **Trace** 面板，把每一輪（turn）裡的 LLM 呼叫、工具呼叫、subagent（以及 subagent 的 subagent）即時畫成瀑布圖，並統計 token、TTFT、TPS 與估算成本。

https://github.com/user-attachments/assets/af4ad973-55d6-48d7-8f8a-be67e6a6b67e

## 功能

- **即時瀑布圖**：每個 LLM 呼叫、工具呼叫、subagent 都是時間軸上的一條 bar，巢狀排在呼叫它的地方底下。
- **一眼看出問題**：失敗的呼叫標紅，最慢的呼叫有 🐢，壓縮 context 以琥珀色標出（`182k → 24k`）。
- **每輪與總計**：一輪一張卡片，最新的在上面，最上方是所有輪的總表。
- **隨意收合**：整輪或任一個 subagent 都能收成一列。
- **滑鼠移上去看詳情**（桌面版）：input/output token、cache 命中、TTFT、tok/s、成本、輸入輸出與錯誤。
- **各種介面**：桌面版與手機畫成 SVG，終端機與 VS Code 畫成文字。

成本依 API 牌價估算。

## 安裝

從 shell：

```bash
claude plugin marketplace add linfengwei/claude-code-trace-waterfall
claude plugin install trace-waterfall@trace-waterfall
```

或在終端機的 Claude Code 提示列輸入：

```
/plugin marketplace add linfengwei/claude-code-trace-waterfall
/plugin install trace-waterfall@trace-waterfall
```

桌面版 App 和 CLI 共用同一套 plugin，在任何終端機執行上面的 shell 指令即可。裝好後開一個新 session（或重開 Claude Code），pane 就會載入。

## 更新

```bash
claude plugin update trace-waterfall@trace-waterfall
```

會從 GitHub 抓最新版本。更新後開一個新 session（或重開 Claude Code）才會載入。

## 使用

- 在桌面版、手機與 VS Code，面板會在 session 開始時自動打開；在終端機輸入 `/trace` 打開（任何地方都可以用 `/trace` 重新打開）。
- 在面板上：
  - **Reset** 清掉已完成的 turn。
  - 每張卡片最上面的 **Fold** 按鈕收合或展開分支。

## 開發

```bash
claude --plugin-dir /path/to/trace-waterfall
```

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

## 檔案結構

| 檔案 | 內容 |
| --- | --- |
| `hooks/register.tsx` | 所有 hook：記錄 turn、LLM 串流、工具、subagent，並繪製面板 |
| `hooks/svg.ts` | 桌面與手機用的 SVG 繪製（總表、瀑布圖、統計卡） |
| `hooks/model.ts` | 價格表、格式化、顏色、時間軸 |
| `types/index.d.ts` | `$.state` 的型別合約 |
| `tests/trace.test.tsx` | 各介面、歷史、背景 subagent、壓縮 context、超大 turn 的測試 |

## 讀取與傳送的資料

- **讀取**：只讀目前 session 自己的事件，包括每個 turn 的提示、每次模型呼叫的模型與 token 用量、每個工具呼叫的名稱、輸入、輸出與錯誤，以及 subagent 的啟動與 context 壓縮。
- **保存**：只存在這個 session 的狀態裡，最多 30 個 turn，不會自己寫任何檔案。
- **不傳送任何資料**：不發網路請求、不讀寫檔案、不執行程式，也不呼叫模型。成本是用程式內建的價格表算的。
- **不改變任何行為**：每個事件都原封不動往下傳，不會擋下或改寫任何呼叫。只新增 `/trace` 指令和 Trace pane。

### Hooks

每個 hook 只記錄它看到的東西，事件原封不動往下傳，不會擋下、改寫或重試任何呼叫。

| Hook | 做什麼 |
| --- | --- |
| `session.start` | 註冊 `/trace`；在終端機以外的介面打開 pane；啟動每 2 秒一次的時鐘，讓進行中的 bar 變長 |
| `command.run`（`/trace`） | 打開 Trace pane |
| `turn.start` | 為這個 turn 開一張卡片並記下提示；subagent 的 turn 則加一列 |
| `turn.step` | 每次模型呼叫加一列，記下模型、第一個 byte 的時間與 token 用量；串流原樣往下傳 |
| `tool.call` | 每個工具呼叫加一列，記下名稱、輸入、輸出第一行或錯誤，以及花了多久；呼叫的結果原樣回傳，hook 自己出錯時呼叫照常進行 |
| `agent.spawn` | 把 subagent 的列接到啟動它的呼叫底下 |
| `session.compact` | 為 context 壓縮加一列，記下壓縮前後的 token 數 |
| `turn.complete` | 結束這個 turn 的卡片，標出結束的方式 |
| `ui.render`（Trace pane） | 依上面記下的資料畫出 pane |

## 限制

- Claude Code 傳給 mod 的 usage 只有 input、output、cache read 與 cache write，沒有 thinking token 數，所以不顯示 thinking。
- 一張卡片的 SVG 上限是 131072 字元。turn 太大時只畫根節點與最新的列，並標示有幾列沒畫；收合分支就能看到其他列。
- 最多保留 30 個 turn。

## 授權

MIT，詳見 [LICENSE](LICENSE)。
