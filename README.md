# Pi Note Panel

Pi coding agent 的專案級 Markdown 筆記側欄。它讓耐久的專案資訊保持可見，但**不會自動加入模型 context**；agent 只有呼叫讀取工具時才會取得筆記內容。

```text
+---------------- Pi terminal ----------------+
| Conversation and editor     | Project Notes |
| reflow to remaining width   | Markdown      |
|                             | scrollable    |
+----------------------------+----------------+
```

側欄預設為右側 36 欄。正文會依欄寬換行；終端太窄或太短時會自動隱藏，空間恢復後自動顯示。超出可見高度的內容可捲動。

## 安裝 / Install

```bash
pi install npm:pi-note-panel
```

在 npm 尚未發布前，從 GitHub 安裝：

```bash
pi install git:github.com/kyrosle/pi-note-panel
```

此 Git 安裝語法已依 Pi 0.82 本地文件核對。若要只安裝在目前專案，Pi 可加上 `-l`。

## 專案資料 / Project data

每個 Pi working directory 都是獨立專案，資料不會跨專案共用：

- `.pi/NOTE.md`：筆記內容；只在首次寫入或 `/note-panel edit` 時 lazy 建立。
- `.pi/note-panel.json`：專案級偏好設定，目前為 `enabled` 與 `width`。

## 指令 / Commands

```text
/note-panel
/note-panel on
/note-panel off
/note-panel width <24-80>
/note-panel refresh
/note-panel edit
/note-panel focus
```

無參數會顯示狀態與用法。`on`、`off` 與 `width` 寫入專案設定；`refresh` 重新載入筆記；`edit` 使用 Pi UI 編輯筆記；`focus` 將鍵盤焦點暫時交給可見側欄。

焦點在側欄時：`Up`/`Down` 逐行捲動、`PageUp`/`PageDown` 捲動一個視窗、`Home`/`End` 跳到開頭/結尾、`Esc` 回到 Pi editor。

## Agent tools

五個 tools 都只針對目前專案的筆記：

| Tool | 參數 | 結果 |
| --- | --- | --- |
| `note_panel_info` | 無 | 不回傳筆記正文，回傳目前 layout 與筆記容量 metrics。 |
| `note_panel_read` | 無 | 回傳已移除 terminal controls 的筆記 Markdown（檔案不存在時為空）與 metrics；一般 Markdown 內容不變。 |
| `note_panel_append` | `{ content: string }` | 附加 Markdown，必要時補一個分隔換行；回傳寫入後 metrics。 |
| `note_panel_replace` | `{ content: string }` | 以 Markdown 完整取代筆記；空字串會留下空檔案；回傳寫入後 metrics。 |
| `note_panel_update_section` | `{ heading: string, content: string, mode: "replace" | "append", level?: 1..6 }` | 以 exact、case-insensitive ATX heading 更新區段；不存在時以 `level` 新增（省略時預設為 2）；回傳寫入後 metrics。 |

建議 agent workflow：先呼叫 `note_panel_info` 了解可見空間，再用寫入 tool 更新內容，最後使用寫入結果中的 post-write metrics 確認是否仍可容納。內容需要閱讀時才呼叫 `note_panel_read`。

每個 metrics 物件包含：

- `uiAvailable`、`visible`、`hiddenReason`：UI 是否可用、是否可見，以及 disabled、narrow terminal、layout conflict 等原因。
- `terminal.columns`、`terminal.rows`：終端尺寸；無互動 UI 時 `terminal` 物件整體為 `null`。
- `panel.outerWidth`、`contentWidth`、`contentRows`、`scrollOffset`：側欄外寬、實際內容空間與目前捲動位置。disabled 或 narrow terminal 但仍有 TUI 時，也會保留已設定的容量預算；unsupported/layout conflict 與 headless 則為 `null`。
- `note.bytes`、`sourceLines`、`wrappedLines`、`visibleWrappedLines`、`hiddenWrappedLines`：前兩者來自原始筆記；換行與可見容量來自清除 terminal controls 後的渲染文字。
- `format`：plain Markdown 能力；保留 headings、lists、checkboxes，不支援 tables。

## 安全與內容邊界

- 筆記是 plain Markdown，不是 terminal instructions；側欄渲染與 `note_panel_read` 都會剝除 terminal control sequences，保留一般 Markdown。
- 擴展每次寫入後的筆記上限為 256 KiB，且只接受 UTF-8 文字；外部寫入的超限既有筆記仍可讀取。
- 讀寫會拒絕 `.pi` 或 `NOTE.md` 經 symlink 逃出目前專案的情況。這是操作開始時的 snapshot threat boundary，不是針對惡意同使用者並行程式的 sandbox。
- 寫入使用 `.pi` 內暫存檔加 atomic rename；驗證失敗不會覆寫既有筆記。
- 沒有刪除筆記檔案的 tool。

## 相容性 / Compatibility

Pi 0.82 的 TUI adaptive render adapter 會保留右側欄位並讓主 conversation/editor 自適應剩餘寬度。若偵測到 incompatible root-render/layout owner，視覺側欄會停用以避免衝突，但 tools 與 `/note-panel` commands 仍可使用。

在 headless、print 或 JSON 模式沒有可互動的側欄；tools 與 commands 仍維持可用並回傳 `ui-unavailable` metrics。RPC 模式不安裝視覺側欄，但保留 tools 與 commands；若 Pi 提供 RPC dialog UI，`/note-panel edit` 仍可使用。

## Development

```bash
npm install
npm run check
npm test
npm run typecheck
npm pack --dry-run
```

## License

[MIT](LICENSE) © 2026 kyrosle. Repository: [kyrosle/pi-note-panel](https://github.com/kyrosle/pi-note-panel).
